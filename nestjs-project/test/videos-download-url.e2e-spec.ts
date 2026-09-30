import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import request from 'supertest';
import { Repository } from 'typeorm';
import queueConfig from '../src/config/queue.config';
import storageConfig from '../src/config/storage.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from '../src/queue/video-processing.contract';
import { originalKey } from '../src/storage/storage-keys';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingStatus } from '../src/videos/video.types';
import {
  bootstrapVideosApp,
  ErrorEnvelopeBody,
  getPresigned,
  InitiateUploadBody,
  partBody,
  purgeVideoObjects,
  putPresignedPart,
  registerConfirmAndLogin,
  resetVideosState,
  VideosE2EContext,
} from './videos-upload.helpers';

const STORAGE = storageConfig();
const QUEUE = queueConfig();

/** MinIO's floor for any part but the last. */
const PART_SIZE = 5 * 1024 * 1024;
const TAIL_SIZE = 1024;
const TOTAL_SIZE = PART_SIZE + TAIL_SIZE;
const ORIGINAL_FILENAME = 'ferias-2026.mp4';

interface DownloadBody {
  url: string;
  expiresAt: string;
}

describe('videos-download-url (e2e)', () => {
  let context: VideosE2EContext;
  let videoRepository: Repository<Video>;
  let internal: S3Client;
  let queue: Queue<VideoProcessJobData>;
  let ownerToken: string;
  let ownerEmail: string;
  let counter = 0;
  let seeded = 0;

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
    ownerEmail = `download_owner_${counter}_${Date.now()}@example.com`;
    ownerToken = await registerConfirmAndLogin(context.app, ownerEmail);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function http() {
    return request(context.app.getHttpServer());
  }

  async function channelIdOf(email: string): Promise<string> {
    // Typed through the generic, not an `as` cast: `npm run lint` runs with
    // `--fix` and strips an assertion over `query`'s `any` as "unnecessary".
    const rows = await context.dataSource.query<{ id: string }[]>(
      'SELECT c.id FROM "channels" c JOIN "users" u ON u.id = c.user_id WHERE u.email = $1',
      [email],
    );
    return rows[0].id;
  }

  /** A row in the terminal success state, with no bytes behind it. */
  async function seedVideo(options: {
    email?: string;
    status?: VideoProcessingStatus;
  }): Promise<Video> {
    const { email = ownerEmail, status = VideoProcessingStatus.READY } =
      options;
    seeded += 1;
    const publicId = `dl${seeded}${Date.now().toString(36)}`.slice(0, 11);

    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: await channelIdOf(email),
        title: 'Seeded clip',
        original_filename: ORIGINAL_FILENAME,
        content_type: 'video/mp4',
        size_bytes: String(TOTAL_SIZE),
        storage_key: originalKey(publicId, 'mp4'),
        thumbnail_key: null,
        upload_id: null,
        duration_seconds: 42,
        processing_status: status,
      }),
    );
  }

  /** The real upload path end to end, then the terminal success state. */
  async function uploadReadyVideo(): Promise<Video> {
    const opened = (
      await http()
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Downloadable clip',
          filename: ORIGINAL_FILENAME,
          contentType: 'video/mp4',
          sizeBytes: TOTAL_SIZE,
        })
        .expect(201)
    ).body as InitiateUploadBody;

    const head = await putPresignedPart(
      opened.parts[0].url,
      partBody(PART_SIZE, 0x61),
    );
    const tail = await putPresignedPart(
      opened.parts[1].url,
      partBody(TAIL_SIZE, 0x62),
    );
    expect([head.status, tail.status]).toEqual([200, 200]);

    await http()
      .post(`/videos/${opened.publicId}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        parts: [
          { partNumber: 1, etag: head.etag },
          { partNumber: 2, etag: tail.etag },
        ],
      })
      .expect(200);

    // The job the completion enqueued is dropped: this suite writes the
    // terminal state itself and must not race a worker for the row.
    await queue.obliterate({ force: true });

    await videoRepository.update(
      { public_id: opened.publicId },
      {
        processing_status: VideoProcessingStatus.READY,
        duration_seconds: 42,
      },
    );

    return videoRepository.findOneByOrFail({ public_id: opened.publicId });
  }

  function downloadUrl(publicId: string, token: string | null = ownerToken) {
    const req = http().get(`/videos/${publicId}/download-url`);
    return token === null ? req : req.set('Authorization', `Bearer ${token}`);
  }

  it('answers 200 with the url and its expiry, pointing at storage', async () => {
    const video = await seedVideo({});

    const body = (await downloadUrl(video.public_id).expect(200))
      .body as DownloadBody;

    expect(body.url).toBeTruthy();
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The browser talks to storage directly; the API is not in the byte path.
    expect(new URL(body.url).host).toBe(new URL(STORAGE.publicEndpoint).host);
  }, 120000);

  it('forces an attachment under the original filename, byte for byte', async () => {
    const video = await uploadReadyVideo();

    const body = (await downloadUrl(video.public_id).expect(200))
      .body as DownloadBody;

    const downloaded = await getPresigned(body.url);
    expect(downloaded.status).toBe(200);
    const disposition = String(downloaded.headers['content-disposition'] ?? '');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(`filename="${ORIGINAL_FILENAME}"`);
    expect(downloaded.headers['content-length']).toBe(String(TOTAL_SIZE));
    expect(downloaded.body.length).toBe(TOTAL_SIZE);

    // Compared against the object in the bucket, not against what was uploaded:
    // the assertion is that the download is the stored file.
    const stored = await internal.send(
      new GetObjectCommand({
        Bucket: STORAGE.bucket,
        Key: `videos/${video.public_id}/original.mp4`,
      }),
    );
    const storedBody = stored.Body;
    if (!storedBody) throw new Error('Storage returned no body for the object');
    const storedBytes = Buffer.from(await storedBody.transformToByteArray());
    expect(downloaded.body.equals(storedBytes)).toBe(true);
  }, 180000);

  it('leaves the view count untouched — a download is not a view', async () => {
    const video = await uploadReadyVideo();
    expect(video.view_count).toBe(0);

    const body = (await downloadUrl(video.public_id).expect(200))
      .body as DownloadBody;
    await downloadUrl(video.public_id).expect(200);
    await downloadUrl(video.public_id).expect(200);

    expect((await getPresigned(body.url)).status).toBe(200);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.view_count).toBe(0);
  }, 180000);

  it('answers 409 VIDEO_NOT_READY while the video is still being processed', async () => {
    const video = await seedVideo({ status: VideoProcessingStatus.PROCESSING });

    const res = await downloadUrl(video.public_id).expect(409);
    const body = res.body as ErrorEnvelopeBody & { url?: string };
    expect(body.error).toBe('VIDEO_NOT_READY');
    // The 409 body is an error envelope and nothing else — no URL slipped out.
    expect(body.url).toBeUndefined();
  }, 120000);

  it("answers another owner's draft with a 404 indistinguishable from a ghost id", async () => {
    const video = await seedVideo({});
    const strangerToken = await registerConfirmAndLogin(
      context.app,
      `download_stranger_${counter}_${Date.now()}@example.com`,
    );

    const onDraft = await downloadUrl(video.public_id, strangerToken).expect(
      404,
    );
    expect((onDraft.body as ErrorEnvelopeBody).error).toBe('VIDEO_NOT_FOUND');
    expect(onDraft.status).not.toBe(403);

    const onGhost = await downloadUrl('neverexisted', strangerToken).expect(
      404,
    );
    expect(onGhost.body).toEqual(onDraft.body);
  }, 120000);

  it('answers 401 without an access token and issues nothing', async () => {
    const video = await seedVideo({});

    const res = await downloadUrl(video.public_id, null).expect(401);
    expect((res.body as { url?: string }).url).toBeUndefined();
  }, 120000);
});
