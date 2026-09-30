import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/video-processing.contract';
import { VideoProcessingProducer } from '../../queue/video-processing.producer';
import { originalKey, thumbnailKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { seedProcessingVideo, waitFor } from '../../test/processing-fixtures';
import {
  generateVideoFixture,
  makeFixtureDir,
  removeFixtureDir,
} from '../../test/video-fixture';
import { User } from '../../users/entities/user.entity';
import { WorkerModule } from '../../worker.module';
import { Video } from '../entities/video.entity';
import { VideoProcessingStatus } from '../video.types';

const PUBLIC_ID = 'procOK00001';
const FIXTURE_SECONDS = 5;

/**
 * The real worker graph consuming a real job: `NestFactory.createApplicationContext`
 * over `WorkerModule` is the same call `src/worker.ts` makes, so what is under
 * test is the whole chain — queue delivery, MinIO, FFmpeg and Postgres.
 *
 * Needs the FFmpeg binaries, so it only runs in the worker image, and it needs
 * to be the **only** consumer attached to `video-processing`: stop the
 * `video-worker` service and run it with
 * `docker compose run --rm --no-deps video-worker npm test -- --runInBand --forceExit <path>`.
 */
describe('VideoProcessingProcessor happy path (integration)', () => {
  let app: INestApplicationContext;
  let videos: Repository<Video>;
  let storage: StorageService;
  let producer: VideoProcessingProducer;
  let queue: Queue;
  let dir: string;
  let video: Video;
  const storageKey = originalKey(PUBLIC_ID, 'mp4');

  beforeAll(async () => {
    dir = await makeFixtureDir();
    const fixture = await generateVideoFixture(dir, {
      durationSeconds: FIXTURE_SECONDS,
    });
    const bytes = await readFile(fixture.path);

    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['error'],
    });
    videos = app.get<Repository<Video>>(getRepositoryToken(Video));
    storage = app.get(StorageService);
    producer = app.get(VideoProcessingProducer);
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    await videos.delete({ public_id: PUBLIC_ID });
    await storage.putObject(storageKey, bytes, 'video/mp4');

    video = await seedProcessingVideo(
      {
        users: app.get<Repository<User>>(getRepositoryToken(User)),
        channels: app.get<Repository<Channel>>(getRepositoryToken(Channel)),
        videos,
      },
      { publicId: PUBLIC_ID, storageKey, sizeBytes: bytes.length },
    );

    await producer.enqueue(video.id);
    await waitFor(
      () => videos.findOneByOrFail({ id: video.id }),
      (row) => row.processing_status !== VideoProcessingStatus.PROCESSING,
      {
        timeoutMs: 120000,
        what: 'the processing status to leave `processing`',
      },
    );
  }, 300000);

  afterAll(async () => {
    await videos?.delete({ public_id: PUBLIC_ID });
    await storage?.deleteObject(storageKey);
    await storage?.deleteObject(thumbnailKey(PUBLIC_ID));
    await app?.close();
    await removeFixtureDir(dir);
  }, 60000);

  it('takes the record from processing to ready without intervention', async () => {
    const row = await videos.findOneByOrFail({ id: video.id });

    expect(row.processing_status).toBe(VideoProcessingStatus.READY);
    expect(row.processing_error).toBeNull();
    expect(row.duration_seconds).toBe(FIXTURE_SECONDS);
  });

  it('writes the probed metadata onto the record', async () => {
    const row = await videos.findOneByOrFail({ id: video.id });

    expect(row.metadata).toMatchObject({
      video: { codec: 'h264', width: 320, height: 240, frameRate: 25 },
    });
    expect(row.metadata?.container).toContain('mp4');
  });

  it('leaves a non-empty JPEG at the canonical thumbnail key', async () => {
    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.thumbnail_key).toBe(thumbnailKey(PUBLIC_ID));

    const head = await storage.headObject(thumbnailKey(PUBLIC_ID));
    expect(head.contentLength).toBeGreaterThan(0);
    expect(head.contentType).toBe('image/jpeg');

    const chunks: Buffer[] = [];
    const stream = await storage.getObjectStream(thumbnailKey(PUBLIC_ID));
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);

    // JPEG SOI marker — a real image, not just a non-empty object.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
  }, 60000);

  it('consumes the job and leaves nothing pending on the queue', async () => {
    const pending = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(pending).toHaveLength(0);
  }, 30000);

  it('leaves no temporary working directory behind', async () => {
    const leftovers = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith('streamtube-job-'),
    );
    expect(leftovers).toEqual([]);
  });
});
