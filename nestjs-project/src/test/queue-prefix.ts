import queueConfig from '../config/queue.config';

/**
 * Jest `setupFiles` hook, and the single place the suite's Redis namespace is
 * decided. Both Jest projects load it — `package.json` for the unit and
 * integration suites, `test/jest-e2e.json` for the end-to-end ones.
 *
 * Why it exists: the queue name and the job name are one constant imported by
 * the API and by the worker (per phase-03-videos/TD-09), so a test that enqueues
 * publishes onto the very queue the `video-worker` running in Compose consumes —
 * and that worker took the job before the assertion could read it, which made
 * `npm test` fail differently on each run. Both states are required at once: the
 * worker up in Compose is an acceptance criterion and a green suite is the
 * definition of done, so neither stopping the worker nor renaming the queue in
 * the tests is available. BullMQ's `prefix` isolates below the queue name: same
 * queue name, same job name, a Redis keyspace of its own.
 *
 * It runs after `dotenv/config`, so it overrides whatever `.env` set instead of
 * being overridden by it, and it derives the namespace from the configured
 * prefix so the default lives in `queue.config.ts` alone.
 */
process.env.VIDEO_QUEUE_PREFIX = `${queueConfig().keyPrefix}-test`;
