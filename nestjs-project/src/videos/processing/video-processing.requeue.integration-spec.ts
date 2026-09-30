import { readFile } from 'node:fs/promises';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import { VideoProcessingProducer } from '../../queue/video-processing.producer';
import { originalKey, thumbnailKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { STORAGE_INTERNAL_CLIENT } from '../../storage/storage.tokens';
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

const PUBLIC_ID = 'procRQ00001';
const FIXTURE_SECONDS = 5;

/**
 * Re-enqueueing the same `videoId` is the only supported way to reprocess a
 * video (per phase-03-videos/TD-09), so a second delivery has to recompute from
 * the stored object and overwrite its own previous output. Needs the FFmpeg
 * binaries and needs to be the only consumer on the queue; see the happy-path
 * suite's header for how to run it.
 */
describe('VideoProcessingProcessor idempotency on re-enqueue (integration)', () => {
  const storageSettings = storageConfig();
  let app: INestApplicationContext;
  let videos: Repository<Video>;
  let storage: StorageService;
  let producer: VideoProcessingProducer;
  let internal: S3Client;
  let dir: string;
  let video: Video;
  const storageKey = originalKey(PUBLIC_ID, 'mp4');

  async function objectsUnderPrefix(): Promise<string[]> {
    const listed = await internal.send(
      new ListObjectsV2Command({
        Bucket: storageSettings.bucket,
        Prefix: `videos/${PUBLIC_ID}/`,
      }),
    );
    return (listed.Contents ?? []).map((entry) => entry.Key ?? '').sort();
  }

  async function processUntilReady(): Promise<Video> {
    await producer.enqueue(video.id);
    return waitFor(
      () => videos.findOneByOrFail({ id: video.id }),
      (row) =>
        row.processing_status === VideoProcessingStatus.READY &&
        row.duration_seconds === FIXTURE_SECONDS,
      { timeoutMs: 120000, what: 'the record to come back ready' },
    );
  }

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
    internal = app.get<S3Client>(STORAGE_INTERNAL_CLIENT);

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

    await processUntilReady();
  }, 300000);

  afterAll(async () => {
    await videos?.delete({ public_id: PUBLIC_ID });
    await storage?.deleteObject(storageKey);
    await storage?.deleteObject(thumbnailKey(PUBLIC_ID));
    await app?.close();
    await removeFixtureDir(dir);
  }, 60000);

  it('recomputes an already-ready video and leaves it consistent', async () => {
    // Corrupt the derived columns on purpose: the only way to observe that the
    // second delivery really recomputed rather than short-circuiting.
    await videos.update(video.id, {
      duration_seconds: 999,
      metadata: null,
      thumbnail_key: null,
    });

    const row = await processUntilReady();

    expect(row.processing_status).toBe(VideoProcessingStatus.READY);
    expect(row.duration_seconds).toBe(FIXTURE_SECONDS);
    expect(row.thumbnail_key).toBe(thumbnailKey(PUBLIC_ID));
    expect(row.metadata).toMatchObject({ video: { codec: 'h264' } });
  }, 180000);

  it('keeps a single thumbnail at the canonical key', async () => {
    // Original + thumbnail, nothing else: the key is derived, so a re-run
    // overwrites the same object instead of adding one.
    expect(await objectsUnderPrefix()).toEqual([
      storageKey,
      thumbnailKey(PUBLIC_ID),
    ]);
  }, 30000);

  it('clears a previous failure reason when the re-run succeeds', async () => {
    await videos.update(video.id, {
      processing_status: VideoProcessingStatus.FAILED,
      processing_error: 'an earlier terminal failure',
      duration_seconds: null,
    });

    const row = await processUntilReady();

    expect(row.processing_status).toBe(VideoProcessingStatus.READY);
    expect(row.processing_error).toBeNull();
  }, 180000);
});
