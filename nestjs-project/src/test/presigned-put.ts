import * as http from 'node:http';
import storageConfig from '../config/storage.config';

export interface PutPartResult {
  status: number;
  etag: string;
  size: number;
}

/**
 * Uploads one part straight to storage with no credentials of its own — which
 * is the whole point of a presigned URL.
 *
 * The socket is dialed at the internal endpoint while the signed `Host` header
 * is preserved byte for byte. Inside the `nestjs-api` container the
 * browser-facing host (`localhost:9000`) resolves to the container itself, so
 * the TCP target has to be rerouted; rewriting the URL instead would change the
 * signed `Host` and break SigV4, which covers that header. Nothing about the
 * signature or the credential story is relaxed — only where the socket lands.
 */
export async function putPresignedPart(
  url: string,
  body: Buffer,
): Promise<PutPartResult> {
  const signed = new URL(url);
  const internal = new URL(storageConfig().internalEndpoint);

  return new Promise<PutPartResult>((resolve, reject) => {
    const req = http.request(
      {
        hostname: internal.hostname,
        port: Number(internal.port || 80),
        path: signed.pathname + signed.search,
        method: 'PUT',
        headers: { Host: signed.host, 'Content-Length': body.length },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            etag: (res.headers.etag ?? '').replace(/"/g, ''),
            size: body.length,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Deterministic filler; the bytes are never decoded, only counted. */
export function partBody(sizeBytes: number, fill = 0x61): Buffer {
  return Buffer.alloc(sizeBytes, fill);
}
