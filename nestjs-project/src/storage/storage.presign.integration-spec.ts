import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { originalKey } from './storage-keys';
import { StorageService } from './storage.service';

type StorageConfig = ConfigType<typeof storageConfig>;

const OBJECT_BYTES = 4096;
const RANGE_BYTES = 1024;

function buildClient(config: StorageConfig, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
}

/**
 * Signing is pointed at the internal endpoint so the signed URL is fetchable
 * from inside the API container — the public endpoint is the browser's view and
 * does not resolve here. That the real configuration signs with the public host
 * instead is asserted in `storage.service.integration-spec.ts`.
 */
function buildService(overrides: Partial<StorageConfig> = {}): {
  service: StorageService;
  config: StorageConfig;
  internal: S3Client;
} {
  const base = storageConfig();
  const config = {
    ...base,
    publicEndpoint: base.internalEndpoint,
    ...overrides,
  };
  const internal = buildClient(config, config.internalEndpoint);
  const signing = buildClient(config, config.publicEndpoint);
  return {
    service: new StorageService(internal, signing, config),
    config,
    internal,
  };
}

describe('StorageService — presigned reads against the Compose MinIO (integration)', () => {
  const { service, config, internal } = buildService();
  const key = originalKey(randomUUID().replace(/-/g, '').slice(0, 11), 'mp4');
  const body = Buffer.alloc(OBJECT_BYTES, 0x7a);

  beforeAll(async () => {
    await service.putObject(key, body, 'video/mp4');
  }, 60000);

  afterAll(async () => {
    await internal.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    internal.destroy();
  });

  it('answers a ranged GET with 206 and exactly the requested window', async () => {
    const { url, expiresAt } = await service.signDownloadUrl(key);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const response = await fetch(url, {
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-${RANGE_BYTES - 1}/${OBJECT_BYTES}`,
    );
    const received = Buffer.from(await response.arrayBuffer());
    expect(received.length).toBe(RANGE_BYTES);
    expect(received.equals(body.subarray(0, RANGE_BYTES))).toBe(true);
  }, 60000);

  it('serves a window from the middle of the object, which is what seeking needs', async () => {
    const { url } = await service.signDownloadUrl(key);
    const start = 2048;
    const end = start + RANGE_BYTES - 1;

    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes ${start}-${end}/${OBJECT_BYTES}`,
    );
    expect((await response.arrayBuffer()).byteLength).toBe(RANGE_BYTES);
  }, 60000);

  it('serves the whole object with 200 when no range is asked for', async () => {
    const { url } = await service.signDownloadUrl(key);

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(OBJECT_BYTES);
    // Playback carries no attachment disposition — it plays inline.
    expect(response.headers.get('content-disposition')).toBeNull();
  }, 60000);

  it('forces an attachment carrying the original filename when asked to', async () => {
    const filename = 'my "best" video.mp4';
    const { url } = await service.signDownloadUrl(key, {
      attachmentFilename: filename,
    });

    const response = await fetch(url);

    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    // Quotes in the name would close the quoted form early, so they are
    // sanitised; the RFC 5987 form carries the name losslessly beside it.
    expect(disposition).toContain('filename="my _best_ video.mp4"');
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  }, 60000);

  it('stops working once the TTL is spent instead of staying valid forever', async () => {
    const shortLived = buildService({ presignTtlSeconds: 1 });
    const { url } = await shortLived.service.signDownloadUrl(key);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    const response = await fetch(url);

    expect(response.status).not.toBe(200);
    expect(response.status).toBeGreaterThanOrEqual(400);
    shortLived.internal.destroy();
  }, 60000);
});
