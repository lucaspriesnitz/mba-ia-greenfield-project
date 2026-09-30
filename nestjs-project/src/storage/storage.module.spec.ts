import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_SIGNING_CLIENT,
} from './storage.tokens';

/**
 * Signing is a local computation — no network. Reading the endpoint back off a
 * signed URL is both cheaper and steadier than poking at the SDK's resolved
 * config, whose shape is an implementation detail.
 */
async function signedUrlOf(client: S3Client): Promise<URL> {
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: 'streamtube', Key: 'videos/probe/x.mp4' }),
    { expiresIn: 60 },
  );
  return new URL(url);
}

describe('StorageModule', () => {
  let moduleRef: TestingModule;
  const config = storageConfig();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('compiles and exposes the service every consumer of the phase injects', () => {
    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
  });

  it('resolves two distinct S3 clients, one per token', () => {
    const internal = moduleRef.get<S3Client>(STORAGE_INTERNAL_CLIENT);
    const signing = moduleRef.get<S3Client>(STORAGE_SIGNING_CLIENT);

    expect(internal).toBeInstanceOf(S3Client);
    expect(signing).toBeInstanceOf(S3Client);
    // Same credentials, different endpoints — one instance for both would leak
    // the Compose service name into URLs handed to clients.
    expect(internal).not.toBe(signing);
  });

  it('gives each client the endpoint its role requires', async () => {
    const internalUrl = await signedUrlOf(
      moduleRef.get<S3Client>(STORAGE_INTERNAL_CLIENT),
    );
    const signingUrl = await signedUrlOf(
      moduleRef.get<S3Client>(STORAGE_SIGNING_CLIENT),
    );

    expect(internalUrl.host).toBe(new URL(config.internalEndpoint).host);
    expect(signingUrl.host).toBe(new URL(config.publicEndpoint).host);
    expect(internalUrl.host).not.toBe(signingUrl.host);
  });

  it('forces path-style addressing, which is what MinIO serves without per-bucket DNS', async () => {
    const url = await signedUrlOf(
      moduleRef.get<S3Client>(STORAGE_SIGNING_CLIENT),
    );

    // Path style puts the bucket in the path; virtual-host style would put it
    // in the hostname, which no DNS inside the Compose network answers for.
    expect(url.pathname).toBe('/streamtube/videos/probe/x.mp4');
    expect(url.hostname.startsWith('streamtube.')).toBe(false);
  });
});
