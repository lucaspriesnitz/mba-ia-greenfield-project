import { customAlphabet } from 'nanoid';

/**
 * URL-safe alphabet — `A–Z a–z 0–9 _ -`. Every character survives a URL path
 * segment untouched, so `/watch/<publicId>` needs no escaping.
 */
export const PUBLIC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export const PUBLIC_ID_LENGTH = 11;

/**
 * `nanoid` is pinned to the 3.x line on purpose: 4+ is ESM-only and this project
 * emits CommonJS (`typeorm-ts-node-commonjs`, ts-jest), where an ESM-only package
 * breaks at `require()` in both the compiled runtime and Jest — not at `tsc`
 * (per phase-03-videos/TD-06).
 */
const generate = customAlphabet(PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH);

/** Random, non-sequential, non-enumerable public identifier. */
export function generatePublicId(): string {
  return generate();
}
