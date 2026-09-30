---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-playback-url.e2e-spec.ts
---

# GET /videos/:publicId/playback-url — Test Plan

## Application Overview

`GET /videos/:publicId/playback-url` emite a URL presigned `GET` de playback de um vídeo pronto. Quem responde `Range` com `206 Partial Content` é o próprio object storage, não a API — a aplicação só assina, e nenhum byte do vídeo atravessa o processo Node. A resposta traz `url`, `expiresAt`, `durationSeconds` (de `duration_seconds`) e `thumbnailUrl` (presigned de `thumbnail_key`, `null` enquanto o worker não escreveu a thumbnail). O endpoint exige `processing_status = 'ready'`: em `awaiting_upload`/`uploading`/`processing` responde `409 VIDEO_NOT_READY`, e no estado terminal `failed` responde `409 VIDEO_PROCESSING_FAILED` — a distinção é deliberada, o primeiro é transitório e o segundo só muda por reenfileiramento. A autorização segue a Authorization Matrix: qualquer autenticado alcança vídeo publicado, só o dono alcança rascunho, e fora disso a resposta é `404 VIDEO_NOT_FOUND` e nunca `403`, para que uma sondagem não confirme que o identificador existe. Cada emissão bem-sucedida incrementa `view_count` em exatamente 1 — a contagem se prende à requisição que emite a URL, não à transferência dos bytes. Na Fase 03 todo vídeo é rascunho (não existe transição de publicação), então só o dono obtém URL.

## Test Scenarios

### 1. GET /videos/:publicId/playback-url (SI-03.13)

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` chama `cleanAllTables(dataSource)` de `src/test/create-test-data-source`; MinIO real do Compose; usuário autenticado com canal pelo fluxo da Fase 02; um vídeo em `processing_status = 'ready'` com objeto real no bucket, `duration_seconds` e `thumbnail_key` preenchidos, montado por upload completo + escrita do estado terminal de sucesso (sem depender do worker rodando).

#### 1.1. playback-url-de-video-ready-devolve-url-e-metadados

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `GET /videos/:publicId/playback-url` autenticado como dono, num vídeo `ready`
    - expect: status `200`
    - expect: o corpo traz `url`, `expiresAt` em ISO-8601, `durationSeconds` igual ao `duration_seconds` da linha e `thumbnailUrl` não nulo quando `thumbnail_key` existe
    - expect: a `url` aponta para o endpoint público do storage, não para o host da aplicação
  2. `GET /videos/:publicId/playback-url` num vídeo `ready` cujo `thumbnail_key` é nulo
    - expect: status `200` com `thumbnailUrl: null`

#### 1.2. url-presigned-responde-206-a-range-e-200-sem-range-sem-a-api-servir-bytes

**Covers AC:** #2, #3
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Obter a `url` por `GET /videos/:publicId/playback-url` e fazer um `GET` nela com o header `Range: bytes=0-1023`
    - expect: status `206`
    - expect: o header `Content-Range` está presente e descreve a faixa pedida sobre o tamanho total do objeto
    - expect: o corpo tem 1024 bytes, e nenhum deles foi servido pela API — o `GET` foi direto ao storage
  2. Fazer um `GET` na mesma `url` **sem** header `Range`
    - expect: status `200` com `Accept-Ranges: bytes` e `Content-Length` igual ao tamanho do objeto
    - expect: os primeiros bytes chegam antes do fim da transferência — o playback pode começar sem download completo

#### 1.3. cada-emissao-incrementa-view-count-em-exatamente-um

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Ler o `view_count` do vídeo `ready` antes de qualquer emissão
    - expect: o valor inicial é `0`
  2. `GET /videos/:publicId/playback-url` autenticado três vezes
    - expect: as três respostas são `200`
    - expect: `view_count` na tabela `videos` é `3` — exatamente um incremento por resposta `200`, independente de a `url` ter sido usada ou não

#### 1.4. video-em-processamento-responde-409-video-not-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `GET /videos/:publicId/playback-url` autenticado como dono, num vídeo com `processing_status = 'processing'`
    - expect: status `409`
    - expect: o envelope de erro traz `error: "VIDEO_NOT_READY"`
    - expect: `view_count` não foi incrementado

#### 1.5. video-em-falha-terminal-responde-409-video-processing-failed

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `GET /videos/:publicId/playback-url` autenticado como dono, num vídeo com `processing_status = 'failed'` e `processing_error` preenchido
    - expect: status `409`
    - expect: o envelope de erro traz `error: "VIDEO_PROCESSING_FAILED"`, distinto de `VIDEO_NOT_READY`
    - expect: `view_count` não foi incrementado

#### 1.6. rascunho-de-outro-dono-e-id-inexistente-respondem-404-identico

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Criar um vídeo `ready` com o usuário A e chamar `GET /videos/:publicId/playback-url` com o token do usuário B
    - expect: status `404`
    - expect: o envelope de erro traz `error: "VIDEO_NOT_FOUND"`
    - expect: a resposta **não** é `403` — não confirma que o identificador existe
  2. `GET /videos/:publicId/playback-url` com um `publicId` que nunca existiu, autenticado como B
    - expect: status `404` com a mesma resposta byte a byte do passo 1 (mesmo `statusCode`, mesmo `error`, mesma `message`)
    - expect: `view_count` do vídeo de A não foi incrementado

#### 1.7. url-emitida-deixa-de-servir-o-objeto-apos-o-ttl

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Com `STORAGE_PRESIGN_TTL_SECONDS` reduzido a um valor curto na configuração de teste, obter a `url` por `GET /videos/:publicId/playback-url`
    - expect: um `GET` imediato na `url` responde `200`
  2. Esperar o TTL expirar e repetir o `GET` na mesma `url`
    - expect: o storage recusa a requisição (status `4xx` de assinatura expirada) e não serve o objeto
    - expect: uma nova chamada ao endpoint devolve uma `url` nova que volta a servir
