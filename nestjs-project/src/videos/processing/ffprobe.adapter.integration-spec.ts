import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generateVideoFixture,
  makeFixtureDir,
  removeFixtureDir,
  VideoFixture,
} from '../../test/video-fixture';
import { FfprobeAdapter } from './ffprobe.adapter';

/**
 * Runs against the real `ffprobe`, so it only passes inside the worker image —
 * the only image that carries the FFmpeg system binaries (per
 * phase-03-videos/TD-05). Run it with
 * `docker compose exec video-worker npm test -- --runInBand --forceExit <path>`.
 */
describe('FfprobeAdapter against the real binary (integration)', () => {
  const adapter = new FfprobeAdapter();
  let dir: string;
  let fixture: VideoFixture;

  beforeAll(async () => {
    dir = await makeFixtureDir();
    fixture = await generateVideoFixture(dir, {
      durationSeconds: 5,
      width: 320,
      height: 240,
      frameRate: 25,
    });
  }, 120000);

  afterAll(async () => {
    await removeFixtureDir(dir);
  });

  it('reads back the known duration of the fixture', async () => {
    const { durationSeconds } = await adapter.probe(fixture.path);

    expect(durationSeconds).toBe(fixture.durationSeconds);
    expect(Number.isInteger(durationSeconds)).toBe(true);
  }, 60000);

  it('carries codec, resolution and frame rate of the video stream', async () => {
    const { metadata } = await adapter.probe(fixture.path);

    expect(metadata.container).toContain('mp4');
    expect(metadata.bitrate).toBeGreaterThan(0);
    expect(metadata.video).toEqual({
      codec: 'h264',
      width: fixture.width,
      height: fixture.height,
      frameRate: fixture.frameRate,
    });
    expect(metadata.audio).toMatchObject({ codec: 'aac', channels: 2 });
  }, 60000);

  it('fails on a file that is not a video, carrying FFmpeg own error text', async () => {
    const notAVideo = join(dir, 'not-a-video.mp4');
    await writeFile(notAVideo, 'this is plain text, not an MP4 container');

    await expect(adapter.probe(notAVideo)).rejects.toThrow(
      /Invalid data found when processing input/,
    );
  }, 60000);

  it('fails on a missing file, carrying FFmpeg own error text', async () => {
    await expect(adapter.probe(join(dir, 'nope.mp4'))).rejects.toThrow(
      /No such file or directory/,
    );
  }, 60000);
});
