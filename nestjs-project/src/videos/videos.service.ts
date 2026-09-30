import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { JwtPayload } from '../auth/auth.types';
import { Channel } from '../channels/entities/channel.entity';
import videoConfig from '../config/video.config';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { originalKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import {
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoProcessingFailedException,
  VideoUploadNotInProgressException,
  VideoUploadTooLargeException,
} from './exceptions/video.exceptions';
import { PublicIdService } from './public-id.service';
import { VideoProcessingStatus, VideoPublicationStatus } from './video.types';

/** One presigned part as the HTTP layer hands it out — `expiresAt` as ISO-8601. */
export interface SignedPartView {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface InitiateUploadResult {
  publicId: string;
  uploadId: string;
  partSizeBytes: number;
  partCount: number;
  parts: SignedPartView[];
}

export interface CompleteUploadResult {
  publicId: string;
  processingStatus: VideoProcessingStatus;
}

export interface PlaybackUrlResult {
  url: string;
  expiresAt: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
}

export interface DownloadUrlResult {
  url: string;
  expiresAt: string;
}

/**
 * Lowercased extension of a filename, or `null` when there is none. A leading
 * dot (`.env`) is not an extension, and neither is a trailing dot.
 */
export function fileExtension(filename: string): string | null {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly publicIdService: PublicIdService,
    private readonly storageService: StorageService,
    private readonly producer: VideoProcessingProducer,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * Pre-registers the draft and opens the multipart upload in one operation.
   * The response is the client's whole contract with storage: it uploads every
   * part straight to the presigned URLs and the API never sees a byte
   * (per phase-03-videos/TD-02).
   */
  async initiateUpload(
    user: JwtPayload,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    // Both checks come before any write or any storage call: a rejected
    // initiation must leave neither a row nor an open multipart behind.
    if (!this.config.acceptedMimeTypes.includes(dto.contentType)) {
      throw new UnsupportedVideoFormatException();
    }
    if (dto.sizeBytes > this.config.maxUploadBytes) {
      throw new VideoUploadTooLargeException();
    }

    const channel = await this.channelRepository.findOne({
      where: { user_id: user.sub },
    });
    if (!channel) {
      throw new Error(`Authenticated user ${user.sub} has no channel`);
    }

    const partSizeBytes = this.config.uploadPartSizeBytes;
    const partCount = Math.ceil(dto.sizeBytes / partSizeBytes);
    const ext = fileExtension(dto.filename);

    // The whole draft is written inside the retry envelope, because the unique
    // constraint on `videos.public_id` is the only authority on whether an id
    // is free (per phase-03-videos/TD-06).
    const video = await this.publicIdService.allocate(async (publicId) => {
      const storageKey = originalKey(publicId, ext);
      const uploadId = await this.storageService.createMultipartUpload(
        storageKey,
        dto.contentType,
      );

      return this.videoRepository.save(
        this.videoRepository.create({
          public_id: publicId,
          channel_id: channel.id,
          title: dto.title,
          description: dto.description ?? null,
          original_filename: dto.filename,
          content_type: dto.contentType,
          size_bytes: String(dto.sizeBytes),
          storage_key: storageKey,
          upload_id: uploadId,
          processing_status: VideoProcessingStatus.UPLOADING,
          publication_status: VideoPublicationStatus.DRAFT,
        }),
      );
    });

    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const parts = await this.storageService.signUploadParts(
      video.storage_key,
      video.upload_id!,
      partNumbers,
    );

    return {
      publicId: video.public_id,
      uploadId: video.upload_id!,
      partSizeBytes,
      partCount,
      parts: parts.map((part) => ({
        partNumber: part.partNumber,
        url: part.url,
        expiresAt: part.expiresAt.toISOString(),
      })),
    };
  }

  /**
   * Re-signs part URLs so an interrupted upload resumes instead of restarting.
   * The response preserves the requested order, because the client maps it back
   * onto its own outstanding parts (per phase-03-videos/TD-02).
   */
  async signUploadParts(
    user: JwtPayload,
    publicId: string,
    partNumbers: number[],
  ): Promise<SignedPartView[]> {
    const video = await this.findOwnedVideo(user, publicId);
    const uploadId = this.requireOpenUpload(video);

    const partCount = this.partCountOf(video);
    const outOfRange = partNumbers.filter((number) => number > partCount);
    if (outOfRange.length > 0) {
      // The bound is per-record, so it cannot live on the DTO. The existing
      // ValidationExceptionFilter renders this as the canonical
      // `{ 400, VALIDATION_ERROR, [...] }` envelope, which is exactly what the
      // API contract calls for — a validation error, not a domain code.
      throw new BadRequestException(
        `partNumbers must be between 1 and ${partCount}; received ${outOfRange.join(
          ', ',
        )}`,
      );
    }

    const parts = await this.storageService.signUploadParts(
      video.storage_key,
      uploadId,
      partNumbers,
    );

    return parts.map((part) => ({
      partNumber: part.partNumber,
      url: part.url,
      expiresAt: part.expiresAt.toISOString(),
    }));
  }

  /**
   * Asks storage to assemble the object, verifies the assembled size against
   * the ceiling, and only then enqueues processing. The declared `sizeBytes`
   * from initiation is never trusted here — the API has not seen a single byte,
   * so storage's own report is the only measurement there is
   * (per phase-03-videos/TD-02).
   */
  async completeUpload(
    user: JwtPayload,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedVideo(user, publicId);
    const uploadId = this.requireOpenUpload(video);

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      uploadId,
      dto.parts,
    );

    const head = await this.storageService.headObject(video.storage_key);
    if (head.contentLength > this.config.maxUploadBytes) {
      // The multipart is already consumed, so "abort" here means deleting the
      // assembled object and discarding the draft: its declared size was a lie
      // and its bytes are gone, so the record can never become valid.
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.remove(video);
      throw new VideoUploadTooLargeException();
    }

    video.upload_id = null;
    video.processing_status = VideoProcessingStatus.PROCESSING;
    await this.videoRepository.save(video);

    // Strictly after storage confirmed the object: a job enqueued earlier could
    // be picked up before the bytes exist (per phase-03-videos/TD-09).
    await this.producer.enqueue(video.id);

    return {
      publicId: video.public_id,
      processingStatus: video.processing_status,
    };
  }

  /** Cancels an upload in flight: no object, no parts, no draft left behind. */
  async abortUpload(user: JwtPayload, publicId: string): Promise<void> {
    const video = await this.findOwnedVideo(user, publicId);
    const uploadId = this.requireOpenUpload(video);

    await this.storageService.abortMultipartUpload(video.storage_key, uploadId);
    await this.videoRepository.remove(video);
  }

  /**
   * Playback is a presigned `GET` handed to the client: the storage service is
   * what answers `Range` with `206 Partial Content`, and the API never carries
   * a byte of the video (per phase-03-videos/TD-07).
   */
  async getPlaybackUrl(
    user: JwtPayload,
    publicId: string,
  ): Promise<PlaybackUrlResult> {
    const video = await this.findViewableVideo(user, publicId);
    this.requireProcessed(video);

    const playback = await this.storageService.signDownloadUrl(
      video.storage_key,
    );
    const thumbnail = video.thumbnail_key
      ? await this.storageService.signDownloadUrl(video.thumbnail_key)
      : null;

    // The count binds to the request that issues the URL, not to the byte
    // transfer the API never observes (per phase-03-videos/TD-07). Atomic, so
    // concurrent issuances do not lose one another.
    await this.videoRepository.increment({ id: video.id }, 'view_count', 1);

    return {
      url: playback.url,
      expiresAt: playback.expiresAt.toISOString(),
      durationSeconds: video.duration_seconds,
      thumbnailUrl: thumbnail?.url ?? null,
    };
  }

  /**
   * The same presigned mechanism as playback plus the content-disposition
   * override, and deliberately no view count: a download is not a view
   * (per phase-03-videos/TD-07).
   */
  async getDownloadUrl(
    user: JwtPayload,
    publicId: string,
  ): Promise<DownloadUrlResult> {
    const video = await this.findViewableVideo(user, publicId);
    this.requireProcessed(video);

    const signed = await this.storageService.signDownloadUrl(
      video.storage_key,
      { attachmentFilename: video.original_filename },
    );

    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  /**
   * `### Authorization Matrix`: a published video is reachable by any
   * authenticated caller, a draft only by its owner. Phase 03 ships no publish
   * transition, so in practice every video is still a draft.
   */
  private async findViewableVideo(
    user: JwtPayload,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (
      video.publication_status !== VideoPublicationStatus.PUBLISHED &&
      video.channel.user_id !== user.sub
    ) {
      // The same exception as a non-existent id, byte for byte — never a 403.
      throw new VideoNotFoundException();
    }

    return video;
  }

  /**
   * The two 409s are distinct on purpose: the first is transient and retrying
   * makes sense, the second is terminal and only a re-enqueue changes it
   * (per phase-03-videos/TD-08).
   */
  private requireProcessed(video: Video): void {
    if (video.processing_status === VideoProcessingStatus.FAILED) {
      throw new VideoProcessingFailedException();
    }
    if (video.processing_status !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException();
    }
  }

  /**
   * A video the caller does not own is indistinguishable from one that does not
   * exist — a probing request must not confirm that an identifier is real,
   * which is what makes the non-enumerable `public_id` worth having.
   */
  private async findOwnedVideo(
    user: JwtPayload,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });

    if (!video || video.channel.user_id !== user.sub) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private requireOpenUpload(video: Video): string {
    if (!video.upload_id) {
      throw new VideoUploadNotInProgressException();
    }
    return video.upload_id;
  }

  /** `size_bytes` is a bigint column, so the pg driver hands it back as a string. */
  private partCountOf(video: Video): number {
    return Math.ceil(
      Number(video.size_bytes) / this.config.uploadPartSizeBytes,
    );
  }
}
