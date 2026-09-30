import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  attempts: parseInt(process.env.VIDEO_QUEUE_ATTEMPTS || '3', 10),
  backoffMs: parseInt(process.env.VIDEO_QUEUE_BACKOFF_MS || '5000', 10),
  // Namespace BullMQ puts in front of every Redis key it writes. A producer and
  // a consumer only meet when the queue name *and* the prefix match, so this is
  // the knob that lets the test suite keep the production queue name — the one
  // constant both sides import (per phase-03-videos/TD-09) — while living in a
  // keyspace of its own, so the `video-worker` running in Compose never eats the
  // job a test just enqueued.
  keyPrefix: process.env.VIDEO_QUEUE_PREFIX || 'streamtube',
}));
