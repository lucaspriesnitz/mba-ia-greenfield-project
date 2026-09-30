import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { Repository } from 'typeorm';
import storageConfig from '../src/config/storage.config';
import { Video } from '../src/videos/entities/video.entity';
import {
  bootstrapVideosApp,
  ErrorEnvelopeBody,
  InitiateUploadBody,
  partBody,
  purgeVideoObjects,
  putPresignedPart,
  registerConfirmAndLogin,
  resetVideosState,
  SignedPartBody,
  VideosE2EContext,
} from './videos-upload.helpers';

const STORAGE = storageConfig();

/**
 * The shipped part size is 64 MiB. Completing a multipart needs every non-final
 * part to clear MinIO's 5 MiB floor, so the suite runs on the floor itself
 * rather than pushing hundreds of megabytes per scenario.
 */
const PART_SIZE = 5 * 1024 * 1024;
const TAIL_SIZE = 1024;
const TOTAL_SIZE = PART_SIZE + TAIL_SIZE;

interface SignPartsBody {
  parts: SignedPartBody[];
}

describe('videos-upload-parts (e2e)', () => {
  let context: VideosE2EContext;
  let videoRepository: Repository<Video>;
  let internal: S3Client;
  let ownerToken: string;
  let counter = 0;

  beforeAll(async () => {
    context = await bootstrapVideosApp({ uploadPartSizeBytes: PART_SIZE });
    videoRepository = context.dataSource.getRepository(Video);
    internal = new S3Client({
      endpoint: STORAGE.internalEndpoint,
      region: STORAGE.region,
      credentials: {
        accessKeyId: STORAGE.accessKey,
        secretAccessKey: STORAGE.secretKey,
      },
      forcePathStyle: true,
    });
  }, 60000);

  afterAll(async () => {
    // The last scenario's assembled object outlives the per-test reset.
    await purgeVideoObjects(context.dataSource);
    await context.dataSource.query('DELETE FROM "videos"');
    await context.app.close();
    internal.destroy();
  });

  beforeEach(async () => {
    await resetVideosState(context);
    counter += 1;
    ownerToken = await registerConfirmAndLogin(
      context.app,
      `parts_owner_${counter}_${Date.now()}@example.com`,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function http() {
    return request(context.app.getHttpServer());
  }

  async function openUpload(token = ownerToken): Promise<InitiateUploadBody> {
    const res = await http()
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Resumable clip',
        filename: 'resume.mp4',
        contentType: 'video/mp4',
        sizeBytes: TOTAL_SIZE,
      })
      .expect(201);
    return res.body as InitiateUploadBody;
  }

  function signParts(
    publicId: string,
    partNumbers: unknown,
    token: string | null = ownerToken,
  ) {
    const call = http().post(`/videos/${publicId}/upload/parts`);
    if (token) call.set('Authorization', `Bearer ${token}`);
    return call.send({ partNumbers });
  }

  it('re-signs the requested parts in the requested order', async () => {
    const opened = await openUpload();
    expect(opened.partCount).toBe(2);

    const res = await signParts(opened.publicId, [2, 1]).expect(200);
    const body = res.body as SignPartsBody;

    expect(body.parts).toHaveLength(2);
    expect(body.parts.map((part) => part.partNumber)).toEqual([2, 1]);
    body.parts.forEach((part) => {
      expect(new URL(part.url).host).toBe(new URL(STORAGE.publicEndpoint).host);
      expect(new Date(part.expiresAt).toISOString()).toBe(part.expiresAt);
    });
  }, 120000);

  it('resumes an upload: the re-sent part completes into an intact object', async () => {
    const opened = await openUpload();

    const first = await putPresignedPart(
      opened.parts[0].url,
      partBody(PART_SIZE, 0x61),
    );
    const tail = await putPresignedPart(
      opened.parts[1].url,
      partBody(TAIL_SIZE, 0x62),
    );
    expect(first.status).toBe(200);
    expect(tail.status).toBe(200);

    // Resume part 1 through a freshly signed URL.
    const resigned = (await signParts(opened.publicId, [1]).expect(200))
      .body as SignPartsBody;
    const resent = await putPresignedPart(
      resigned.parts[0].url,
      partBody(PART_SIZE, 0x63),
    );
    expect(resent.status).toBe(200);
    expect(resent.etag).not.toBe(first.etag);

    await http()
      .post(`/videos/${opened.publicId}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        parts: [
          { partNumber: 1, etag: resent.etag },
          { partNumber: 2, etag: tail.etag },
        ],
      })
      .expect(200);

    const head = await internal.send(
      new HeadObjectCommand({
        Bucket: STORAGE.bucket,
        Key: `videos/${opened.publicId}/original.mp4`,
      }),
    );
    // The resume replaced part 1 rather than appending it.
    expect(head.ContentLength).toBe(TOTAL_SIZE);
  }, 120000);

  it('answers 404 for a video owned by someone else, indistinguishably from one that does not exist', async () => {
    const opened = await openUpload();

    const intruderToken = await registerConfirmAndLogin(
      context.app,
      `intruder_${counter}_${Date.now()}@example.com`,
    );

    const foreign = await signParts(opened.publicId, [1], intruderToken).expect(
      404,
    );
    const missing = await signParts('zzzzzzzzzzz', [1], intruderToken).expect(
      404,
    );

    expect((foreign.body as ErrorEnvelopeBody).error).toBe('VIDEO_NOT_FOUND');
    expect(foreign.body).toEqual(missing.body);
  }, 120000);

  it('answers 409 once the upload has been completed', async () => {
    const opened = await openUpload();

    const first = await putPresignedPart(
      opened.parts[0].url,
      partBody(PART_SIZE),
    );
    const tail = await putPresignedPart(
      opened.parts[1].url,
      partBody(TAIL_SIZE),
    );

    await http()
      .post(`/videos/${opened.publicId}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        parts: [
          { partNumber: 1, etag: first.etag },
          { partNumber: 2, etag: tail.etag },
        ],
      })
      .expect(200);

    const row = await videoRepository.findOneByOrFail({
      public_id: opened.publicId,
    });
    expect(row.upload_id).toBeNull();

    const res = await signParts(opened.publicId, [1]).expect(409);
    expect((res.body as ErrorEnvelopeBody).error).toBe(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    );
  }, 120000);

  it('answers 400 for a part number past partCount, and for an empty array', async () => {
    const opened = await openUpload();

    const outOfRange = await signParts(opened.publicId, [
      opened.partCount + 1,
    ]).expect(400);
    expect((outOfRange.body as ErrorEnvelopeBody).error).toBe(
      'VALIDATION_ERROR',
    );
    expect(outOfRange.body).not.toHaveProperty('parts');

    const empty = await signParts(opened.publicId, []).expect(400);
    expect((empty.body as ErrorEnvelopeBody).error).toBe('VALIDATION_ERROR');
  }, 120000);

  it('answers 401 without an access token and issues no URL', async () => {
    const opened = await openUpload();

    const res = await signParts(opened.publicId, [1], null).expect(401);
    expect(res.body).not.toHaveProperty('parts');
  }, 120000);
});
