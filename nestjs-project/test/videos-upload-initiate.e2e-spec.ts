import request from 'supertest';
import { Repository } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import storageConfig from '../src/config/storage.config';
import videoConfig from '../src/config/video.config';
import { Video } from '../src/videos/entities/video.entity';
import {
  bootstrapVideosApp,
  ErrorEnvelopeBody,
  InitiateUploadBody,
  partBody,
  putPresignedPart,
  registerConfirmAndLogin,
  resetVideosState,
  VideosE2EContext,
} from './videos-upload.helpers';

const VIDEO = videoConfig();
const STORAGE = storageConfig();

describe('videos-upload-initiate (e2e)', () => {
  let context: VideosE2EContext;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let accessToken: string;
  let email: string;
  let counter = 0;

  beforeAll(async () => {
    context = await bootstrapVideosApp();
    videoRepository = context.dataSource.getRepository(Video);
    channelRepository = context.dataSource.getRepository(Channel);
  }, 60000);

  afterAll(async () => {
    await context.dataSource.query('DELETE FROM "videos"');
    await context.app.close();
  });

  beforeEach(async () => {
    await resetVideosState(context);
    counter += 1;
    email = `uploader_${counter}_${Date.now()}@example.com`;
    accessToken = await registerConfirmAndLogin(context.app, email);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      title: 'A holiday clip',
      description: 'shot on a phone',
      filename: 'holiday.MP4',
      contentType: 'video/mp4',
      // Two parts: enough to prove the ceil() without moving real bytes.
      sizeBytes: VIDEO.uploadPartSizeBytes + 1024,
      ...overrides,
    };
  }

  function initiate(body: Record<string, unknown>) {
    return request(context.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  async function channelIdOfCaller(): Promise<string> {
    const rows: { id: string }[] = await context.dataSource.query(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    const channel = await channelRepository.findOneByOrFail({
      user_id: rows[0].id,
    });
    return channel.id;
  }

  it('creates the draft and returns presigned parts', async () => {
    const sent = validBody();
    const res = await initiate(sent).expect(201);
    const body = res.body as InitiateUploadBody;

    expect(typeof body.publicId).toBe('string');
    expect(body.publicId.length).toBeGreaterThanOrEqual(10);
    expect(body.publicId.length).toBeLessThanOrEqual(16);
    expect(typeof body.uploadId).toBe('string');
    expect(body.partSizeBytes).toBe(VIDEO.uploadPartSizeBytes);
    expect(body.partCount).toBe(
      Math.ceil(sent.sizeBytes / VIDEO.uploadPartSizeBytes),
    );
    expect(body.parts).toHaveLength(body.partCount);

    body.parts.forEach((part) => {
      expect(typeof part.partNumber).toBe('number');
      expect(typeof part.url).toBe('string');
      // ISO-8601 round-trip: a malformed stamp would not survive it.
      expect(new Date(part.expiresAt).toISOString()).toBe(part.expiresAt);
    });

    const rows = await videoRepository.find({
      where: { public_id: body.publicId },
    });
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row.processing_status).toBe('uploading');
    expect(row.publication_status).toBe('draft');
    expect(row.upload_id).not.toBeNull();
    expect(row.storage_key).toBe(`videos/${body.publicId}/original.mp4`);
    expect(row.channel_id).toBe(await channelIdOfCaller());
  }, 60000);

  it('rejects a declared size above the ceiling with 413 and writes nothing', async () => {
    const res = await initiate(
      validBody({ sizeBytes: VIDEO.maxUploadBytes + 1 }),
    ).expect(413);

    expect((res.body as ErrorEnvelopeBody).error).toBe(
      'VIDEO_UPLOAD_TOO_LARGE',
    );
    expect(await videoRepository.count()).toBe(0);
  }, 60000);

  it('rejects a content type outside the accepted list with 415 and writes nothing', async () => {
    const res = await initiate(
      validBody({ contentType: 'application/pdf' }),
    ).expect(415);

    expect((res.body as ErrorEnvelopeBody).error).toBe(
      'UNSUPPORTED_VIDEO_FORMAT',
    );
    expect(await videoRepository.count()).toBe(0);
  }, 60000);

  it('rejects a request with no access token with 401 and writes nothing', async () => {
    await request(context.app.getHttpServer())
      .post('/videos')
      .send(validBody())
      .expect(401);

    expect(await videoRepository.count()).toBe(0);
  }, 60000);

  it('rejects a malformed body with 400 and writes nothing', async () => {
    const res = await initiate(validBody({ title: '' })).expect(400);

    expect((res.body as ErrorEnvelopeBody).error).toBe('VALIDATION_ERROR');
    expect(await videoRepository.count()).toBe(0);
  }, 60000);

  it('hands out part URLs that accept a PUT with no credentials at all', async () => {
    // One short part: `UploadPart` has no minimum, only `Complete` does.
    const res = await initiate(validBody({ sizeBytes: 1024 })).expect(201);
    const body = res.body as InitiateUploadBody;

    const signed = new URL(body.parts[0].url);
    // The client is pointed at storage, never at the application.
    expect(signed.host).toBe(new URL(STORAGE.publicEndpoint).host);
    expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();

    const put = await putPresignedPart(body.parts[0].url, partBody(1024));
    expect(put.status).toBe(200);
    expect(put.etag).toBeTruthy();
  }, 60000);

  it('gives consecutive uploads unrelated public ids', async () => {
    const first = (await initiate(validBody()).expect(201))
      .body as InitiateUploadBody;
    const second = (await initiate(validBody()).expect(201))
      .body as InitiateUploadBody;

    expect(first.publicId).not.toBe(second.publicId);
    // No ordinal relation: neither is a prefix of the other, and they do not
    // differ only by a trailing counter.
    expect(second.publicId.startsWith(first.publicId)).toBe(false);
    expect(first.publicId.slice(0, -1)).not.toBe(second.publicId.slice(0, -1));

    expect(await videoRepository.count()).toBe(2);
  }, 60000);
});
