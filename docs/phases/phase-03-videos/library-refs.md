---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1141.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-28T22:32:42-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1141.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-28T22:32:42-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-09-28T22:32:42-03:00"
  bullmq:
    version: "^5.81.5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-28T22:32:42-03:00"
  nanoid:
    version: "^3.3.19"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-09-28T22:32:42-03:00"
  ffmpeg:
    version: "5.1.9-0+deb12u1"
    context7_id: "/websites/ffmpeg_documentation"
    fetched_at: "2026-09-28T22:32:42-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T22:31:06-03:00"
---

# phase-03-videos — Library References

Distilled Context7 excerpts for the libraries this phase fixes. Every version below is
the one actually resolved inside the running containers (`docker compose exec`), not the
range in `package.json`. Re-fetch when a TD in `## Decisions Index` changes its
`Libraries` cell.

| Library | Version (installed) | Fixed by | Context7 ID |
|---|---|---|---|
| `@aws-sdk/client-s3` | 3.1141.0 | `phase-03-videos/TD-01` (A) | `/aws/aws-sdk-js-v3` |
| `@aws-sdk/s3-request-presigner` | 3.1141.0 | `phase-03-videos/TD-01` (A) | `/aws/aws-sdk-js-v3` |
| `@nestjs/bullmq` | 11.0.5 | `phase-03-videos/TD-03` (A) | `/nestjs/docs.nestjs.com` |
| `bullmq` | 5.81.5 | `phase-03-videos/TD-03` (A) | `/taskforcesh/bullmq` |
| `nanoid` | 3.3.19 | `phase-03-videos/TD-06` (C) | `/ai/nanoid` |
| `ffmpeg` (system package) | 5.1.9-0+deb12u1 | `phase-03-videos/TD-05` (B) | `/websites/ffmpeg_documentation` |

---

## @aws-sdk/client-s3

**Version line:** `^3.1141.0` — resolved `3.1141.0` in the API and worker images.
**Decided in:** `phase-03-videos/TD-01` Option A (single bucket, keys under
`videos/<publicId>/`, every access presigned).
**Context7 ID:** `/aws/aws-sdk-js-v3` (trust 9.6, 5132 snippets).

### 1. Multipart upload is three commands, not one

TD-02 Option C needs the multipart primitives exposed directly rather than the
`lib-storage` `Upload` helper, because the bytes never pass through the API. The commands
`src/storage/storage.service.ts` sends are the v3 command objects:

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  S3Client,
} from '@aws-sdk/client-s3';
```

`CreateMultipartUpload` answers with `UploadId`, which every subsequent `UploadPart` and
the final `CompleteMultipartUpload` must carry. `CompleteMultipartUpload` takes the
`{ PartNumber, ETag }` pairs the client collected from its own `PUT` responses — the SDK
serializes them into the documented `<CompleteMultipartUpload>` XML body, and **parts must
be sorted ascending by `PartNumber`** or the service rejects the assembly.

`AbortMultipartUpload` is the only way to reclaim already-stored parts of an upload that
is never completed; once `Complete` has run the multipart no longer exists and the object
can only be removed with `DeleteObject` (which is why the completion path in
`StorageService` carries both).

### 2. Two clients, one bucket

`S3Client` takes `endpoint` and `forcePathStyle` in its constructor config. This phase
instantiates it twice (`STORAGE_INTERNAL_CLIENT`, `STORAGE_SIGNING_CLIENT`) because a
presigned URL bakes the endpoint host into the signature: the API and worker reach MinIO
at the Compose service name, while the URL handed to a browser must resolve from outside
the Compose network. Signing is a local cryptographic operation — no round trip — so a
second client costs nothing at runtime.

### 3. `Range` and `206` are the storage service's job

`GetObject` served through a presigned URL answers `Range` requests with
`206 Partial Content` on its own. TD-07's whole point is that Node never sees those bytes,
so the project implements no partial-content logic of its own.

---

## @aws-sdk/s3-request-presigner

**Version line:** `^3.1141.0` — resolved `3.1141.0`. Kept in lockstep with
`@aws-sdk/client-s3`; the presigner signs that client's command objects, so a version
skew between the two is a signature-mismatch waiting to happen.
**Decided in:** `phase-03-videos/TD-01` Option A, consumed by TD-02 (upload) and TD-07
(playback/download).
**Context7 ID:** `/aws/aws-sdk-js-v3`.

### 1. `getSignedUrl(client, command, options)`

```typescript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

Context7, verbatim on the default: "The `expiresIn` configuration defaults to 900 seconds
if not explicitly provided." This project never relies on that default — `expiresIn` is
always passed from `storageConfig.presignTtlSeconds` so the TTL is one configured number
rather than a per-call constant.

### 2. What can be signed

Any command from `@aws-sdk/client-s3` — this phase signs `UploadPartCommand` (upload) and
`GetObjectCommand` (playback and download). Download differs from playback only by
`ResponseContentDisposition` on the `GetObjectCommand`, which the presigned URL carries as
a query-string override; no second storage object and no API-side proxying.

### 3. Header hoisting

`getSignedUrl` accepts `hoistableHeaders` / `signableHeaders` / `unhoistableHeaders` to
control whether an `x-amz-*` header travels in the query string or must be resent by the
client. This phase signs no SSE or custom headers, so the defaults apply — worth knowing
only if server-side encryption is added later, because a header that is signed but not
resent produces a `SignatureDoesNotMatch` that looks like a clock-skew bug.

---

## @nestjs/bullmq

**Version line:** `^11.0.5` — resolved `11.0.5`, matching `@nestjs/core ^11.0.1`.
**Decided in:** `phase-03-videos/TD-03` Option A (BullMQ over Redis) and
`phase-03-videos/TD-04` Option A (worker as its own Compose service).
**Context7 ID:** `/nestjs/docs.nestjs.com` (trust 9.5) — the framework's own Queues page is
the authority for the Nest wrapper; the engine semantics are under `bullmq` below.

### 1. `forRootAsync` for the connection, `registerQueueAsync` for the queue

```typescript
BullModule.registerQueueAsync({
  name: 'audio',
  useFactory: () => ({
    connection: { host: 'localhost', port: 6379 },
  }),
});
```

The `name` attribute is specified **outside** the factory function — the docs call this out
explicitly, and getting it wrong yields a queue registered under `undefined`. `src/queue/queue.module.ts`
follows this shape, injecting `queueConfig` so host, port, `attempts` and `backoffMs` all
come from configuration rather than literals.

### 2. `WorkerHost`, not `@Process`

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('audio')
export class AudioConsumer extends WorkerHost {
  async process(job: Job<any, any, string>): Promise<any> { /* switch (job.name) */ }
}
```

Context7 is explicit that "BullMQ uses this named processor pattern instead of the legacy
`@Process` decorator". Multiple job names on one queue are routed by a `switch (job.name)`
inside `process()`. `VideoProcessingProcessor` extends `WorkerHost` accordingly.

### 3. The consumer is registered where the worker boots, not where the producer lives

A `@Processor` class only consumes if its module is loaded in the process that boots it.
TD-04's split relies on exactly this: `VideoProcessingModule` (holding the processor) is
imported only by `src/worker.module.ts`, the root module of the `src/worker.ts` entrypoint,
while `AppModule` imports `QueueModule` alone for `@InjectQueue`-based producing. Importing
the processor module in the API would silently turn the API into a second consumer.

### 4. `@OnWorkerEvent` for lifecycle, and it fires on every attempt

`@OnWorkerEvent('failed')` inside a `WorkerHost` subclass subscribes the class to the
underlying BullMQ worker's events. It is **not** a "job gave up" hook — it fires once per
failed attempt, so a handler that writes terminal state must gate on
`job.attemptsMade >= job.opts.attempts` itself (see `bullmq` § 2 below).

### 5. Sandboxed processors are not usable here

The docs' `processors: [join(__dirname, 'processor')]` option forks the handler into a
child process where "dependency injection and the IoC container are unavailable". The
video processor needs the TypeORM repository and `StorageService`, so this option is out —
process isolation is achieved at the container level (TD-04) instead.

---

## bullmq

**Version line:** `^5.81.5` — resolved `5.81.5`. Pulled in as a direct dependency (not only
as `@nestjs/bullmq`'s peer) because the code imports `Job` and the failure types from it.
**Decided in:** `phase-03-videos/TD-03` Option A; failure semantics feed
`phase-03-videos/TD-08`.
**Context7 ID:** `/taskforcesh/bullmq` (trust 8.8, benchmark 88.33, 1719 snippets).

### 1. Retry is `attempts` + `backoff`, set once as `defaultJobOptions`

```typescript
await queue.add('test-retry', { foo: 'bar' }, { attempts: 3, backoff: 1000 });
```

A number means a fixed delay; `{ type: 'exponential', delay: 1000 }` means 1s, 2s, 4s, 8s…
`QueueModule` sets these as `defaultJobOptions` on the queue rather than per `add()` call,
so the retry ceiling TD-08 depends on is one configured value.

### 2. Terminal failure is read off the job, not off the error type

BullMQ emits `failed` on **every** attempt, not only the last one. TD-08's terminal state
must therefore be written only once the queue has given up, which
`VideoProcessingProcessor.onFailed` does by comparing the job's own counters:

```typescript
const ceiling = job.opts.attempts ?? 1;
if (job.attemptsMade < ceiling) return;   // transient — the queue will retry
```

Writing `FAILED` on an intermediate attempt would make a transient storage timeout look
permanent.

### 3. `UnrecoverableError` — available, deliberately unused here

```typescript
import { Worker, UnrecoverableError } from 'bullmq';
// throw new UnrecoverableError('Unrecoverable');
```

Throwing it "moves the job to the failed set without retries, overriding any attempts
settings". This phase does **not** use it: the processor cannot cheaply tell a permanently
undecodable object from a truncated download, so every failure walks the full backoff
ladder. Noted here because it is the correct lever if a future revision wants to
short-circuit known-permanent failures (e.g. ffprobe reporting an unsupported container)
instead of burning the attempt budget.

### 4. `removeOnFail: false` is what keeps a terminal failure inspectable

A job that exhausts `attempts` lands in the failed set. If `removeOnFail` were left to drop
it, the only trace of a terminal failure would be the `Video` row's processing state, with
no job-level error. `QueueModule` therefore keeps failed jobs and removes only completed
ones.

### 5. Concurrency is per worker instance

`new Worker(name, handler, { concurrency: N })` — and it can be raised at runtime. Under
`@nestjs/bullmq` this is the `concurrency` option on `@Processor`. This phase sets it
nowhere, so it stays at BullMQ's default of 1: FFmpeg is CPU- and disk-bound and the worker
writes the whole original to a temp file before probing it, so parallel jobs would contend
on both. Scaling is horizontal (more `video-worker` containers), not `concurrency`.

### 6. Redis restart loses enqueued jobs — by design, and it is survivable

The queue is Redis state. TD-03 accepts the loss because the video's own state lives in
PostgreSQL and reprocessing is re-enqueueing the same id (TD-09).

---

## nanoid

**Version line:** `^3.3.19` — resolved `3.3.19`. **Pinned to the 3.x line deliberately.**
**Decided in:** `phase-03-videos/TD-06` Option C (random ~11-char URL-safe id in a unique
column).
**Context7 ID:** `/ai/nanoid` (trust 9.9, 496 snippets).

### 1. The ESM×CommonJS trap — why 3.x and not latest

Context7's own module-structure page states it as a compatibility warning:

```javascript
// ✗ This will NOT work
const { nanoid } = require('nanoid')

// ✗ Use import instead
import { nanoid } from 'nanoid'
```

Every `nanoid` major from 4 upward ships ESM-only. This project emits CommonJS
(`typeorm-ts-node-commonjs` for migrations, `ts-jest` for the suites), so an ESM-only
`nanoid` fails at `require()` in the compiled runtime and in Jest — and **`tsc --noEmit`
does not catch it**, because the types resolve fine. `3.3.19` is the last line that ships a
CommonJS build. Upgrading this package is a build-system decision, not a dependency bump;
TD-06 names a `crypto.randomBytes` generator as the fallback if 3.x ever has to be dropped.

### 2. `customAlphabet(alphabet, defaultSize)`

```
## customAlphabet(alphabet: string, defaultSize?: number)
- alphabet (string) - Required - The characters to use for ID generation.
- defaultSize (number) - Optional - The default length for generated IDs.
```

Returns a generator function. `src/videos/public-id.util.ts` binds it once at module load
with the 64-character URL-safe alphabet (`A–Z a–z 0–9 _ -`) and length 11, so
`/watch/<publicId>` never needs escaping.

### 3. Size validation

`nanoid(-1)` and `customAlphabet(..., -1)` throw `RangeError: Wrong ID size`. Length is a
compile-time constant here (`PUBLIC_ID_LENGTH = 11`), so the guard is informational.

### 4. Collisions

64 characters over 11 positions is ~66 bits of randomness. TD-06 does not rely on that
alone: the column carries a unique constraint and draft creation retries on violation, so
correctness comes from the database and the alphabet only makes retries vanishingly rare.
Do **not** import `nanoid/non-secure` — it drops the crypto source and the unlisted-video
guarantee rests on ids being unguessable, not merely unique.

---

## ffmpeg (system package — `ffmpeg` + `ffprobe`)

**Version line:** `5.1.9-0+deb12u1`, the Debian bookworm package installed by
`nestjs-project/Dockerfile.worker` (`apt install -y … ffmpeg`) on top of `node:25.6.0-slim`.
Same version present in the API image, which is what lets the integration suites exercise
the adapters. **This is not an npm dependency** — TD-05 Option B rejects the wrapper
packages, so there is no entry for it in `package.json` and its version is pinned by the
base image, not by the lockfile.
**Decided in:** `phase-03-videos/TD-05` Option B (spawn the binaries directly from the
worker).
**Context7 ID:** `/websites/ffmpeg_documentation` (trust 9.9, 3913 snippets).

### 1. Single-frame extraction

```bash
ffmpeg -i in.avi -f image2 -frames:v 1 img.jpeg
```

`-frames:v 1` is what makes the output one image rather than a sequence.
`FfmpegThumbnailAdapter` builds this same line with `-ss <offset>` **before** `-i` (input
seeking, which is orders of magnitude faster than output seeking on a large file) and `-y`
so the process never blocks on the interactive overwrite prompt — a spawned child has no
one to answer it, and the job would hang instead of failing.

### 2. `-ss` past the end of a short video

Input seeking beyond the duration yields no frame and a non-zero exit. TD-05 makes the
offset configurable with a safe default precisely so short clips still produce a thumbnail.

### 3. The `thumbnail` filter is the alternative this phase does not use

```
## thumbnail
Select the most representative frame in a given sequence of consecutive frames.
- n (int) - Optional - Set the frames batch size to analyze. Default 100.
```

It picks a representative frame instead of a fixed timestamp, at the cost of decoding a
whole batch. TD-05 chose the fixed configurable offset: deterministic, and it reads only as
far into the file as the seek target.

### 4. `ffprobe` for duration and metadata

`FfprobeAdapter` spawns:

```bash
ffprobe -v error -print_format json -show_format -show_streams <file>
```

`-show_format` carries `duration` and `bit_rate`; `-show_streams` carries the per-stream
`codec_name`, `width`, `height` and `r_frame_rate`. `-print_format json` makes the output
parseable without scraping, and `-v error` keeps the banner off stdout so the JSON starts
at byte 0. Both binaries ship in the same Debian `ffmpeg` package — installing one installs
the other.

### 5. Why no npm wrapper

`fluent-ffmpeg` and the `ffmpeg-static` family add a dependency layer and, in the static
case, a second copy of the binary in the image. The project needs two fixed command lines,
not a command builder, and spawning directly keeps FFmpeg's own stderr available for the
job's failure message (TD-08).
