---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-initiate.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` abre o protocolo de upload da Fase 03: numa única operação pré-cadastra o vídeo como rascunho no canal do usuário autenticado e inicia o multipart upload no object storage, devolvendo as URLs presigned `PUT` das partes. O endpoint recebe `title`, `description`, `filename`, `contentType` e `sizeBytes`, aloca o `public_id` curto e não enumerável, deriva `storage_key` como `videos/<publicId>/original.<ext>`, persiste a linha com `processing_status = 'uploading'`, `publication_status = 'draft'` e `upload_id` preenchido, e assina o primeiro lote de partes com o endpoint de storage alcançável pelo navegador. Nenhum byte do arquivo passa pela API — o corpo da requisição carrega só metadados. `contentType` fora da lista aceita e `sizeBytes` acima do teto configurado não são erro de validação genérico: são `415 UNSUPPORTED_VIDEO_FORMAT` e `413 VIDEO_UPLOAD_TOO_LARGE` do Error Catalog. A rota é protegida pelo `JwtAuthGuard` global da Fase 02 e o rascunho nasce sempre no canal do próprio autenticado.

## Test Scenarios

### 1. POST /videos (SI-03.7)

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` chama `cleanAllTables(dataSource)` de `src/test/create-test-data-source`; MinIO e Redis reais do Compose; o usuário autenticado e seu canal saem do fluxo de cadastro → confirmação → login da Fase 02 (o canal é criado junto com o usuário por `UsersService`), e o `access_token` vai no header `Authorization`.

#### 1.1. initiate-upload-cria-rascunho-e-devolve-partes-presigned

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos` com `Authorization: Bearer <access token>` e corpo válido (`title`, `filename`, `contentType` na lista aceita, `sizeBytes` abaixo do teto)
    - expect: status `201`
    - expect: o corpo traz `publicId` (string de ~11 caracteres), `uploadId`, `partSizeBytes`, `partCount` igual a `ceil(sizeBytes / partSizeBytes)` e `parts` não vazio
    - expect: cada item de `parts` tem `partNumber`, `url` e `expiresAt` em ISO-8601, e `parts.length === partCount`
  2. Consultar a tabela `videos` pelo `publicId` devolvido
    - expect: existe exatamente uma linha com aquele `public_id`
    - expect: `processing_status = 'uploading'`, `publication_status = 'draft'` e `upload_id` não nulo
    - expect: `channel_id` é o canal do usuário autenticado que fez a chamada
    - expect: `storage_key` é `videos/<publicId>/original.<ext>`, com `<ext>` vindo do `filename` enviado

#### 1.2. initiate-upload-rejeita-size-bytes-acima-do-teto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos` autenticado com `sizeBytes` acima de `VIDEO_MAX_UPLOAD_BYTES`
    - expect: status `413`
    - expect: o envelope de erro traz `error: "VIDEO_UPLOAD_TOO_LARGE"`
  2. Contar as linhas da tabela `videos`
    - expect: nenhuma linha foi criada
    - expect: nenhum multipart upload foi aberto no storage

#### 1.3. initiate-upload-rejeita-content-type-fora-da-lista

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos` autenticado com `contentType` fora de `VIDEO_ACCEPTED_MIME_TYPES` (por exemplo `application/pdf`)
    - expect: status `415`
    - expect: o envelope de erro traz `error: "UNSUPPORTED_VIDEO_FORMAT"`
  2. Contar as linhas da tabela `videos`
    - expect: nenhuma linha foi criada

#### 1.4. initiate-upload-exige-token-de-acesso

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos` com corpo válido e **sem** header `Authorization`
    - expect: status `401`
    - expect: nenhuma linha foi criada na tabela `videos`

#### 1.5. partes-presigned-aceitam-put-direto-sem-credencial

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos` autenticado com um `sizeBytes` que produza ao menos uma parte
    - expect: status `201` e `parts[0].url` presente
  2. `PUT` direto na `parts[0].url` com um buffer de bytes, **sem** header `Authorization` e sem nenhuma credencial de storage
    - expect: o storage responde `200` e devolve um `ETag`
    - expect: a requisição não tocou o processo da API — o host da `url` é o endpoint público do storage, não o da aplicação

#### 1.6. public-id-distinto-e-sem-relacao-de-ordem-entre-uploads

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos` autenticado duas vezes em sequência, com o mesmo usuário e corpos válidos
    - expect: os dois `publicId` são diferentes
    - expect: o segundo `publicId` não é o primeiro incrementado nem um sufixo sequencial dele — não há relação de ordem observável entre os dois
    - expect: as duas linhas em `videos` têm `public_id` distintos e a constraint de unicidade não foi violada
