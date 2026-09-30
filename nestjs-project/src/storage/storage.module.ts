import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_SIGNING_CLIENT,
} from './storage.tokens';

/**
 * `forcePathStyle` is mandatory against MinIO: virtual-host addressing would
 * require per-bucket DNS that does not exist inside the Compose network
 * (per phase-03-videos/TD-01).
 */
function buildClient(
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client {
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

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config, config.internalEndpoint),
    },
    {
      provide: STORAGE_SIGNING_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config, config.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService, STORAGE_INTERNAL_CLIENT, STORAGE_SIGNING_CLIENT],
})
export class StorageModule {}
