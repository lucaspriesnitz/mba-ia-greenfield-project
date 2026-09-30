---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-download-url.e2e-spec.ts
---

# GET /videos/:publicId/download-url — Test Plan

## Application Overview

`GET /videos/:publicId/download-url` emite a URL presigned `GET` de download pelo mesmo mecanismo do playback, acrescentando o override de `response-content-disposition` na própria URL para que o navegador salve o arquivo com o `original_filename` do vídeo em vez de tocá-lo. A resposta traz `url` e `expiresAt`. As guardas são as mesmas do playback — `processing_status = 'ready'` obrigatório (`409 VIDEO_NOT_READY` nos estados transitórios, `409 VIDEO_PROCESSING_FAILED` no terminal `failed`), posse verificada com `404 VIDEO_NOT_FOUND` e nunca `403` para rascunho de outro dono, e `401` sem token de acesso — com uma diferença deliberada: emitir URL de download **não** incrementa `view_count`, porque download não é visualização. Nenhum byte do arquivo atravessa a API: o storage serve o objeto direto ao cliente.

## Test Scenarios

### 1. GET /videos/:publicId/download-url (SI-03.14)

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` chama `cleanAllTables(dataSource)` de `src/test/create-test-data-source`; MinIO real do Compose; usuário autenticado com canal pelo fluxo da Fase 02; um vídeo em `processing_status = 'ready'` com objeto real no bucket e `original_filename` conhecido.

#### 1.1. download-url-de-video-ready-devolve-url-e-expiracao

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `GET /videos/:publicId/download-url` autenticado como dono, num vídeo `ready`
    - expect: status `200`
    - expect: o corpo traz `url` e `expiresAt` em ISO-8601
    - expect: a `url` aponta para o endpoint público do storage, não para o host da aplicação

#### 1.2. url-forca-attachment-com-o-nome-original-e-conteudo-identico

**Covers AC:** #2, #3
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Obter a `url` por `GET /videos/:publicId/download-url` e fazer um `GET` nela
    - expect: o header `Content-Disposition` é `attachment` e carrega o `filename` igual ao `original_filename` da linha do vídeo
  2. Comparar o corpo baixado com o objeto armazenado sob `videos/<publicId>/original.<ext>`
    - expect: o conteúdo é byte a byte igual ao objeto do bucket
    - expect: o `Content-Length` bate com o tamanho do objeto

#### 1.3. emitir-download-url-nao-altera-view-count

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Ler o `view_count` do vídeo `ready` antes de qualquer emissão
    - expect: o valor inicial é `0`
  2. `GET /videos/:publicId/download-url` três vezes e baixar o objeto por uma das URLs
    - expect: as três respostas são `200`
    - expect: `view_count` na tabela `videos` continua `0` — download não é visualização

#### 1.4. video-em-processamento-responde-409-video-not-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `GET /videos/:publicId/download-url` autenticado como dono, num vídeo com `processing_status = 'processing'`
    - expect: status `409`
    - expect: o envelope de erro traz `error: "VIDEO_NOT_READY"`
    - expect: nenhuma URL presigned é emitida

#### 1.5. rascunho-de-outro-dono-responde-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Criar um vídeo `ready` com o usuário A e chamar `GET /videos/:publicId/download-url` com o token do usuário B
    - expect: status `404`
    - expect: o envelope de erro traz `error: "VIDEO_NOT_FOUND"`
    - expect: a resposta **não** é `403` e é indistinguível da resposta a um `publicId` inexistente

#### 1.6. download-url-exige-token-de-acesso

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `GET /videos/:publicId/download-url` **sem** header `Authorization`
    - expect: status `401`
    - expect: nenhuma URL presigned é emitida
