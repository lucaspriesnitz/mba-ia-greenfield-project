// `@Type()` reads design-time metadata, which nothing in a bare unit run has
// loaded yet — the app gets it transitively through NestFactory.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CompleteUploadDto } from './complete-upload.dto';

function isValid(payload: Record<string, unknown>): boolean {
  const dto = plainToInstance(CompleteUploadDto, payload);
  return validateSync(dto).length === 0;
}

describe('CompleteUploadDto', () => {
  it('accepts a contiguous ascending list', () => {
    expect(
      isValid({
        parts: [
          { partNumber: 1, etag: 'a' },
          { partNumber: 2, etag: 'b' },
          { partNumber: 3, etag: 'c' },
        ],
      }),
    ).toBe(true);
  });

  it('accepts a single part', () => {
    expect(isValid({ parts: [{ partNumber: 1, etag: 'a' }] })).toBe(true);
  });

  it('rejects an empty array', () => {
    expect(isValid({ parts: [] })).toBe(false);
  });

  it('rejects a missing array', () => {
    expect(isValid({})).toBe(false);
  });

  it('rejects an empty etag', () => {
    expect(isValid({ parts: [{ partNumber: 1, etag: '' }] })).toBe(false);
  });

  it('rejects a missing etag', () => {
    expect(isValid({ parts: [{ partNumber: 1 }] })).toBe(false);
  });

  it('rejects descending order', () => {
    expect(
      isValid({
        parts: [
          { partNumber: 2, etag: 'b' },
          { partNumber: 1, etag: 'a' },
        ],
      }),
    ).toBe(false);
  });

  it('rejects a gap in the sequence', () => {
    expect(
      isValid({
        parts: [
          { partNumber: 1, etag: 'a' },
          { partNumber: 3, etag: 'c' },
        ],
      }),
    ).toBe(false);
  });

  it('rejects a sequence that does not start at 1', () => {
    expect(
      isValid({
        parts: [
          { partNumber: 2, etag: 'b' },
          { partNumber: 3, etag: 'c' },
        ],
      }),
    ).toBe(false);
  });

  it('rejects a fractional part number', () => {
    expect(isValid({ parts: [{ partNumber: 1.5, etag: 'a' }] })).toBe(false);
  });
});
