import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoProcessingStatus, VideoPublicationStatus } from '../video.types';

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Random ~11-character URL-safe identifier. Foreign keys point at `id`,
   * never here (per phase-03-videos/TD-06).
   */
  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'bigint' })
  size_bytes: string;

  /** `videos/<public_id>/original.<ext>` (per phase-03-videos/TD-01). */
  @Column({ type: 'varchar', length: 512 })
  storage_key: string;

  /** `videos/<public_id>/thumbnail.jpg`, written by the worker. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** Multipart upload id from storage; cleared on completion or abort. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number | null;

  /**
   * `ffprobe` format + stream subset. Typed loosely on purpose: the shape is the
   * probe's, not ours, and `unknown` would force a cast at every write site
   * (TypeORM's QueryDeepPartialEntity also rejects `Record<string, unknown>`).
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.AWAITING_UPLOAD,
  })
  processing_status: VideoProcessingStatus;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({
    type: 'enum',
    enum: VideoPublicationStatus,
    default: VideoPublicationStatus.DRAFT,
  })
  publication_status: VideoPublicationStatus;

  @Column({ type: 'integer', default: 0 })
  view_count: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
