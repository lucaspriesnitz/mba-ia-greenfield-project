import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { PublicIdService } from './public-id.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // ChannelsModule re-exports its own forFeature, which is how the draft
    // resolves the caller's channel without a second Channel registration.
    ChannelsModule,
    ConfigModule,
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [PublicIdService, VideosService],
  // TypeOrmModule re-exported so the standalone worker resolves the same Video
  // repository; PublicIdService and VideosService exported for consumers.
  exports: [TypeOrmModule, PublicIdService, VideosService],
})
export class VideosModule {}
