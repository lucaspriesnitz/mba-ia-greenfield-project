import { getQueueToken } from '@nestjs/bullmq';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from '../../queue/video-processing.contract';
import { VideoProcessingProducer } from '../../queue/video-processing.producer';
import { originalKey, thumbnailKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { seedProcessingVideo, waitFor } from '../../test/processing-fixtures';
import { User } from '../../users/entities/user.entity';
import { WorkerModule } from '../../worker.module';
import { Video } from '../entities/video.entity';
import { VideoProcessingStatus } from '../video.types';

const PUBLIC_ID = 'procFAIL001';
const CORRUPT = Buffer.from(
  'this is not an MP4 container, just bytes with an mp4 extension',
);

/**
 * Same wiring as the happy-path suite — the real `WorkerModule` context — with
 * an object that FFmpeg cannot decode. Needs the FFmpeg binaries and needs to
 * be the only consumer on the queue; see the happy-path suite's header for how
 * to run it.
 */
describe('VideoProcessingProcessor terminal failure (integration)', () => {
  const settings = queueConfig();
  let app: INestApplicationContext;
  let videos: Repository<Video>;
  let storage: StorageService;
  let queue: Queue<VideoProcessJobData>;
  let video: Video;
  let failedJob: Job<VideoProcessJobData>;
  const storageKey = originalKey(PUBLIC_ID, 'mp4');

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    videos = app.get<Repository<Video>>(getRepositoryToken(Video));
    storage = app.get(StorageService);
    queue = app.get<Queue<VideoProcessJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );

    await videos.delete({ public_id: PUBLIC_ID });
    await storage.putObject(storageKey, CORRUPT, 'video/mp4');

    video = await seedProcessingVideo(
      {
        users: app.get<Repository<User>>(getRepositoryToken(User)),
        channels: app.get<Repository<Channel>>(getRepositoryToken(Channel)),
        videos,
      },
      { publicId: PUBLIC_ID, storageKey, sizeBytes: CORRUPT.length },
    );

    await app.get(VideoProcessingProducer).enqueue(video.id);

    // attempts × exponential backoff: the terminal state is only written after
    // the queue has spent the whole budget.
    await waitFor(
      () => videos.findOneByOrFail({ id: video.id }),
      (row) => row.processing_status === VideoProcessingStatus.FAILED,
      { timeoutMs: 180000, what: 'the terminal failed status' },
    );

    [failedJob] = await queue.getFailed();
  }, 300000);

  afterAll(async () => {
    await videos?.delete({ public_id: PUBLIC_ID });
    await storage?.deleteObject(storageKey);
    await app?.close();
    const cleanup = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: { host: settings.redisHost, port: settings.redisPort },
      // Must name the same namespace the app under test used, or this would
      // obliterate an empty keyspace and leave the real one dirty.
      prefix: settings.keyPrefix,
    });
    await cleanup.obliterate({ force: true });
    await cleanup.close();
  }, 60000);

  it('lands in the terminal failed status with the cause recorded', async () => {
    const row = await videos.findOneByOrFail({ id: video.id });

    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.processing_error).toEqual(expect.any(String));
    // FFmpeg's own diagnostic, which is why the adapters spawn the binary
    // instead of using a wrapper.
    expect(row.processing_error).toMatch(/ffprobe/);
    expect(row.duration_seconds).toBeNull();
    expect(row.thumbnail_key).toBeNull();
  });

  it('gave up after exactly the configured number of attempts', () => {
    expect(failedJob).toBeDefined();
    expect(failedJob.data.videoId).toBe(video.id);
    expect(failedJob.attemptsMade).toBe(settings.attempts);
    expect(failedJob.opts.attempts).toBe(settings.attempts);
  });

  it('writes no thumbnail for a video it could not decode', async () => {
    await expect(storage.headObject(thumbnailKey(PUBLIC_ID))).rejects.toThrow();
  }, 30000);

  it('never retries on its own once terminal', async () => {
    const before = await videos.findOneByOrFail({ id: video.id });

    // Comfortably longer than the configured backoff: if anything were still
    // scheduled it would have fired inside this window.
    await new Promise((resolve) =>
      setTimeout(resolve, settings.backoffMs * 3 + 2000),
    );

    const after = await videos.findOneByOrFail({ id: video.id });
    expect(after.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());

    const [job] = await queue.getFailed();
    expect(job.attemptsMade).toBe(settings.attempts);
    expect(await queue.getJobs(['waiting', 'delayed', 'active'])).toHaveLength(
      0,
    );
  }, 120000);
});
