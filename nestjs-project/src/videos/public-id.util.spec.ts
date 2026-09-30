import {
  generatePublicId,
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
} from './public-id.util';

describe('generatePublicId', () => {
  it('loads its generator dependency under the CommonJS runtime Jest uses', () => {
    // This is the test that closes the ESM x CommonJS constraint of TD-06.
    // requireActual goes through the CommonJS loader, so an ESM-only package
    // blows up right here — at load time, not at tsc.
    expect(() => {
      jest.requireActual('nanoid');
    }).not.toThrow();
    expect(typeof generatePublicId).toBe('function');
  });

  it('returns an 11-character identifier', () => {
    expect(generatePublicId()).toHaveLength(11);
    expect(PUBLIC_ID_LENGTH).toBe(11);
  });

  it('only ever emits characters from the URL-safe alphabet', () => {
    const pattern = /^[A-Za-z0-9_-]+$/;

    for (let i = 0; i < 500; i += 1) {
      expect(generatePublicId()).toMatch(pattern);
    }
  });

  it('declares an alphabet that is exactly A-Z a-z 0-9 _ -', () => {
    expect([...PUBLIC_ID_ALPHABET].sort().join('')).toBe(
      [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-']
        .sort()
        .join(''),
    );
    expect(new Set(PUBLIC_ID_ALPHABET).size).toBe(PUBLIC_ID_ALPHABET.length);
  });

  it('survives a URL path segment without escaping', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = generatePublicId();
      expect(encodeURIComponent(id)).toBe(id);
      expect(new URL(`https://example.com/watch/${id}`).pathname).toBe(
        `/watch/${id}`,
      );
    }
  });

  it('produces distinct values on consecutive calls', () => {
    expect(generatePublicId()).not.toBe(generatePublicId());
  });

  it('shows no sequential relation across a large batch', () => {
    const ids = Array.from({ length: 1000 }, () => generatePublicId());

    // No duplicates at this volume...
    expect(new Set(ids).size).toBe(ids.length);

    // ...and the sequence is not monotonic in either direction, which is what
    // "not sequential" has to mean for a random identifier.
    const ascending = ids.every((id, i) => i === 0 || ids[i - 1] < id);
    const descending = ids.every((id, i) => i === 0 || ids[i - 1] > id);
    expect(ascending).toBe(false);
    expect(descending).toBe(false);
  });

  it('spreads the first character across the alphabet instead of anchoring it', () => {
    const firstChars = new Set(
      Array.from({ length: 500 }, () => generatePublicId()[0]),
    );

    // A counter-derived id would collapse this set to a handful of values.
    expect(firstChars.size).toBeGreaterThan(20);
  });
});
