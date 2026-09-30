import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoProcessingStatus, VideoPublicationStatus } from '../video.types';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
  });

  beforeEach(async () => {
    // Videos reference channels, so they go first or cleanAllTables trips the FK.
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    return {
      public_id: `pub${Date.now()}${counter}`.slice(0, 11),
      channel_id: channelId,
      title: 'A video',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: '1048576',
      storage_key: 'videos/pub00000000/original.mp4',
      ...overrides,
    };
  }

  it('should persist a video and generate id and timestamps', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'aaaaaaaaaaa' }),
      ),
    );

    expect(video.id).toBeDefined();
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should apply the three defaults without the insert supplying them', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'bbbbbbbbbbb' }),
      ),
    );
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.processing_status).toBe(
      VideoProcessingStatus.AWAITING_UPLOAD,
    );
    expect(reloaded.publication_status).toBe(VideoPublicationStatus.DRAFT);
    expect(reloaded.view_count).toBe(0);
  });

  it('should reject two videos sharing the same public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'ccccccccccc' }),
      ),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(
          buildVideo(channel.id, { public_id: 'ccccccccccc' }),
        ),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should surface the unique violation as PostgreSQL code 23505', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'ddddddddddd' }),
      ),
    );

    await expect(
      videoRepository.insert(
        videoRepository.create(
          buildVideo(channel.id, { public_id: 'ddddddddddd' }),
        ),
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('should reject a video whose channel_id does not exist', async () => {
    await expect(
      videoRepository.insert(
        videoRepository.create(
          buildVideo('00000000-0000-0000-0000-000000000000', {
            public_id: 'eeeeeeeeeee',
          }),
        ),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject a video with no channel_id at all', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id", "title", "original_filename", "content_type", "size_bytes", "storage_key")
         VALUES ('fffffffffff', 't', 'f.mp4', 'video/mp4', 1, 'k')`,
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should round-trip a jsonb metadata object', async () => {
    const channel = await createChannel();
    const metadata = {
      format: { duration: '12.5', bit_rate: '800000' },
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
    };

    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'ggggggggggg', metadata }),
      ),
    );
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.metadata).toEqual(metadata);
  });

  it('should keep nullable columns null until the worker fills them', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'hhhhhhhhhhh' }),
      ),
    );
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.thumbnail_key).toBeNull();
    expect(reloaded.upload_id).toBeNull();
    expect(reloaded.duration_seconds).toBeNull();
    expect(reloaded.metadata).toBeNull();
    expect(reloaded.processing_error).toBeNull();
    expect(reloaded.description).toBeNull();
  });

  it('should carry a 10GB size_bytes through bigint without precision loss', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, {
          public_id: 'iiiiiiiiiii',
          size_bytes: '10737418240',
        }),
      ),
    );
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.size_bytes).toBe('10737418240');
  });

  it('should move the two status axes independently', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'jjjjjjjjjjj' }),
      ),
    );

    await videoRepository.update(saved.id, {
      processing_status: VideoProcessingStatus.READY,
    });
    const afterProcessing = await videoRepository.findOneByOrFail({
      id: saved.id,
    });

    expect(afterProcessing.processing_status).toBe(VideoProcessingStatus.READY);
    expect(afterProcessing.publication_status).toBe(
      VideoPublicationStatus.DRAFT,
    );
  });

  it('should load the owning channel through the many-to-one relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'kkkkkkkkkkk' }),
      ),
    );

    const withChannel = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });

    expect(withChannel.channel.id).toBe(channel.id);
  });
});
