# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (pass --runInBand --forceExit yourself)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. Both suites **must** be run with `--runInBand --forceExit`, and **neither script embeds the flags** — pass them on the command line every time:

```bash
docker compose exec nestjs-api npm test -- --runInBand --forceExit
docker compose exec nestjs-api npm run test:e2e -- --runInBand --forceExit
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently. `--forceExit` is required because Jest does not exit on its own after either suite: the TypeORM connection and the BullMQ Redis connections stay open.

The `video-worker` container stays **up** while the suites run, and nothing has to be stopped. Both suites set `VIDEO_QUEUE_PREFIX` to a namespace of their own in `src/test/queue-prefix.ts` (a Jest `setupFiles` hook), so producer and consumer inside a test meet on the same queue name — the one constant the contract owns — inside a Redis keyspace the live worker never reads. A raw `new Queue(...)`/`new Worker(...)` in a test must pass `prefix: <queueConfig()>.keyPrefix`, or it lands in the wrong keyspace and sees nothing.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", "<the queue-prefix hook>"]`, in this order and in both configs. Without `dotenv/config`, `.env` is not loaded inside the Jest process and `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS. `src/test/queue-prefix.ts` comes second so it overrides `VIDEO_QUEUE_PREFIX` instead of being overridden by `.env`; dropping it puts the suite back on the live worker's Redis keyspace and the queue assertions turn flaky again.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

### Videos (Phase 03)

Video upload, processing and delivery. The API never carries the file bytes: clients upload directly to object storage with presigned URLs, and a separate worker container does the FFmpeg work off a queue.

**Endpoints** — all under `@Controller('videos')`, all behind the global JWT guard:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/videos` | Pre-register the draft and open the multipart upload |
| `POST` | `/videos/:publicId/upload/parts` | Sign a batch of part URLs |
| `POST` | `/videos/:publicId/upload/complete` | Complete the multipart upload and enqueue processing |
| `DELETE` | `/videos/:publicId/upload` | Abort the upload and discard the draft |
| `GET` | `/videos/:publicId/playback-url` | Presigned GET for streaming (storage answers `Range` with `206`) |
| `GET` | `/videos/:publicId/download-url` | Presigned GET with attachment disposition |

**Modules and where the code lives**

- `src/videos/` — `VideosModule`, controller, service, DTOs, the `Video` entity and its domain exceptions.
- `src/videos/public-id.service.ts` — allocates the short public id. `allocate(persist)` wraps the caller's write in a retry envelope and retries on a `23505` unique violation naming `public_id`.
- `src/storage/` — `StorageModule` over the S3 SDK, pointed at MinIO. `storage-keys.ts` owns the key layout; `storage.service.ts` owns multipart, presigning and `deleteObject`.
- `src/queue/` — `QueueModule` over BullMQ. The queue is `video-processing` (`VIDEO_PROCESSING_QUEUE`); `video-processing.contract.ts` is the job payload shape shared by producer and worker. The Redis key namespace is `VIDEO_QUEUE_PREFIX` (`queueConfig().keyPrefix`), set on the shared Bull config so the registered queue and every `@Processor` worker inherit it together.
- `src/videos/processing/` — the worker side: `ffprobe.adapter.ts` (duration and metadata), `ffmpeg-thumbnail.adapter.ts` (one frame), `spawn-binary.ts` and the BullMQ processor.
- `src/worker.ts` + `src/worker.module.ts` — the standalone worker entrypoint, run by the `video-worker` container.

**Status model.** Two independent columns on `videos`, not one. `processing_status` moves `awaiting_upload → uploading → processing → ready | failed` (`VideoProcessingStatus`); `publication_status` is `draft | published` (`VideoPublicationStatus`). A video is publicly visible only when `processing_status = 'ready'` **and** `publication_status = 'published'`.

Permanent failure is not signalled with BullMQ's `UnrecoverableError` — the processor uses `@OnWorkerEvent('failed')` and only writes the terminal `failed` state once `job.attemptsMade` reaches the configured ceiling.

**Infrastructure** — `compose.yaml` runs seven services: `nestjs-api`, `db`, `mailpit`, `minio`, `minio-init` (one-shot, creates the private `streamtube` bucket and exits), `redis` and `video-worker`.

FFmpeg is a **system package**, not an npm dependency. Both `Dockerfile.dev` and `Dockerfile.worker` install it via `apt`, so `ffmpeg` and `ffprobe` are on `PATH` in the API container too — the adapter integration suites need them there.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
