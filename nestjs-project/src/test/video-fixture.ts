import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBinary } from '../videos/processing/spawn-binary';

/**
 * Synthetic video fixtures, built by `ffmpeg` at test time instead of being
 * committed as binaries. They only exist where `ffmpeg` does — the worker
 * image (per phase-03-videos/TD-05) — which is where every suite that uses
 * them runs.
 */
export interface VideoFixture {
  path: string;
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
}

export interface VideoFixtureOptions {
  filename?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  withAudio?: boolean;
}

export async function makeFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
}

export async function removeFixtureDir(dir: string | undefined): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true });
}

export async function generateVideoFixture(
  dir: string,
  options: VideoFixtureOptions = {},
): Promise<VideoFixture> {
  const {
    filename = 'fixture.mp4',
    durationSeconds = 5,
    width = 320,
    height = 240,
    frameRate = 25,
    withAudio = true,
  } = options;

  const path = join(dir, filename);
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=${frameRate}`,
  ];

  if (withAudio) {
    args.push(
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-shortest',
      '-c:a',
      'aac',
    );
  }

  args.push(
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(durationSeconds),
    path,
  );

  await runBinary('ffmpeg', args);

  return { path, durationSeconds, width, height, frameRate };
}
