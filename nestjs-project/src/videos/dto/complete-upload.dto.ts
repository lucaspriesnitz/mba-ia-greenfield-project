import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** One part the client already uploaded, as storage needs it back to assemble. */
export class UploadedPartDto {
  @IsInt()
  @Min(1)
  partNumber: number;

  @IsString()
  @IsNotEmpty()
  etag: string;
}

/**
 * Completion carries *every* part, so the sequence must start at 1 and ascend
 * with no gaps. Storage would reject a malformed list anyway, but it would do
 * so as an opaque 500 — catching it here keeps it a 400.
 */
@ValidatorConstraint({ name: 'ascendingContiguousParts', async: false })
export class AscendingContiguousParts implements ValidatorConstraintInterface {
  validate(parts: unknown): boolean {
    if (!Array.isArray(parts)) return false;
    return parts.every(
      (part, index) =>
        (part as UploadedPartDto | undefined)?.partNumber === index + 1,
    );
  }

  defaultMessage(): string {
    return 'parts must start at partNumber 1 and ascend with no gaps';
  }
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  @Validate(AscendingContiguousParts)
  parts: UploadedPartDto[];
}
