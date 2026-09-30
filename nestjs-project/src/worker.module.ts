import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import mailConfig from './config/mail.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import swaggerConfig from './config/swagger.config';
import videoConfig from './config/video.config';
import { envValidationSchema } from './config/env.validation';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';
import { VideosModule } from './videos/videos.module';

/**
 * Root module of the second entrypoint built from this same source tree. It
 * carries configuration, the database connection, storage and the queue — and
 * deliberately nothing that serves HTTP: no `AuthModule` (which is where the
 * global guards and the throttler live), no controllers of its own, no
 * listener (per phase-03-videos/TD-04).
 *
 * The configuration block is byte-for-byte the API's: same factories, same Joi
 * schema. A worker that validated a narrower environment than the API would
 * boot on a broken `.env` and only fail later, mid-job.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        swaggerConfig,
        storageConfig,
        queueConfig,
        videoConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // VideosModule re-exports TypeOrmModule.forFeature([Video]), so the worker
    // resolves the very same repository the API writes through — same entity,
    // same schema, no duplicated model.
    VideosModule,
    StorageModule,
    QueueModule,
    // The consumer, and the only place it is registered: the API process never
    // imports this module (per phase-03-videos/TD-04).
    VideoProcessingModule,
    // `autoLoadEntities` only sees what some module registered via forFeature.
    // VideosModule brings Video and (through ChannelsModule) Channel, but
    // Channel↔User is a bidirectional relation: without User in the graph
    // TypeORM refuses to build metadata at all. UsersModule owns that entity
    // and carries no HTTP surface, so it is the registration to reuse.
    UsersModule,
  ],
})
export class WorkerModule {}
