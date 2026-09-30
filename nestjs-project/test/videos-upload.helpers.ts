import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import videoConfig from '../src/config/video.config';
import { cleanAllTables } from '../src/test/create-test-data-source';

export { partBody, putPresignedPart } from '../src/test/presigned-put';
export type { PutPartResult } from '../src/test/presigned-put';
export { getPresigned } from '../src/test/presigned-get';
export type { GetPresignedResult } from '../src/test/presigned-get';

export interface VideosE2EContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
}

/**
 * Boots the real application the way `main.ts` does — `Test.createTestingModule`
 * does not run `main.ts`, so the global pipe and both filters are applied here
 * or the endpoints answer with the wrong shape.
 *
 * `videoOverrides` exists because the shipped part size is 64 MiB: completing a
 * multipart requires every non-final part to clear MinIO's 5 MiB floor, and a
 * suite that honoured the production value would push hundreds of megabytes
 * per scenario.
 *
 * `storageOverrides` exists for one scenario only — expiring a presigned URL
 * inside a test run, which the shipped 15-minute TTL makes impossible. It is
 * otherwise left alone on purpose: the URLs the tests assert on are the ones
 * the application really issues, signed with the real public host.
 */
export async function bootstrapVideosApp(
  videoOverrides: Partial<ReturnType<typeof videoConfig>> = {},
  storageOverrides: Partial<ReturnType<typeof storageConfig>> = {},
): Promise<VideosE2EContext> {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  if (Object.keys(videoOverrides).length > 0) {
    builder
      .overrideProvider(videoConfig.KEY)
      .useValue({ ...videoConfig(), ...videoOverrides });
  }

  if (Object.keys(storageOverrides).length > 0) {
    builder
      .overrideProvider(storageConfig.KEY)
      .useValue({ ...storageConfig(), ...storageOverrides });
  }

  const moduleFixture = await builder.compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

/** Shape of `POST /videos` — supertest hands the body back as `any`. */
export interface SignedPartBody {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface InitiateUploadBody {
  publicId: string;
  uploadId: string;
  partSizeBytes: number;
  partCount: number;
  parts: SignedPartBody[];
}

export interface ErrorEnvelopeBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

/**
 * Every scenario that completes an upload leaves an assembled object in the
 * bucket, and the row that names its key is about to be deleted — without this
 * the bucket grows by a few megabytes on every run of the suite, with nothing
 * left pointing at the residue.
 */
export async function purgeVideoObjects(dataSource: DataSource): Promise<void> {
  // Typed through the generic rather than an `as` cast: `npm run lint` runs
  // with `--fix`, and the fixer strips an assertion over `query`'s `any` as
  // "unnecessary", which would leave the rows untyped on the next run.
  const rows = await dataSource.query<{ public_id: string }[]>(
    'SELECT public_id FROM "videos"',
  );

  if (rows.length === 0) return;

  const config = storageConfig();
  const client = new S3Client({
    endpoint: config.internalEndpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });

  try {
    for (const { public_id } of rows) {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: `videos/${public_id}/`,
        }),
      );
      const keys = (listed.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => Boolean(key));

      if (keys.length === 0) continue;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
    }
  } finally {
    client.destroy();
  }
}

/**
 * `cleanAllTables` is a Phase 02 helper and does not know about `videos`, which
 * carries an FK to `channels` — the videos go first or the delete trips it.
 */
export async function resetVideosState(
  context: VideosE2EContext,
): Promise<void> {
  await purgeVideoObjects(context.dataSource);
  await context.dataSource.query('DELETE FROM "videos"');
  await cleanAllTables(context.dataSource);
  context.throttlerStorage.storage.clear();
}

/** Register → confirm → login, returning the access token of a user with a channel. */
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const authService = app.get(AuthService);
  const mailService = (
    authService as unknown as {
      mailService: {
        sendConfirmationEmail: (
          email: string,
          name: string,
          token: string,
        ) => Promise<void>;
      };
    }
  ).mailService;

  let confirmationToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email, _name, token) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return (login.body as { access_token: string }).access_token;
}
