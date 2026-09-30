/**
 * The whole contract between the API and the worker. Both sides import from
 * here — the queue name, the job name and the payload shape are never spelled
 * literally anywhere else (per phase-03-videos/TD-09).
 */

/** Queue backed by Redis via `@nestjs/bullmq` (per phase-03-videos/TD-03). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** The single job this queue carries. */
export const VIDEO_PROCESS_JOB = 'video.process';

/**
 * One internal id and nothing else — no storage key, no size, no channel, no
 * title. A thin payload cannot go stale between enqueue and delivery, which is
 * what makes a retry (or a manual re-enqueue) safe (per phase-03-videos/TD-09).
 */
export interface VideoProcessJobData {
  /** `Video.id`, the internal primary key — never `public_id`. */
  videoId: string;
}
