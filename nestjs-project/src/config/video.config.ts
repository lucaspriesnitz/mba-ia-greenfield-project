import { registerAs } from '@nestjs/config';

const DEFAULT_ACCEPTED_MIME_TYPES =
  'video/mp4,video/quicktime,video/x-matroska,video/webm';

export default registerAs('video', () => ({
  maxUploadBytes: parseInt(
    process.env.VIDEO_MAX_UPLOAD_BYTES || '10737418240',
    10,
  ),
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  thumbnailOffsetSeconds: parseInt(
    process.env.VIDEO_THUMBNAIL_OFFSET_SECONDS || '3',
    10,
  ),
  acceptedMimeTypes: (
    process.env.VIDEO_ACCEPTED_MIME_TYPES || DEFAULT_ACCEPTED_MIME_TYPES
  )
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type.length > 0),
}));
