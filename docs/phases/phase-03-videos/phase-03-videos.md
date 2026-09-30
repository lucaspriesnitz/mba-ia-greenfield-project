---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-27T18:51:51-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-27T18:04:13-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-26T12:09:11-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend foundation for video upload and delivery — object storage with a per-video key prefix, resumable 10GB presigned multipart upload that pre-registers the video as a draft, a BullMQ processing queue consumed by a dedicated FFmpeg worker that extracts duration/metadata and generates a thumbnail, a short non-enumerable public identifier per video, and presigned streaming plus download — so that a video goes from `awaiting_upload` to `ready` (or to a terminal `failed`) without a single byte crossing the API container.

---

## Step Implementations

### SI-03.1 — Dependências, namespaces de configuração e validação de ambiente

**Description:** Instalar as dependências de storage e fila da fase e criar os três namespaces de configuração (`storage`, `queue`, `video`) no padrão `registerAs` da Fase 01, com todas as variáveis novas validadas no schema Joi de bootstrap.

**Technical actions:**

1. Instalar dependências de produção em `nestjs-project`: `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` (cliente S3 serve MinIO e S3 sem camada de abstração, per `phase-03-videos/TD-01`), `@nestjs/bullmq@^11.x` e `bullmq@^5.x` (per `phase-03-videos/TD-03`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `STORAGE_INTERNAL_ENDPOINT` (string, default `'http://minio:9000'` — nome do serviço do Compose, usado por API e worker), `STORAGE_PUBLIC_ENDPOINT` (string, default `'http://localhost:9000'` — endpoint alcançável pelo navegador, usado **só para assinar**), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY` (string, required), `STORAGE_SECRET_KEY` (string, required), `STORAGE_BUCKET` (string, default `'streamtube'`), `STORAGE_PRESIGN_TTL_SECONDS` (number, default `900`). Os dois endpoints são a consequência direta do upload direto ao storage (per `phase-03-videos/TD-02`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`), `VIDEO_QUEUE_ATTEMPTS` (number, default `3`), `VIDEO_QUEUE_BACKOFF_MS` (number, default `5000`); e `src/config/video.config.ts` — `registerAs('video', ...)` lendo `VIDEO_MAX_UPLOAD_BYTES` (number, default `10737418240`), `VIDEO_UPLOAD_PART_SIZE_BYTES` (number, default `67108864`), `VIDEO_THUMBNAIL_OFFSET_SECONDS` (number, default `3` — offset configurável com default seguro para vídeos curtos, per `phase-03-videos/TD-05`), `VIDEO_ACCEPTED_MIME_TYPES` (string CSV, default `'video/mp4,video/quicktime,video/x-matroska,video/webm'`)
4. Estender `src/config/env.validation.ts` com todas as variáveis novas no schema Joi (`STORAGE_ACCESS_KEY` e `STORAGE_SECRET_KEY` obrigatórias, as demais com default) e replicar em `.env.example` com defaults compatíveis com o Compose — valores com caractere especial de shell entre aspas, per a convenção de `.env` do `nestjs-project/CLAUDE.md`
5. Registrar as três factories em `ConfigModule.forRoot({ load: [...] })` do `AppModule`, mantendo `validationOptions: { allowUnknown: true, abortEarly: false }`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: bootstrap falha sem `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`; defaults aplicados quando ausentes | `src/config/env.validation.integration-spec.ts` (estender) |
| `storageConfig`, `queueConfig`, `videoConfig` | Unit: cada factory lê o env e coage tipos (número, CSV → array) | `src/config/video.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Subir a aplicação sem `STORAGE_ACCESS_KEY` falha no bootstrap com erro de validação Joi nomeando a variável — a aplicação não sobe
- Subir a aplicação com apenas as variáveis obrigatórias preenchidas funciona, e `GET /` continua retornando `200`
- `VIDEO_MAX_UPLOAD_BYTES` ausente resolve para `10737418240`; presente sobrescreve o default
- `VIDEO_ACCEPTED_MIME_TYPES` chega ao código como array de strings, não como CSV cru
- `STORAGE_INTERNAL_ENDPOINT` e `STORAGE_PUBLIC_ENDPOINT` são valores independentes e nenhum deles tem `localhost` como default do lado interno

---

### SI-03.2 — Infra do Compose: MinIO, Redis, bucket e imagem do worker com FFmpeg

**Description:** Subir os três serviços novos que a fase exige no `compose.yaml` — object storage, fila e worker — com o bucket único provisionado no boot e FFmpeg instalado como pacote de sistema na imagem do worker.

**Technical actions:**

1. Adicionar serviço `minio` ao `nestjs-project/compose.yaml` — imagem `minio/minio`, comando `server /data --console-address ":9001"`, portas `9000:9000` e `9001:9001`, credenciais de `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`, volume nomeado para `/data` e `healthcheck` contra `/minio/health/live`
2. Adicionar serviço `redis` ao `compose.yaml` — imagem `redis:7-alpine`, porta `6379:6379`, `healthcheck` com `redis-cli ping` (per `phase-03-videos/TD-03`)
3. Adicionar serviço one-shot `minio-init` — imagem `minio/mc`, dependente de `minio` saudável, criando o bucket único `STORAGE_BUCKET` de forma idempotente e **sem nenhuma policy de leitura pública** (per `phase-03-videos/TD-01`)
4. Criar `nestjs-project/Dockerfile.worker` — mesma base Node do `Dockerfile.dev`, `apt-get install ffmpeg` (traz `ffmpeg` e `ffprobe` como pacote de sistema, per `phase-03-videos/TD-05`), entrypoint no bootstrap standalone do worker
5. Adicionar serviço `video-worker` ao `compose.yaml` — build por `Dockerfile.worker`, mesmo volume do código-fonte, `depends_on` de `db` saudável + `redis` saudável + `minio` saudável, sem porta publicada (per `phase-03-videos/TD-04`)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — as variáveis de ambiente que os serviços consomem nascem lá

**Acceptance criteria:**

- `docker compose ps` mostra `nestjs-api`, `db`, `mailpit`, `minio`, `redis` e `video-worker` com status `running`
- `curl http://localhost:9000/minio/health/live` responde `200` no host
- `docker compose exec redis redis-cli ping` responde `PONG`
- O bucket configurado em `STORAGE_BUCKET` existe após `docker compose up -d`, e uma segunda subida não falha por bucket já existente
- Um `GET` anônimo direto a uma chave do bucket, sem assinatura, é recusado — não há superfície public-read
- `docker compose exec video-worker ffprobe -version` e `docker compose exec video-worker ffmpeg -version` retornam código 0
- A suíte existente continua verde com a infra nova no ar (`docker compose exec nestjs-api npm test -- --runInBand`)

---

### SI-03.3 — Fundação do módulo de vídeos: entidade `Video`, migration e exceções de domínio

**Description:** Criar a entidade `Video` com os campos de status ortogonais e a identidade pública separada do UUID interno, gerar a migration da tabela, e declarar as exceções de domínio da fase sobre a base `DomainException` da Fase 02.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com todas as colunas de `## Technical Specifications` → `### Data Model` → `Video`: `id` (uuid PK gerado), `public_id` (varchar(16), unique), `channel_id` (uuid FK → channels), `title`, `description`, `original_filename`, `content_type`, `size_bytes` (bigint), `storage_key`, `thumbnail_key`, `upload_id`, `duration_seconds`, `metadata` (jsonb), `processing_status` (enum, default `awaiting_upload`), `processing_error`, `publication_status` (enum, default `draft`), `view_count` (default `0`), `created_at`, `updated_at`. `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })`. Índices: unique em `public_id`, índice em `channel_id` e em `processing_status` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-08`)
2. Criar `src/videos/video.types.ts` — os dois enums TypeScript `VideoProcessingStatus` (`awaiting_upload` \| `uploading` \| `processing` \| `ready` \| `failed`) e `VideoPublicationStatus` (`draft` \| `published`), referenciados pela entidade como enum do PostgreSQL (per `phase-03-videos/TD-08`)
3. Gerar a migration por `docker compose exec nestjs-api npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL — tipos enum criados, constraint unique em `public_id`, FK para `channels(id)`, defaults de `processing_status`, `publication_status` e `view_count`
4. Criar `src/videos/exceptions/video.exceptions.ts` — subclasses de `DomainException` para cada linha de `### Error Catalog`: `VideoNotFoundException` (404), `VideoUploadTooLargeException` (413), `UnsupportedVideoFormatException` (415), `VideoUploadNotInProgressException` (409), `VideoNotReadyException` (409), `VideoProcessingFailedException` (409), com `errorCode` e `message` idênticos ao catálogo
5. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])` nos imports, exportando `TypeOrmModule` para que o worker use o mesmo repositório

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique em `public_id`, FK obrigatória para `channels`, defaults de `processing_status`/`publication_status`/`view_count`, `metadata` aceita jsonb, timestamps automáticos | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration `CreateVideos` | Integration: `migration:run` cria a tabela e `migration:revert` a desfaz sem resíduo de tipo enum | `src/videos/entities/video.migration.integration-spec.ts` |
| `VideosModule` | Unit: módulo compila com a wiring de `forFeature` | `src/videos/videos.module.spec.ts` |
| Exceções de vídeo | Unit: cada subclasse expõe o par `errorCode`/`httpStatus` do catálogo e é capturada pelo `DomainExceptionFilter` global | `src/videos/exceptions/video.exceptions.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas, os dois tipos enum, a constraint unique de `public_id` e a FK para `channels`
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unique constraint
- Inserir um vídeo sem `channel_id` falha com violação de FK
- Um vídeo recém-inserido tem `processing_status = 'awaiting_upload'`, `publication_status = 'draft'` e `view_count = 0` sem que a inserção informe qualquer um dos três
- `npm run migration:revert` remove a tabela e os tipos enum, e um `migration:run` seguinte reaplica sem erro
- Lançar `VideoNotFoundException` de dentro de um handler resulta em `{ statusCode: 404, error: 'VIDEO_NOT_FOUND', message: 'Video not found' }` na resposta HTTP

---

### SI-03.4 — Gerador de identificador público curto, com retry em colisão

**Description:** Implementar o gerador do `public_id` de ~11 caracteres URL-safe e o helper que garante unicidade tentando de novo na violação da constraint, resolvendo antes disso qual dependência de geração o build deste projeto aceita.

**Build constraint — `nanoid` é ESM-only nos majors recentes e este projeto compila CommonJS.** Registrada em `phase-03-videos/TD-06` e sem `library-refs.md` nesta fase (nenhuma TD da fase declara `**Libraries:**`), a constraint mora aqui, amarrada ao SI que implementa o identificador. O `nestjs-project` usa `typeorm-ts-node-commonjs`, `module: nodenext` com emissão CommonJS e Jest via `ts-jest` — um pacote ESM-only quebra em `require()` no runtime compilado **e** dentro do Jest, não no `tsc`. Por isso a escolha da dependência é a **primeira ação** deste SI e tem critério de aceite próprio, não é detalhe de implementação:

- **Caminho preferido** — `nanoid` numa linha que ainda publique CommonJS, instalada e validada por `require('nanoid')` dentro do container e por um teste unitário rodando sob Jest. Se passar, é a dependência.
- **Fallback declarado em `phase-03-videos/TD-06`** — gerador próprio sobre `crypto.randomBytes` do Node, sem dependência nova. É o caminho que vale se a validação acima falhar por qualquer motivo.

Nas duas pontas o resto do SI é idêntico: a interface exposta é `generatePublicId(): string`, e nenhum outro arquivo da fase sabe qual das duas ganhou.

**Technical actions:**

1. Validar a compatibilidade CommonJS antes de fixar: rodar `docker compose exec nestjs-api node -e "require('nanoid')"` na versão candidata; **se falhar**, não instalar nada e seguir pelo fallback `crypto.randomBytes`. Registrar a versão efetivamente fixada em `package.json` (ou a ausência de dependência nova, no fallback)
2. Criar `src/videos/public-id.util.ts` — `generatePublicId()` devolvendo 11 caracteres do alfabeto URL-safe (`A–Z a–z 0–9 _ -`), aleatório e não sequencial, que é o que sustenta a garantia de não-enumerabilidade (per `phase-03-videos/TD-06`)
3. Criar `src/videos/public-id.service.ts` — `allocate(): Promise<string>` que gera, tenta persistir e **retenta na violação de unique constraint** (código `23505` do PostgreSQL) até um teto configurável de tentativas, propagando o erro se estourar (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: comprimento 11, alfabeto restrito a URL-safe, ausência de sequencialidade entre chamadas consecutivas, e `require()` sob Jest funciona (é o teste que fecha a constraint ESM × CommonJS) | `src/videos/public-id.util.spec.ts` |
| `PublicIdService` | Unit: retenta quando o repositório lança `23505` e desiste com erro ao estourar o teto de tentativas | `src/videos/public-id.service.spec.ts` |
| `PublicIdService` | Integration: colisão real contra a constraint unique da tabela `videos` é absorvida e o segundo vídeo nasce com id distinto | `src/videos/public-id.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — a constraint unique de `public_id` e o repositório de `Video` precisam existir para o retry ser testável contra o banco

**Acceptance criteria:**

- `docker compose exec nestjs-api node -e "require('nanoid')"` retorna código 0 **ou** o `package.json` não ganhou dependência de geração de id nenhuma — as duas saídas são conformes, a terceira (dependência instalada que falha em `require`) não é
- `docker compose exec nestjs-api npm test -- src/videos/public-id.util.spec.ts` passa, provando que o gerador carrega sob o runtime CommonJS do Jest
- Duas chamadas consecutivas de `generatePublicId()` devolvem valores distintos e nenhuma relação de ordem entre eles
- Todo valor gerado tem 11 caracteres e aparece intacto numa URL sem escaping
- Forçar o repositório a rejeitar a primeira tentativa com violação de unique constraint resulta em um segundo id persistido, sem erro visível ao chamador
- `docker compose exec nestjs-api npx tsc --noEmit` continua saindo com código 0

---

### SI-03.5 — Módulo de storage: cliente S3, derivação de chaves e operações presigned

**Description:** Encapsular todo o acesso ao object storage num módulo próprio — dois clientes S3 (endpoint interno para API e worker, endpoint público só para assinar), a derivação canônica das chaves de vídeo, e as operações multipart e de leitura presigned que os endpoints da fase consomem.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — dois providers de `S3Client` distinguidos por token: `STORAGE_INTERNAL_CLIENT` (`endpoint: storageConfig.internalEndpoint`) para I/O real de bytes, e `STORAGE_SIGNING_CLIENT` (`endpoint: storageConfig.publicEndpoint`) usado exclusivamente para gerar assinaturas. Ambos com `forcePathStyle: true` e credenciais da config. Os dois endpoints são exigência do upload direto (per `phase-03-videos/TD-02`)
2. Criar `src/storage/storage-keys.ts` — `originalKey(publicId, ext)` → `videos/<publicId>/original.<ext>` e `thumbnailKey(publicId)` → `videos/<publicId>/thumbnail.jpg`, funções puras e a única fonte dessas strings no código (per `phase-03-videos/TD-01`)
3. Criar `src/storage/storage.service.ts` com as operações multipart, assinadas pelo cliente público: `createMultipartUpload(key, contentType)`, `signUploadParts(key, uploadId, partNumbers)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` e `headObject(key)` — este último pelo cliente interno, para conferir o tamanho real do objeto montado (per `phase-03-videos/TD-02`)
4. Adicionar ao mesmo serviço as leituras presigned: `signDownloadUrl(key, { attachmentFilename? })` — sem `attachmentFilename` é a URL de playback que o storage serve respondendo `Range` com `206 Partial Content`; com ele, aplica o override de content-disposition que força anexo. TTL vindo de `STORAGE_PRESIGN_TTL_SECONDS` (per `phase-03-videos/TD-07`)
5. Adicionar as operações que o worker usa pelo cliente interno: `getObjectStream(key)` para ler o original e `putObject(key, body, contentType)` para gravar a thumbnail (per `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage-keys` | Unit: derivação de `original.<ext>` e `thumbnail.jpg` sob o prefixo do `publicId`, incluindo extensão ausente ou em caixa alta | `src/storage/storage-keys.spec.ts` |
| `StorageService` (multipart) | Integration contra o MinIO do Compose: initiate → sign parts → PUT nas URLs → complete monta o objeto; `headObject` reporta o tamanho montado; `abort` remove as partes | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` (presign de leitura) | Integration contra o MinIO: `GET` na URL assinada com header `Range` responde `206` com `Content-Range`; a variante de anexo responde com `Content-Disposition: attachment` | `src/storage/storage.presign.integration-spec.ts` |
| `StorageModule` | Unit: módulo compila e os dois clientes são resolvidos por tokens distintos, com endpoints distintos | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 + SI-03.2 — a config de storage e o MinIO com bucket provisionado são pré-requisito dos testes de integração

**Acceptance criteria:**

- Uma URL assinada pelo `STORAGE_SIGNING_CLIENT` tem o host do endpoint público, e nenhuma URL devolvida a um cliente carrega o nome de serviço interno do Compose
- `PUT` numa URL de parte assinada grava a parte no bucket sem nenhuma credencial no cliente
- Depois do complete, `headObject` reporta o tamanho igual à soma das partes enviadas
- `GET` na URL de playback com `Range: bytes=0-1023` responde `206` com `Content-Range` e exatamente 1024 bytes
- `GET` na URL de download responde `200` com `Content-Disposition: attachment` carregando o nome de arquivo original
- Uma URL assinada rejeitada após o TTL responde erro do storage, não `200`
- `abortMultipartUpload` deixa o bucket sem nenhuma parte residual da chave abortada

---

### SI-03.6 — Fila de processamento: registro do BullMQ e produtor do job

**Description:** Registrar a fila `video-processing` sobre Redis via `@nestjs/bullmq` com retry em backoff e teto de tentativas, e expor o produtor que enfileira o job de payload fino.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` injetando `queueConfig` (`connection: { host, port }`), e `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts: queueConfig.attempts, backoff: { type: 'exponential', delay: queueConfig.backoffMs }, removeOnComplete: true, removeOnFail: false } })` — retry, backoff e teto vêm da biblioteca, não de código do projeto (per `phase-03-videos/TD-03`)
2. Criar `src/queue/video-processing.contract.ts` — o nome da fila, o nome do job e o tipo do payload `{ videoId: string }`, que é o contrato único entre API e worker e a fonte da forma descrita em `### Events/Messages` → `video.process` (per `phase-03-videos/TD-09`)
3. Criar `src/queue/video-processing.producer.ts` — `enqueue(videoId: string)` publicando o job com **apenas o id interno do vídeo**, nada mais: sem chave de storage, sem tamanho, sem canal, sem título (per `phase-03-videos/TD-09`)
4. Registrar `QueueModule` no `AppModule` e exportar o produtor para consumo pelo `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Unit: `enqueue` publica no nome de job correto com payload exatamente `{ videoId }` e nenhum campo extra | `src/queue/video-processing.producer.spec.ts` |
| `QueueModule` | Integration contra o Redis do Compose: módulo compila, a fila aceita um job e o job aparece como `waiting` com as opções de retry e backoff configuradas | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.1 + SI-03.2 — a config da fila e o serviço `redis` no ar

**Acceptance criteria:**

- Enfileirar por `enqueue(videoId)` deixa exatamente um job pendente na fila `video-processing`, e o payload persistido no Redis tem uma única chave, `videoId`
- O job pendente carrega `attempts` e `backoff` vindos de `VIDEO_QUEUE_ATTEMPTS` e `VIDEO_QUEUE_BACKOFF_MS`, não de literais
- Subir a API com o Redis indisponível falha de forma observável no log em vez de aceitar enfileiramento silenciosamente perdido
- Um job que falha em todas as tentativas permanece consultável como `failed` na fila, não é removido

---

### SI-03.7 — Pré-cadastro do rascunho e início do upload multipart

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload-initiate.plan.md`
**Authorization:** Owner — o rascunho nasce no canal do próprio autenticado

**Description:** Implementar o endpoint que cria o vídeo como rascunho e inicia o upload multipart no storage na mesma operação, devolvendo as URLs presigned das partes — o passo que casa um-para-um com o pré-cadastro exigido pela fase.

**Technical actions:**

1. Criar `src/videos/dto/initiate-upload.dto.ts` — `title`, `description`, `filename`, `contentType`, `sizeBytes` com os decoradores `class-validator` das regras de `### API Contracts` → `#### Validation Rules`; `contentType` fora da lista aceita e `sizeBytes` acima do teto **não** são erro de validação genérico e sim as exceções `UnsupportedVideoFormatException` e `VideoUploadTooLargeException` do catálogo, checadas no serviço contra `videoConfig`
2. Criar `src/videos/videos.service.ts` com `initiateUpload(user, dto)` — resolve o canal do autenticado, aloca o `public_id` via `PublicIdService` (per `phase-03-videos/TD-06`), deriva `storage_key` por `originalKey(publicId, ext)` (per `phase-03-videos/TD-01`), chama `createMultipartUpload`, e persiste o rascunho com `processing_status = 'uploading'`, `upload_id` preenchido e `publication_status = 'draft'` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`)
3. Calcular `partCount = ceil(sizeBytes / videoConfig.partSizeBytes)` e assinar as URLs do primeiro lote de partes por `signUploadParts`, devolvendo `partSizeBytes`, `partCount` e a lista `parts` conforme `### API Contracts` → `#### POST /videos`
4. Criar `src/videos/videos.controller.ts` com `@Post()` e os decoradores OpenAPI explícitos (`@ApiOperation`, `@ApiBody`, `@ApiResponse` para 201/413/415/400/401 usando `ApiErrorEnvelopeDto`), per `openapi-docs-nestjs/TD-01`
5. Declarar `VideosController`, `VideosService` e `PublicIdService` no `VideosModule`, importando `StorageModule` e `QueueModule`, e registrar `VideosModule` no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: branch de `contentType` fora da lista, branch de `sizeBytes` acima do teto, cálculo de `partCount`, derivação da chave (repo e storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: o rascunho é persistido com `processing_status = 'uploading'`, `upload_id` não nulo e `public_id` único; o multipart existe no MinIO | `src/videos/videos.service.integration-spec.ts` |
| `InitiateUploadDto` | Unit: `title`/`filename`/`contentType`/`sizeBytes` obrigatórios, limites de tamanho de string, `sizeBytes` inteiro positivo | `src/videos/dto/initiate-upload.dto.spec.ts` |

Sem linha de E2E nesta tabela por desenho: os cenários HTTP ponta a ponta deste endpoint são autorados fora do plano por `/plan-test-specs`, no arquivo apontado por `**Test Specs:**`.

**Dependencies:** SI-03.3 + SI-03.4 + SI-03.5 — entidade e exceções, alocador de `public_id`, e o módulo de storage

**Acceptance criteria:**

- `POST /videos` com corpo válido e token de acesso retorna `201` com `publicId`, `uploadId`, `partSizeBytes`, `partCount` e `parts` não vazio
- Depois de um `201`, existe na tabela `videos` uma linha com aquele `publicId`, `processing_status = 'uploading'`, `publication_status = 'draft'`, `upload_id` não nulo e `channel_id` igual ao canal do autenticado
- `POST /videos` com `sizeBytes` acima do teto retorna `413` com `error: "VIDEO_UPLOAD_TOO_LARGE"` e não cria linha nenhuma
- `POST /videos` com `contentType` fora da lista aceita retorna `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"` e não cria linha nenhuma
- `POST /videos` sem token de acesso retorna `401` e não cria linha nenhuma
- As URLs de `parts` aceitam `PUT` direto do cliente sem nenhuma credencial e sem passar pela API
- Dois `POST /videos` consecutivos do mesmo usuário produzem `publicId` distintos e sem relação de ordem entre si

---

### SI-03.8 — Reassinatura de partes para retomada do upload

**Route:** POST /videos/:publicId/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner

**Description:** Implementar o endpoint que reassina URLs de partes específicas, que é o que torna a retomada real depois de queda de conexão ou expiração das URLs do lote inicial.

**Technical actions:**

1. Criar `src/videos/dto/sign-parts.dto.ts` — `partNumbers: number[]`, não vazio, cada item inteiro em `1..partCount`, no máximo 1000 por requisição
2. Adicionar `VideosService.signUploadParts(user, publicId, partNumbers)` — resolve o vídeo por `public_id` **com checagem de posse**, exige `upload_id` não nulo sob pena de `VideoUploadNotInProgressException`, valida cada `partNumber` contra o `partCount` derivado de `size_bytes`, e delega a `StorageService.signUploadParts` (per `phase-03-videos/TD-02`)
3. Adicionar `@Post(':publicId/upload/parts')` ao `VideosController` com os decoradores OpenAPI de 200/404/409/400/401

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.signUploadParts` | Unit: vídeo inexistente → `VideoNotFoundException`; vídeo de outro dono → `VideoNotFoundException`; `upload_id` nulo → `VideoUploadNotInProgressException`; `partNumber` fora do range → erro de validação | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.signUploadParts` | Integration: as URLs reassinadas aceitam `PUT` no MinIO e a parte substitui a anterior de mesmo número | `src/videos/videos.service.integration-spec.ts` (estender) |
| `SignPartsDto` | Unit: array vazio rejeitado, item não inteiro rejeitado, teto de 1000 itens | `src/videos/dto/sign-parts.dto.spec.ts` |

Sem linha de E2E nesta tabela por desenho — cenários HTTP autorados por `/plan-test-specs`.

**Dependencies:** SI-03.7 — reassina partes de um upload que só existe depois do initiate

**Acceptance criteria:**

- `POST /videos/:publicId/upload/parts` com `partNumbers` válido retorna `200` com uma URL por número pedido, na mesma ordem
- Reenviar a mesma parte por uma URL reassinada e depois concluir o upload produz um objeto íntegro — a retomada não corrompe o que já subiu
- `POST /videos/:publicId/upload/parts` para um `publicId` de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, sem revelar que o identificador existe
- `POST /videos/:publicId/upload/parts` num vídeo cujo upload já foi concluído retorna `409` com `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`
- `POST /videos/:publicId/upload/parts` com `partNumber` maior que o `partCount` do vídeo retorna `400`
- `POST /videos/:publicId/upload/parts` sem token de acesso retorna `401`

---

### SI-03.9 — Conclusão e cancelamento do upload, com enfileiramento do processamento

**Route:** POST /videos/:publicId/upload/complete, DELETE /videos/:publicId/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Fechar o protocolo de upload: a conclusão manda o storage montar o objeto, confere o tamanho real, move o vídeo para `processing` e enfileira o job; o cancelamento aborta o multipart e descarta o rascunho.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `parts: { partNumber: number; etag: string }[]`, não vazio, em ordem crescente de `partNumber` e sem lacunas
2. Adicionar `VideosService.completeUpload(user, publicId, dto)` — checa posse e `upload_id`, chama `completeMultipartUpload`, confere por `headObject` que o objeto montado não excede `videoConfig.maxUploadBytes` (o teto declarado no initiate não é confiável, porque a API não vê os bytes) e, se exceder, aborta e lança `VideoUploadTooLargeException`; no caminho felizes limpa `upload_id`, grava `processing_status = 'processing'` e chama o produtor (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`)
3. Enfileirar por `VideoProcessingProducer.enqueue(video.id)` — id interno, payload fino, **depois** da confirmação de montagem do objeto, nunca antes (per `phase-03-videos/TD-09`)
4. Adicionar `VideosService.abortUpload(user, publicId)` — checa posse e `upload_id`, chama `abortMultipartUpload` e remove a linha do rascunho, deixando o bucket sem partes residuais
5. Adicionar `@Post(':publicId/upload/complete')` e `@Delete(':publicId/upload')` ao `VideosController` com os decoradores OpenAPI de 200/204/404/409/413/400/401

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: `upload_id` nulo → `VideoUploadNotInProgressException`; objeto montado acima do teto → aborta e lança `VideoUploadTooLargeException` sem enfileirar; caminho felizes enfileira exatamente uma vez | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.completeUpload` | Integration: partes reais no MinIO são montadas, `upload_id` é limpo, `processing_status` vira `processing` e um job com `{ videoId }` aparece na fila do Redis | `src/videos/videos.service.integration-spec.ts` (estender) |
| `VideosService.abortUpload` | Integration: a linha do rascunho desaparece e o bucket não tem parte residual da chave | `src/videos/videos.abort.integration-spec.ts` |
| `CompleteUploadDto` | Unit: array vazio rejeitado, `etag` vazio rejeitado, ordem decrescente rejeitada | `src/videos/dto/complete-upload.dto.spec.ts` |

Sem linha de E2E nesta tabela por desenho — cenários HTTP autorados por `/plan-test-specs`.

**Dependencies:** SI-03.7 + SI-03.6 — o upload iniciado e a fila com o produtor registrado

**Acceptance criteria:**

- `POST /videos/:publicId/upload/complete` com todas as partes enviadas retorna `200` com `processingStatus: "processing"`
- Depois do `200`, a linha do vídeo tem `upload_id` nulo e `processing_status = 'processing'`, e existe exatamente um job pendente na fila `video-processing` carregando o id interno daquele vídeo
- O objeto montado é legível no bucket sob `videos/<publicId>/original.<ext>` e seu tamanho é a soma das partes
- Concluir um upload cujo objeto montado excede o teto retorna `413` com `error: "VIDEO_UPLOAD_TOO_LARGE"`, não enfileira job e não deixa o objeto no bucket
- `POST /videos/:publicId/upload/complete` duas vezes: a segunda retorna `409` com `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"` e não enfileira um segundo job
- `DELETE /videos/:publicId/upload` retorna `204`, a linha do rascunho deixa de existir e nenhuma parte sobra no bucket
- Nenhum byte do arquivo trafega pelo processo da API em qualquer um dos caminhos acima — o corpo das requisições carrega apenas metadados de partes

---

### SI-03.10 — Worker como aplicação NestJS standalone

**Description:** Criar o segundo entrypoint do mesmo código-fonte — um contexto de aplicação NestJS sem listener HTTP, registrando só o que o consumo da fila exige — que é o que isola o trabalho pesado do atendimento de requisições.

**Technical actions:**

1. Criar `src/worker.module.ts` — módulo raiz do worker importando `ConfigModule.forRoot` com as mesmas factories e o mesmo schema Joi do `AppModule`, `TypeOrmModule.forRootAsync` idêntico, `VideosModule`, `StorageModule` e `QueueModule`; **sem** `AuthModule`, **sem** controllers, **sem** `ThrottlerModule` (per `phase-03-videos/TD-04`)
2. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, com `enableShutdownHooks()` e log de readiness; nenhum `listen()` em lugar nenhum
3. Apontar o entrypoint do `Dockerfile.worker` para este bootstrap e registrar o script `start:worker` em `package.json`, mais o modo watch equivalente para desenvolvimento

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Integration: o contexto de aplicação compila e resolve `Repository<Video>`, `StorageService` e a conexão da fila, sem abrir porta HTTP | `src/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.2 + SI-03.5 + SI-03.6 — a imagem com FFmpeg e o serviço no Compose, o módulo de storage e a wiring da fila

**Acceptance criteria:**

- `docker compose up -d` deixa `video-worker` em `running` e o log do container registra a linha de readiness
- `docker compose logs video-worker` não mostra nenhuma mensagem de servidor HTTP escutando, e nenhuma porta está publicada para o serviço
- O worker conecta no banco pelo nome de serviço `db` e no storage por `STORAGE_INTERNAL_ENDPOINT`, nunca por `localhost`
- Reiniciar apenas `video-worker` não interrompe o atendimento de `GET /` pela API
- O contexto do worker resolve o repositório de `Video` — mesma entidade, mesmo esquema, sem código duplicado

---

### SI-03.11 — Adaptador FFmpeg: extração de metadados e geração de thumbnail

**Description:** Encapsular as duas linhas de comando fixas que a fase precisa — `ffprobe` para duração e metadados, `ffmpeg` para o frame da thumbnail — por spawn direto do binário de sistema, sem wrapper npm.

**Technical actions:**

1. Criar `src/videos/processing/ffprobe.adapter.ts` — spawn de `ffprobe -v quiet -print_format json -show_format -show_streams <input>`, parse do JSON de saída e projeção num tipo próprio com `durationSeconds` (de `format.duration`) e o subconjunto de metadados de `### Data Model` → `metadata`: container, bitrate, e por stream de vídeo/áudio o codec, resolução, frame rate e canais (per `phase-03-videos/TD-05`)
2. Criar `src/videos/processing/ffmpeg-thumbnail.adapter.ts` — spawn de `ffmpeg -ss <offset> -i <input> -frames:v 1 -f image2 <output>`, com `offset` vindo de `VIDEO_THUMBNAIL_OFFSET_SECONDS` e recuo automático para `0` quando a duração extraída é menor que o offset, que é o default seguro para vídeos curtos exigido pela decisão (per `phase-03-videos/TD-05`)
3. Nos dois adaptadores, capturar `stderr` do binário e anexá-lo à mensagem de erro em caso de código de saída diferente de zero — manter o diagnóstico do FFmpeg acessível é a razão de não usar wrapper (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfprobeAdapter` | Integration dentro da imagem do worker, contra um arquivo de vídeo de fixture: `durationSeconds` bate com a duração conhecida e o objeto de metadados carrega codec e resolução | `src/videos/processing/ffprobe.adapter.integration-spec.ts` |
| `FfprobeAdapter` | Unit: arquivo inexistente ou não decodificável propaga erro contendo o `stderr` do binário | `src/videos/processing/ffprobe.adapter.spec.ts` |
| `FfmpegThumbnailAdapter` | Integration dentro da imagem do worker: gera um JPEG não vazio a partir do fixture; com offset maior que a duração, recua para `0` e ainda gera imagem | `src/videos/processing/ffmpeg-thumbnail.adapter.integration-spec.ts` |

**Dependencies:** SI-03.2 — os binários `ffprobe` e `ffmpeg` só existem na imagem do worker

**Acceptance criteria:**

- Rodar a extração sobre um vídeo de fixture com duração conhecida devolve `durationSeconds` igual à duração real, arredondada para inteiro
- O objeto de metadados devolvido carrega codec, largura, altura e frame rate do stream de vídeo
- Rodar a geração de thumbnail sobre o mesmo fixture produz um arquivo JPEG de tamanho maior que zero
- Um vídeo mais curto que `VIDEO_THUMBNAIL_OFFSET_SECONDS` ainda produz thumbnail, e não erro
- Passar um arquivo que não é vídeo resulta em erro cuja mensagem contém a saída de erro do próprio FFmpeg
- Nenhuma dependência npm de FFmpeg aparece em `package.json` — os binários vêm do pacote de sistema da imagem

---

### SI-03.12 — Processor do job: ciclo de status e falha terminal

**Description:** Implementar o consumidor da fila que fecha o ciclo de processamento — carrega o registro pelo id, lê o objeto do storage pelo endpoint interno, extrai metadados, grava a thumbnail e devolve o vídeo a `ready`, ou o deixa em `failed` terminal quando as tentativas esgotam.

**Technical actions:**

1. Criar `src/videos/processing/video-processing.processor.ts` — `@Processor('video-processing')` recebendo `{ videoId }`, carregando o registro por id e **derivando a chave do storage do próprio registro**, não do payload; vídeo inexistente encerra o job sem erro (registro já removido por cancelamento) (per `phase-03-videos/TD-09`)
2. Implementar o caminho felizes: baixar o original por `getObjectStream` pelo endpoint interno para arquivo temporário, rodar `FfprobeAdapter`, rodar `FfmpegThumbnailAdapter`, subir o JPEG por `putObject` em `thumbnailKey(publicId)`, e gravar `duration_seconds`, `metadata`, `thumbnail_key` e `processing_status = 'ready'` numa única atualização; limpar o temporário em `finally` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-01`)
3. Implementar o caminho de falha: relançar o erro para o BullMQ contar a tentativa e aplicar o backoff; num handler `@OnWorkerEvent('failed')`, quando `job.attemptsMade >= job.opts.attempts`, gravar `processing_status = 'failed'` e `processing_error` com a causa — estado terminal visível, sem retry infinito (per `phase-03-videos/TD-03`, `phase-03-videos/TD-08`)
4. Tornar a execução idempotente: reler o registro no início de cada tentativa e sobrescrever a própria saída parcial anterior, para que uma redelivery não componha resultado
5. Registrar o processor no `VideosModule` sob o `WorkerModule` apenas — o processo da API não registra consumidor nenhum (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: vídeo inexistente encerra sem erro; erro do adaptador é relançado para a fila contar tentativa; o temporário é removido mesmo no caminho de erro | `src/videos/processing/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration com MinIO e Postgres reais: objeto de fixture no bucket → job consumido → `duration_seconds`, `metadata` e `thumbnail_key` gravados, `processing_status = 'ready'`, e a thumbnail legível no bucket | `src/videos/processing/video-processing.processor.integration-spec.ts` |
| Falha terminal | Integration: objeto corrompido no bucket → tentativas esgotam → `processing_status = 'failed'` com `processing_error` preenchido, e nenhuma tentativa adicional depois disso | `src/videos/processing/video-processing.failure.integration-spec.ts` |
| Idempotência | Integration: reenfileirar o mesmo `videoId` sobre um vídeo já `ready` recomputa e deixa o registro consistente, sem duplicar thumbnail | `src/videos/processing/video-processing.requeue.integration-spec.ts` |

**Dependencies:** SI-03.9 + SI-03.10 + SI-03.11 — o job enfileirado na conclusão do upload, o worker standalone que o consome e os adaptadores de FFmpeg

**Acceptance criteria:**

- Concluir um upload de vídeo válido leva o registro de `processing` a `ready` sem intervenção, com `duration_seconds` e `metadata` preenchidos
- Depois de `ready`, a chave `videos/<publicId>/thumbnail.jpg` existe no bucket e é um JPEG não vazio
- Um vídeo cujo objeto não é decodificável termina em `processing_status = 'failed'` com `processing_error` descrevendo a causa, depois de exatamente `VIDEO_QUEUE_ATTEMPTS` tentativas
- Um vídeo em `failed` permanece em `failed` — nenhuma tentativa nova acontece sem reenfileiramento explícito
- Reenfileirar o id de um vídeo já `ready` deixa o registro `ready` de novo, com uma única thumbnail na chave canônica
- Nenhum arquivo temporário sobra no container do worker depois de um job concluído ou falho
- `GET /` na API responde em tempo normal enquanto um job de processamento está em curso — o trabalho pesado não está no processo que atende requisições

---

### SI-03.13 — Entrega por streaming: URL de playback presigned

**Route:** GET /videos/:publicId/playback-url
**Test Specs:** see `nestjs-project/specs/videos-playback-url.plan.md`
**Authorization:** Authenticated para vídeo publicado; Owner enquanto rascunho

**Description:** Implementar o endpoint que emite a URL presigned de playback — quem responde `Range` com `206 Partial Content` é o storage, não a API — e registra a visualização no momento da emissão.

**Technical actions:**

1. Adicionar `VideosService.getPlaybackUrl(user, publicId)` — resolve por `public_id`, aplica a regra de `### Authorization Matrix` (publicado → qualquer autenticado; rascunho → só o dono; fora disso `VideoNotFoundException`, nunca `403`), e exige `processing_status = 'ready'` sob pena de `VideoNotReadyException` ou, no estado terminal, `VideoProcessingFailedException` (per `phase-03-videos/TD-08`)
2. Assinar a URL de playback por `StorageService.signDownloadUrl(video.storage_key)` sem override de disposição, e a `thumbnailUrl` por `signDownloadUrl(video.thumbnail_key)` quando a chave existir, devolvendo `null` quando não (per `phase-03-videos/TD-07`, `phase-03-videos/TD-01`)
3. Incrementar `view_count` por update atômico no mesmo caminho da emissão — a contagem se prende à requisição que emite a URL, não à transferência dos bytes (per `phase-03-videos/TD-07`)
4. Adicionar `@Get(':publicId/playback-url')` ao `VideosController` com os decoradores OpenAPI de 200/404/409/401

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Unit: `processing_status` em `processing` → `VideoNotReadyException`; em `failed` → `VideoProcessingFailedException`; rascunho de outro dono → `VideoNotFoundException`; `thumbnail_key` nulo → `thumbnailUrl: null` | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.getPlaybackUrl` | Integration: a URL emitida serve o objeto real do MinIO respondendo `206` a `Range`, e `view_count` sobe exatamente 1 por emissão | `src/videos/videos.playback.integration-spec.ts` |

Sem linha de E2E nesta tabela por desenho — cenários HTTP autorados por `/plan-test-specs`.

**Dependencies:** SI-03.12 — o vídeo só chega a `ready` com metadados e thumbnail depois do processamento

**Acceptance criteria:**

- `GET /videos/:publicId/playback-url` num vídeo `ready` retorna `200` com `url`, `expiresAt`, `durationSeconds` e `thumbnailUrl`
- Um `GET` na `url` devolvida com `Range: bytes=0-1023` responde `206` com `Content-Range`, sem que a API tenha servido nenhum byte
- Um `GET` na `url` sem header `Range` responde `200` e permite começar a tocar antes do download completo
- Cada `200` do endpoint incrementa `view_count` do vídeo em exatamente 1
- `GET /videos/:publicId/playback-url` num vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:publicId/playback-url` num vídeo em `failed` retorna `409` com `error: "VIDEO_PROCESSING_FAILED"`
- `GET /videos/:publicId/playback-url` num rascunho de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, indistinguível da resposta a um `publicId` inexistente
- A `url` devolvida deixa de servir o objeto depois de `STORAGE_PRESIGN_TTL_SECONDS`

---

### SI-03.14 — Download do vídeo: URL presigned com disposição de anexo

**Route:** GET /videos/:publicId/download-url
**Test Specs:** see `nestjs-project/specs/videos-download-url.plan.md`
**Authorization:** Authenticated para vídeo publicado; Owner enquanto rascunho

**Description:** Implementar o endpoint de download pelo mesmo mecanismo presigned do playback, acrescentando o override de content-disposition que força o navegador a salvar o arquivo com o nome original.

**Technical actions:**

1. Adicionar `VideosService.getDownloadUrl(user, publicId)` — mesma resolução, mesma regra de posse e mesmas guardas de `processing_status` do playback, sem incrementar `view_count` (download não é visualização) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
2. Assinar por `StorageService.signDownloadUrl(video.storage_key, { attachmentFilename: video.original_filename })`, que aplica o override de disposição na própria URL (per `phase-03-videos/TD-07`)
3. Adicionar `@Get(':publicId/download-url')` ao `VideosController` com os decoradores OpenAPI de 200/404/409/401

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDownloadUrl` | Unit: mesmas guardas de estado e de posse do playback; `view_count` **não** é incrementado | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.getDownloadUrl` | Integration: a URL emitida serve o objeto do MinIO com `Content-Disposition: attachment` carregando `original_filename` | `src/videos/videos.download.integration-spec.ts` |

Sem linha de E2E nesta tabela por desenho — cenários HTTP autorados por `/plan-test-specs`.

**Dependencies:** SI-03.12 — mesma pré-condição de estado `ready` do playback (independente de SI-03.13)

**Acceptance criteria:**

- `GET /videos/:publicId/download-url` num vídeo `ready` retorna `200` com `url` e `expiresAt`
- Um `GET` na `url` devolvida responde com `Content-Disposition: attachment` e o nome de arquivo igual ao `original_filename` do vídeo
- O conteúdo baixado pela `url` é byte-a-byte igual ao objeto armazenado
- Emitir uma URL de download **não** altera `view_count`
- `GET /videos/:publicId/download-url` num vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:publicId/download-url` num rascunho de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:publicId/download-url` sem token de acesso retorna `401`

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | uuid | PK, generated | Internal key. Foreign keys point here, never at `public_id` (per `phase-03-videos/TD-06`) |
| public_id | varchar(16) | unique, not null | Random ~11-character URL-safe identifier, generated at draft creation, retried on unique-constraint violation. Canonical public route `/watch/<publicId>` (per `phase-03-videos/TD-06`) |
| channel_id | uuid | FK → channels.id, not null | Owning channel; the channel's `user_id` is the ownership chain for authorization |
| title | varchar(255) | not null | Supplied at upload initiation |
| description | text | nullable | Not edited in this phase |
| original_filename | varchar(255) | not null | Supplied at upload initiation; its extension feeds `storage_key` |
| content_type | varchar(100) | not null | Declared MIME type, validated against the accepted list |
| size_bytes | bigint | not null | Declared byte size, validated against the 10GB ceiling |
| storage_key | varchar(512) | not null | `videos/<public_id>/original.<ext>` (per `phase-03-videos/TD-01`) |
| thumbnail_key | varchar(512) | nullable | `videos/<public_id>/thumbnail.jpg`, written by the worker (per `phase-03-videos/TD-01`) |
| upload_id | varchar(255) | nullable | Multipart upload id returned by storage at initiation; cleared on completion or abort (per `phase-03-videos/TD-02`) |
| duration_seconds | integer | nullable | Extracted by `ffprobe` (per `phase-03-videos/TD-05`) |
| metadata | jsonb | nullable | `ffprobe` `format` + video/audio stream subset (per `phase-03-videos/TD-05`) |
| processing_status | enum | not null, default `awaiting_upload` | `awaiting_upload` \| `uploading` \| `processing` \| `ready` \| `failed`; `failed` is terminal (per `phase-03-videos/TD-08`) |
| processing_error | text | nullable | Reason recorded when `processing_status` reaches `failed` (per `phase-03-videos/TD-08`) |
| publication_status | enum | not null, default `draft` | `draft` \| `published`. Publishing requires `processing_status = 'ready'`; the publish transition itself is a Phase 04 capability (per `phase-03-videos/TD-08`) |
| view_count | integer | not null, default `0` | Incremented when a playback URL is issued (per `phase-03-videos/TD-07`) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`)
**Indexes:** `(public_id)` — unique, `(channel_id)` — FK, `(processing_status)` — for dashboard filtering and requeue sweeps

**Orthogonality invariant** (per `phase-03-videos/TD-08`): `processing_status` and `publication_status` answer independent questions and are never collapsed into one column. "Watchable" is the explicit conjunction `processing_status = 'ready' AND publication_status = 'published'` — never an implicit enum reading.

### API Contracts

**Error response envelope:** inherited from `phase-02-auth/TD-07` — `{ statusCode, error, message }`, where `error` carries the domain code from the Error Catalog below. Not redefined by this phase.

**OpenAPI:** every endpoint below carries explicit `@ApiOperation`, `@ApiResponse` (per status code, including the error envelope via `ApiErrorEnvelopeDto`), `@ApiBody` and `@ApiParam` decorators, per `openapi-docs-nestjs/TD-01` — the `class-validator` CLI plugin infers DTO schemas but not operations, typed responses or error contracts.

#### POST /videos (SI-03.7)

Initiates a resumable multipart upload and pre-registers the video as a draft in the same operation (per `phase-03-videos/TD-02`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer `<access token>`

**Request body:**
- title: string, required — max 255 characters
- description: string, optional — free text
- filename: string, required — max 255 characters; its extension becomes `<ext>` in `storage_key`
- contentType: string, required — must be in the accepted MIME list
- sizeBytes: number, required — integer, max `10737418240` (10 GiB)

**Response 201:**
- publicId: string — the ~11-character public identifier
- uploadId: string — the storage multipart upload id
- partSizeBytes: number — the part size every non-final part must use
- partCount: number — `ceil(sizeBytes / partSizeBytes)`
- parts: array of `{ partNumber: number, url: string, expiresAt: string (ISO-8601) }` — presigned `PUT` URLs signed with the browser-reachable storage endpoint (per `phase-03-videos/TD-02`)

**Error responses:**
- 413 VIDEO_UPLOAD_TOO_LARGE: when `sizeBytes` exceeds the configured ceiling
- 415 UNSUPPORTED_VIDEO_FORMAT: when `contentType` is not in the accepted list
- 401 unauthorized: when no valid access token is presented
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:publicId/upload/parts (SI-03.8)

Re-signs presigned part URLs so an interrupted upload resumes without restarting (per `phase-03-videos/TD-02`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer `<access token>`

**Request body:**
- partNumbers: array of number, required — 1..`partCount`, max 1000 entries per request

**Response 200:**
- parts: array of `{ partNumber: number, url: string, expiresAt: string (ISO-8601) }`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not resolve to a video owned by the caller
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when the video has no open `upload_id`
- 401 unauthorized: when no valid access token is presented
- 400 validation error: when a requested part number is outside `1..partCount`

---

#### POST /videos/:publicId/upload/complete (SI-03.9)

Asks storage to assemble the object, then enqueues processing (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer `<access token>`

**Request body:**
- parts: array of `{ partNumber: number, etag: string }`, required — every uploaded part, in ascending `partNumber` order

**Response 200:**
- publicId: string
- processingStatus: string — `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not resolve to a video owned by the caller
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when the video has no open `upload_id`
- 401 unauthorized: when no valid access token is presented
- 400 validation error: when the parts array is empty or malformed

---

#### DELETE /videos/:publicId/upload (SI-03.9)

Aborts the multipart upload at storage and discards the draft.

**Request headers:**
- Authorization: Bearer `<access token>`

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not resolve to a video owned by the caller
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when the video has no open `upload_id`
- 401 unauthorized: when no valid access token is presented

---

#### GET /videos/:publicId/playback-url (SI-03.13)

Issues a short-lived presigned `GET` URL; the storage service answers `Range` with `206 Partial Content` (per `phase-03-videos/TD-07`). View counting is recorded at issuance, not at byte transfer.

**Request headers:**
- Authorization: Bearer `<access token>`

**Response 200:**
- url: string — presigned `GET` URL signed with the browser-reachable storage endpoint
- expiresAt: string (ISO-8601)
- durationSeconds: number | null — from `duration_seconds` (per `phase-03-videos/TD-05`)
- thumbnailUrl: string | null — presigned `GET` URL for `thumbnail_key`; `null` until the worker writes it (per `phase-03-videos/TD-01`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not resolve to a video the caller may reach
- 409 VIDEO_NOT_READY: when `processing_status` is `awaiting_upload`, `uploading` or `processing`
- 409 VIDEO_PROCESSING_FAILED: when `processing_status` is the terminal `failed`
- 401 unauthorized: when no valid access token is presented

---

#### GET /videos/:publicId/download-url (SI-03.14)

Same presigned mechanism as playback, with a response content-disposition override forcing an attachment (per `phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer `<access token>`

**Response 200:**
- url: string — presigned `GET` URL carrying the attachment content-disposition override, filename `original_filename`
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not resolve to a video the caller may reach
- 409 VIDEO_NOT_READY: when `processing_status` is `awaiting_upload`, `uploading` or `processing`
- 409 VIDEO_PROCESSING_FAILED: when `processing_status` is the terminal `failed`
- 401 unauthorized: when no valid access token is presented

---

#### Validation Rules — Upload initiation and part signing

| Field | Rule | Error |
|-------|------|-------|
| title | required, string, max 255 | 400 validation error |
| filename | required, string, max 255 | 400 validation error |
| contentType | required, one of the configured accepted MIME list | 415 UNSUPPORTED_VIDEO_FORMAT |
| sizeBytes | required, integer, min 1, max `10737418240` | 413 VIDEO_UPLOAD_TOO_LARGE |
| partNumbers[] | required, non-empty, each integer in `1..partCount` | 400 validation error |
| parts[].partNumber | required, integer, ascending, no gaps | 400 validation error |
| parts[].etag | required, non-empty string | 400 validation error |

The ceiling and the accepted MIME list are configuration (`video.config.ts`), not literals in code — `10737418240` is the default for `VIDEO_MAX_UPLOAD_BYTES`. The ceiling is enforced **at initiation** on the declared `sizeBytes`, and again at completion against the assembled object's size reported by storage — the API never sees the bytes, so declaration alone is not trusted.

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner | Notes |
|----------|-----------|---------------|-------|-------|
| POST /videos | ✗ | ✗ | ✓ | The draft is created for the caller's own channel; there is no cross-channel upload |
| POST /videos/:publicId/upload/parts | ✗ | ✗ | ✓ | Owner of the video's channel only |
| POST /videos/:publicId/upload/complete | ✗ | ✗ | ✓ | Owner of the video's channel only |
| DELETE /videos/:publicId/upload | ✗ | ✗ | ✓ | Owner of the video's channel only |
| GET /videos/:publicId/playback-url | ✗ | ✓ | ✓ | Authenticated for any `publication_status = 'published'` video; owner-only while `publication_status = 'draft'` (per `phase-03-videos/TD-08`) |
| GET /videos/:publicId/download-url | ✗ | ✓ | ✓ | Same rule as playback |

The global `JwtAuthGuard` registered as `APP_GUARD` in Phase 02 already protects every route by default; no endpoint in this phase carries `@Public()`. Ownership is resolved as `video.channel.user_id === currentUser.id`; a non-owner asking for a draft receives `404 VIDEO_NOT_FOUND`, never `403` — a probing request must not confirm that the identifier exists (which is what makes the non-enumerable `public_id` of `phase-03-videos/TD-06` worth having).

**Anonymous playback is out of scope here by construction:** it becomes reachable when the publication flow lands (Phase 04 — "fluxo de rascunho e publicação"), at which point `GET /videos/:publicId/playback-url` gains `@Public()` for published videos. Phase 03 ships no publish transition, so every video is a draft and only its owner can obtain a URL.

---

### Error Catalog

**Error response format:** inherited from `phase-02-auth/TD-07` — `{ statusCode, error, message }`. This phase adds codes to the existing catalog; it does not redefine the envelope.

| errorCode | HTTP | Message | Trigger |
|-----------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:publicId/*` endpoint when `public_id` does not resolve, or resolves to a draft the caller does not own |
| VIDEO_UPLOAD_TOO_LARGE | 413 | Video exceeds the maximum upload size | POST /videos with `sizeBytes` above the configured ceiling, or completion when the assembled object exceeds it |
| UNSUPPORTED_VIDEO_FORMAT | 415 | Video format is not supported | POST /videos with a `contentType` outside the accepted list |
| VIDEO_UPLOAD_NOT_IN_PROGRESS | 409 | No upload in progress for this video | Part signing, completion or abort when `upload_id` is null |
| VIDEO_NOT_READY | 409 | Video is still being processed | Playback or download URL requested while `processing_status` is `awaiting_upload`, `uploading` or `processing` |
| VIDEO_PROCESSING_FAILED | 409 | Video processing failed | Playback or download URL requested while `processing_status` is the terminal `failed` (per `phase-03-videos/TD-08`) |

`VIDEO_NOT_READY` and `VIDEO_PROCESSING_FAILED` are deliberately distinct: the first is transient and retrying makes sense, the second is terminal and only a re-enqueue by id changes it (per `phase-03-videos/TD-09`).

---

### Events/Messages

#### video.process

Queue name `video-processing`, registered via `@nestjs/bullmq` over Redis (per `phase-03-videos/TD-03`).

**Payload:**

```json
{ "videoId": "uuid" }
```

`videoId` is the internal `Video.id` primary key, not `public_id`. The job carries nothing else — no storage key, no size, no channel, no title (per `phase-03-videos/TD-09`).

**Producer:** `VideosService.completeUpload()` in the `nestjs-api` service (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
**Consumer:** `VideoProcessingProcessor` in the `video-worker` service — a NestJS standalone application from the same source, FFmpeg installed as a system package in its image (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
**Trigger:** a successful `POST /videos/:publicId/upload/complete`, after storage confirms the object is assembled
**Delivery semantics:** at-least-once, with an attempt ceiling and exponential backoff configured on the queue (per `phase-03-videos/TD-03`). On exhausting the attempts the worker leaves the video in the terminal `failed` `processing_status` with `processing_error` filled, rather than retrying forever (per `phase-03-videos/TD-08`). Reprocessing is re-enqueueing the same `videoId`, which is safe because the job carries no state that can go stale (per `phase-03-videos/TD-09`).

**Worker side-effects on success:** writes `duration_seconds`, `metadata`, `thumbnail_key` and `processing_status = 'ready'` back to the record; uploads `videos/<public_id>/thumbnail.jpg` through the internal storage endpoint (per `phase-03-videos/TD-09`, `phase-03-videos/TD-01`).

**Idempotency:** the processor re-reads the record at the start of every attempt and recomputes from the stored object, so a redelivery overwrites its own previous partial output instead of compounding it.

---

## Dependency Map

```
SI-03.1 (root — dependências e config)
├── SI-03.2 — depends on SI-03.1 (os serviços do Compose consomem as variáveis de ambiente)
│   └── SI-03.11 — depends on SI-03.2 (ffprobe/ffmpeg só existem na imagem do worker)
├── SI-03.3 — depends on SI-03.1
│   └── SI-03.4 — depends on SI-03.3 (retry de colisão precisa da constraint unique)
├── SI-03.5 — depends on SI-03.1 + SI-03.2 (config de storage + MinIO no ar)
└── SI-03.6 — depends on SI-03.1 + SI-03.2 (config de fila + Redis no ar)

SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.7 — depends on todos os três (entidade, public_id, storage)
    ├── SI-03.8 — depends on SI-03.7 (reassina partes de um upload já iniciado)
    └── SI-03.9 — depends on SI-03.7 + SI-03.6 (conclui o upload e enfileira)

SI-03.2 + SI-03.5 + SI-03.6
└── SI-03.10 — depends on todos os três (worker standalone com storage e fila)

SI-03.9 + SI-03.10 + SI-03.11
└── SI-03.12 — depends on todos os três (consome o job, roda FFmpeg, fecha o ciclo de status)
    ├── SI-03.13 — depends on SI-03.12 (playback exige processing_status = 'ready')
    └── SI-03.14 — depends on SI-03.12 (download exige a mesma pré-condição; independente de SI-03.13)
```

Ordem linearizada de implementação: SI-03.1 → SI-03.2, SI-03.3 (paralelos) → SI-03.4, SI-03.5, SI-03.6, SI-03.11 (paralelos) → SI-03.7 → SI-03.8, SI-03.9, SI-03.10 (SI-03.8 e SI-03.10 paralelos a SI-03.9) → SI-03.12 → SI-03.13, SI-03.14 (paralelos)

Caminho crítico: SI-03.1 → SI-03.3 → SI-03.4 → SI-03.7 → SI-03.9 → SI-03.12 → SI-03.13

---

## Deliverables

- [ ] SI-03.1 — Dependências, namespaces de configuração e validação de ambiente
- [ ] SI-03.2 — Infra do Compose: MinIO, Redis, bucket e imagem do worker com FFmpeg
- [ ] SI-03.3 — Fundação do módulo de vídeos: entidade `Video`, migration e exceções de domínio
- [ ] SI-03.4 — Gerador de identificador público curto, com retry em colisão
- [ ] SI-03.5 — Módulo de storage: cliente S3, derivação de chaves e operações presigned
- [ ] SI-03.6 — Fila de processamento: registro do BullMQ e produtor do job
- [ ] SI-03.7 — Pré-cadastro do rascunho e início do upload multipart
- [ ] SI-03.8 — Reassinatura de partes para retomada do upload
- [ ] SI-03.9 — Conclusão e cancelamento do upload, com enfileiramento do processamento
- [ ] SI-03.10 — Worker como aplicação NestJS standalone
- [ ] SI-03.11 — Adaptador FFmpeg: extração de metadados e geração de thumbnail
- [ ] SI-03.12 — Processor do job: ciclo de status e falha terminal
- [ ] SI-03.13 — Entrega por streaming: URL de playback presigned
- [ ] SI-03.14 — Download do vídeo: URL presigned com disposição de anexo

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
