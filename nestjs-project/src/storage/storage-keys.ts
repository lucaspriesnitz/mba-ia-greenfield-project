/**
 * The only place in the codebase that spells a video's storage keys. Every
 * object of a video lives under the single bucket behind the `videos/<publicId>/`
 * prefix, so deleting a video is deleting a prefix (per phase-03-videos/TD-01).
 */

const VIDEO_PREFIX = 'videos';
const ORIGINAL_BASENAME = 'original';
const THUMBNAIL_FILENAME = 'thumbnail.jpg';

/**
 * Lowercases and strips leading dots. An absent or blank extension yields the
 * bare `original`, never a trailing dot, because `original.` is a malformed key.
 */
function normalizeExtension(ext: string | null | undefined): string {
  if (!ext) return '';
  return ext.trim().replace(/^\.+/, '').toLowerCase();
}

/** `videos/<publicId>/original.<ext>` — the uploaded file, as uploaded. */
export function originalKey(publicId: string, ext?: string | null): string {
  const normalized = normalizeExtension(ext);
  const filename = normalized
    ? `${ORIGINAL_BASENAME}.${normalized}`
    : ORIGINAL_BASENAME;
  return `${VIDEO_PREFIX}/${publicId}/${filename}`;
}

/** `videos/<publicId>/thumbnail.jpg` — written by the worker, always JPEG. */
export function thumbnailKey(publicId: string): string {
  return `${VIDEO_PREFIX}/${publicId}/${THUMBNAIL_FILENAME}`;
}
