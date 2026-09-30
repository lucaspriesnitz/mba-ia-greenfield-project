import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { PUBLIC_ID_MAX_ATTEMPTS, PublicIdService } from './public-id.service';
import * as publicIdUtil from './public-id.util';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('PublicIdService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let service: PublicIdService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    service = new PublicIdService();
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `public_id_owner_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `public_id_channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  /** The write the caller owns — `allocate` only supplies the id. */
  function persistDraft(
    channelId: string,
    overrides: Partial<Video> = {},
  ): (publicId: string) => Promise<Video> {
    return (publicId) =>
      videoRepository.save(
        videoRepository.create({
          public_id: publicId,
          channel_id: channelId,
          title: 'A video',
          original_filename: 'clip.mp4',
          content_type: 'video/mp4',
          size_bytes: '1048576',
          storage_key: `videos/${publicId}/original.mp4`,
          ...overrides,
        }),
      );
  }

  it('absorbs a real unique-constraint collision and the second video is born with a distinct id', async () => {
    const channel = await createChannel();
    const taken = 'AAAAAAAAAAA';
    await persistDraft(channel.id)(taken);

    // Force the first draw to hit the id already in the table; later draws fall
    // back to the real generator.
    const generate = jest
      .spyOn(publicIdUtil, 'generatePublicId')
      .mockReturnValueOnce(taken);

    const second = await service.allocate(persistDraft(channel.id));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(second.public_id).not.toBe(taken);
    expect(second.public_id).toHaveLength(11);
    expect(await videoRepository.count()).toBe(2);
  }, 30000);

  it('leaves no half-written row behind after absorbing the collision', async () => {
    const channel = await createChannel();
    const taken = 'BBBBBBBBBBB';
    await persistDraft(channel.id)(taken);
    jest.spyOn(publicIdUtil, 'generatePublicId').mockReturnValueOnce(taken);

    const second = await service.allocate(persistDraft(channel.id));

    const rows = await videoRepository.find({ order: { created_at: 'ASC' } });
    expect(rows.map((row) => row.public_id).sort()).toEqual(
      [taken, second.public_id].sort(),
    );
  }, 30000);

  it('persists on the first attempt when the drawn id is free', async () => {
    const channel = await createChannel();
    const generate = jest.spyOn(publicIdUtil, 'generatePublicId');

    const video = await service.allocate(persistDraft(channel.id));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(video.id).toBeDefined();
    const reloaded = await videoRepository.findOneByOrFail({ id: video.id });
    expect(reloaded.public_id).toBe(video.public_id);
    expect(reloaded.public_id).toHaveLength(11);
  }, 30000);

  it('gives up against the real constraint once the attempt ceiling is exhausted', async () => {
    const channel = await createChannel();
    const taken = 'CCCCCCCCCCC';
    await persistDraft(channel.id)(taken);
    const generate = jest
      .spyOn(publicIdUtil, 'generatePublicId')
      .mockReturnValue(taken);

    await expect(
      service.allocate(persistDraft(channel.id)),
    ).rejects.toBeInstanceOf(QueryFailedError);

    expect(generate).toHaveBeenCalledTimes(PUBLIC_ID_MAX_ATTEMPTS);
    expect(await videoRepository.count()).toBe(1);
  }, 30000);

  it('propagates a foreign-key violation instead of retrying it as a collision', async () => {
    const generate = jest.spyOn(publicIdUtil, 'generatePublicId');

    await expect(
      service.allocate(persistDraft('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(QueryFailedError);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(await videoRepository.count()).toBe(0);
  }, 30000);
});
