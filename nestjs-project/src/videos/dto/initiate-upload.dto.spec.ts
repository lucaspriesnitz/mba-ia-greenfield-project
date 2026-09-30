import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { InitiateUploadDto } from './initiate-upload.dto';

function errorsFor(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(InitiateUploadDto, payload);
  return validateSync(dto).map((error) => error.property);
}

const VALID = {
  title: 'A holiday clip',
  description: 'optional prose',
  filename: 'holiday.mp4',
  contentType: 'video/mp4',
  sizeBytes: 1024,
};

describe('InitiateUploadDto', () => {
  it('accepts a well-formed body', () => {
    expect(errorsFor(VALID)).toEqual([]);
  });

  function without(field: string): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...VALID };
    delete copy[field];
    return copy;
  }

  it('accepts a body without the optional description', () => {
    expect(errorsFor(without('description'))).toEqual([]);
  });

  it.each(['title', 'filename', 'contentType', 'sizeBytes'])(
    'rejects a body missing %s',
    (field) => {
      expect(errorsFor(without(field))).toContain(field);
    },
  );

  it.each(['title', 'filename'])('rejects %s longer than 255', (field) => {
    expect(errorsFor({ ...VALID, [field]: 'x'.repeat(256) })).toContain(field);
  });

  it.each(['title', 'filename', 'contentType'])(
    'rejects an empty %s',
    (field) => {
      expect(errorsFor({ ...VALID, [field]: '' })).toContain(field);
    },
  );

  it.each([
    ['a fractional size', 1024.5],
    ['zero', 0],
    ['a negative size', -1],
    ['a non-numeric size', 'big'],
  ])('rejects %s', (_label, sizeBytes) => {
    expect(errorsFor({ ...VALID, sizeBytes })).toContain('sizeBytes');
  });

  /**
   * The two domain rules are deliberately absent from the DTO: they carry their
   * own status codes (415 / 413) and the service owns them, so the schema layer
   * must let both through rather than collapsing them into a 400.
   */
  it('lets an unsupported content type through — 415 is the service’s call', () => {
    expect(errorsFor({ ...VALID, contentType: 'application/pdf' })).toEqual([]);
  });

  it('lets an oversized sizeBytes through — 413 is the service’s call', () => {
    expect(errorsFor({ ...VALID, sizeBytes: 10737418241 })).toEqual([]);
  });
});
