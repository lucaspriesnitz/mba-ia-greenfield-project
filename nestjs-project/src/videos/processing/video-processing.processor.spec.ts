import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { VideoProcessJobData } from '../../queue/video-processing.contract';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoProcessingStatus } from '../video.types';
import { FfmpegThumbnailAdapter } from './ffmpeg-thumbnail.adapter';
import { FfprobeAdapter } from './ffprobe.adapter';
import { VideoProcessingProcessor } from './video-processing.processor';

const VIDEO_ID = '11111111-1111-1111-1111-111111111111';

const PROBE = {
  durationSeconds: 12,
  metadata: {
    container: 'mov,mp4',
    bitrate: 400000,
    video: { codec: 'h264', width: 320, height: 240, frameRate: 25 },
    audio: null,
  },
};

function videoRow(): Video {
  return {
    id: VIDEO_ID,
    public_id: 'abc123XYZ_-',
    storage_key: 'videos/abc123XYZ_-/original.mp4',
  } as Video;
}

function job(
  data: Partial<VideoProcessJobData> = {},
): Job<VideoProcessJobData> {
  return { data: { videoId: VIDEO_ID, ...data } } as Job<VideoProcessJobData>;
}

describe('VideoProcessingProcessor', () => {
  let videos: jest.Mocked<Pick<Repository<Video>, 'findOne' | 'update'>>;
  let storage: jest.Mocked<
    Pick<StorageService, 'getObjectStream' | 'putObject'>
  >;
  let ffprobe: jest.Mocked<Pick<FfprobeAdapter, 'probe'>>;
  let thumbnails: jest.Mocked<Pick<FfmpegThumbnailAdapter, 'generate'>>;
  let processor: VideoProcessingProcessor;
  /** The temp file the processor downloaded into, captured from the adapter. */
  let probedPath: string | undefined;

  beforeEach(() => {
    probedPath = undefined;

    videos = {
      findOne: jest.fn().mockResolvedValue(videoRow()),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Pick<Repository<Video>, 'findOne' | 'update'>>;

    storage = {
      getObjectStream: jest.fn().mockResolvedValue(Readable.from(['bytes'])),
      putObject: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<
      Pick<StorageService, 'getObjectStream' | 'putObject'>
    >;

    ffprobe = {
      probe: jest.fn().mockImplementation((input: string) => {
        probedPath = input;
        return Promise.resolve(PROBE);
      }),
    } as unknown as jest.Mocked<Pick<FfprobeAdapter, 'probe'>>;

    thumbnails = {
      generate: jest
        .fn()
        .mockImplementation(async (_i: string, out: string) => {
          await writeFile(out, 'jpeg-bytes');
          return out;
        }),
    } as unknown as jest.Mocked<Pick<FfmpegThumbnailAdapter, 'generate'>>;

    processor = new VideoProcessingProcessor(
      videos as unknown as Repository<Video>,
      storage as unknown as StorageService,
      ffprobe as unknown as FfprobeAdapter,
      thumbnails as unknown as FfmpegThumbnailAdapter,
    );
  });

  it('ends without error when the video no longer exists', async () => {
    videos.findOne.mockResolvedValue(null);

    await expect(processor.process(job())).resolves.toBeUndefined();

    // A cancelled upload must not burn an attempt, so nothing else happens.
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(videos.update).not.toHaveBeenCalled();
  });

  it('writes metadata, thumbnail key and ready in a single update', async () => {
    await processor.process(job());

    expect(storage.getObjectStream).toHaveBeenCalledWith(
      'videos/abc123XYZ_-/original.mp4',
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/abc123XYZ_-/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(videos.update).toHaveBeenCalledTimes(1);
    expect(videos.update).toHaveBeenCalledWith(VIDEO_ID, {
      duration_seconds: 12,
      metadata: PROBE.metadata,
      thumbnail_key: 'videos/abc123XYZ_-/thumbnail.jpg',
      processing_status: VideoProcessingStatus.READY,
      processing_error: null,
    });
  });

  it('derives the storage key from the record, never from the payload', async () => {
    videos.findOne.mockResolvedValue({
      ...videoRow(),
      storage_key: 'videos/other/original.mkv',
    } as Video);

    await processor.process(job());

    expect(storage.getObjectStream).toHaveBeenCalledWith(
      'videos/other/original.mkv',
    );
  });

  it('rethrows an adapter failure so the queue counts the attempt', async () => {
    ffprobe.probe.mockImplementation((input: string) => {
      probedPath = input;
      return Promise.reject(new Error('ffprobe exited with code 1: bad data'));
    });

    await expect(processor.process(job())).rejects.toThrow(/bad data/);
    expect(videos.update).not.toHaveBeenCalled();
  });

  it('removes the temporary directory on both the happy and the error path', async () => {
    await processor.process(job());
    expect(probedPath).toBeDefined();
    expect(existsSync(dirname(probedPath as string))).toBe(false);

    ffprobe.probe.mockImplementation((input: string) => {
      probedPath = input;
      return Promise.reject(new Error('boom'));
    });

    await expect(processor.process(job())).rejects.toThrow('boom');
    expect(existsSync(dirname(probedPath as string))).toBe(false);
  });

  it('leaves the record alone while attempts remain', async () => {
    const failing = {
      data: { videoId: VIDEO_ID },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as Job<VideoProcessJobData>;

    await processor.onFailed(failing, new Error('transient'));

    expect(videos.update).not.toHaveBeenCalled();
  });

  it('records the terminal failure once the attempts are exhausted', async () => {
    const exhausted = {
      data: { videoId: VIDEO_ID },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as Job<VideoProcessJobData>;

    await processor.onFailed(exhausted, new Error('ffprobe: bad data'));

    expect(videos.update).toHaveBeenCalledWith(VIDEO_ID, {
      processing_status: VideoProcessingStatus.FAILED,
      processing_error: 'ffprobe: bad data',
    });
  });
});
