import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import request from 'supertest';
import { Repository } from 'typeorm';
import queueConfig from '../src/config/queue.config';
import storageConfig from '../src/config/storage.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from '../src/queue/video-processing.contract';
import { originalKey, thumbnailKey } from '../src/storage/storage-keys';
import { StorageService } from '../src/storage/storage.service';
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
const RANGE_BYTES = 1024;
const DURATION_SECONDS = 42;

interface PlaybackBody {
  url: string;
  expiresAt: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
}

describe('videos-playback-url (e2e)', () => {
  let context: VideosE2EContext;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let internal: S3Client;
  let queue: Queue<VideoProcessJobData>;
  let ownerToken: string;
  let ownerEmail: string;
  let counter = 0;
  let seeded = 0;

  beforeAll(async () => {
    context = await bootstrapVideosApp({ uploadPartSizeBytes: PART_SIZE });
    videoRepository = context.dataSource.getRepository(Video);
    storageService = context.app.get(StorageService);
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
    ownerEmail = `playback_owner_${counter}_${Date.now()}@example.com`;
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

  /**
   * A row in the terminal success state, written without running the worker —
   * the endpoint reads the row and the bucket, and nothing else. No bytes are
   * uploaded here; the scenarios that actually fetch the issued URL use
   * `uploadReadyVideo` instead.
   */
  async function seedVideo(options: {
    email?: string;
    status?: VideoProcessingStatus;
    withThumbnail?: boolean;
  }): Promise<Video> {
    const {
      email = ownerEmail,
      status = VideoProcessingStatus.READY,
      withThumbnail = true,
    } = options;
    seeded += 1;
    const publicId = `pb${seeded}${Date.now().toString(36)}`.slice(0, 11);

    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: await channelIdOf(email),
        title: 'Seeded clip',
        original_filename: 'seeded.mp4',
        content_type: 'video/mp4',
        size_bytes: String(TOTAL_SIZE),
        storage_key: originalKey(publicId, 'mp4'),
        thumbnail_key: withThumbnail ? thumbnailKey(publicId) : null,
        upload_id: null,
        duration_seconds: DURATION_SECONDS,
        processing_status: status,
        ...(status === VideoProcessingStatus.FAILED && {
          processing_error: 'ffprobe exited with code 1',
        }),
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
          title: 'Playable clip',
          filename: 'playable.mp4',
          contentType: 'video/mp4',
          sizeBytes: TOTAL_SIZE,
        })
        .expect(201)
    ).body as InitiateUploadBody;

    const head = await putPresignedPart(
      opened.parts[0].url,
      partBody(PART_SIZE),
    );
    const tail = await putPresignedPart(
      opened.parts[1].url,
      partBody(TAIL_SIZE),
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

    const thumb = thumbnailKey(opened.publicId);
    await storageService.putObject(
      thumb,
      Buffer.alloc(512, 0x5b),
      'image/jpeg',
    );

    await videoRepository.update(
      { public_id: opened.publicId },
      {
        processing_status: VideoProcessingStatus.READY,
        duration_seconds: DURATION_SECONDS,
        thumbnail_key: thumb,
      },
    );

    return videoRepository.findOneByOrFail({ public_id: opened.publicId });
  }

  function playbackUrl(publicId: string, token = ownerToken) {
    return http()
      .get(`/videos/${publicId}/playback-url`)
      .set('Authorization', `Bearer ${token}`);
  }

  it('answers 200 with the url, the expiry, the duration and the thumbnail', async () => {
    const video = await seedVideo({});

    const body = (await playbackUrl(video.public_id).expect(200))
      .body as PlaybackBody;

    expect(body.url).toBeTruthy();
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.durationSeconds).toBe(DURATION_SECONDS);
    expect(body.thumbnailUrl).not.toBeNull();
    // The URL points at the storage endpoint the browser can reach, never at
    // the application — the API is not in the byte path.
    expect(new URL(body.url).host).toBe(new URL(STORAGE.publicEndpoint).host);
    expect(new URL(body.url).pathname).toContain(
      `videos/${video.public_id}/original.mp4`,
    );

    const bare = await seedVideo({ withThumbnail: false });
    const bareBody = (await playbackUrl(bare.public_id).expect(200))
      .body as PlaybackBody;
    expect(bareBody.thumbnailUrl).toBeNull();
  }, 120000);

  it('hands out a url storage answers with 206 to a range and 200 without one', async () => {
    const video = await uploadReadyVideo();

    const body = (await playbackUrl(video.public_id).expect(200))
      .body as PlaybackBody;

    const ranged = await getPresigned(body.url, {
      Range: `bytes=0-${RANGE_BYTES - 1}`,
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe(
      `bytes 0-${RANGE_BYTES - 1}/${TOTAL_SIZE}`,
    );
    expect(ranged.body.length).toBe(RANGE_BYTES);

    const whole = await getPresigned(body.url);
    expect(whole.status).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-length']).toBe(String(TOTAL_SIZE));
    expect(whole.body.length).toBe(TOTAL_SIZE);
    // The object arrives in several chunks and the first one lands well before
    // the last — playback can start without waiting for the whole file.
    expect(whole.chunkCount).toBeGreaterThan(1);
    expect(whole.msToFirstChunk).toBeLessThan(whole.msToEnd);
  }, 180000);

  it('raises the view count by exactly one per 200', async () => {
    const video = await seedVideo({});
    expect(video.view_count).toBe(0);

    await playbackUrl(video.public_id).expect(200);
    await playbackUrl(video.public_id).expect(200);
    await playbackUrl(video.public_id).expect(200);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    // Three issuances, three views — no URL was fetched, so the count is bound
    // to the request and not to the byte transfer.
    expect(row.view_count).toBe(3);
  }, 120000);

  it('answers 409 VIDEO_NOT_READY while the video is still being processed', async () => {
    const video = await seedVideo({ status: VideoProcessingStatus.PROCESSING });

    const res = await playbackUrl(video.public_id).expect(409);
    expect((res.body as ErrorEnvelopeBody).error).toBe('VIDEO_NOT_READY');

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.view_count).toBe(0);
  }, 120000);

  it('answers 409 VIDEO_PROCESSING_FAILED on the terminal failure, distinctly', async () => {
    const video = await seedVideo({ status: VideoProcessingStatus.FAILED });

    const res = await playbackUrl(video.public_id).expect(409);
    const body = res.body as ErrorEnvelopeBody;
    expect(body.error).toBe('VIDEO_PROCESSING_FAILED');
    expect(body.error).not.toBe('VIDEO_NOT_READY');

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.view_count).toBe(0);
  }, 120000);

  it("answers another owner's draft and a nonexistent id with the same 404", async () => {
    const video = await seedVideo({});
    const strangerToken = await registerConfirmAndLogin(
      context.app,
      `playback_stranger_${counter}_${Date.now()}@example.com`,
    );

    const onDraft = await playbackUrl(video.public_id, strangerToken).expect(
      404,
    );
    expect((onDraft.body as ErrorEnvelopeBody).error).toBe('VIDEO_NOT_FOUND');
    expect(onDraft.status).not.toBe(403);

    const onGhost = await playbackUrl('neverexisted', strangerToken).expect(
      404,
    );
    // Byte for byte the same answer: probing cannot confirm the id exists.
    expect(onGhost.body).toEqual(onDraft.body);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.view_count).toBe(0);
  }, 120000);

  it('issues a url that stops serving the object once the ttl is spent', async () => {
    const video = await uploadReadyVideo();

    // A dedicated app whose only difference is the TTL; everything else, the
    // signing host included, is what the application really ships.
    const shortLived = await bootstrapVideosApp(
      { uploadPartSizeBytes: PART_SIZE },
      { presignTtlSeconds: 1 },
    );

    try {
      const issue = async () =>
        (
          await request(shortLived.app.getHttpServer())
            .get(`/videos/${video.public_id}/playback-url`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .expect(200)
        ).body as PlaybackBody;

      const first = await issue();
      expect((await getPresigned(first.url)).status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 2500));
      const expired = await getPresigned(first.url);
      expect(expired.status).toBeGreaterThanOrEqual(400);
      expect(expired.status).not.toBe(200);

      const second = await issue();
      expect(second.url).not.toBe(first.url);
      expect((await getPresigned(second.url)).status).toBe(200);
    } finally {
      await shortLived.app.close();
    }
  }, 180000);
});
