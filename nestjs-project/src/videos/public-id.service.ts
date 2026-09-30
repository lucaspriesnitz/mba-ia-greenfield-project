import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { generatePublicId } from './public-id.util';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

/**
 * Attempt ceiling. With a 64-character alphabet over 11 positions a single
 * collision is already improbable; five consecutive ones mean something other
 * than chance is wrong, and looping forever would hide it.
 */
export const PUBLIC_ID_MAX_ATTEMPTS = 5;

/** TypeORM copies the pg driver's `code`/`detail` onto the thrown error. */
type PostgresQueryFailure = QueryFailedError & {
  code?: unknown;
  detail?: unknown;
};

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const failure = err as PostgresQueryFailure;
  return (
    failure.code === PG_UNIQUE_VIOLATION &&
    typeof failure.detail === 'string' &&
    failure.detail.includes(PUBLIC_ID_COLUMN)
  );
}

@Injectable()
export class PublicIdService {
  /**
   * Retry envelope around the caller's own write. The caller passes the whole
   * insert as `persist` and receives whatever it returns — the generated id is
   * handed in, never returned on its own, because the unique constraint on
   * `videos.public_id` is the only authority on whether an id is free, and it
   * only speaks when a row is actually inserted (per phase-03-videos/TD-06).
   *
   * Probing for existence before writing would trade that guarantee for a race
   * window between the check and the insert.
   *
   * Only a unique violation naming `public_id` is retried. Any other failure —
   * including a unique violation on another column — propagates untouched.
   */
  async allocate<T>(persist: (publicId: string) => Promise<T>): Promise<T> {
    let lastCollision: unknown;

    for (let attempt = 0; attempt < PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      try {
        return await persist(generatePublicId());
      } catch (err) {
        if (!isPublicIdCollision(err)) throw err;
        lastCollision = err;
      }
    }

    throw lastCollision;
  }
}
