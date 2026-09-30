import * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

/** Joi types `value` as `any`; this is the shape the schema actually produces. */
type ValidatedEnv = Record<string, string | number>;

interface ValidationOutcome {
  value: ValidatedEnv;
  error?: Joi.ValidationError;
}

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'storage-access',
  STORAGE_SECRET_KEY: 'storage-secret',
};

const validate = (env: Record<string, string>): ValidationOutcome =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as ValidationOutcome;

const validateWithout = (...omitted: string[]): ValidationOutcome => {
  const env: Record<string, string> = { ...requiredEnv };
  for (const key of omitted) delete env[key];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  }) as ValidationOutcome;
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage credentials', () => {
  it('should reject bootstrap without STORAGE_ACCESS_KEY, naming the variable', () => {
    const { error } = validateWithout('STORAGE_ACCESS_KEY');
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY');
  });

  it('should reject bootstrap without STORAGE_SECRET_KEY, naming the variable', () => {
    const { error } = validateWithout('STORAGE_SECRET_KEY');
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_KEY');
  });

  it('should accept an environment carrying only the required variables', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
  });
});

describe('envValidationSchema — phase 03 defaults', () => {
  it('should default the storage endpoints to distinct internal and public values', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_INTERNAL_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
    expect(value.STORAGE_INTERNAL_ENDPOINT).not.toContain('localhost');
  });

  it('should default the remaining storage variables', () => {
    const { value } = validate({});
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_BUCKET).toBe('streamtube');
    expect(value.STORAGE_PRESIGN_TTL_SECONDS).toBe(900);
  });

  it('should default the queue variables', () => {
    const { value } = validate({});
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.VIDEO_QUEUE_ATTEMPTS).toBe(3);
    expect(value.VIDEO_QUEUE_BACKOFF_MS).toBe(5000);
    expect(value.VIDEO_QUEUE_PREFIX).toBe('streamtube');
  });

  it('should default VIDEO_MAX_UPLOAD_BYTES to 10GB and let it be overridden', () => {
    expect(validate({}).value.VIDEO_MAX_UPLOAD_BYTES).toBe(10737418240);
    expect(
      validate({ VIDEO_MAX_UPLOAD_BYTES: '2048' }).value.VIDEO_MAX_UPLOAD_BYTES,
    ).toBe(2048);
  });

  it('should default the remaining video variables', () => {
    const { value } = validate({});
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.VIDEO_THUMBNAIL_OFFSET_SECONDS).toBe(3);
    expect(value.VIDEO_ACCEPTED_MIME_TYPES).toBe(
      'video/mp4,video/quicktime,video/x-matroska,video/webm',
    );
  });

  it('should reject a non-numeric VIDEO_MAX_UPLOAD_BYTES', () => {
    const { error } = validate({ VIDEO_MAX_UPLOAD_BYTES: 'not-a-number' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_MAX_UPLOAD_BYTES');
  });
});
