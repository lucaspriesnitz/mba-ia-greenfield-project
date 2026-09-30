import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from '../../queue/video-processing.contract';
import { thumbnailKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoProcessingStatus } from '../video.types';
import { FfmpegThumbnailAdapter } from './ffmpeg-thumbnail.adapter';
import { FfprobeAdapter } from './ffprobe.adapter';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/**
 * The consumer side of `video.process`. It lives only in the worker process —
 * the API registers no consumer at all (per phase-03-videos/TD-04), which is
 * why it is provided by `VideoProcessingModule` and not by the shared
 * `VideosModule`.
 *
 * The job carries `{ videoId }` and nothing else, so every input is re-read
 * from the record at the start of each attempt: a redelivery recomputes from
 * the stored object and overwrites its own previous partial output instead of
 * compounding it (per phase-03-videos/TD-09).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffprobe: FfprobeAdapter,
    private readonly thumbnails: FfmpegThumbnailAdapter,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videos.findOne({ where: { id: videoId } });

    if (!video) {
      // Cancelled upload: the row is already gone. Nothing to do and nothing
      // to retry — failing here would burn the attempt budget for no reason.
      this.logger.warn(`Video ${videoId} no longer exists; job discarded`);
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-job-'));
    const originalPath = join(workDir, 'original');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      // The storage key comes from the record, never from the payload.
      await pipeline(
        await this.storage.getObjectStream(video.storage_key),
        createWriteStream(originalPath),
      );

      const probe = await this.ffprobe.probe(originalPath);
      await this.thumbnails.generate(
        originalPath,
        thumbnailPath,
        probe.durationSeconds,
      );

      const key = thumbnailKey(video.public_id);
      await this.storage.putObject(
        key,
        await readFile(thumbnailPath),
        THUMBNAIL_CONTENT_TYPE,
      );

      // One update: the record never sits in a half-written state where the
      // status says `ready` but the metadata is not there yet.
      await this.videos.update(video.id, {
        duration_seconds: probe.durationSeconds,
        // TypeORM's QueryDeepPartialEntity rejects concrete nullable members,
        // which is the same reason `Video.metadata` itself is typed loosely.
        metadata: probe.metadata as Record<string, any>,
        thumbnail_key: key,
        processing_status: VideoProcessingStatus.READY,
        // A successful re-run clears the reason left by an earlier failure.
        processing_error: null,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * The attempt ceiling and the backoff belong to the queue; this handler only
   * records the outcome once the queue has given up. Writing `failed` on every
   * intermediate attempt would make a transient error look terminal (per
   * phase-03-videos/TD-03, phase-03-videos/TD-08).
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const ceiling = job.opts.attempts ?? 1;
    if (job.attemptsMade < ceiling) return;

    await this.videos.update(job.data.videoId, {
      processing_status: VideoProcessingStatus.FAILED,
      processing_error: error.message,
    });

    this.logger.error(
      `Video ${job.data.videoId} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
  }
}
