import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_SIGNING_CLIENT,
} from './storage.tokens';

/** One presigned `PUT` for one part of a multipart upload. */
export interface SignedPart {
  partNumber: number;
  url: string;
  expiresAt: Date;
}

/** A part the client already uploaded, as storage needs it back to assemble. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface ObjectHead {
  contentLength: number;
  contentType: string | undefined;
}

/**
 * Quoted form for the legacy parsers plus the RFC 5987 form for anything
 * outside ASCII, which is what browsers actually honour for accented filenames.
 */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename,
  )}`;
}

/**
 * Every byte of every video goes through here. The API process itself never
 * carries upload or playback bytes — it hands out presigned URLs and the client
 * talks to storage directly (per phase-03-videos/TD-02, phase-03-videos/TD-07).
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_INTERNAL_CLIENT) private readonly internal: S3Client,
    @Inject(STORAGE_SIGNING_CLIENT) private readonly signing: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  private get bucket(): string {
    return this.config.bucket;
  }

  private get ttlSeconds(): number {
    return this.config.presignTtlSeconds;
  }

  private expiry(): Date {
    return new Date(Date.now() + this.ttlSeconds * 1000);
  }

  /** Opens the multipart upload and returns storage's upload id. */
  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!response.UploadId) {
      throw new Error(`Storage returned no upload id for key ${key}`);
    }
    return response.UploadId;
  }

  /**
   * Signed by the public client, so the URLs resolve from a browser. The client
   * uploads with no credentials of its own.
   */
  async signUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<SignedPart[]> {
    const expiresAt = this.expiry();

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.signing,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: this.ttlSeconds },
        ),
        expiresAt,
      })),
    );
  }

  /** Asks storage to assemble the parts into the final object. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  /**
   * Removes an assembled object. The completion path needs it: once storage has
   * assembled the parts the multipart no longer exists, so an object that turns
   * out to breach the size ceiling can only be undone by deleting it.
   */
  async deleteObject(key: string): Promise<void> {
    await this.internal.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** Discards the upload and every part already stored under it. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internal.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * Internal client on purpose: this is the API asking storage a question about
   * the assembled object, not a URL for a client.
   */
  async headObject(key: string): Promise<ObjectHead> {
    const response = await this.internal.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    return {
      contentLength: Number(response.ContentLength ?? 0),
      contentType: response.ContentType,
    };
  }

  /**
   * Playback and download are the same presigned `GET`; the only difference is
   * the content-disposition override. Without `attachmentFilename` the storage
   * service answers `Range` with `206 Partial Content` on its own, which is the
   * whole point of not proxying the bytes (per phase-03-videos/TD-07).
   */
  async signDownloadUrl(
    key: string,
    options: { attachmentFilename?: string } = {},
  ): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.signing,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.attachmentFilename && {
          ResponseContentDisposition: attachmentDisposition(
            options.attachmentFilename,
          ),
        }),
      }),
      { expiresIn: this.ttlSeconds },
    );

    return { url, expiresAt: this.expiry() };
  }

  /** Worker side: reads the stored original to feed FFmpeg. */
  async getObjectStream(key: string): Promise<Readable> {
    const response = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`Storage returned no body for key ${key}`);
    }
    return response.Body as Readable;
  }

  /** Worker side: writes the generated thumbnail. */
  async putObject(
    key: string,
    body: Buffer | Readable,
    contentType: string,
  ): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
