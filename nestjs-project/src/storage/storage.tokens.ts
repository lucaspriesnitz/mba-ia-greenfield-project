/**
 * Two S3 clients, same credentials, different endpoints — the split is the
 * direct consequence of uploading straight to storage (per
 * phase-03-videos/TD-02). They live in their own file so `storage.service.ts`
 * can import the tokens without a cycle through `storage.module.ts`.
 */

/** Real byte I/O from inside the Compose network. Never used for signing. */
export const STORAGE_INTERNAL_CLIENT = 'STORAGE_INTERNAL_CLIENT';

/**
 * Signing only. Its endpoint is the browser-reachable one, so every URL handed
 * to a client carries a host the browser can resolve — never the Compose
 * service name.
 */
export const STORAGE_SIGNING_CLIENT = 'STORAGE_SIGNING_CLIENT';
