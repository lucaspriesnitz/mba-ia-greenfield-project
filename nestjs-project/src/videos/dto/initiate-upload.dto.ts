import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body of `POST /videos`. It carries metadata only — never a byte of the file,
 * which travels straight from the client to storage (per phase-03-videos/TD-02).
 *
 * Two fields are deliberately under-decorated: `contentType` has no `@IsIn` and
 * `sizeBytes` has no `@Max`. Both rules exist, but they are domain rules with
 * their own HTTP status in the Error Catalog — `415 UNSUPPORTED_VIDEO_FORMAT`
 * and `413 VIDEO_UPLOAD_TOO_LARGE`. Declaring them here would collapse both
 * into a generic `400`, so the service checks them against `video.config`.
 */
export class InitiateUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Its extension becomes `<ext>` in `videos/<publicId>/original.<ext>`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @IsString()
  @IsNotEmpty()
  contentType: string;

  @IsInt()
  @Min(1)
  sizeBytes: number;
}
