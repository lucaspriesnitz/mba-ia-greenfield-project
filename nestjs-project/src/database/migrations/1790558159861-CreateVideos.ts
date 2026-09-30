import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1790558159861 implements MigrationInterface {
  name = 'CreateVideos1790558159861';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_status_enum" AS ENUM('awaiting_upload', 'uploading', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_publication_status_enum" AS ENUM('draft', 'published')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(16) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL, "description" text, "original_filename" character varying(255) NOT NULL, "content_type" character varying(100) NOT NULL, "size_bytes" bigint NOT NULL, "storage_key" character varying(512) NOT NULL, "thumbnail_key" character varying(512), "upload_id" character varying(255), "duration_seconds" integer, "metadata" jsonb, "processing_status" "public"."videos_processing_status_enum" NOT NULL DEFAULT 'awaiting_upload', "processing_error" text, "publication_status" "public"."videos_publication_status_enum" NOT NULL DEFAULT 'draft', "view_count" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cc84e47e199e109fa2a1c8c4fb" ON "videos" ("processing_status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cc84e47e199e109fa2a1c8c4fb"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_publication_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."videos_processing_status_enum"`,
    );
  }
}
