import { originalKey, thumbnailKey } from './storage-keys';

describe('storage-keys', () => {
  const publicId = 'V1StGXR8Z5j';

  describe('originalKey', () => {
    it('places the original under the video prefix with its extension', () => {
      expect(originalKey(publicId, 'mp4')).toBe(
        `videos/${publicId}/original.mp4`,
      );
    });

    it('accepts the extension with a leading dot and drops it', () => {
      expect(originalKey(publicId, '.mp4')).toBe(
        `videos/${publicId}/original.mp4`,
      );
    });

    it('lowercases an uppercase extension so the same file never yields two keys', () => {
      expect(originalKey(publicId, 'MOV')).toBe(
        `videos/${publicId}/original.mov`,
      );
      expect(originalKey(publicId, '.MKV')).toBe(
        `videos/${publicId}/original.mkv`,
      );
    });

    it('emits the bare basename — never a trailing dot — when the extension is absent', () => {
      expect(originalKey(publicId)).toBe(`videos/${publicId}/original`);
      expect(originalKey(publicId, '')).toBe(`videos/${publicId}/original`);
      expect(originalKey(publicId, '   ')).toBe(`videos/${publicId}/original`);
      expect(originalKey(publicId, null)).toBe(`videos/${publicId}/original`);
    });

    it('keeps every object of one video under a single deletable prefix', () => {
      const prefix = `videos/${publicId}/`;

      expect(originalKey(publicId, 'mp4').startsWith(prefix)).toBe(true);
      expect(thumbnailKey(publicId).startsWith(prefix)).toBe(true);
    });
  });

  describe('thumbnailKey', () => {
    it('is always the JPEG the worker writes, regardless of the source format', () => {
      expect(thumbnailKey(publicId)).toBe(`videos/${publicId}/thumbnail.jpg`);
    });

    it('does not collide with the original', () => {
      expect(thumbnailKey(publicId)).not.toBe(originalKey(publicId, 'jpg'));
    });
  });
});
