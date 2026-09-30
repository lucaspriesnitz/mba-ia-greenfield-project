import { BadRequestException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import type { JwtPayload } from '../auth/auth.types';
import { Channel } from '../channels/entities/channel.entity';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import {
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoProcessingFailedException,
  VideoUploadNotInProgressException,
  VideoUploadTooLargeException,
} from './exceptions/video.exceptions';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { PublicIdService } from './public-id.service';
import { VideoProcessingStatus, VideoPublicationStatus } from './video.types';
import { fileExtension, VideosService } from './videos.service';

const USER: JwtPayload = { sub: 'user-1', email: 'owner@example.com' };
const CHANNEL = { id: 'channel-1', user_id: 'user-1' } as Channel;

const PART_SIZE = 5 * 1024 * 1024;
const CONFIG = {
  maxUploadBytes: 100 * 1024 * 1024,
  uploadPartSizeBytes: PART_SIZE,
  thumbnailOffsetSeconds: 3,
  acceptedMimeTypes: ['video/mp4', 'video/webm'],
} as ConfigType<typeof videoConfig>;

/** Three parts: `size_bytes` is a string, as the pg driver returns bigint. */
function storedVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'abcdefghijk',
    storage_key: 'videos/abcdefghijk/original.mp4',
    upload_id: 'upload-abc',
    size_bytes: String(PART_SIZE * 2 + 1),
    channel: { id: CHANNEL.id, user_id: USER.sub } as Channel,
    ...overrides,
  } as Video;
}

function validDto(overrides: Partial<InitiateUploadDto> = {}) {
  return {
    title: 'A title',
    filename: 'holiday.MP4',
    contentType: 'video/mp4',
    sizeBytes: PART_SIZE * 2 + 1,
    ...overrides,
  } as InitiateUploadDto;
}

describe('VideosService', () => {
  // The doubles are held as standalone mocks rather than read back off the
  // objects, so assertions never reference an unbound method.
  let saveVideo: jest.Mock;
  let findVideo: jest.Mock;
  let findChannel: jest.Mock;
  let removeVideo: jest.Mock;
  let createMultipartUpload: jest.Mock;
  let signUploadParts: jest.Mock;
  let completeMultipartUpload: jest.Mock;
  let abortMultipartUpload: jest.Mock;
  let deleteObject: jest.Mock;
  let headObject: jest.Mock;
  let signDownloadUrl: jest.Mock;
  let incrementVideo: jest.Mock;
  let enqueue: jest.Mock;
  let service: VideosService;

  beforeEach(() => {
    // `create` is a pure factory in TypeORM; echoing the input keeps the saved
    // shape observable without pulling in the real repository.
    saveVideo = jest.fn((entity: Video) => Promise.resolve(entity));
    findVideo = jest.fn().mockResolvedValue(null);
    findChannel = jest.fn().mockResolvedValue(CHANNEL);
    createMultipartUpload = jest.fn().mockResolvedValue('upload-abc');
    signUploadParts = jest.fn((_key: string, _id: string, numbers: number[]) =>
      Promise.resolve(
        numbers.map((partNumber) => ({
          partNumber,
          url: `https://storage.example/part/${partNumber}`,
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        })),
      ),
    );

    removeVideo = jest.fn((entity: Video) => Promise.resolve(entity));
    completeMultipartUpload = jest.fn().mockResolvedValue(undefined);
    abortMultipartUpload = jest.fn().mockResolvedValue(undefined);
    deleteObject = jest.fn().mockResolvedValue(undefined);
    headObject = jest
      .fn()
      .mockResolvedValue({ contentLength: 1024, contentType: 'video/mp4' });
    signDownloadUrl = jest.fn((key: string) =>
      Promise.resolve({
        url: `https://storage.example/${key}?signed=1`,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
    );
    incrementVideo = jest.fn().mockResolvedValue({ affected: 1 });
    enqueue = jest.fn().mockResolvedValue(undefined);

    const videoRepository = {
      create: (input: Partial<Video>) => input as Video,
      save: saveVideo,
      findOne: findVideo,
      remove: removeVideo,
      increment: incrementVideo,
    } as unknown as Repository<Video>;
    const channelRepository = {
      findOne: findChannel,
    } as unknown as Repository<Channel>;
    const storageService = {
      createMultipartUpload,
      signUploadParts,
      completeMultipartUpload,
      abortMultipartUpload,
      deleteObject,
      headObject,
      signDownloadUrl,
    } as unknown as StorageService;
    const producer = { enqueue } as unknown as VideoProcessingProducer;

    service = new VideosService(
      videoRepository,
      channelRepository,
      new PublicIdService(),
      storageService,
      producer,
      CONFIG,
    );
  });

  describe('fileExtension', () => {
    it.each([
      ['holiday.MP4', 'mp4'],
      ['a.tar.gz', 'gz'],
      ['noextension', null],
      ['.env', null],
      ['trailing.', null],
    ])('derives %s → %s', (filename, expected) => {
      expect(fileExtension(filename)).toBe(expected);
    });
  });

  describe('initiateUpload', () => {
    it('rejects a content type outside the accepted list before any write', async () => {
      await expect(
        service.initiateUpload(
          USER,
          validDto({ contentType: 'application/pdf' }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);

      expect(createMultipartUpload).not.toHaveBeenCalled();
      expect(saveVideo).not.toHaveBeenCalled();
    });

    it('rejects a declared size above the ceiling before any write', async () => {
      await expect(
        service.initiateUpload(
          USER,
          validDto({ sizeBytes: CONFIG.maxUploadBytes + 1 }),
        ),
      ).rejects.toBeInstanceOf(VideoUploadTooLargeException);

      expect(createMultipartUpload).not.toHaveBeenCalled();
      expect(saveVideo).not.toHaveBeenCalled();
    });

    it('accepts a size exactly at the ceiling', async () => {
      await expect(
        service.initiateUpload(
          USER,
          validDto({ sizeBytes: CONFIG.maxUploadBytes }),
        ),
      ).resolves.toBeDefined();
    });

    it('computes partCount as ceil(sizeBytes / partSizeBytes) and signs every part', async () => {
      const result = await service.initiateUpload(USER, validDto());

      expect(result.partSizeBytes).toBe(PART_SIZE);
      expect(result.partCount).toBe(3);
      expect(result.parts).toHaveLength(3);
      expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(result.parts[0].expiresAt).toBe('2030-01-01T00:00:00.000Z');
    });

    it('derives the storage key from the public id and the lowercased extension', async () => {
      const result = await service.initiateUpload(USER, validDto());

      const [key, contentType] = createMultipartUpload.mock.calls[0] as [
        string,
        string,
      ];
      expect(key).toBe(`videos/${result.publicId}/original.mp4`);
      expect(contentType).toBe('video/mp4');
    });

    it('persists the draft as uploading, draft and with the upload id filled', async () => {
      await service.initiateUpload(USER, validDto());

      const [saved] = saveVideo.mock.calls[0] as [Video];
      expect(saved.processing_status).toBe(VideoProcessingStatus.UPLOADING);
      expect(saved.publication_status).toBe(VideoPublicationStatus.DRAFT);
      expect(saved.upload_id).toBe('upload-abc');
      expect(saved.channel_id).toBe(CHANNEL.id);
      // bigint round-trips as a string through the pg driver, so the column is
      // written as one too.
      expect(saved.size_bytes).toBe(String(PART_SIZE * 2 + 1));
    });

    it('resolves the channel of the authenticated caller, never another one', async () => {
      await service.initiateUpload(USER, validDto());

      expect(findChannel).toHaveBeenCalledWith({
        where: { user_id: USER.sub },
      });
    });
  });

  describe('signUploadParts', () => {
    it('raises VideoNotFound when no video carries that public id', async () => {
      findVideo.mockResolvedValue(null);

      await expect(
        service.signUploadParts(USER, 'missing', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('raises VideoNotFound — not a 403 — when the video belongs to someone else', async () => {
      findVideo.mockResolvedValue(
        storedVideo({ channel: { id: 'other', user_id: 'user-2' } as Channel }),
      );

      await expect(
        service.signUploadParts(USER, 'abcdefghijk', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(signUploadParts).not.toHaveBeenCalled();
    });

    it('raises VideoUploadNotInProgress when the upload id is already cleared', async () => {
      findVideo.mockResolvedValue(storedVideo({ upload_id: null }));

      await expect(
        service.signUploadParts(USER, 'abcdefghijk', [1]),
      ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
      expect(signUploadParts).not.toHaveBeenCalled();
    });

    it('rejects a part number above the partCount derived from size_bytes', async () => {
      findVideo.mockResolvedValue(storedVideo());

      // ceil((2 * PART_SIZE + 1) / PART_SIZE) === 3
      await expect(
        service.signUploadParts(USER, 'abcdefghijk', [1, 4]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(signUploadParts).not.toHaveBeenCalled();
    });

    it('accepts the last part number in range', async () => {
      findVideo.mockResolvedValue(storedVideo());

      await expect(
        service.signUploadParts(USER, 'abcdefghijk', [3]),
      ).resolves.toHaveLength(1);
    });

    it('preserves the requested order and signs against the stored key', async () => {
      findVideo.mockResolvedValue(storedVideo());

      const parts = await service.signUploadParts(USER, 'abcdefghijk', [3, 1]);

      expect(parts.map((part) => part.partNumber)).toEqual([3, 1]);
      expect(parts[0].expiresAt).toBe('2030-01-01T00:00:00.000Z');
      expect(signUploadParts).toHaveBeenCalledWith(
        'videos/abcdefghijk/original.mp4',
        'upload-abc',
        [3, 1],
      );
    });
  });
  describe('completeUpload', () => {
    const parts = [
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 3, etag: 'etag-3' },
    ];

    it('raises VideoUploadNotInProgress when the upload id is already cleared', async () => {
      findVideo.mockResolvedValue(storedVideo({ upload_id: null }));

      await expect(
        service.completeUpload(USER, 'abcdefghijk', { parts }),
      ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
      expect(completeMultipartUpload).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('raises VideoNotFound for a video owned by someone else', async () => {
      findVideo.mockResolvedValue(
        storedVideo({ channel: { id: 'other', user_id: 'user-2' } as Channel }),
      );

      await expect(
        service.completeUpload(USER, 'abcdefghijk', { parts }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('discards the object and the draft, and does not enqueue, when the assembled object is over the ceiling', async () => {
      findVideo.mockResolvedValue(storedVideo());
      headObject.mockResolvedValue({
        contentLength: CONFIG.maxUploadBytes + 1,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload(USER, 'abcdefghijk', { parts }),
      ).rejects.toBeInstanceOf(VideoUploadTooLargeException);

      expect(deleteObject).toHaveBeenCalledWith(
        'videos/abcdefghijk/original.mp4',
      );
      expect(removeVideo).toHaveBeenCalledTimes(1);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('clears the upload id, moves to processing and enqueues exactly once', async () => {
      const video = storedVideo();
      findVideo.mockResolvedValue(video);

      const result = await service.completeUpload(USER, 'abcdefghijk', {
        parts,
      });

      expect(result).toEqual({
        publicId: 'abcdefghijk',
        processingStatus: VideoProcessingStatus.PROCESSING,
      });
      expect(video.upload_id).toBeNull();
      expect(video.processing_status).toBe(VideoProcessingStatus.PROCESSING);
      expect(enqueue).toHaveBeenCalledTimes(1);
      // The thin payload is the internal id, never the public one.
      expect(enqueue).toHaveBeenCalledWith('video-1');
    });

    it('enqueues only after storage confirmed the assembled object', async () => {
      findVideo.mockResolvedValue(storedVideo());
      const order: string[] = [];
      completeMultipartUpload.mockImplementation(() => {
        order.push('complete');
        return Promise.resolve();
      });
      headObject.mockImplementation(() => {
        order.push('head');
        return Promise.resolve({
          contentLength: 1024,
          contentType: 'video/mp4',
        });
      });
      enqueue.mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve();
      });

      await service.completeUpload(USER, 'abcdefghijk', { parts });

      expect(order).toEqual(['complete', 'head', 'enqueue']);
    });
  });

  describe('abortUpload', () => {
    it('raises VideoUploadNotInProgress when there is no open upload', async () => {
      findVideo.mockResolvedValue(storedVideo({ upload_id: null }));

      await expect(
        service.abortUpload(USER, 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
      expect(abortMultipartUpload).not.toHaveBeenCalled();
      expect(removeVideo).not.toHaveBeenCalled();
    });

    it('aborts at storage and removes the draft row', async () => {
      findVideo.mockResolvedValue(storedVideo());

      await service.abortUpload(USER, 'abcdefghijk');

      expect(abortMultipartUpload).toHaveBeenCalledWith(
        'videos/abcdefghijk/original.mp4',
        'upload-abc',
      );
      expect(removeVideo).toHaveBeenCalledTimes(1);
    });
  });
  describe('getPlaybackUrl', () => {
    function readyVideo(overrides: Partial<Video> = {}): Video {
      return storedVideo({
        upload_id: null,
        processing_status: VideoProcessingStatus.READY,
        publication_status: VideoPublicationStatus.DRAFT,
        duration_seconds: 42,
        thumbnail_key: 'videos/abcdefghijk/thumbnail.jpg',
        ...overrides,
      });
    }

    it('signs the object and the thumbnail and reports the duration', async () => {
      findVideo.mockResolvedValue(readyVideo());

      const result = await service.getPlaybackUrl(USER, 'abcdefghijk');

      expect(result.url).toContain('videos/abcdefghijk/original.mp4');
      expect(result.thumbnailUrl).toContain('videos/abcdefghijk/thumbnail.jpg');
      expect(result.durationSeconds).toBe(42);
      expect(result.expiresAt).toBe('2030-01-01T00:00:00.000Z');
      // No disposition override on playback — that is what download adds.
      expect(signDownloadUrl).toHaveBeenNthCalledWith(
        1,
        'videos/abcdefghijk/original.mp4',
      );
    });

    it('reports a null thumbnail while the worker has not written one', async () => {
      findVideo.mockResolvedValue(readyVideo({ thumbnail_key: null }));

      const result = await service.getPlaybackUrl(USER, 'abcdefghijk');

      expect(result.thumbnailUrl).toBeNull();
      expect(signDownloadUrl).toHaveBeenCalledTimes(1);
    });

    it('increments the view count once per issuance, atomically', async () => {
      findVideo.mockResolvedValue(readyVideo());

      await service.getPlaybackUrl(USER, 'abcdefghijk');

      expect(incrementVideo).toHaveBeenCalledTimes(1);
      expect(incrementVideo).toHaveBeenCalledWith(
        { id: 'video-1' },
        'view_count',
        1,
      );
    });

    it.each([
      VideoProcessingStatus.AWAITING_UPLOAD,
      VideoProcessingStatus.UPLOADING,
      VideoProcessingStatus.PROCESSING,
    ])('answers VIDEO_NOT_READY while %s', async (status) => {
      findVideo.mockResolvedValue(readyVideo({ processing_status: status }));

      await expect(
        service.getPlaybackUrl(USER, 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(incrementVideo).not.toHaveBeenCalled();
    });

    it('answers VIDEO_PROCESSING_FAILED on the terminal state', async () => {
      findVideo.mockResolvedValue(
        readyVideo({ processing_status: VideoProcessingStatus.FAILED }),
      );

      await expect(
        service.getPlaybackUrl(USER, 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoProcessingFailedException);
      expect(incrementVideo).not.toHaveBeenCalled();
    });

    it('hides a draft owned by somebody else behind VIDEO_NOT_FOUND', async () => {
      findVideo.mockResolvedValue(
        readyVideo({
          channel: { id: 'channel-2', user_id: 'someone-else' } as Channel,
        }),
      );

      await expect(
        service.getPlaybackUrl(USER, 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(signDownloadUrl).not.toHaveBeenCalled();
      expect(incrementVideo).not.toHaveBeenCalled();
    });

    it('lets any authenticated caller reach a published video', async () => {
      findVideo.mockResolvedValue(
        readyVideo({
          publication_status: VideoPublicationStatus.PUBLISHED,
          channel: { id: 'channel-2', user_id: 'someone-else' } as Channel,
        }),
      );

      await expect(
        service.getPlaybackUrl(USER, 'abcdefghijk'),
      ).resolves.toMatchObject({ durationSeconds: 42 });
    });

    it('answers VIDEO_NOT_FOUND for an identifier that never existed', async () => {
      findVideo.mockResolvedValue(null);

      await expect(
        service.getPlaybackUrl(USER, 'nonexistent'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getDownloadUrl', () => {
    function readyVideo(overrides: Partial<Video> = {}): Video {
      return storedVideo({
        upload_id: null,
        processing_status: VideoProcessingStatus.READY,
        publication_status: VideoPublicationStatus.DRAFT,
        original_filename: 'Ferias 2026.mp4',
        ...overrides,
      });
    }

    it('signs with the attachment override carrying the original filename', async () => {
      findVideo.mockResolvedValue(readyVideo());

      const result = await service.getDownloadUrl(USER, 'abcdefghijk');

      expect(signDownloadUrl).toHaveBeenCalledWith(
        'videos/abcdefghijk/original.mp4',
        { attachmentFilename: 'Ferias 2026.mp4' },
      );
      expect(result.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    });

    it('does not count a download as a view', async () => {
      findVideo.mockResolvedValue(readyVideo());

      await service.getDownloadUrl(USER, 'abcdefghijk');

      expect(incrementVideo).not.toHaveBeenCalled();
    });

    it('applies the same state guards as playback', async () => {
      findVideo.mockResolvedValue(
        readyVideo({ processing_status: VideoProcessingStatus.PROCESSING }),
      );
      await expect(
        service.getDownloadUrl(USER, 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);

      findVideo.mockResolvedValue(
        readyVideo({ processing_status: VideoProcessingStatus.FAILED }),
      );
      await expect(
        service.getDownloadUrl(USER, 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoProcessingFailedException);
    });

    it('applies the same ownership guard as playback', async () => {
      findVideo.mockResolvedValue(
        readyVideo({
          channel: { id: 'channel-2', user_id: 'someone-else' } as Channel,
        }),
      );

      await expect(
        service.getDownloadUrl(USER, 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(signDownloadUrl).not.toHaveBeenCalled();
    });
  });
});
