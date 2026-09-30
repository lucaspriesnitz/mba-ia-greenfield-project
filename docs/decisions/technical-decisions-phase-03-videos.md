---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-27
scope_description: "Backend foundation for video upload and processing: object storage layout, 10GB upload strategy, background processing queue, worker runtime, metadata/thumbnail extraction, unique public video identifier, streaming and download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the whole phase: videos module, object storage integration, processing queue, video worker, upload/streaming/download endpoints, videos table migration, and the new Compose services (storage, queue, worker).
- `next-frontend/` — no open decision in this document. The video interface is explicitly out of scope for this phase; the frontend is untouched and no capability of Fase 03 requires it.

---

## TD-01: Object Storage Client and Bucket/Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage technology itself is not an open choice — the target architecture (`docs/diagrams/software-arch.mermaid`) states `Object Storage — S3 or MinIO`, so the project runs MinIO locally in Docker and would swap for S3 in production. Because MinIO implements the S3 API, the same client library serves both and no dev/prod abstraction layer is required: the swap is client configuration. What remains open is how the bucket namespace is organized and how object keys are derived, which every other decision in this document reads from.

**Options:**

### Option A: Single bucket, per-video key prefix
- One bucket (e.g. `streamtube`) holding both originals and thumbnails, keyed by the video's public identifier: `videos/<publicId>/original.<ext>` and `videos/<publicId>/thumbnail.jpg`. All access is presigned, for both object kinds.
- **Pros:** One bucket to provision and one policy to reason about. Every object of a video is co-located under one prefix, so listing, debugging and deletion are a single prefix operation. No public-read surface anywhere — unlisted videos leak nothing, not even their thumbnails.
- **Cons:** Cannot apply different lifecycle or cache policies to thumbnails versus originals without prefix-scoped rules. Every thumbnail render needs a presigned URL.

### Option B: Two buckets, public-read thumbnails
- `streamtube-videos` (private, presigned only) and `streamtube-thumbnails` (public-read). Listings link thumbnails directly with no signature.
- **Pros:** Listing pages need no signing round of any kind for thumbnails; thumbnails become cacheable by any CDN with no expiry coupling.
- **Cons:** Introduces a public-read surface. A thumbnail of an unlisted video becomes fetchable by anyone holding the key, which weakens the "unlisted is only reachable by direct link" guarantee to "unguessable key". Two buckets to provision and keep in sync.

### Option C: Bucket per environment
- `streamtube-dev`, `streamtube-prod`, selected by configuration.
- **Pros:** Environment isolation enforced at the bucket boundary.
- **Cons:** Solves a problem the project does not have — environments already differ by endpoint and credentials. Adds naming coupling to configuration with no gain for the phase.

**Recommendation:** **Option A** — signing a presigned URL is a local cryptographic operation with no round trip to the storage service, so the cost Option B optimizes away is negligible, while the public-read surface it introduces is a real weakening of the unlisted guarantee. Keeping every object of a video under one prefix also makes deletion and inspection trivial.

**Decision:** A — single bucket, keys derived from the video's public identifier (`videos/<publicId>/original.<ext>`, `videos/<publicId>/thumbnail.jpg`), all access presigned.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: 10GB Upload Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance · Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A 10GB file cannot traverse a Node.js process without paying for it in memory, event-loop time and connection fragility, and `docs/project-plan.md` §4 states the upload must not lock the system and must be resumable on connection failure. This decision sets who receives the bytes and therefore shapes the upload endpoints, the draft pre-registration moment, and the front contract for a future phase.

**Options:**

### Option A: Bytes through the API
- The client posts the file to a NestJS endpoint (`multipart/form-data` or raw stream) and the API pipes it into storage.
- **Pros:** One code path, full server-side control over validation, no storage endpoint exposed to the client.
- **Cons:** 10GB crosses the API container, competing with request handling for CPU, memory and sockets. A dropped connection restarts the whole transfer. This is the failure mode the requirement explicitly forbids.

### Option B: Presigned single PUT
- The API issues one presigned `PUT` URL and the client uploads the whole object in a single request directly to storage.
- **Pros:** Bytes never touch Node. Simple: one signature, one request.
- **Cons:** No resumability — a failure at 9GB restarts from zero. S3-compatible single-part uploads are also capped well below 10GB in practice, so the requirement cannot be met this way.

### Option C: Presigned multipart upload
- The API initiates a multipart upload, pre-registers the video as a draft and returns the upload id plus presigned URLs per part; the client uploads parts directly to storage and calls a completion endpoint, which asks storage to assemble the object and enqueues processing.
- **Pros:** Bytes never touch Node. Parts are independently retryable, which is exactly the resumability the requirement asks for. Parallel part upload raises throughput. The initiate step is the natural place for the draft pre-registration the phase requires.
- **Cons:** Three-step protocol (initiate → upload parts → complete) instead of one request, so the client is more involved and abandoned uploads need cleanup. The storage endpoint reachable by the browser differs from the internal Compose service name, so two endpoint configurations are required.

**Recommendation:** **Option C** — it is the only option that satisfies both halves of the written requirement (10GB without loading the system, resumable on connection failure), and its initiate step maps one-to-one onto the mandated draft pre-registration.

**Decision:** C — presigned multipart upload, with `initiate` creating the draft and `complete` enqueueing processing. Storage is configured with two endpoints: the internal Compose service name for API and worker, and a browser-reachable endpoint used when signing.

---

## TD-03: Background Processing Queue

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** This is the phase's one genuinely open stack decision — the target architecture marks the queue as `Message Queue — TBD`. `docs/project-plan.md` §4 states that metadata extraction is heavy and must run in the background without blocking the user. The video record carries a processing status that the channel dashboard displays, so retry semantics and observable progress are part of the requirement, not infrastructure polish.

**Options:**

### Option A: BullMQ over Redis
- Redis as a Compose service; BullMQ as the queue, integrated through the official `@nestjs/bullmq` package. Producer in the API module, consumer in the worker.
- **Pros:** Retry with exponential backoff, attempt ceilings, configurable concurrency, job progress and delayed jobs all come as library features rather than project code. First-party NestJS integration matches the stack. Redis is a single lightweight container.
- **Cons:** One more service in Compose. Queue state lives in Redis memory, so a Redis loss drops enqueued jobs.

### Option B: pg-boss over PostgreSQL
- The queue lives in the existing PostgreSQL 17 instance as dedicated tables.
- **Pros:** No new container. Jobs are durable and transactional with the domain data, so enqueueing can share a transaction with the draft insert.
- **Cons:** Progress reporting and concurrency control are thinner and largely become project code. The database that serves product reads also carries queue polling. No first-party NestJS integration.

### Option C: RabbitMQ
- A dedicated broker with exchanges and routing.
- **Pros:** Mature broker semantics, strong delivery guarantees, good fit for fan-out topologies.
- **Cons:** Solves routing complexity this phase does not have — one producer, one job type, one consumer. Heaviest operational footprint of the three.

### Option D: In-process background work
- The API schedules the work itself, via `worker_threads` or a deferred task, with no broker.
- **Pros:** No new infrastructure at all.
- **Cons:** FFmpeg over a 10GB file runs inside the container that serves requests, which is the blocking the requirement forbids. No retry, no visibility, and work is lost on restart.

**Recommendation:** **Option A** — the requirement's real content is that processing must be observable and recoverable, and BullMQ delivers retry, backoff, concurrency and progress without project code. The cost is one small container in an environment that already runs several. Losing enqueued jobs on a Redis restart is acceptable because the video's state lives in PostgreSQL and reprocessing is re-enqueueing the same id (TD-09).

**Decision:** A — BullMQ over Redis, Redis as a Compose service, integrated via `@nestjs/bullmq`. Package versions are pinned in `library-refs.md`.
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-04: Worker Runtime Topology

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados) · Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Something has to consume the queue and run FFmpeg. The target architecture already draws `Video Worker — FFmpeg` as its own container, and `CLAUDE.md` requires everything to run in containers with service names as hosts. What is open is whether the worker is a separate deployable and how it shares code with the API.

**Options:**

### Option A: Separate Compose service, NestJS standalone application
- A dedicated service built from the same `nestjs-project` source with FFmpeg installed in its image, booting a NestJS application context with no HTTP server, registering only the queue consumer.
- **Pros:** FFmpeg never competes with request handling for CPU. Scales and restarts independently. Reuses entities, repositories and the storage client with no duplication, since it is the same codebase with a different entry point. Matches the drawn architecture.
- **Cons:** A second build target and a second container to keep in the Compose file. Shared code means a change in the API module can affect the worker.

### Option B: Same container, separate process
- The API image also starts a worker process, supervised inside one container.
- **Pros:** One image, one service.
- **Cons:** FFmpeg and the HTTP server share CPU and memory limits, which reintroduces the contention the phase is trying to avoid. Two processes in one container also complicates restarts and logs.

### Option C: Consumer inside the API process
- The queue consumer registers in the running API application.
- **Pros:** Simplest possible wiring.
- **Cons:** Same contention as Option B with no isolation at all — heavy transcoding work directly inside the request-serving event loop's process.

**Recommendation:** **Option A** — it is the only option that actually isolates heavy work from request handling, and it costs a build target rather than duplicated code because the worker is the same application booted without an HTTP listener.

**Decision:** A — worker as its own Compose service, a NestJS standalone application from the same source with FFmpeg in the image.

---

## TD-05: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados) · Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must read duration and metadata from the uploaded file and produce a thumbnail from one frame. The tool is FFmpeg (with `ffprobe` for inspection); what is open is how the Node process drives it and where the binaries come from.

**Options:**

### Option A: `fluent-ffmpeg` wrapper
- A fluent JavaScript API that builds and runs FFmpeg command lines.
- **Pros:** Readable chained API, handles argument assembly, widely used with many examples.
- **Cons:** An extra dependency whose release cadence lags FFmpeg's, wrapping a CLI the project would otherwise call directly. Errors surface as wrapper errors, one level removed from the actual FFmpeg output.

### Option B: Direct `child_process` invocation of `ffprobe`/`ffmpeg`
- The worker spawns the binaries itself: `ffprobe -v quiet -print_format json -show_format -show_streams` for duration and metadata, and `ffmpeg -ss <t> -i <input> -frames:v 1` for the thumbnail frame. Binaries come from the system package installed in the worker image.
- **Pros:** No extra dependency, and the exact command line is visible in the code and in logs. Full access to FFmpeg's stderr for diagnosing failures. The binary version is pinned by the image, not by an npm wrapper.
- **Cons:** The project assembles and escapes arguments itself, and parses `ffprobe` JSON output by hand.

### Option C: npm-distributed FFmpeg binary
- A package such as `@ffmpeg-installer/ffmpeg` ships the binary through npm instead of the image.
- **Pros:** No system package needed; the binary version is locked in the lockfile.
- **Cons:** Platform-specific binaries downloaded at install time, which is fragile in a slim Debian image and adds install weight. The image already installs system packages, so this solves nothing here.

**Recommendation:** **Option B** — the project needs two fixed command lines, not a command builder, and spawning directly keeps FFmpeg's own error output available while removing a dependency layer between the code and the tool.

**Decision:** B — spawn `ffprobe` and `ffmpeg` directly from the worker, binaries installed as system packages in the worker image. The thumbnail frame timestamp is a configurable offset with a safe default for short videos.
**Libraries:** ffmpeg

---

## TD-06: Unique Public Video Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** `docs/project-plan.md` §4 asks for a short, unique URL per video that never conflicts with another. "Short" rules out a UUID in the path; "never conflicts" rules out deriving the identifier from the title. The identifier also has to exist from the moment the upload starts, because the draft is pre-registered before the file is complete. Existing entities in the project use UUID primary keys, and this decision does not change that — it adds a separate public identity.

**Options:**

### Option A: UUID in the URL
- The primary key itself is the public identifier.
- **Pros:** No extra column, no extra generation step, collision-free by construction.
- **Cons:** 36 characters is not short, which fails the stated requirement. Also exposes the internal key in every public URL.

### Option B: Sequential identifier encoded in base62
- A database sequence rendered in a compact alphabet.
- **Pros:** Shortest possible identifiers, guaranteed unique with no retry logic, and naturally ordered.
- **Cons:** Enumerable. Anyone can walk the space and discover videos, which breaks the platform's unlisted guarantee — an unlisted video would be reachable by counting rather than by holding the link. Also leaks total catalogue size.

### Option C: Random short identifier in a unique column
- An ~11-character URL-safe random string (nanoid alphabet) stored in its own column with a unique constraint, generated when the draft is created; collisions retried on constraint violation.
- **Pros:** Short and not enumerable, so the unlisted guarantee holds. Separates public identity from the internal key, so foreign keys stay on the UUID and no public route exposes it.
- **Cons:** Needs a uniqueness constraint plus retry-on-collision, and one extra indexed column.

**Recommendation:** **Option C** — the platform's unlisted requirement makes non-enumerability a functional constraint, not a preference, and that rules out the sequential option regardless of how compact it is.

**Decision:** C — a random ~11-character URL-safe identifier in a dedicated unique column, generated at draft creation, with collision retried on unique-constraint violation. The canonical public route is `/watch/<publicId>`. The generator package and version are pinned in `library-refs.md`; the ESM-only distribution of recent `nanoid` majors must be validated against this project's CommonJS build before pinning, with a `crypto.randomBytes`-based generator as the fallback.
**Libraries:** nanoid

---

## TD-07: Video Delivery — Streaming and Download

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo) · Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, which means HTTP range requests answered with `206 Partial Content`, and the user must also be able to download the file. Both read the same stored object, so this is one decision about who serves those bytes.

**Options:**

### Option A: API proxies the bytes
- A NestJS endpoint reads the object from storage and streams it to the client, parsing `Range` headers and answering `206` itself.
- **Pros:** Full server-side control per request — authorization, view counting and rate limiting all sit naturally in the request path. The storage endpoint is never exposed to the client.
- **Cons:** Every watched byte crosses the API container, so playback traffic competes with request handling exactly as the 10GB upload would. Range handling, partial responses and caching headers all become project code.

### Option B: Presigned GET direct to storage
- The API issues a short-lived presigned `GET` URL and the client fetches the object straight from storage, which honours `Range` and answers `206 Partial Content` natively. Download uses the same mechanism with a response content-disposition override forcing an attachment.
- **Pros:** No playback bytes in Node. Range and partial responses are the storage service's own implementation rather than project code. Authorization still happens server-side, because obtaining the URL requires a request the API authorizes; short expiry limits sharing. Consistent with the upload path (TD-02).
- **Cons:** The client learns a storage URL, so the browser-reachable endpoint must exist. View counting attaches to the URL-issuing request rather than to the byte transfer, and playback cannot be interrupted once a URL is issued until it expires.

### Option C: Hybrid — proxy for streaming, presigned for download
- Playback through the API, download direct.
- **Pros:** Keeps per-request control over the playback path.
- **Cons:** Two delivery mechanisms to build and test, and it keeps the higher-volume path (playback) inside Node, which is the wrong half to keep.

**Recommendation:** **Option B** — the storage service already implements range requests correctly, and routing playback through Node would reintroduce the exact contention this phase is designed to avoid while forcing the project to reimplement partial-content semantics.

**Decision:** B — playback and download are served by short-lived presigned `GET` URLs issued by authorized API endpoints; the storage service answers `Range` with `206 Partial Content`, and download forces an attachment disposition. View counting is recorded when the playback URL is issued.

---

## TD-08: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload · Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video is pre-registered as a draft before the file exists, then moves through upload and background processing, and the channel dashboard displays its status. The phase requires a status cycle reaching a terminal error state, so the vocabulary is an interface contract, not an internal detail.

**Options:**

### Option A: Single status enum
- One column covering every situation the video can be in.
- **Pros:** One field to read and filter on, trivially simple to store.
- **Cons:** Conflates independent questions, so the enum has to name every crossing and can represent illegal states. Later phases add publication and visibility, at which point combinations such as "published but still processing" become expressible and have to be defended in code.

### Option B: Orthogonal status fields
- Separate fields for processing state (awaiting upload → uploading → processing → ready, with failed as terminal) and for the publication state the draft flow needs, with the single rule that publishing requires processing to be ready.
- **Pros:** Each field answers one question, illegal combinations are not representable, and the dependency between them lives in one validation rule. Filtering "watchable" is an explicit conjunction rather than an implicit enum reading.
- **Cons:** More than one column to read, and queries must state the conjunction explicitly.

### Option C: Event-sourced state
- Persist processing events and derive the current state.
- **Pros:** Full audit trail of every transition.
- **Cons:** Far beyond what the phase requires, and every read of a status becomes a projection. No capability in Fase 03 asks for transition history.

**Recommendation:** **Option B** — the phase already carries two independent questions about the same record (has the file been processed, is it still a draft), and separating them keeps illegal states unrepresentable at the cost of one explicit conjunction in queries.

**Decision:** B — orthogonal status fields, with processing state reaching a terminal failure state that the channel dashboard can display, and publication gated on processing being ready. On exhausting the retry ceiling the video is left in the terminal failure state rather than silently retried forever; reprocessing is re-enqueueing the same id.

---

## TD-09: Processing Job Contract

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas) · Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The API enqueues and the worker consumes, so the job payload is the contract between them and belongs in the plan's Events/Messages specification. What the payload carries determines whether a job can be safely retried later.

**Options:**

### Option A: Fat payload
- The job carries the storage key, the file size, the channel and the title.
- **Pros:** The worker needs no database read before starting.
- **Cons:** Duplicates state that already lives in PostgreSQL, so a retry can run against stale values. Any change to the payload shape becomes a migration of in-flight jobs.

### Option B: Thin payload — video id only
- The job carries the video's identifier; the worker loads the record and derives the storage key from it.
- **Pros:** Nothing in the job can go stale, so a retry hours later behaves like the first attempt. Re-enqueueing by id is the whole reprocessing mechanism. The payload shape never needs to change.
- **Cons:** One database read per job before work starts.

### Option C: Full entity snapshot
- The job carries a serialized copy of the video record.
- **Pros:** Complete context travels with the job.
- **Cons:** Largest payload, worst staleness, and it couples the queue to the entity's shape.

**Recommendation:** **Option B** — one indexed read is a negligible cost next to decoding a video file, and it is what makes retry and manual reprocessing idempotent from the job's point of view.

**Decision:** B — the job carries only the video identifier. The worker loads the record, reads the object from storage through the internal endpoint, and writes duration, metadata, thumbnail key and processing state back.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Client and Bucket/Key Layout | Single bucket, per-video key prefix | A (single bucket, `videos/<publicId>/...`, all presigned) |
| TD-02 | Backend | 10GB Upload Strategy | Presigned multipart upload | C (presigned multipart, initiate creates draft, complete enqueues) |
| TD-03 | Backend | Background Processing Queue | BullMQ over Redis | A (BullMQ + Redis via `@nestjs/bullmq`) |
| TD-04 | Backend | Worker Runtime Topology | Separate Compose service, NestJS standalone | A (own service, same source, FFmpeg in image) |
| TD-05 | Backend | Metadata Extraction and Thumbnail Generation | Direct `ffprobe`/`ffmpeg` invocation | B (spawn binaries from system packages) |
| TD-06 | Backend | Unique Public Video Identifier | Random short id in a unique column | C (~11-char random id, `/watch/<publicId>`) |
| TD-07 | Backend | Video Delivery — Streaming and Download | Presigned GET direct to storage | B (storage answers `Range` with `206`) |
| TD-08 | Backend | Video Status Lifecycle and Failure Handling | Orthogonal status fields | B (processing + publication, terminal failure state) |
| TD-09 | Backend | Processing Job Contract | Thin payload — video id only | B (id only, worker loads the record) |
