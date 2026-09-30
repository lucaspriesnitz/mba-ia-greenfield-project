import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { VideosModule } from '../videos.module';
import { FfmpegThumbnailAdapter } from './ffmpeg-thumbnail.adapter';
import { FfprobeAdapter } from './ffprobe.adapter';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Everything that consumes the queue, in a module only `WorkerModule` imports.
 *
 * Technical action 5 of SI-03.12 asks for the processor to be registered "in
 * VideosModule, under WorkerModule only" — but `VideosModule` is imported by
 * `AppModule` too, and a `@Processor` provider in it would make the API a
 * consumer, which is exactly what the action forbids. A separate module is the
 * only way to keep the two entrypoints sharing the same domain code while only
 * one of them attaches a worker to Redis (per phase-03-videos/TD-04).
 */
@Module({
  imports: [ConfigModule, VideosModule, StorageModule, QueueModule],
  providers: [FfprobeAdapter, FfmpegThumbnailAdapter, VideoProcessingProcessor],
  exports: [FfprobeAdapter, FfmpegThumbnailAdapter],
})
export class VideoProcessingModule {}
