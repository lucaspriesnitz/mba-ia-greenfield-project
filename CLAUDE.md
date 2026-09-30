# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Modules under `src/`: `auth/`, `users/`, `channels/`, `mail/`, `videos/`, `storage/`, `queue/`, plus `common/`, `config/`, `database/` and `swagger/`. The same source tree also carries a second entrypoint, the video worker (`src/worker.ts` + `src/worker.module.ts`).
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — frontend delivered in Phases 01–02; out of scope for Phase 03

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, issues presigned storage URLs, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

Two container-level points the diagram file still shows unresolved, settled by Phase 03 and
recorded in `docs/decisions/technical-decisions-phase-03-videos.md`:

- The **Message Queue** is no longer `TBD`: it is **Redis + BullMQ** (TD-03).
- The API **does not carry video bytes**. It signs URLs and the client talks to storage
  directly, in both directions (TD-02 for upload, TD-07 for playback/download).

## Videos (Phase 03)

Upload, asynchronous processing and delivery of videos. Decisions in
`docs/decisions/technical-decisions-phase-03-videos.md` (TD-01…TD-09); plan and progress in
`docs/phases/phase-03-videos/`.

### Where the code lives

| Path | Role |
|---|---|
| `nestjs-project/src/videos/` | `VideosModule` — controller, service, `Video` entity, DTOs, domain exceptions, `public_id` generator |
| `nestjs-project/src/videos/processing/` | `VideoProcessingModule` — BullMQ processor and the `ffprobe`/`ffmpeg` adapters. Imported **only** by `WorkerModule` |
| `nestjs-project/src/storage/` | `StorageModule` — S3 client (MinIO), key derivation, presigned URLs, multipart operations |
| `nestjs-project/src/queue/` | `QueueModule` — BullMQ registration, producer, and the API↔worker contract in `video-processing.contract.ts` |
| `nestjs-project/src/worker.ts`, `src/worker.module.ts` | The worker entrypoint: a NestJS **application context** with no HTTP listener |
| `nestjs-project/src/database/migrations/1790558159861-CreateVideos.ts` | Creates the `videos` table, its two enum types and the FK to `channels` |

### Endpoints

All under `/videos`, all behind the global JWT guard.

| Method & path | What it does |
|---|---|
| `POST /videos` | Pre-registers the draft on the caller's channel and opens the multipart upload; returns `publicId`, `uploadId`, `partSizeBytes`, `partCount` and the presigned PUT URLs |
| `POST /videos/:publicId/upload/parts` | Re-signs specific part numbers so an interrupted upload resumes |
| `POST /videos/:publicId/upload/complete` | Assembles the parts at storage, re-checks the assembled size, moves the video to `processing` and enqueues the job |
| `DELETE /videos/:publicId/upload` | Aborts the multipart upload and discards the draft |
| `GET /videos/:publicId/playback-url` | Presigned GET for streaming; also returns `durationSeconds` and a presigned `thumbnailUrl`. Increments `view_count` |
| `GET /videos/:publicId/download-url` | Presigned GET with a content-disposition override, so the browser saves the file. Does **not** count as a view |

Domain error codes: `VIDEO_NOT_FOUND` (404), `VIDEO_UPLOAD_TOO_LARGE` (413),
`UNSUPPORTED_VIDEO_FORMAT` (415), `VIDEO_UPLOAD_NOT_IN_PROGRESS` (409),
`VIDEO_NOT_READY` (409), `VIDEO_PROCESSING_FAILED` (409).

### Upload — no bytes through the API (TD-02)

The 10GB ceiling is met by **presigned multipart upload**: the request body of `POST /videos`
carries metadata only, and the client PUTs each part straight to storage. The API never
receives, buffers or proxies a byte of the file. Because the declared size cannot be trusted,
`complete` re-reads the assembled object's real length from storage and rejects an oversized
result by deleting the object and the draft.

### Queue and worker (TD-03, TD-04, TD-09)

Redis + BullMQ, queue `video-processing`, job `video.process`, payload `{ videoId }` and
nothing else — a thin payload cannot go stale between enqueue and delivery. Attempts and
exponential backoff are queue-level defaults; failed jobs are kept so a terminal failure stays
inspectable. The Redis key namespace is configurable (`VIDEO_QUEUE_PREFIX`), which is how the
test suite shares the queue name with production without the running `video-worker` consuming
the jobs the tests enqueue.

The consumer runs in its own Compose service (`video-worker`), built from `Dockerfile.worker`,
which is where FFmpeg is installed. The API process registers **no** consumer, so FFmpeg work
never competes with request handling. On each job the worker re-reads the record, streams the
original down from storage, runs `ffprobe` for duration/metadata and `ffmpeg` for one JPEG
frame, uploads the thumbnail and writes `duration_seconds`, `metadata`, `thumbnail_key` and
`processing_status = 'ready'` in a single update.

### Status model (TD-08)

Two orthogonal columns, never collapsed:

- `processing_status`: `awaiting_upload` → `uploading` → `processing` → `ready` | `failed`.
  `failed` is terminal — only a re-enqueue moves a video out of it, and it is written only
  after the queue exhausts the attempt budget.
- `publication_status`: `draft` | `published`. Phase 03 ships no publish transition.

### Storage (TD-01)

One bucket (`STORAGE_BUCKET`, default `streamtube`), no public-read policy: every object is
reached through a presigned URL. Keys are derived in one place, `src/storage/storage-keys.ts`:
`videos/<publicId>/original.<ext>` and `videos/<publicId>/thumbnail.jpg`. The module builds
**two** S3 clients with the same credentials — an internal one for byte I/O inside the Compose
network and a signing one whose endpoint is browser-reachable, so a signed URL never carries a
Compose service name.

### Unique URL (TD-06)

`Video.public_id` is a random 11-character URL-safe id from `nanoid` (pinned to 3.x — 4+ is
ESM-only and this project emits CommonJS). Uniqueness is enforced by the unique constraint on
the column, and `PublicIdService.allocate` retries on collision. Foreign keys point at
`Video.id` (uuid), never at `public_id`.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.