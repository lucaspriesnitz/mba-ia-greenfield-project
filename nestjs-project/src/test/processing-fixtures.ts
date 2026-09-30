import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingStatus } from '../videos/video.types';

/**
 * Shared setup for the three `VideoProcessingProcessor` integration suites:
 * each of them needs an owning channel, a `processing` row, and a real object
 * under the row's `storage_key`.
 */
export interface ProcessingRepos {
  users: Repository<User>;
  channels: Repository<Channel>;
  videos: Repository<Video>;
}

export interface SeedOptions {
  publicId: string;
  storageKey: string;
  sizeBytes: number;
  originalFilename?: string;
  contentType?: string;
}

export async function seedProcessingVideo(
  repos: ProcessingRepos,
  options: SeedOptions,
): Promise<Video> {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  const owner = await repos.users.save(
    repos.users.create({
      email: `processing_${stamp}@example.com`,
      password: 'hashed',
    }),
  );
  const channel = await repos.channels.save(
    repos.channels.create({
      name: `Processing ${stamp}`,
      nickname: `processing-${stamp}`,
      user_id: owner.id,
    }),
  );

  return repos.videos.save(
    repos.videos.create({
      public_id: options.publicId,
      channel_id: channel.id,
      title: 'Processing fixture',
      original_filename: options.originalFilename ?? 'fixture.mp4',
      content_type: options.contentType ?? 'video/mp4',
      size_bytes: String(options.sizeBytes),
      storage_key: options.storageKey,
      // The state the API leaves behind on a successful completion.
      processing_status: VideoProcessingStatus.PROCESSING,
    }),
  );
}

/** Polls until `predicate` holds or the budget runs out, then throws. */
export async function waitFor<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const { timeoutMs = 60000, intervalMs = 500, what = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  let last: T = await probe();

  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${what}; last value: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await probe();
  }

  return last;
}
