import { spawn } from 'node:child_process';

export interface BinaryResult {
  stdout: string;
  stderr: string;
}

/**
 * Carries the binary's own diagnostic in `message`. Keeping FFmpeg's `stderr`
 * reachable is the entire reason this phase spawns the system binaries instead
 * of going through an npm wrapper (per phase-03-videos/TD-05) — and it is what
 * ends up in `processing_error` when a job fails terminally.
 */
export class BinaryExecutionError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `${command} exited with code ${exitCode ?? 'null'}: ${
        stderr.trim() || '<no stderr>'
      }`,
    );
    this.name = 'BinaryExecutionError';
  }
}

/**
 * Both FFmpeg adapters spawn a fixed command line and need the same three
 * things: stdout collected, stderr collected, and a non-zero exit turned into
 * an error that still carries the stderr.
 */
export function runBinary(
  command: string,
  args: string[],
): Promise<BinaryResult> {
  return new Promise<BinaryResult>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // The binary missing from `PATH` never reaches `close`; it surfaces here.
    child.on('error', (error: Error) => {
      reject(
        new BinaryExecutionError(command, null, `${error.message}${stderr}`),
      );
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new BinaryExecutionError(command, code, stderr));
    });
  });
}
