import queueConfig from './queue.config';
import storageConfig from './storage.config';
import videoConfig from './video.config';

describe('video / storage / queue config factories', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const clear = (...keys: string[]) => {
    for (const key of keys) delete process.env[key];
  };

  describe('storageConfig', () => {
    it('should apply the Compose-facing defaults when nothing is set', () => {
      clear(
        'STORAGE_INTERNAL_ENDPOINT',
        'STORAGE_PUBLIC_ENDPOINT',
        'STORAGE_REGION',
        'STORAGE_BUCKET',
        'STORAGE_PRESIGN_TTL_SECONDS',
      );

      const config = storageConfig();

      expect(config.internalEndpoint).toBe('http://minio:9000');
      expect(config.publicEndpoint).toBe('http://localhost:9000');
      expect(config.region).toBe('us-east-1');
      expect(config.bucket).toBe('streamtube');
      expect(config.presignTtlSeconds).toBe(900);
    });

    it('should keep the internal endpoint free of localhost by default', () => {
      clear('STORAGE_INTERNAL_ENDPOINT');

      expect(storageConfig().internalEndpoint).not.toContain('localhost');
    });

    it('should read the two endpoints as independent values', () => {
      process.env.STORAGE_INTERNAL_ENDPOINT = 'http://storage-internal:9000';
      process.env.STORAGE_PUBLIC_ENDPOINT = 'https://cdn.example.com';

      const config = storageConfig();

      expect(config.internalEndpoint).toBe('http://storage-internal:9000');
      expect(config.publicEndpoint).toBe('https://cdn.example.com');
    });

    it('should coerce the presign TTL to a number', () => {
      process.env.STORAGE_PRESIGN_TTL_SECONDS = '60';

      const { presignTtlSeconds } = storageConfig();

      expect(presignTtlSeconds).toBe(60);
      expect(typeof presignTtlSeconds).toBe('number');
    });

    it('should expose the credentials read from the environment', () => {
      process.env.STORAGE_ACCESS_KEY = 'access';
      process.env.STORAGE_SECRET_KEY = 'secret';

      const config = storageConfig();

      expect(config.accessKey).toBe('access');
      expect(config.secretKey).toBe('secret');
    });
  });

  describe('queueConfig', () => {
    it('should apply defaults when nothing is set', () => {
      clear(
        'REDIS_HOST',
        'REDIS_PORT',
        'VIDEO_QUEUE_ATTEMPTS',
        'VIDEO_QUEUE_BACKOFF_MS',
        'VIDEO_QUEUE_PREFIX',
      );

      const config = queueConfig();

      expect(config.redisHost).toBe('redis');
      expect(config.redisPort).toBe(6379);
      expect(config.attempts).toBe(3);
      expect(config.backoffMs).toBe(5000);
      expect(config.keyPrefix).toBe('streamtube');
    });

    it('should let VIDEO_QUEUE_PREFIX move the whole queue to another keyspace', () => {
      // This is what isolates the suite from the worker running in Compose, so
      // the value has to be configurable and not a literal in the module.
      process.env.VIDEO_QUEUE_PREFIX = 'streamtube-elsewhere';

      expect(queueConfig().keyPrefix).toBe('streamtube-elsewhere');
    });

    it('should coerce port, attempts and backoff to numbers', () => {
      process.env.REDIS_PORT = '6380';
      process.env.VIDEO_QUEUE_ATTEMPTS = '5';
      process.env.VIDEO_QUEUE_BACKOFF_MS = '1000';

      const config = queueConfig();

      expect(config.redisPort).toBe(6380);
      expect(config.attempts).toBe(5);
      expect(config.backoffMs).toBe(1000);
      expect(typeof config.attempts).toBe('number');
    });
  });

  describe('videoConfig', () => {
    it('should resolve VIDEO_MAX_UPLOAD_BYTES to the 10GB default when absent', () => {
      clear('VIDEO_MAX_UPLOAD_BYTES');

      expect(videoConfig().maxUploadBytes).toBe(10737418240);
    });

    it('should let VIDEO_MAX_UPLOAD_BYTES override the default', () => {
      process.env.VIDEO_MAX_UPLOAD_BYTES = '1024';

      expect(videoConfig().maxUploadBytes).toBe(1024);
    });

    it('should apply the part size and thumbnail offset defaults', () => {
      clear('VIDEO_UPLOAD_PART_SIZE_BYTES', 'VIDEO_THUMBNAIL_OFFSET_SECONDS');

      const config = videoConfig();

      expect(config.uploadPartSizeBytes).toBe(67108864);
      expect(config.thumbnailOffsetSeconds).toBe(3);
    });

    it('should expose the accepted MIME types as an array, not raw CSV', () => {
      clear('VIDEO_ACCEPTED_MIME_TYPES');

      const { acceptedMimeTypes } = videoConfig();

      expect(Array.isArray(acceptedMimeTypes)).toBe(true);
      expect(acceptedMimeTypes).toEqual([
        'video/mp4',
        'video/quicktime',
        'video/x-matroska',
        'video/webm',
      ]);
    });

    it('should parse a custom CSV list trimming surrounding whitespace', () => {
      process.env.VIDEO_ACCEPTED_MIME_TYPES = 'video/mp4, video/webm ,';

      expect(videoConfig().acceptedMimeTypes).toEqual([
        'video/mp4',
        'video/webm',
      ]);
    });
  });
});
