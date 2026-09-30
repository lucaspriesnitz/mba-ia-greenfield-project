import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.contract';
import { VideoProcessingProducer } from './video-processing.producer';

/**
 * Registers the Redis connection and the `video-processing` queue. Every job
 * option that governs failure handling is set here, once, from configuration:
 * attempts, exponential backoff and the decision to keep failed jobs around so
 * a terminal failure stays inspectable (per phase-03-videos/TD-03).
 *
 * The Redis key `prefix` is set on the shared configuration, not on the queue
 * registration, because `@nestjs/bullmq` merges the shared config into the queue
 * options and then builds each `@Processor`'s worker from those same options.
 * One setting therefore namespaces producer and consumer together — which is
 * what keeps them in step no matter which prefix is configured.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.redisHost, port: config.redisPort },
        prefix: config.keyPrefix,
      }),
    }),
    BullModule.registerQueueAsync({
      name: VIDEO_PROCESSING_QUEUE,
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        defaultJobOptions: {
          attempts: config.attempts,
          backoff: { type: 'exponential', delay: config.backoffMs },
          removeOnComplete: true,
          // A job that exhausted its attempts must stay queryable as `failed`;
          // dropping it would erase the only trace of a terminal failure.
          removeOnFail: false,
        },
      }),
    }),
  ],
  providers: [VideoProcessingProducer],
  exports: [VideoProcessingProducer, BullModule],
})
export class QueueModule {}
