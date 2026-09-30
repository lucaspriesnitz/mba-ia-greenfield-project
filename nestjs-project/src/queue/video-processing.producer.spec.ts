import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.contract';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer', () => {
  let producer: VideoProcessingProducer;
  const queue = { add: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    queue.add.mockResolvedValue({ id: '1' });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessingProducer,
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();

    producer = moduleRef.get(VideoProcessingProducer);
  });

  it('publishes under the job name the worker listens for', async () => {
    await producer.enqueue('11111111-1111-1111-1111-111111111111');

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(VIDEO_PROCESS_JOB, {
      videoId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('sends the internal id and strictly nothing else', async () => {
    await producer.enqueue('22222222-2222-2222-2222-222222222222');

    const [, payload] = queue.add.mock.calls[0] as [string, object];
    expect(Object.keys(payload)).toEqual(['videoId']);
  });

  it('adds no per-job options, leaving retry and backoff to the queue defaults', async () => {
    await producer.enqueue('33333333-3333-3333-3333-333333333333');

    // A third argument here would silently shadow the configured
    // attempts/backoff for this job.
    expect(queue.add.mock.calls[0]).toHaveLength(2);
  });

  it('surfaces a publishing failure instead of swallowing it', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis is down'));

    await expect(
      producer.enqueue('44444444-4444-4444-4444-444444444444'),
    ).rejects.toThrow('redis is down');
  });
});
