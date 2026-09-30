---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete + DELETE /videos/:publicId/upload — Test Plan

## Application Overview

Os dois endpoints que fecham o protocolo de upload da Fase 03, ambos do `SI-03.9`. `POST /videos/:publicId/upload/complete` recebe a lista de partes (`partNumber` + `etag`, em ordem crescente e sem lacunas), manda o storage montar o objeto, confere por `headObject` que o objeto montado não excede `VIDEO_MAX_UPLOAD_BYTES` — o teto declarado no initiate não é confiável porque a API nunca vê os bytes —, limpa `upload_id`, grava `processing_status = 'processing'` e só então enfileira o job `video.process` na fila `video-processing` com payload fino `{ videoId }` (id interno, nunca o `public_id`). Se o objeto montado exceder o teto, o multipart é abortado e a resposta é `413 VIDEO_UPLOAD_TOO_LARGE`, sem job e sem objeto residual. `DELETE /videos/:publicId/upload` aborta o multipart e descarta o rascunho, deixando o bucket sem partes órfãs. Ambos exigem posse e `upload_id` aberto; a segunda conclusão do mesmo vídeo responde `409 VIDEO_UPLOAD_NOT_IN_PROGRESS` e não enfileira um segundo job.

## Test Scenarios

### 1. POST /videos/:publicId/upload/complete (SI-03.9)

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` chama `cleanAllTables(dataSource)` de `src/test/create-test-data-source` e drena a fila `video-processing` no Redis; MinIO e Redis reais do Compose; usuário autenticado com canal pelo fluxo da Fase 02, e um upload aberto por `POST /videos` com as partes já enviadas por `PUT` presigned.

#### 1.1. complete-monta-objeto-move-para-processing-e-enfileira-um-job

**Covers AC:** #1, #2, #3
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos/:publicId/upload/complete` autenticado com todas as partes enviadas, cada uma com seu `partNumber` e `etag`, em ordem crescente
    - expect: status `200`
    - expect: o corpo traz `publicId` e `processingStatus: "processing"`
  2. Ler a linha do vídeo na tabela `videos`
    - expect: `upload_id` é nulo
    - expect: `processing_status = 'processing'`
  3. Inspecionar a fila `video-processing` no Redis
    - expect: existe exatamente **um** job pendente
    - expect: o payload do job é `{ videoId }` com o `id` interno (uuid) daquele vídeo, e não o `public_id`
  4. Ler o objeto montado no bucket
    - expect: o objeto existe sob a chave `videos/<publicId>/original.<ext>`
    - expect: o `ContentLength` do objeto é a soma exata dos tamanhos das partes enviadas

#### 1.2. complete-com-objeto-acima-do-teto-aborta-sem-enfileirar

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Abrir um upload declarando um `sizeBytes` abaixo do teto, mas enviar partes cuja soma real excede `VIDEO_MAX_UPLOAD_BYTES` (teto reduzido por configuração de teste)
    - expect: cada `PUT` presigned responde `200`
  2. `POST /videos/:publicId/upload/complete` com essas partes
    - expect: status `413`
    - expect: o envelope de erro traz `error: "VIDEO_UPLOAD_TOO_LARGE"`
    - expect: a fila `video-processing` continua vazia — nenhum job foi enfileirado
    - expect: a chave `videos/<publicId>/original.<ext>` não existe no bucket e não há partes residuais do multipart

#### 1.3. complete-repetido-responde-409-e-nao-enfileira-segundo-job

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos/:publicId/upload/complete` uma primeira vez com todas as partes
    - expect: status `200` e exatamente um job na fila `video-processing`
  2. `POST /videos/:publicId/upload/complete` uma segunda vez com o mesmo corpo
    - expect: status `409`
    - expect: o envelope de erro traz `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`
    - expect: a fila `video-processing` continua com **um** único job — nenhum segundo job foi enfileirado

#### 1.4. nenhum-byte-do-arquivo-trafega-pela-api

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Percorrer o protocolo inteiro — `POST /videos`, `PUT` nas URLs presigned, `POST /videos/:publicId/upload/parts`, `POST /videos/:publicId/upload/complete` — medindo o corpo de cada requisição feita ao servidor da aplicação
    - expect: nenhuma requisição à API carrega o conteúdo do arquivo; os corpos só têm metadados (`title`, `filename`, `contentType`, `sizeBytes`, `partNumbers`, `parts[].partNumber`, `parts[].etag`)
    - expect: o host das URLs de `PUT` das partes é o endpoint do storage, não o da aplicação
    - expect: o objeto final existe no bucket com o tamanho somado das partes, provando que os bytes chegaram lá sem intermediação da API

### 2. DELETE /videos/:publicId/upload (SI-03.9)

**Setup:** o mesmo bootstrap do grupo 1; o cenário abre um upload por `POST /videos` e envia ao menos uma parte por `PUT` presigned antes de cancelar, para que haja parte residual a limpar.

#### 2.1. abort-descarta-rascunho-e-nao-deixa-parte-residual

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `DELETE /videos/:publicId/upload` autenticado como dono, com o upload em andamento e ao menos uma parte já enviada
    - expect: status `204` e corpo vazio
  2. Consultar a tabela `videos` por aquele `public_id`
    - expect: a linha do rascunho deixou de existir
  3. Listar os multipart uploads e os objetos do prefixo `videos/<publicId>/` no bucket
    - expect: não há multipart aberto para aquela chave
    - expect: não sobrou nenhuma parte nem objeto sob o prefixo
