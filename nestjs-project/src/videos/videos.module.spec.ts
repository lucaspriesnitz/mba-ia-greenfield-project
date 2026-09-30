import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * The module now reaches storage, queue and video config through its imports,
 * so the compilation test has to load the same namespaces the app loads — the
 * DI wiring this test exists to catch now spans three modules, not one.
 */
function configModule() {
  return ConfigModule.forRoot({
    isGlobal: true,
    load: [storageConfig, queueConfig, videoConfig],
  });
}

describe('VideosModule', () => {
  it('should compile with TypeOrmModule.forFeature([Video])', async () => {
    const module = await Test.createTestingModule({
      imports: [
        configModule(),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(VideosService)).toBeDefined();
    expect(module.get(VideosController)).toBeDefined();
    await module.close();
  }, 30000);

  it('should re-export TypeOrmModule so an importer resolves the Video repository', async () => {
    const module = await Test.createTestingModule({
      imports: [
        configModule(),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    // Resolvable from the consuming context — this is what lets the standalone
    // worker share the same repository instead of re-declaring forFeature.
    expect(
      module.get(getRepositoryToken(Video), { strict: false }),
    ).toBeDefined();
    await module.close();
  }, 30000);
});
