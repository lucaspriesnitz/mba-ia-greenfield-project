import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, Worker } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from './video-processing.contract';
import { VideoProcessingProducer } from './video-processing.producer';

describe('QueueModule against the Compose Redis (integration)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<VideoProcessJobData>;
  const config = queueConfig();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get<Queue<VideoProcessJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  }, 30000);

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  }, 30000);

  it('compiles with a real Redis connection and exposes the producer', () => {
    expect(producer).toBeInstanceOf(VideoProcessingProducer);
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    // The queue name stays the contract's, shared with the worker; what keeps
    // this suite out of the running worker's reach is the Redis key prefix, and
    // it comes from configuration rather than from a literal here.
    expect(queue.opts.prefix).toBe(config.keyPrefix);
    expect(config.keyPrefix).not.toBe('');
  });

  it('leaves exactly one waiting job carrying only the video id', async () => {
    const videoId = '55555555-5555-5555-5555-555555555555';

    await producer.enqueue(videoId);

    const waiting = await queue.getWaiting();
    expect(waiting).toHaveLength(1);
    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
    expect(waiting[0].name).toBe(VIDEO_PROCESS_JOB);
    // Read back out of Redis, not out of the in-process object.
    expect(waiting[0].data).toEqual({ videoId });
    expect(Object.keys(waiting[0].data)).toEqual(['videoId']);
  }, 30000);

  it('stamps the job with the configured attempts and exponential backoff', async () => {
    await producer.enqueue('66666666-6666-6666-6666-666666666666');

    const [job] = await queue.getWaiting();
    expect(job.opts.attempts).toBe(config.attempts);
    expect(job.opts.backoff).toEqual({
      type: 'exponential',
      delay: config.backoffMs,
    });
    // The values come from VIDEO_QUEUE_ATTEMPTS / VIDEO_QUEUE_BACKOFF_MS, and
    // the defaults are only the fallback — not a literal in the module.
    expect(config.attempts).toBeGreaterThan(0);
    expect(config.backoffMs).toBeGreaterThan(0);
  }, 30000);

  it('keeps a job that exhausted every attempt queryable as failed', async () => {
    // A throwaway consumer that always blows up, so the job really walks the
    // failure path instead of being poked into the failed set by hand.
    const worker = new Worker(
      VIDEO_PROCESSING_QUEUE,
      () => {
        throw new Error('processing blew up');
      },
      {
        connection: { host: config.redisHost, port: config.redisPort },
        // The same namespace the module registers the queue under: a consumer on
        // another prefix would watch a different keyspace and never see the job.
        prefix: config.keyPrefix,
      },
    );

    try {
      const gaveUp = new Promise<void>((resolve) =>
        worker.once('failed', () => resolve()),
      );
      const job = await queue.add(
        VIDEO_PROCESS_JOB,
        { videoId: '77777777-7777-7777-7777-777777777777' },
        { attempts: 1 },
      );
      await gaveUp;

      // `removeOnFail: false` is what keeps the record inspectable afterwards.
      const failed = await queue.getFailed();
      expect(failed).toHaveLength(1);
      expect(failed[0].id).toBe(job.id);
      expect(failed[0].failedReason).toBe('processing blew up');
    } finally {
      await worker.close();
    }
  }, 30000);
});
