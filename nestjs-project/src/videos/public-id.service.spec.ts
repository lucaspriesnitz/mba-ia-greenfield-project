import { QueryFailedError } from 'typeorm';
import { PUBLIC_ID_MAX_ATTEMPTS, PublicIdService } from './public-id.service';

function makeUniqueError(column = 'public_id'): QueryFailedError {
  const err = new QueryFailedError(
    'INSERT',
    [],
    new Error(),
  ) as QueryFailedError & {
    code: string;
    detail: string;
  };
  err.code = '23505';
  err.detail = `Key (${column})=(abc) already exists.`;
  return err;
}

describe('PublicIdService', () => {
  describe('allocate', () => {
    it('persists on the first attempt and returns what the caller returned', async () => {
      const service = new PublicIdService();
      const persist = jest.fn().mockResolvedValue({ id: 'video-uuid' });

      const result = await service.allocate(persist);

      expect(result).toEqual({ id: 'video-uuid' });
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it('hands the generated public id to the caller instead of returning it', async () => {
      const service = new PublicIdService();
      const persist = jest.fn().mockResolvedValue('saved');

      await service.allocate(persist);

      const [publicId] = persist.mock.calls[0] as [string];
      expect(publicId).toHaveLength(11);
      expect(publicId).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('retries with a fresh id when the repository raises 23505 on public_id', async () => {
      const service = new PublicIdService();
      const persist = jest
        .fn()
        .mockRejectedValueOnce(makeUniqueError())
        .mockResolvedValue('saved');

      const result = await service.allocate(persist);

      expect(result).toBe('saved');
      expect(persist).toHaveBeenCalledTimes(2);
      const [firstId] = persist.mock.calls[0] as [string];
      const [secondId] = persist.mock.calls[1] as [string];
      expect(firstId).not.toBe(secondId);
    });

    it('keeps retrying across several consecutive collisions', async () => {
      const service = new PublicIdService();
      const persist = jest
        .fn()
        .mockRejectedValueOnce(makeUniqueError())
        .mockRejectedValueOnce(makeUniqueError())
        .mockRejectedValueOnce(makeUniqueError())
        .mockResolvedValue('saved');

      await expect(service.allocate(persist)).resolves.toBe('saved');
      expect(persist).toHaveBeenCalledTimes(4);
    });

    it('gives up once the attempt ceiling is exhausted, propagating the error', async () => {
      const service = new PublicIdService();
      const persist = jest.fn().mockRejectedValue(makeUniqueError());

      await expect(service.allocate(persist)).rejects.toBeInstanceOf(
        QueryFailedError,
      );
      expect(persist).toHaveBeenCalledTimes(PUBLIC_ID_MAX_ATTEMPTS);
    });

    it('propagates a failure that is not a unique violation without retrying', async () => {
      const service = new PublicIdService();
      const boom = new Error('connection reset');
      const persist = jest.fn().mockRejectedValue(boom);

      await expect(service.allocate(persist)).rejects.toBe(boom);
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it('propagates a unique violation on another column without retrying', async () => {
      const service = new PublicIdService();
      const other = makeUniqueError('nickname');
      const persist = jest.fn().mockRejectedValue(other);

      await expect(service.allocate(persist)).rejects.toBe(other);
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it('never repeats an id across attempts', async () => {
      const service = new PublicIdService();
      const persist = jest.fn().mockRejectedValue(makeUniqueError());

      await expect(service.allocate(persist)).rejects.toBeDefined();

      const ids = persist.mock.calls.map((call) => (call as [string])[0]);
      expect(new Set(ids).size).toBe(PUBLIC_ID_MAX_ATTEMPTS);
    });
  });
});
