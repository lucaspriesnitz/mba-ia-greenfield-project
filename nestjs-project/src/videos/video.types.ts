/**
 * The two status axes are orthogonal and are never collapsed into one column
 * (per phase-03-videos/TD-08). "Watchable" is the explicit conjunction
 * `processing_status = 'ready' AND publication_status = 'published'`.
 */

export enum VideoProcessingStatus {
  AWAITING_UPLOAD = 'awaiting_upload',
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  /** Terminal — only a re-enqueue by id moves a video out of it. */
  FAILED = 'failed',
}

export enum VideoPublicationStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
}
