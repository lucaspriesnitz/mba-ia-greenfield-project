import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { originalKey } from './storage-keys';
import { StorageService, UploadedPart } from './storage.service';

type StorageConfig = ConfigType<typeof storageConfig>;

/** MinIO rejects any part but the last below 5 MiB. */
const MIN_PART_BYTES = 5 * 1024 * 1024;
const TAIL_PART_BYTES = 1024;

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

function buildService(overrides: Partial<StorageConfig> = {}): {
  service: StorageService;
  config: StorageConfig;
  internal: S3Client;
} {
  const config = { ...storageConfig(), ...overrides };
  const internal = buildClient(config, config.internalEndpoint);
  const signing = buildClient(config, config.publicEndpoint);
  return {
    service: new StorageService(internal, signing, config),
    config,
    internal,
  };
}

describe('StorageService — multipart against the Compose MinIO (integration)', () => {
  // The suite runs inside the `nestjs-api` container, where the browser-facing
  // `STORAGE_PUBLIC_ENDPOINT` (localhost) resolves to the container itself. To
  // actually PUT to the signed URLs, signing is pointed at the internal
  // endpoint here; the public-host guarantee is asserted separately below,
  // against the unmodified configuration.
  const reachable = buildService({
    publicEndpoint: storageConfig().internalEndpoint,
  });

  const createdKeys: string[] = [];

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        reachable.internal.send(
          new DeleteObjectCommand({
            Bucket: reachable.config.bucket,
            Key: key,
          }),
        ),
      ),
    );
    reachable.internal.destroy();
  });

  function freshKey(): string {
    const key = originalKey(randomUUID().replace(/-/g, '').slice(0, 11), 'mp4');
    createdKeys.push(key);
    return key;
  }

  /**
   * The body is a `Uint8Array`, not a `Buffer`: `Buffer<ArrayBufferLike>` does
   * not satisfy the fetch `BodyInit`, whose views must be backed by a plain
   * `ArrayBuffer`.
   */
  async function uploadPart(
    url: string,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<string> {
    const response = await fetch(url, { method: 'PUT', body });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  it('assembles an object from signed parts and reports the assembled size', async () => {
    const key = freshKey();
    const bodies = [
      new Uint8Array(MIN_PART_BYTES).fill(0x61),
      new Uint8Array(TAIL_PART_BYTES).fill(0x62),
    ];

    const uploadId = await reachable.service.createMultipartUpload(
      key,
      'video/mp4',
    );
    expect(uploadId).toBeTruthy();

    const signed = await reachable.service.signUploadParts(
      key,
      uploadId,
      [1, 2],
    );
    expect(signed.map((part) => part.partNumber)).toEqual([1, 2]);
    for (const part of signed) {
      // No credentials are attached here on purpose: the signature in the URL
      // is the whole authorization, which is what lets a browser upload direct.
      expect(part.url).toContain('X-Amz-Signature');
      expect(part.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }

    const parts: UploadedPart[] = [];
    for (const part of signed) {
      parts.push({
        partNumber: part.partNumber,
        etag: await uploadPart(part.url, bodies[part.partNumber - 1]),
      });
    }

    await reachable.service.completeMultipartUpload(key, uploadId, parts);

    const head = await reachable.service.headObject(key);
    expect(head.contentLength).toBe(MIN_PART_BYTES + TAIL_PART_BYTES);
    expect(head.contentType).toBe('video/mp4');
  }, 60000);

  it('assembles in part-number order even when the parts come back shuffled', async () => {
    const key = freshKey();
    const first = new Uint8Array(MIN_PART_BYTES).fill(0x63);
    const second = new Uint8Array(TAIL_PART_BYTES).fill(0x64);

    const uploadId = await reachable.service.createMultipartUpload(
      key,
      'video/mp4',
    );
    const signed = await reachable.service.signUploadParts(
      key,
      uploadId,
      [1, 2],
    );
    const bodies = new Map([
      [1, first],
      [2, second],
    ]);
    const parts: UploadedPart[] = [];
    for (const part of signed) {
      parts.push({
        partNumber: part.partNumber,
        etag: await uploadPart(part.url, bodies.get(part.partNumber)!),
      });
    }

    await reachable.service.completeMultipartUpload(
      key,
      uploadId,
      [...parts].reverse(),
    );

    const stream = await reachable.service.getObjectStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const assembled = Buffer.concat(chunks);

    expect(assembled.length).toBe(MIN_PART_BYTES + TAIL_PART_BYTES);
    expect(assembled.subarray(0, MIN_PART_BYTES).equals(first)).toBe(true);
    expect(assembled.subarray(MIN_PART_BYTES).equals(second)).toBe(true);
  }, 60000);

  it('leaves no residual part behind after an abort', async () => {
    const key = freshKey();

    const uploadId = await reachable.service.createMultipartUpload(
      key,
      'video/mp4',
    );
    const [part] = await reachable.service.signUploadParts(key, uploadId, [1]);
    await uploadPart(part.url, new Uint8Array(MIN_PART_BYTES).fill(0x65));

    const before = await reachable.internal.send(
      new ListPartsCommand({
        Bucket: reachable.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
    expect(before.Parts).toHaveLength(1);

    await reachable.service.abortMultipartUpload(key, uploadId);

    await expect(
      reachable.internal.send(
        new ListPartsCommand({
          Bucket: reachable.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      ),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });

    // And the object itself was never assembled.
    await expect(reachable.service.headObject(key)).rejects.toMatchObject({
      name: 'NotFound',
    });
  }, 60000);

  it('writes and reads back a worker-side object through the internal client', async () => {
    const key = freshKey();
    const thumbnail = Buffer.from('not-really-a-jpeg-but-bytes-are-bytes');

    await reachable.service.putObject(key, thumbnail, 'image/jpeg');

    const head = await reachable.service.headObject(key);
    expect(head.contentLength).toBe(thumbnail.length);
    expect(head.contentType).toBe('image/jpeg');
  }, 60000);

  it('signs with the public host and never leaks the Compose service name', async () => {
    const { service, config, internal } = buildService();
    const key = originalKey('PUBLICHOST1', 'mp4');
    const publicHost = new URL(config.publicEndpoint).host;
    const internalHost = new URL(config.internalEndpoint).host;

    const uploadUrl = (
      await service.signUploadParts(key, 'an-upload-id', [1])
    )[0].url;
    const downloadUrl = (await service.signDownloadUrl(key)).url;

    for (const url of [uploadUrl, downloadUrl]) {
      expect(new URL(url).host).toBe(publicHost);
      expect(url).not.toContain(internalHost);
    }

    internal.destroy();
  }, 30000);
});
