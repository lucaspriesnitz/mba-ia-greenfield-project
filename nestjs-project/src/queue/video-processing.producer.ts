import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from './video-processing.contract';

/**
 * The only way a processing job is ever created. Retry, backoff and the attempt
 * ceiling are queue-level defaults registered by `QueueModule`, so nothing here
 * re-states them — the library owns that behaviour, not project code
 * (per phase-03-videos/TD-03).
 */
@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessJobData>,
  ) {}

  /** Publishes `{ videoId }` and nothing more (per phase-03-videos/TD-09). */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(VIDEO_PROCESS_JOB, { videoId });
  }
}
