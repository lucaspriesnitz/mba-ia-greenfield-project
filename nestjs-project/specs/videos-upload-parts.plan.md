---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-parts.e2e-spec.ts
---

# POST /videos/:publicId/upload/parts — Test Plan

## Application Overview

`POST /videos/:publicId/upload/parts` reassina URLs presigned `PUT` de partes específicas de um upload em andamento. É o endpoint que torna a retomada real: as URLs do lote inicial expiram em `STORAGE_PRESIGN_TTL_SECONDS`, e sem reassinatura uma queda de conexão obrigaria reiniciar o upload de 10GB do zero. O corpo carrega `partNumbers`, um array não vazio de inteiros em `1..partCount`, com teto de 1000 entradas por requisição. O serviço resolve o vídeo por `public_id` **com checagem de posse** — um vídeo de outro dono responde `404 VIDEO_NOT_FOUND`, nunca `403`, para não confirmar que o identificador existe —, exige `upload_id` não nulo sob pena de `409 VIDEO_UPLOAD_NOT_IN_PROGRESS`, e valida cada número contra o `partCount` derivado de `size_bytes`. A resposta preserva a ordem pedida, e reenviar uma parte por URL reassinada substitui a parte de mesmo número sem corromper o que já subiu.

## Test Scenarios

### 1. POST /videos/:publicId/upload/parts (SI-03.8)

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` chama `cleanAllTables(dataSource)` de `src/test/create-test-data-source`; MinIO e Redis reais do Compose; usuário autenticado com canal pelo fluxo da Fase 02, e um rascunho com upload em andamento criado por `POST /videos` antes de cada cenário.

#### 1.1. reassina-partes-na-ordem-pedida

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos` autenticado para abrir um upload com `partCount` maior que 1
    - expect: status `201` com `publicId` e `partCount`
  2. `POST /videos/:publicId/upload/parts` com `partNumbers` válido em ordem não trivial (por exemplo `[2, 1]`)
    - expect: status `200`
    - expect: `parts` tem exatamente um item por número pedido
    - expect: `parts[i].partNumber` corresponde a `partNumbers[i]` — a ordem da resposta é a ordem do pedido
    - expect: cada item traz `url` e `expiresAt` em ISO-8601, e as `url` apontam para o endpoint público do storage

#### 1.2. retomada-reenvia-parte-e-conclui-objeto-integro

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Abrir um upload por `POST /videos` e enviar todas as partes por `PUT` nas URLs do lote inicial
    - expect: cada `PUT` responde `200` com `ETag`
  2. `POST /videos/:publicId/upload/parts` pedindo a reassinatura de uma parte já enviada, e reenviar o mesmo conteúdo por `PUT` na URL nova
    - expect: status `200` na reassinatura e `200` com um novo `ETag` no `PUT`
  3. `POST /videos/:publicId/upload/complete` com a lista de partes, usando o `ETag` mais recente de cada número
    - expect: status `200`
    - expect: o objeto montado em `videos/<publicId>/original.<ext>` é legível e seu tamanho é a soma das partes enviadas — a retomada não duplicou nem corrompeu nada

#### 1.3. video-de-outro-dono-responde-404-sem-revelar-existencia

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Abrir um upload com o usuário A, autenticar o usuário B e chamar `POST /videos/:publicId/upload/parts` com o `publicId` de A usando o token de B
    - expect: status `404`
    - expect: o envelope de erro traz `error: "VIDEO_NOT_FOUND"`
    - expect: a resposta é indistinguível da resposta a um `publicId` que não existe — mesmo status, mesmo código, mesma mensagem

#### 1.4. upload-ja-concluido-responde-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. Abrir um upload, enviar as partes e concluir por `POST /videos/:publicId/upload/complete`
    - expect: status `200` e `upload_id` limpo na linha do vídeo
  2. `POST /videos/:publicId/upload/parts` no mesmo `publicId`
    - expect: status `409`
    - expect: o envelope de erro traz `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`

#### 1.5. part-number-fora-do-range-responde-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos/:publicId/upload/parts` num upload em andamento com `partNumbers` contendo um número maior que o `partCount` do vídeo
    - expect: status `400`
    - expect: nenhuma URL é devolvida
  2. `POST /videos/:publicId/upload/parts` com `partNumbers: []`
    - expect: status `400` — o array não pode ser vazio

#### 1.6. reassinatura-exige-token-de-acesso

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-27T23:26:05Z

**Steps:**
  1. `POST /videos/:publicId/upload/parts` com corpo válido e **sem** header `Authorization`
    - expect: status `401`
    - expect: nenhuma URL presigned é emitida
