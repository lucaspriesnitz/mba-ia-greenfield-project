import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { CreateUsersAndChannels1775687773260 } from '../../database/migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from '../../database/migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1790558159861 } from '../../database/migrations/1790558159861-CreateVideos';
import { createTestDataSource } from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const MANAGED_TABLES = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
];

/**
 * Dropping a table does NOT drop the enum types it used — a leftover type makes
 * the next `CREATE TYPE` fail with "already exists". Every reset clears them too.
 */
const MANAGED_ENUM_TYPES = [
  'videos_processing_status_enum',
  'videos_publication_status_enum',
  'verification_tokens_type_enum',
];

async function resetSchema(dataSource: DataSource): Promise<void> {
  for (const table of MANAGED_TABLES) {
    await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
  await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
  for (const type of MANAGED_ENUM_TYPES) {
    await dataSource.query(`DROP TYPE IF EXISTS "public"."${type}" CASCADE`);
  }
}

async function tableExists(
  dataSource: DataSource,
  table: string,
): Promise<boolean> {
  const rows = await dataSource.query<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.length > 0;
}

async function enumTypesPresent(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<{ typname: string }[]>(
    `SELECT t.typname FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = ANY($1::text[])
     ORDER BY t.typname`,
    [['videos_processing_status_enum', 'videos_publication_status_enum']],
  );
  return rows.map((r) => r.typname);
}

describe('CreateVideos migration (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1790558159861,
        ],
      },
    );

    await dataSource.initialize();
    await resetSchema(dataSource);
  }, 60000);

  afterAll(async () => {
    // Leave the shared database fully migrated for whatever suite runs next.
    await resetSchema(dataSource);
    await dataSource.runMigrations();
    await dataSource.destroy();
  }, 60000);

  it('should apply CreateVideos on top of the foundation migrations', async () => {
    const ran = await dataSource.runMigrations();

    expect(ran).toHaveLength(3);
    expect(ran.map((m) => m.name)).toContain('CreateVideos1790558159861');
    expect(await tableExists(dataSource, 'videos')).toBe(true);
  }, 60000);

  it('should create both enum types, the unique constraint and the FK', async () => {
    expect(await enumTypesPresent(dataSource)).toEqual([
      'videos_processing_status_enum',
      'videos_publication_status_enum',
    ]);

    const constraints = await dataSource.query<
      { constraint_name: string; constraint_type: string }[]
    >(
      `SELECT constraint_name, constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    const types = constraints.map((c) => c.constraint_type);

    expect(types).toContain('UNIQUE');
    expect(types).toContain('FOREIGN KEY');
    expect(types).toContain('PRIMARY KEY');
  });

  it('should index channel_id and processing_status', async () => {
    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'videos'`,
    );
    const definitions = indexes.map((i) => i.indexdef).join('\n');

    expect(definitions).toContain('channel_id');
    expect(definitions).toContain('processing_status');
  });

  it('should revert cleanly, leaving no table and no orphan enum type', async () => {
    await dataSource.undoLastMigration();

    expect(await tableExists(dataSource, 'videos')).toBe(false);
    expect(await enumTypesPresent(dataSource)).toEqual([]);
  }, 60000);

  it('should re-apply after a revert without failing on an existing type', async () => {
    const ran = await dataSource.runMigrations();

    expect(ran).toHaveLength(1);
    expect(ran[0].name).toBe('CreateVideos1790558159861');
    expect(await tableExists(dataSource, 'videos')).toBe(true);
    expect(await enumTypesPresent(dataSource)).toHaveLength(2);
  }, 60000);
});
