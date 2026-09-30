import {
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import type { JwtPayload } from '../auth/auth.types';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from '../queue/video-processing.contract';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { partBody, putPresignedPart } from '../test/presigned-put';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { PublicIdService } from './public-id.service';
import {
  VideoUploadNotInProgressException,
  VideoUploadTooLargeException,
} from './exceptions/video.exceptions';
import { VideoProcessingStatus, VideoPublicationStatus } from './video.types';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

type StorageConfig = ConfigType<typeof storageConfig>;

/** Small parts keep the suite fast; nothing here completes a multipart. */
const PART_SIZE = 5 * 1024 * 1024;

const VIDEO_CONFIG = {
  ...videoConfig(),
  uploadPartSizeBytes: PART_SIZE,
} as ConfigType<typeof videoConfig>;

function buildClient(config: StorageConfig, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
}

describe('VideosService upload protocol (integration)', () => {
  const storage = storageConfig();
  const queueSettings = queueConfig();
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let internal: S3Client;
  let queue: Queue<VideoProcessJobData>;
  let service: VideosService;
  let user: JwtPayload;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    internal = buildClient(storage, storage.internalEndpoint);
    const storageService = new StorageService(
      internal,
      buildClient(storage, storage.publicEndpoint),
      storage,
    );

    queue = new Queue<VideoProcessJobData>(VIDEO_PROCESSING_QUEUE, {
      connection: {
        host: queueSettings.redisHost,
        port: queueSettings.redisPort,
      },
      // The suite's own Redis namespace, so the `video-worker` running in
      // Compose cannot consume the job these assertions are about.
      prefix: queueSettings.keyPrefix,
    });

    service = new VideosService(
      videoRepository,
      channelRepository,
      new PublicIdService(),
      storageService,
      new VideoProcessingProducer(queue),
      VIDEO_CONFIG,
    );
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
    await queue.obliterate({ force: true });
    await queue.close();
    internal.destroy();
  });

  let counter = 0;
  beforeEach(async () => {
    await queue.obliterate({ force: true });
    // Videos reference channels, so they go first or cleanAllTables trips the FK.
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);

    counter += 1;
    const owner = await userRepository.save(
      userRepository.create({
        email: `initiate_owner_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `channel-${counter}-${Date.now()}`,
        user_id: owner.id,
      }),
    );
    user = { sub: owner.id, email: owner.email };
  });

  const dto = {
    title: 'A holiday clip',
    filename: 'holiday.MP4',
    contentType: 'video/mp4',
    sizeBytes: PART_SIZE * 2 + 1024,
  };

  it('persists the draft as uploading with an open upload id and a unique public id', async () => {
    const result = await service.initiateUpload(user, dto);

    const row = await videoRepository.findOneByOrFail({
      public_id: result.publicId,
    });
    expect(row.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(row.publication_status).toBe(VideoPublicationStatus.DRAFT);
    expect(row.upload_id).toBe(result.uploadId);
    expect(row.upload_id).not.toBeNull();
    expect(row.channel_id).toBe(channel.id);
    expect(row.storage_key).toBe(`videos/${result.publicId}/original.mp4`);
    // bigint comes back from the pg driver as a string.
    expect(Number(row.size_bytes)).toBe(dto.sizeBytes);
  });

  it('opens a real multipart upload at storage that lists its own parts', async () => {
    const result = await service.initiateUpload(user, dto);

    // ListParts only answers for an upload id that actually exists — an empty
    // Parts array is the proof the multipart is open, not that it is missing.
    const listed = await internal.send(
      new ListPartsCommand({
        Bucket: storage.bucket,
        Key: `videos/${result.publicId}/original.mp4`,
        UploadId: result.uploadId,
      }),
    );
    expect(listed.Parts ?? []).toEqual([]);

    // Leave no open multipart behind for the bucket-wide assertions of SI-03.9.
    await internal.send(
      new AbortMultipartUploadCommand({
        Bucket: storage.bucket,
        Key: `videos/${result.publicId}/original.mp4`,
        UploadId: result.uploadId,
      }),
    );
  });

  it('signs one URL per part, numbered from 1', async () => {
    const result = await service.initiateUpload(user, dto);

    expect(result.partCount).toBe(3);
    expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    result.parts.forEach((part) => {
      expect(new URL(part.url).host).toBe(new URL(storage.publicEndpoint).host);
      expect(new Date(part.expiresAt).toISOString()).toBe(part.expiresAt);
    });
  });

  it('gives two consecutive uploads by the same user distinct public ids', async () => {
    const first = await service.initiateUpload(user, dto);
    const second = await service.initiateUpload(user, dto);

    expect(first.publicId).not.toBe(second.publicId);
    expect(await videoRepository.count()).toBe(2);
  });

  describe('signUploadParts', () => {
    it('re-signs a part whose PUT replaces the part of the same number', async () => {
      const opened = await service.initiateUpload(user, dto);
      const key = `videos/${opened.publicId}/original.mp4`;

      // First pass with the URL from the initial batch.
      const first = await putPresignedPart(
        opened.parts[0].url,
        partBody(PART_SIZE, 0x61),
      );
      expect(first.status).toBe(200);

      // Resume: a fresh URL for the same part number, with different content.
      const resigned = await service.signUploadParts(
        user,
        opened.publicId,
        [1],
      );
      expect(resigned).toHaveLength(1);
      expect(resigned[0].partNumber).toBe(1);

      const second = await putPresignedPart(
        resigned[0].url,
        partBody(PART_SIZE, 0x62),
      );
      expect(second.status).toBe(200);
      expect(second.etag).not.toBe(first.etag);

      // Storage keeps one entry for part 1 — the re-upload replaced it rather
      // than appending a second copy.
      const listed = await internal.send(
        new ListPartsCommand({
          Bucket: storage.bucket,
          Key: key,
          UploadId: opened.uploadId,
        }),
      );
      const partOne = (listed.Parts ?? []).filter(
        (part) => part.PartNumber === 1,
      );
      expect(partOne).toHaveLength(1);
      expect(partOne[0].ETag?.replace(/"/g, '')).toBe(second.etag);

      await internal.send(
        new AbortMultipartUploadCommand({
          Bucket: storage.bucket,
          Key: key,
          UploadId: opened.uploadId,
        }),
      );
    }, 60000);

    it('signs the requested numbers in the requested order', async () => {
      const opened = await service.initiateUpload(user, dto);

      const parts = await service.signUploadParts(
        user,
        opened.publicId,
        [3, 1],
      );

      expect(parts.map((part) => part.partNumber)).toEqual([3, 1]);
      parts.forEach((part) => {
        expect(new URL(part.url).host).toBe(
          new URL(storage.publicEndpoint).host,
        );
      });

      await internal.send(
        new AbortMultipartUploadCommand({
          Bucket: storage.bucket,
          Key: `videos/${opened.publicId}/original.mp4`,
          UploadId: opened.uploadId,
        }),
      );
    }, 60000);
  });
  describe('completeUpload', () => {
    async function uploadAllParts(opened: {
      publicId: string;
      parts: { url: string }[];
    }): Promise<{
      parts: { partNumber: number; etag: string }[];
      total: number;
    }> {
      const head = await putPresignedPart(
        opened.parts[0].url,
        partBody(PART_SIZE),
      );
      const middle = await putPresignedPart(
        opened.parts[1].url,
        partBody(PART_SIZE),
      );
      const tail = await putPresignedPart(opened.parts[2].url, partBody(1024));
      expect([head.status, middle.status, tail.status]).toEqual([
        200, 200, 200,
      ]);

      return {
        parts: [
          { partNumber: 1, etag: head.etag },
          { partNumber: 2, etag: middle.etag },
          { partNumber: 3, etag: tail.etag },
        ],
        total: head.size + middle.size + tail.size,
      };
    }

    it('assembles the object, clears the upload id, moves to processing and enqueues one thin job', async () => {
      const opened = await service.initiateUpload(user, dto);
      const uploaded = await uploadAllParts(opened);

      const result = await service.completeUpload(user, opened.publicId, {
        parts: uploaded.parts,
      });

      expect(result.processingStatus).toBe(VideoProcessingStatus.PROCESSING);

      const row = await videoRepository.findOneByOrFail({
        public_id: opened.publicId,
      });
      expect(row.upload_id).toBeNull();
      expect(row.processing_status).toBe(VideoProcessingStatus.PROCESSING);

      const head = await internal.send(
        new HeadObjectCommand({
          Bucket: storage.bucket,
          Key: `videos/${opened.publicId}/original.mp4`,
        }),
      );
      expect(head.ContentLength).toBe(uploaded.total);

      const waiting = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(waiting).toHaveLength(1);
      // The payload is the internal uuid and nothing else.
      expect(waiting[0].data).toEqual({ videoId: row.id });
    }, 120000);

    it('deletes the object and the draft, and enqueues nothing, when the assembled object breaches the ceiling', async () => {
      const opened = await service.initiateUpload(user, dto);
      const uploaded = await uploadAllParts(opened);

      // The ceiling is the only thing lowered; the bytes are real.
      const tightService = new VideosService(
        videoRepository,
        channelRepository,
        new PublicIdService(),
        new StorageService(
          internal,
          buildClient(storage, storage.publicEndpoint),
          storage,
        ),
        new VideoProcessingProducer(queue),
        { ...VIDEO_CONFIG, maxUploadBytes: 1024 } as ConfigType<
          typeof videoConfig
        >,
      );

      await expect(
        tightService.completeUpload(user, opened.publicId, {
          parts: uploaded.parts,
        }),
      ).rejects.toBeInstanceOf(VideoUploadTooLargeException);

      await expect(
        internal.send(
          new HeadObjectCommand({
            Bucket: storage.bucket,
            Key: `videos/${opened.publicId}/original.mp4`,
          }),
        ),
      ).rejects.toBeDefined();

      expect(
        await videoRepository.findOneBy({ public_id: opened.publicId }),
      ).toBeNull();
      expect(
        await queue.getJobs(['waiting', 'delayed', 'active']),
      ).toHaveLength(0);
    }, 120000);

    it('answers the second completion with VideoUploadNotInProgress and enqueues no second job', async () => {
      const opened = await service.initiateUpload(user, dto);
      const uploaded = await uploadAllParts(opened);

      await service.completeUpload(user, opened.publicId, {
        parts: uploaded.parts,
      });

      await expect(
        service.completeUpload(user, opened.publicId, {
          parts: uploaded.parts,
        }),
      ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);

      expect(
        await queue.getJobs(['waiting', 'delayed', 'active']),
      ).toHaveLength(1);
    }, 120000);
  });
});
