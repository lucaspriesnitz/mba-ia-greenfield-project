import * as http from 'node:http';
import storageConfig from '../config/storage.config';

export interface GetPresignedResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** How many chunks the response arrived in — 2 or more means it streamed. */
  chunkCount: number;
  /** Milliseconds from request to the first chunk, and to the last one. */
  msToFirstChunk: number;
  msToEnd: number;
}

/**
 * Fetches a presigned `GET` the way a browser would, with no credentials of its
 * own — the counterpart of `putPresignedPart`.
 *
 * The socket is dialed at the internal endpoint while the signed `Host` header
 * is preserved byte for byte, for the same reason as the `PUT` helper: inside
 * the `nestjs-api` container the browser-facing host (`localhost:9000`) resolves
 * to the container itself, and rewriting the URL would change the signed `Host`
 * that SigV4 covers. Only where the socket lands changes; the signature and the
 * credential story are untouched.
 */
export async function getPresigned(
  url: string,
  headers: Record<string, string> = {},
): Promise<GetPresignedResult> {
  const signed = new URL(url);
  const internal = new URL(storageConfig().internalEndpoint);
  const startedAt = Date.now();

  return new Promise<GetPresignedResult>((resolve, reject) => {
    const req = http.request(
      {
        hostname: internal.hostname,
        port: Number(internal.port || 80),
        path: signed.pathname + signed.search,
        method: 'GET',
        headers: { Host: signed.host, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let msToFirstChunk = -1;

        res.on('data', (chunk: Buffer) => {
          if (msToFirstChunk < 0) msToFirstChunk = Date.now() - startedAt;
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            chunkCount: chunks.length,
            msToFirstChunk,
            msToEnd: Date.now() - startedAt,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
