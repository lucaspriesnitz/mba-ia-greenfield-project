import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { FfprobeAdapter } from './ffprobe.adapter';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const spawnMock = spawn as unknown as jest.Mock;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
}

/**
 * The unit layer owns the failure contract, so the binary is mocked: this suite
 * has to be runnable in the API container, where `ffprobe` does not exist. The
 * real binary is exercised by `ffprobe.adapter.integration-spec.ts`, inside the
 * worker image.
 */
function fakeSpawn(outcome: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  spawnError?: Error;
}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  setImmediate(() => {
    if (outcome.spawnError) {
      child.emit('error', outcome.spawnError);
      return;
    }
    if (outcome.stdout) child.stdout.write(outcome.stdout);
    if (outcome.stderr) child.stderr.write(outcome.stderr);
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', outcome.code ?? 0));
  });

  return child;
}

const PROBE_JSON = JSON.stringify({
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '5.467000',
    bit_rate: '412345',
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 320,
      height: 240,
      r_frame_rate: '30000/1001',
    },
    {
      codec_type: 'audio',
      codec_name: 'aac',
      channels: 2,
      sample_rate: '44100',
    },
  ],
});

describe('FfprobeAdapter', () => {
  const adapter = new FfprobeAdapter();

  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('asks the binary for JSON covering both format and streams', async () => {
    spawnMock.mockReturnValue(fakeSpawn({ stdout: PROBE_JSON }));

    await adapter.probe('/tmp/clip.mp4');

    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe('ffprobe');
    expect(args).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '/tmp/clip.mp4',
    ]);
  });

  it('projects the probe onto the metadata subset, rounding the duration', async () => {
    spawnMock.mockReturnValue(fakeSpawn({ stdout: PROBE_JSON }));

    const result = await adapter.probe('/tmp/clip.mp4');

    // `duration_seconds` is an integer column, so the projection rounds.
    expect(result.durationSeconds).toBe(5);
    expect(result.metadata).toEqual({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate: 412345,
      // `r_frame_rate` arrives as a rational, never as a decimal.
      video: { codec: 'h264', width: 320, height: 240, frameRate: 29.97 },
      audio: { codec: 'aac', channels: 2, sampleRate: 44100 },
    });
  });

  it('propagates the binary stderr when the file is not decodable', async () => {
    spawnMock.mockReturnValue(
      fakeSpawn({
        stderr:
          '[mov,mp4 @ 0x55] moov atom not found\n/tmp/junk.mp4: Invalid data found when processing input\n',
        code: 1,
      }),
    );

    await expect(adapter.probe('/tmp/junk.mp4')).rejects.toThrow(
      /moov atom not found/,
    );
  });

  it('propagates the binary stderr when the file does not exist', async () => {
    spawnMock.mockReturnValue(
      fakeSpawn({
        stderr: '/tmp/missing.mp4: No such file or directory\n',
        code: 1,
      }),
    );

    await expect(adapter.probe('/tmp/missing.mp4')).rejects.toThrow(
      /ffprobe exited with code 1: .*No such file or directory/s,
    );
  });

  it('surfaces a missing binary instead of hanging', async () => {
    spawnMock.mockReturnValue(
      fakeSpawn({ spawnError: new Error('spawn ffprobe ENOENT') }),
    );

    await expect(adapter.probe('/tmp/clip.mp4')).rejects.toThrow(
      /spawn ffprobe ENOENT/,
    );
  });

  it('refuses output that carries no duration', async () => {
    spawnMock.mockReturnValue(
      fakeSpawn({ stdout: JSON.stringify({ format: {}, streams: [] }) }),
    );

    await expect(adapter.probe('/tmp/audio-only.bin')).rejects.toThrow(
      /no duration/,
    );
  });
});
