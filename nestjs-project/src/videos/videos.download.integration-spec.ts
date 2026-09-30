import { randomUUID } from 'node:crypto';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import type { JwtPayload } from '../auth/auth.types';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { VideoProcessJobData } from '../queue/video-processing.contract';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { originalKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { PublicIdService } from './public-id.service';
import { VideoProcessingStatus } from './video.types';
import { VideosService } from './videos.service';

type StorageConfig = ConfigType<typeof storageConfig>;

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const OBJECT_BYTES = 4096;
const ASCII_FILENAME = 'ferias-2026.mp4';
const ACCENTED_FILENAME = 'Férias "2026".mp4';

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

/**
 * Signing is pointed at the internal endpoint so the issued URL is fetchable
 * from inside the API container — the public endpoint is the browser's view and
 * does not resolve here. That the shipped configuration signs with the public
 * host instead is asserted end to end in `test/videos-download-url.e2e-spec.ts`.
 */
describe('VideosService.getDownloadUrl (integration)', () => {
  const base = storageConfig();
  const storage: StorageConfig = {
    ...base,
    publicEndpoint: base.internalEndpoint,
  };

  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let internal: S3Client;
  let signing: S3Client;
  let storageService: StorageService;
  let service: VideosService;
  let user: JwtPayload;
  let channel: Channel;

  const writtenKeys: string[] = [];
  const objectBody = Buffer.alloc(OBJECT_BYTES, 0x3c);

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);

    internal = buildClient(storage, storage.internalEndpoint);
    signing = buildClient(storage, storage.publicEndpoint);
    storageService = new StorageService(internal, signing, storage);

    service = new VideosService(
      videoRepository,
      dataSource.getRepository(Channel),
      new PublicIdService(),
      storageService,
      // Download never enqueues anything; a live queue would only leak a Redis
      // connection into a suite that has no job to publish.
      new VideoProcessingProducer(
        undefined as unknown as Queue<VideoProcessJobData>,
      ),
      videoConfig(),
    );
  }, 60000);

  afterAll(async () => {
    if (writtenKeys.length > 0) {
      await internal.send(
        new DeleteObjectsCommand({
          Bucket: storage.bucket,
          Delete: { Objects: writtenKeys.map((Key) => ({ Key })) },
        }),
      );
    }
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
    internal.destroy();
    signing.destroy();
  });

  let counter = 0;
  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);

    counter += 1;
    const owner = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `download_owner_${counter}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: `Channel ${counter}`,
        nickname: `download-channel-${counter}-${Date.now()}`,
        user_id: owner.id,
      }),
    );
    user = { sub: owner.id, email: owner.email };
  });

  async function seedReadyVideo(
    originalFilename = ASCII_FILENAME,
  ): Promise<Video> {
    const publicId = randomUUID().replace(/-/g, '').slice(0, 11);
    const key = originalKey(publicId, 'mp4');

    await storageService.putObject(key, objectBody, 'video/mp4');
    writtenKeys.push(key);

    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'Downloadable clip',
        original_filename: originalFilename,
        content_type: 'video/mp4',
        size_bytes: String(OBJECT_BYTES),
        storage_key: key,
        thumbnail_key: null,
        upload_id: null,
        duration_seconds: 42,
        processing_status: VideoProcessingStatus.READY,
      }),
    );
  }

  it('issues a URL storage serves as an attachment under the original filename', async () => {
    const video = await seedReadyVideo();

    const issued = await service.getDownloadUrl(user, video.public_id);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const response = await fetch(issued.url);

    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(`filename="${ASCII_FILENAME}"`);

    const downloaded = Buffer.from(await response.arrayBuffer());
    expect(downloaded.equals(objectBody)).toBe(true);
    expect(response.headers.get('content-length')).toBe(String(OBJECT_BYTES));
  }, 120000);

  it('carries a name outside ASCII in the RFC 5987 form, which is the lossless one', async () => {
    const video = await seedReadyVideo(ACCENTED_FILENAME);

    const issued = await service.getDownloadUrl(user, video.public_id);
    const disposition =
      (await fetch(issued.url)).headers.get('content-disposition') ?? '';

    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    // The quoted form is deliberately not compared byte for byte: HTTP headers
    // are latin-1 on the wire, so an accented name survives the trip only in
    // the extended form beside it — which is exactly why it is emitted.
    const extended = disposition.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(extended)).toBe(ACCENTED_FILENAME);
  }, 120000);

  it('leaves the view count untouched — a download is not a view', async () => {
    const video = await seedReadyVideo();
    expect(video.view_count).toBe(0);

    const issued = await service.getDownloadUrl(user, video.public_id);
    await service.getDownloadUrl(user, video.public_id);
    await service.getDownloadUrl(user, video.public_id);

    // Even fetching the object through the issued URL moves nothing: the count
    // is the playback endpoint's business alone.
    expect((await fetch(issued.url)).status).toBe(200);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.view_count).toBe(0);
  }, 120000);
});
