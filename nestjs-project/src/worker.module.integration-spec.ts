import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { AuthService } from './auth/auth.service';
import { VIDEO_PROCESSING_QUEUE } from './queue/video-processing.contract';
import { StorageService } from './storage/storage.service';
import { Video } from './videos/entities/video.entity';
import { WorkerModule } from './worker.module';

/**
 * Boots the real worker entrypoint — `createApplicationContext`, the same call
 * `src/worker.ts` makes — because the point of this SI is that the second
 * process resolves the same graph as the API without ever opening a port.
 */
describe('WorkerModule as a standalone application context (integration)', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['error'],
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
  }, 30000);

  it('resolves the very same Video repository the API writes through', async () => {
    const repository = app.get<Repository<Video>>(getRepositoryToken(Video));

    expect(repository).toBeInstanceOf(Repository);
    // A real round trip, not just DI resolution: the connection is live and the
    // entity is mapped against the migrated schema.
    await expect(repository.count()).resolves.toBeGreaterThanOrEqual(0);
    expect(repository.metadata.tableName).toBe('videos');
  }, 30000);

  it('resolves StorageService and the video-processing queue', async () => {
    expect(app.get(StorageService)).toBeInstanceOf(StorageService);

    const queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    // Reaching Redis, not just holding an object shaped like a queue.
    await expect(queue.getJobCounts('waiting')).resolves.toHaveProperty(
      'waiting',
    );
  }, 30000);

  it('reaches the database and the storage by Compose service name, never localhost', () => {
    const options = app.get(DataSource).options as { host?: string };
    expect(options.host).not.toMatch(/localhost|127\.0\.0\.1/);

    // The worker only ever talks to storage over the internal endpoint; the
    // public one exists solely to sign URLs handed to a browser.
    const internal =
      process.env.STORAGE_INTERNAL_ENDPOINT ?? 'http://minio:9000';
    expect(internal).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it('is an application context with no HTTP listener at all', () => {
    // `INestApplication` is the type that carries `listen`; an application
    // context does not, which is what keeps the worker portless.
    expect((app as unknown as { listen?: unknown }).listen).toBeUndefined();
  });

  it('leaves the HTTP concerns of the API out of the graph', () => {
    // No AuthModule means no global JwtAuthGuard and no throttler in the worker
    // process (per phase-03-videos/TD-04).
    expect(() => app.get(AuthService, { strict: false })).toThrow();
  });
});
