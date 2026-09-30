import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * The worker entrypoint. `createApplicationContext` builds the DI graph without
 * an HTTP adapter — there is no `listen()` here and no port is published for
 * the service, which is the whole point of splitting the process: heavy FFmpeg
 * work never competes with request handling (per phase-03-videos/TD-04).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: false,
  });

  // SIGTERM from `docker compose stop` has to reach the queue consumer so it
  // drains the job it holds instead of dropping it.
  app.enableShutdownHooks();

  new Logger('VideoWorker').log(
    'Video worker ready — consuming the video-processing queue',
  );
}

void bootstrap();
