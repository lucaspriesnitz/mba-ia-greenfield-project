import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import request from 'supertest';
import { Repository } from 'typeorm';
import queueConfig from '../src/config/queue.config';
import storageConfig from '../src/config/storage.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from '../src/queue/video-processing.contract';
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
const QUEUE = queueConfig();

/** MinIO's floor for any part but the last. */
const PART_SIZE = 5 * 1024 * 1024;
const TAIL_SIZE = 1024;
const TOTAL_SIZE = PART_SIZE + TAIL_SIZE;

interface CompleteBody {
  publicId: string;
  processingStatus: string;
}

describe('videos-upload-complete (e2e)', () => {
  let context: VideosE2EContext;
  let videoRepository: Repository<Video>;
  let internal: S3Client;
  let queue: Queue<VideoProcessJobData>;
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
    queue = new Queue<VideoProcessJobData>(VIDEO_PROCESSING_QUEUE, {
      connection: { host: QUEUE.redisHost, port: QUEUE.redisPort },
      // The suite's own Redis namespace — the same one the app under test is
      // configured with — so the `video-worker` running in Compose cannot
      // consume the job these assertions are about.
      prefix: QUEUE.keyPrefix,
    });
  }, 60000);

  afterAll(async () => {
    // The last scenario's assembled object outlives the per-test reset.
    await purgeVideoObjects(context.dataSource);
    await context.dataSource.query('DELETE FROM "videos"');
    await context.app.close();
    await queue.obliterate({ force: true });
    await queue.close();
    internal.destroy();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await resetVideosState(context);
    counter += 1;
    ownerToken = await registerConfirmAndLogin(
      context.app,
      `complete_owner_${counter}_${Date.now()}@example.com`,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function http() {
    return request(context.app.getHttpServer());
  }

  async function openUpload(): Promise<InitiateUploadBody> {
    const res = await http()
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Completed clip',
        filename: 'done.mp4',
        contentType: 'video/mp4',
        sizeBytes: TOTAL_SIZE,
      })
      .expect(201);
    return res.body as InitiateUploadBody;
  }

  async function uploadEveryPart(
    parts: SignedPartBody[],
  ): Promise<{ partNumber: number; etag: string }[]> {
    const head = await putPresignedPart(parts[0].url, partBody(PART_SIZE));
    const tail = await putPresignedPart(parts[1].url, partBody(TAIL_SIZE));
    expect([head.status, tail.status]).toEqual([200, 200]);
    return [
      { partNumber: 1, etag: head.etag },
      { partNumber: 2, etag: tail.etag },
    ];
  }

  function complete(
    publicId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    return http()
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts });
  }

  async function pendingJobs() {
    return queue.getJobs(['waiting', 'delayed', 'active']);
  }

  it('assembles the object, moves to processing and enqueues one thin job', async () => {
    const opened = await openUpload();
    const parts = await uploadEveryPart(opened.parts);

    const res = await complete(opened.publicId, parts).expect(200);
    const body = res.body as CompleteBody;

    expect(body.publicId).toBe(opened.publicId);
    expect(body.processingStatus).toBe('processing');

    const row = await videoRepository.findOneByOrFail({
      public_id: opened.publicId,
    });
    expect(row.upload_id).toBeNull();
    expect(row.processing_status).toBe('processing');

    const jobs = await pendingJobs();
    expect(jobs).toHaveLength(1);
    // The internal uuid, never the public id, and nothing else in the payload.
    expect(jobs[0].data).toEqual({ videoId: row.id });
    expect(jobs[0].data.videoId).not.toBe(opened.publicId);

    const head = await internal.send(
      new HeadObjectCommand({
        Bucket: STORAGE.bucket,
        Key: `videos/${opened.publicId}/original.mp4`,
      }),
    );
    expect(head.ContentLength).toBe(TOTAL_SIZE);
  }, 120000);

  it('answers 413 and leaves no object and no job when the assembled size breaches a lowered ceiling', async () => {
    // A dedicated app whose only difference is the ceiling; the bytes are real.
    const tight = await bootstrapVideosApp({
      uploadPartSizeBytes: PART_SIZE,
      maxUploadBytes: TOTAL_SIZE - 1,
    });

    try {
      // The declared size clears the lowered ceiling, the assembled one does not.
      const opened = (
        await request(tight.app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({
            title: 'Too large once assembled',
            filename: 'toobig.mp4',
            contentType: 'video/mp4',
            sizeBytes: 1024,
          })
          .expect(201)
      ).body as InitiateUploadBody;

      // partCount is 1 under the lowered declaration, so both parts are signed
      // explicitly through the resume endpoint would be out of range — upload a
      // single part large enough to breach the ceiling instead.
      const only = await putPresignedPart(
        opened.parts[0].url,
        partBody(TOTAL_SIZE),
      );
      expect(only.status).toBe(200);

      const res = await request(tight.app.getHttpServer())
        .post(`/videos/${opened.publicId}/upload/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts: [{ partNumber: 1, etag: only.etag }] })
        .expect(413);

      expect((res.body as ErrorEnvelopeBody).error).toBe(
        'VIDEO_UPLOAD_TOO_LARGE',
      );
      expect(await pendingJobs()).toHaveLength(0);

      const objects = await internal.send(
        new ListObjectsV2Command({
          Bucket: STORAGE.bucket,
          Prefix: `videos/${opened.publicId}/`,
        }),
      );
      expect(objects.Contents ?? []).toEqual([]);

      const uploads = await internal.send(
        new ListMultipartUploadsCommand({
          Bucket: STORAGE.bucket,
          Prefix: `videos/${opened.publicId}/`,
        }),
      );
      expect(uploads.Uploads ?? []).toEqual([]);
    } finally {
      await tight.app.close();
    }
  }, 120000);

  it('answers 409 on the second completion and does not enqueue a second job', async () => {
    const opened = await openUpload();
    const parts = await uploadEveryPart(opened.parts);

    await complete(opened.publicId, parts).expect(200);
    expect(await pendingJobs()).toHaveLength(1);

    const res = await complete(opened.publicId, parts).expect(409);
    expect((res.body as ErrorEnvelopeBody).error).toBe(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    );
    expect(await pendingJobs()).toHaveLength(1);
  }, 120000);

  it('moves the file to storage without a single byte crossing the API', async () => {
    const opened = await openUpload();

    // Every request to the application carries metadata only. The part URLs
    // point at storage, so the bytes never enter this process.
    opened.parts.forEach((part) => {
      expect(new URL(part.url).host).toBe(new URL(STORAGE.publicEndpoint).host);
    });

    const parts = await uploadEveryPart(opened.parts);

    const resigned = (
      await http()
        .post(`/videos/${opened.publicId}/upload/parts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ partNumbers: [2] })
        .expect(200)
    ).body as { parts: SignedPartBody[] };
    expect(new URL(resigned.parts[0].url).host).toBe(
      new URL(STORAGE.publicEndpoint).host,
    );

    // The completion body carries part numbers and etags, nothing else.
    const completionBody = { parts };
    expect(JSON.stringify(completionBody).length).toBeLessThan(500);

    await complete(opened.publicId, parts).expect(200);

    const head = await internal.send(
      new HeadObjectCommand({
        Bucket: STORAGE.bucket,
        Key: `videos/${opened.publicId}/original.mp4`,
      }),
    );
    expect(head.ContentLength).toBe(TOTAL_SIZE);
  }, 120000);

  describe('DELETE /videos/:publicId/upload', () => {
    it('answers 204, discards the draft and leaves no residue', async () => {
      const opened = await openUpload();

      const uploaded = await putPresignedPart(
        opened.parts[0].url,
        partBody(PART_SIZE),
      );
      expect(uploaded.status).toBe(200);

      const res = await http()
        .delete(`/videos/${opened.publicId}/upload`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(204);
      expect(res.body).toEqual({});

      expect(
        await videoRepository.findOneBy({ public_id: opened.publicId }),
      ).toBeNull();

      const uploads = await internal.send(
        new ListMultipartUploadsCommand({
          Bucket: STORAGE.bucket,
          Prefix: `videos/${opened.publicId}/`,
        }),
      );
      expect(uploads.Uploads ?? []).toEqual([]);

      const objects = await internal.send(
        new ListObjectsV2Command({
          Bucket: STORAGE.bucket,
          Prefix: `videos/${opened.publicId}/`,
        }),
      );
      expect(objects.Contents ?? []).toEqual([]);
    }, 120000);
  });
});
