import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../../config/video.config';
import { runBinary } from './spawn-binary';

/**
 * One frame, one JPEG, by direct spawn of the system `ffmpeg` — no npm wrapper,
 * so the binary's `stderr` stays reachable on failure (per phase-03-videos/TD-05).
 */
@Injectable()
export class FfmpegThumbnailAdapter {
  constructor(
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * `durationSeconds` is the value `FfprobeAdapter` already extracted. When the
   * video is not longer than the configured offset the seek falls back to `0`,
   * which is the safe default for short videos the decision asks for — seeking
   * at or past the end yields no frame and `ffmpeg` exits non-zero.
   */
  async generate(
    inputPath: string,
    outputPath: string,
    durationSeconds?: number | null,
  ): Promise<string> {
    await runBinary('ffmpeg', [
      // Without `-y` ffmpeg asks on stdin whether to overwrite and the spawn
      // hangs; a re-run of the same job has to be able to rewrite its output.
      '-y',
      '-ss',
      String(this.offsetFor(durationSeconds)),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-f',
      'image2',
      outputPath,
    ]);

    return outputPath;
  }

  private offsetFor(durationSeconds?: number | null): number {
    const configured = this.config.thumbnailOffsetSeconds;
    if (durationSeconds === undefined || durationSeconds === null) {
      return configured;
    }
    return durationSeconds <= configured ? 0 : configured;
  }
}
