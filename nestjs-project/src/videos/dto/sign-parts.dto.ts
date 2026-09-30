import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

/**
 * Body of `POST /videos/:publicId/upload/parts`.
 *
 * The upper bound of each part number is `partCount`, which is derived from the
 * video's own `size_bytes` — a per-record value the schema layer cannot know.
 * It is enforced in the service; only the record-independent rules live here.
 */
export class SignPartsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
