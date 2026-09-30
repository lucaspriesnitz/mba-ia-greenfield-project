import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../../config/video.config';
import {
  generateVideoFixture,
  makeFixtureDir,
  removeFixtureDir,
  VideoFixture,
} from '../../test/video-fixture';
import { FfmpegThumbnailAdapter } from './ffmpeg-thumbnail.adapter';

const OFFSET_SECONDS = 3;

function adapterWithOffset(seconds: number): FfmpegThumbnailAdapter {
  return new FfmpegThumbnailAdapter({
    ...videoConfig(),
    thumbnailOffsetSeconds: seconds,
  } as ConfigType<typeof videoConfig>);
}

/** JPEG starts with SOI (`FF D8 FF`) — a real image, not just a non-empty file. */
function isJpeg(bytes: Buffer): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Real `ffmpeg`, so this suite only runs inside the worker image (per
 * phase-03-videos/TD-05).
 */
describe('FfmpegThumbnailAdapter against the real binary (integration)', () => {
  let dir: string;
  let longEnough: VideoFixture;
  let shorterThanOffset: VideoFixture;

  beforeAll(async () => {
    dir = await makeFixtureDir();
    longEnough = await generateVideoFixture(dir, {
      filename: 'long.mp4',
      durationSeconds: 5,
    });
    shorterThanOffset = await generateVideoFixture(dir, {
      filename: 'short.mp4',
      durationSeconds: 1,
    });
  }, 180000);

  afterAll(async () => {
    await removeFixtureDir(dir);
  });

  it('writes a non-empty JPEG at the configured offset', async () => {
    const output = join(dir, 'long.jpg');

    await adapterWithOffset(OFFSET_SECONDS).generate(
      longEnough.path,
      output,
      longEnough.durationSeconds,
    );

    const { size } = await stat(output);
    expect(size).toBeGreaterThan(0);
    expect(isJpeg(await readFile(output))).toBe(true);
  }, 60000);

  it('falls back to offset 0 for a video shorter than the configured offset', async () => {
    const output = join(dir, 'short.jpg');

    // Seeking to 3s in a 1s clip yields no frame and ffmpeg exits non-zero;
    // the fallback is what keeps short videos from failing processing.
    await adapterWithOffset(OFFSET_SECONDS).generate(
      shorterThanOffset.path,
      output,
      shorterThanOffset.durationSeconds,
    );

    const { size } = await stat(output);
    expect(size).toBeGreaterThan(0);
    expect(isJpeg(await readFile(output))).toBe(true);
  }, 60000);

  it('overwrites its own previous output instead of blocking on a prompt', async () => {
    const output = join(dir, 'rerun.jpg');
    const adapter = adapterWithOffset(OFFSET_SECONDS);

    await adapter.generate(longEnough.path, output, longEnough.durationSeconds);
    await adapter.generate(longEnough.path, output, longEnough.durationSeconds);

    expect(isJpeg(await readFile(output))).toBe(true);
  }, 60000);

  it('fails on a file that is not a video, carrying FFmpeg own error text', async () => {
    const output = join(dir, 'never.jpg');

    await expect(
      adapterWithOffset(OFFSET_SECONDS).generate(
        join(dir, 'does-not-exist.mp4'),
        output,
      ),
    ).rejects.toThrow(/No such file or directory/);
  }, 60000);
});
