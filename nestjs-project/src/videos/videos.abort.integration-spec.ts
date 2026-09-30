import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import type { JwtPayload } from '../auth/auth.types';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoProcessJobData,
} from '../queue/video-processing.contract';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { partBody, putPresignedPart } from '../test/presigned-put';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoUploadNotInProgressException } from './exceptions/video.exceptions';
import { PublicIdService } from './public-id.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const PART_SIZE = 5 * 1024 * 1024;

describe('VideosService.abortUpload (integration)', () => {
  const storage = storageConfig();
  const queueSettings = queueConfig();
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let internal: S3Client;
  let queue: Queue<VideoProcessJobData>;
  let service: VideosService;
  let user: JwtPayload;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);

    const client = (endpoint: string) =>
      new S3Client({
        endpoint,
        region: storage.region,
        credentials: {
          accessKeyId: storage.accessKey,
          secretAccessKey: storage.secretKey,
        },
        forcePathStyle: true,
      });

    internal = client(storage.internalEndpoint);
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
      dataSource.getRepository(Channel),
      new PublicIdService(),
      new StorageService(internal, client(storage.publicEndpoint), storage),
      new VideoProcessingProducer(queue),
      { ...videoConfig(), uploadPartSizeBytes: PART_SIZE } as ConfigType<
        typeof videoConfig
      >,
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
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);

    counter += 1;
    const owner = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `abort_owner_${counter}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: `Channel ${counter}`,
        nickname: `abort-channel-${counter}-${Date.now()}`,
        user_id: owner.id,
      }),
    );
    user = { sub: owner.id, email: owner.email };
  });

  const dto = {
    title: 'Cancelled clip',
    filename: 'cancel.mp4',
    contentType: 'video/mp4',
    sizeBytes: PART_SIZE + 1024,
  };

  it('discards the draft and leaves no part or object under the prefix', async () => {
    const opened = await service.initiateUpload(user, dto);
    const key = `videos/${opened.publicId}/original.mp4`;

    // A real part is uploaded first, so there is residue to clean up.
    const uploaded = await putPresignedPart(
      opened.parts[0].url,
      partBody(PART_SIZE),
    );
    expect(uploaded.status).toBe(200);

    await service.abortUpload(user, opened.publicId);

    expect(
      await videoRepository.findOneBy({ public_id: opened.publicId }),
    ).toBeNull();

    const uploads = await internal.send(
      new ListMultipartUploadsCommand({
        Bucket: storage.bucket,
        Prefix: `videos/${opened.publicId}/`,
      }),
    );
    expect(uploads.Uploads ?? []).toEqual([]);

    const objects = await internal.send(
      new ListObjectsV2Command({
        Bucket: storage.bucket,
        Prefix: `videos/${opened.publicId}/`,
      }),
    );
    expect(objects.Contents ?? []).toEqual([]);
    expect(key).toContain(opened.publicId);
  }, 120000);

  it('refuses to abort a draft with no open upload', async () => {
    const opened = await service.initiateUpload(user, dto);
    await service.abortUpload(user, opened.publicId);

    await expect(
      service.abortUpload(user, opened.publicId),
    ).rejects.toBeDefined();

    // And an upload already cleared on a surviving row answers the domain code.
    const second = await service.initiateUpload(user, dto);
    await videoRepository.update(
      { public_id: second.publicId },
      { upload_id: null },
    );

    await expect(
      service.abortUpload(user, second.publicId),
    ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
  }, 120000);
});
