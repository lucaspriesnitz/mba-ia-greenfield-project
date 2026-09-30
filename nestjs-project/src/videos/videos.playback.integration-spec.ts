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
import { originalKey, thumbnailKey } from '../storage/storage-keys';
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
const RANGE_BYTES = 1024;
const THUMBNAIL_BYTES = 512;
const DURATION_SECONDS = 42;

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
 * host instead is asserted end to end in `test/videos-playback-url.e2e-spec.ts`.
 */
describe('VideosService.getPlaybackUrl (integration)', () => {
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
  const objectBody = Buffer.alloc(OBJECT_BYTES, 0x7a);
  const thumbnailBody = Buffer.alloc(THUMBNAIL_BYTES, 0x5b);

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
      // Playback never enqueues anything; a live queue would only leak a Redis
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
        email: `playback_owner_${counter}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: `Channel ${counter}`,
        nickname: `playback-channel-${counter}-${Date.now()}`,
        user_id: owner.id,
      }),
    );
    user = { sub: owner.id, email: owner.email };
  });

  /**
   * A video in the terminal success state with a real object behind it, written
   * without running the worker: the endpoint only reads the row and the bucket.
   */
  async function seedReadyVideo(withThumbnail: boolean): Promise<Video> {
    const publicId = randomUUID().replace(/-/g, '').slice(0, 11);
    const key = originalKey(publicId, 'mp4');

    await storageService.putObject(key, objectBody, 'video/mp4');
    writtenKeys.push(key);

    let thumbKey: string | null = null;
    if (withThumbnail) {
      thumbKey = thumbnailKey(publicId);
      await storageService.putObject(thumbKey, thumbnailBody, 'image/jpeg');
      writtenKeys.push(thumbKey);
    }

    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'Ready clip',
        original_filename: 'ready clip.mp4',
        content_type: 'video/mp4',
        size_bytes: String(OBJECT_BYTES),
        storage_key: key,
        thumbnail_key: thumbKey,
        upload_id: null,
        duration_seconds: DURATION_SECONDS,
        processing_status: VideoProcessingStatus.READY,
      }),
    );
  }

  it('issues a URL the storage service answers with 206 to a ranged GET', async () => {
    const video = await seedReadyVideo(true);

    const issued = await service.getPlaybackUrl(user, video.public_id);
    expect(issued.durationSeconds).toBe(DURATION_SECONDS);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const ranged = await fetch(issued.url, {
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
    });

    // The bytes come from MinIO; this process only ever signed a string.
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-${RANGE_BYTES - 1}/${OBJECT_BYTES}`,
    );
    const received = Buffer.from(await ranged.arrayBuffer());
    expect(received.length).toBe(RANGE_BYTES);
    expect(received.equals(objectBody.subarray(0, RANGE_BYTES))).toBe(true);

    const whole = await fetch(issued.url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect((await whole.arrayBuffer()).byteLength).toBe(OBJECT_BYTES);
  }, 120000);

  it('serves the thumbnail it signed, and reports null while the worker has written none', async () => {
    const withThumb = await seedReadyVideo(true);
    const issued = await service.getPlaybackUrl(user, withThumb.public_id);

    expect(issued.thumbnailUrl).not.toBeNull();
    const thumb = await fetch(issued.thumbnailUrl as string);
    expect(thumb.status).toBe(200);
    expect((await thumb.arrayBuffer()).byteLength).toBe(THUMBNAIL_BYTES);

    const without = await seedReadyVideo(false);
    const bare = await service.getPlaybackUrl(user, without.public_id);
    expect(bare.thumbnailUrl).toBeNull();
  }, 120000);

  it('raises the view count by exactly one per issuance, on the row', async () => {
    const video = await seedReadyVideo(false);
    expect(video.view_count).toBe(0);

    await service.getPlaybackUrl(user, video.public_id);
    await service.getPlaybackUrl(user, video.public_id);
    await service.getPlaybackUrl(user, video.public_id);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    // Three issuances, three views — no URL was ever fetched in this scenario,
    // so the count is bound to the request, not to the byte transfer.
    expect(row.view_count).toBe(3);
  }, 120000);
});
