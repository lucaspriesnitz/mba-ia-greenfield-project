import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SignPartsDto } from './sign-parts.dto';

function errorsFor(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(SignPartsDto, payload);
  return validateSync(dto).map((error) => error.property);
}

describe('SignPartsDto', () => {
  it('accepts a non-empty list of positive integers', () => {
    expect(errorsFor({ partNumbers: [2, 1, 7] })).toEqual([]);
  });

  it('accepts exactly 1000 entries', () => {
    const partNumbers = Array.from({ length: 1000 }, (_, i) => i + 1);
    expect(errorsFor({ partNumbers })).toEqual([]);
  });

  it('rejects more than 1000 entries', () => {
    const partNumbers = Array.from({ length: 1001 }, (_, i) => i + 1);
    expect(errorsFor({ partNumbers })).toContain('partNumbers');
  });

  it('rejects an empty array', () => {
    expect(errorsFor({ partNumbers: [] })).toContain('partNumbers');
  });

  it('rejects a missing array', () => {
    expect(errorsFor({})).toContain('partNumbers');
  });

  it.each([
    ['a fractional entry', [1.5]],
    ['a zero entry', [0]],
    ['a negative entry', [-3]],
    ['a non-numeric entry', ['two']],
  ])('rejects %s', (_label, partNumbers) => {
    expect(errorsFor({ partNumbers })).toContain('partNumbers');
  });

  /**
   * The upper bound is `partCount`, derived from the video's own `size_bytes`.
   * The schema layer has no record in hand, so it must let a large number
   * through and leave the bound to the service.
   */
  it('lets a number above any plausible partCount through', () => {
    expect(errorsFor({ partNumbers: [999999] })).toEqual([]);
  });
});
