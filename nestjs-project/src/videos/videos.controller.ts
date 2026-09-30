import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import {
  CompleteUploadResult,
  DownloadUrlResult,
  InitiateUploadResult,
  PlaybackUrlResult,
  SignedPartView,
  VideosService,
} from './videos.service';

const SIGNED_PART_SCHEMA = {
  type: 'object',
  properties: {
    partNumber: { type: 'number' },
    url: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const;

@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Initiate a resumable video upload',
    description:
      'Pre-registers the video as a draft on the caller’s channel and opens a multipart upload at storage, returning presigned PUT URLs. The request body carries metadata only — no file bytes ever reach the API.',
  })
  @ApiBody({ type: InitiateUploadDto })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated and draft created',
    schema: {
      properties: {
        publicId: { type: 'string' },
        uploadId: { type: 'string' },
        partSizeBytes: { type: 'number' },
        partCount: { type: 'number' },
        parts: { type: 'array', items: SIGNED_PART_SCHEMA },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size exceeds the maximum upload size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Content type is not in the accepted list',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user, dto);
  }

  @Post(':publicId/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-sign presigned part URLs',
    description:
      'Issues fresh presigned PUT URLs for specific parts so an interrupted upload resumes instead of restarting. The response preserves the requested order.',
  })
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiBody({ type: SignPartsDto })
  @ApiResponse({
    status: 200,
    description: 'Parts re-signed',
    schema: {
      properties: { parts: { type: 'array', items: SIGNED_PART_SCHEMA } },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or a part number outside 1..partCount',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with that identifier belongs to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video has no upload in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: SignPartsDto,
  ): Promise<{ parts: SignedPartView[] }> {
    return {
      parts: await this.videosService.signUploadParts(
        user,
        publicId,
        dto.partNumbers,
      ),
    };
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a multipart upload',
    description:
      'Asks storage to assemble the uploaded parts, verifies the assembled size against the ceiling, moves the video to processing and enqueues the processing job. The request body carries part numbers and etags only.',
  })
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiBody({ type: CompleteUploadDto })
  @ApiResponse({
    status: 200,
    description: 'Object assembled and processing enqueued',
    schema: {
      properties: {
        publicId: { type: 'string' },
        processingStatus: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with that identifier belongs to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video has no upload in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'The assembled object exceeds the maximum upload size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user, publicId, dto);
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel an upload in progress',
    description:
      'Aborts the multipart upload at storage and discards the draft, leaving no residual parts in the bucket.',
  })
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiResponse({
    status: 204,
    description: 'Upload cancelled and draft discarded',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with that identifier belongs to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video has no upload in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user, publicId);
  }

  @Get(':publicId/playback-url')
  @ApiOperation({
    summary: 'Issue a presigned playback URL',
    description:
      'Returns a short-lived presigned GET URL for the stored video. The storage service answers Range requests with 206 Partial Content, so playback starts without a full download and the API serves no bytes. Each 200 increments the view count.',
  })
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiResponse({
    status: 200,
    description: 'Playback URL issued',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
        durationSeconds: { type: 'number', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with that identifier is reachable by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'The video is still being processed, or its processing failed terminally',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPlaybackUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<PlaybackUrlResult> {
    return this.videosService.getPlaybackUrl(user, publicId);
  }

  @Get(':publicId/download-url')
  @ApiOperation({
    summary: 'Issue a presigned download URL',
    description:
      'Returns a short-lived presigned GET URL carrying a content-disposition override, so the browser saves the file under its original name instead of playing it. Issuing a download URL is not a view and does not change the view count.',
  })
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiResponse({
    status: 200,
    description: 'Download URL issued',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No video with that identifier is reachable by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'The video is still being processed, or its processing failed terminally',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<DownloadUrlResult> {
    return this.videosService.getDownloadUrl(user, publicId);
  }
}
