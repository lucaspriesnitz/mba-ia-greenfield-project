import { Injectable } from '@nestjs/common';
import { runBinary } from './spawn-binary';

/** The `format` + stream subset that lands in `Video.metadata`. */
export type ProbedVideoStream = {
  codec: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
};

export type ProbedAudioStream = {
  codec: string | null;
  channels: number | null;
  sampleRate: number | null;
};

export type ProbedMetadata = {
  container: string | null;
  bitrate: number | null;
  video: ProbedVideoStream | null;
  audio: ProbedAudioStream | null;
};

export interface ProbeResult {
  /** Rounded to an integer — `Video.duration_seconds` is an `integer` column. */
  durationSeconds: number;
  metadata: ProbedMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
  streams?: FfprobeStream[];
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `r_frame_rate` comes as the rational `"30000/1001"`, never as a decimal. */
function toFrameRate(rational: string | undefined): number | null {
  if (!rational) return null;
  const [numerator, denominator] = rational.split('/');
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) {
    return null;
  }
  return Math.round((top / bottom) * 1000) / 1000;
}

/**
 * `ffprobe` by direct spawn, no npm wrapper (per phase-03-videos/TD-05).
 *
 * The plan's command line reads `-v quiet`; this uses `-v error` instead. They
 * differ in exactly one way that matters: `quiet` suppresses the binary's own
 * error output, and both technical action 3 and the SI's acceptance criteria
 * require a failure to carry FFmpeg's `stderr`. `error` leaves stdout — where
 * the JSON goes — untouched.
 */
@Injectable()
export class FfprobeAdapter {
  async probe(inputPath: string): Promise<ProbeResult> {
    const { stdout } = await runBinary('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ]);

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new Error(`ffprobe returned output that is not JSON: ${stdout}`);
    }

    const duration = toNumber(parsed.format?.duration);
    if (duration === null) {
      throw new Error(
        `ffprobe reported no duration for ${inputPath}; the file is not a decodable video`,
      );
    }

    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    return {
      durationSeconds: Math.round(duration),
      metadata: {
        container: parsed.format?.format_name ?? null,
        bitrate: toNumber(parsed.format?.bit_rate),
        video: video
          ? {
              codec: video.codec_name ?? null,
              width: video.width ?? null,
              height: video.height ?? null,
              frameRate: toFrameRate(video.r_frame_rate),
            }
          : null,
        audio: audio
          ? {
              codec: audio.codec_name ?? null,
              channels: audio.channels ?? null,
              sampleRate: toNumber(audio.sample_rate),
            }
          : null,
      },
    };
  }
}
