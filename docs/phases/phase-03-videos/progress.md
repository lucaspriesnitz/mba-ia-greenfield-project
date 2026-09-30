# phase-03-videos — Progress

**Status:** completed
**SIs:** 14/14 completed (`SI-03.1` a `SI-03.14`)

**Estado medido em 2026-09-29** (tudo por `docker compose exec` de dentro de `nestjs-project/`),
**com a stack inteira no ar, `video-worker` incluído** — que é o estado em que o avaliador roda
`docker compose up -d` e depois `npm test`:

| Medida | Resultado |
|---|---|
| `npm test -- --runInBand --forceExit` | **53 de 53 suítes, 379 de 379 testes verdes, em duas rodadas seguidas com o worker no ar** |
| `npm run test:e2e -- --runInBand --forceExit` | **8 de 8 suítes, 83 de 83 testes verdes** |
| `npx tsc --noEmit` | **exit 0** |
| `npm run lint` | **0 erros, 0 warnings** |
| `npm run build` | **exit 0** |

> **A medição vale no estado que o avaliador encontra, não num arranjo.** Duas rodadas consecutivas
> com o `video-worker` rodando é o que prova ausência de corrida; uma rodada verde não prova nada
> num defeito desse tipo. O FFmpeg mora também na imagem de dev da API (`Dockerfile.dev`), então as
> quatro suítes de FFmpeg rodam em `nestjs-api` como a linha de Deliverables do plano manda — o
> processamento continua sendo do worker, só o binário é que passou a existir nos dois lugares.

O Lote D somou **2 suítes e 6 testes** ao unit/integração e **2 suítes E2E com 13 testes**
(de 6/70 para 8/83).

> **`npm run test:e2e` não embute `--runInBand`**, ao contrário do que o `nestjs-project/CLAUDE.md`
> afirma; e o Jest não sai sozinho depois de nenhuma das duas suítes (conexão TypeORM e conexões
> Redis do BullMQ vazando), então `--forceExit` é obrigatório nas duas. Os números acima foram
> medidos com as duas flags explícitas.
>
> **A dívida de lint do Lote A foi quitada aqui.** Antes do `SI-03.7` o total estava em 162 erros —
> 14 acima da base —, todos em `public-id.service.ts` e no seu spec, escritos às cegas quando o
> Docker estava fora. Detalhe na entrada do `SI-03.7`.

**A suíte é idempotente.** `src/database/migrations.integration-spec.ts` passou a dropar os tipos enum no
`beforeAll`, além das tabelas — sem isso ela deixava `verification_tokens_type_enum` residente e a rodada
seguinte ficava vermelha em `CREATE TYPE ... already exists`. Rodadas consecutivas dão o mesmo resultado,
então não é mais necessário resetar o schema à mão entre medições.

**Infra da fase no ar:** cinco serviços (`db`, `mailpit`, `minio` healthy, `redis` healthy,
`nestjs-api`), bucket `streamtube` criado como private por `minio-init` one-shot. O `video-worker`
está **parado** — é a convenção de medição registrada no `SI-03.12`, porque um consumidor vivo
disputa a fila `video-processing` com a suíte. Subi-lo de volta é do dono.

**Sem operação de git neste trabalho** — nada de `add`, `commit`, `branch` ou `push`. Trabalho feito na
`dev`, que é o que a spec do vault registra como a branch da sessão.

### SI-03.1 — Dependências, namespaces de configuração e validação de ambiente
- **Status:** completed
- **Tests:** 25 passing
- **Observations:**
  - `.env` local (gitignored) recebeu as 15 variáveis novas; sem `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` o bootstrap passa a falhar, então quem clonar o repo precisa do `.env.example` atualizado.
  - Fora de escopo, herdado: `.env.example` segue com `MAIL_FROM="StreamTube" <noreply@streamtube.com>` sem aspas externas — o parser do Compose quebra nessa linha (achado da peça 9 da spec do vault). Não tocado por ser de outro SI.

### SI-03.2 — Infra do Compose: MinIO, Redis, bucket e imagem do worker com FFmpeg
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - **As imagens `minio/minio` e `minio/mc` do plano desapareceram do registry público** (`pull access denied ... repository does not exist`; `quay.io/minio/*` responde `401`; `bitnami/minio` sumiu também). Substituídas por **`chainguard/minio`** nos dois serviços — é MinIO de verdade (`RELEASE.2026-09-22`, nonroot uid 65532), então a TD-01 e o enunciado seguem intactos. A imagem **traz o `mc` embutido**, então o `minio-init` usa a mesma imagem do servidor e o entrypoint de `mc` ficou verbatim: a troca foi de duas linhas de `image:`.
  - AC verificado no ar: seis serviços de pé (`db`, `mailpit`, `minio` healthy, `redis` healthy, `nestjs-api`, `video-worker`); `minio-init` sai `0` como one-shot deve, logando `Bucket created successfully local/streamtube` com `Access permission … is set to private`; `curl http://localhost:9000/minio/health/live` → `200`; `redis-cli ping` → `PONG`; `ffprobe -version` e `ffmpeg -version` no worker → exit 0 (FFmpeg 5.1.9); `GET` anônimo em `/streamtube/anything` → `403 AccessDenied`. `mc mb --ignore-existing` garante a segunda subida.
  - `Dockerfile.worker` usa `CMD tail -f /dev/null`, o mesmo idioma do `Dockerfile.dev`, e não o bootstrap standalone que a ação técnica 4 cita: esse bootstrap nasce só no SI-03.10, e o AC deste SI exige `video-worker` com status `running`. Qualquer outro CMD hoje deixaria o container em crash-loop e reprovaria o próprio AC. O `nestjs-api` também sobe com `tail -f /dev/null` por desenho do repo — zero log e nenhuma resposta HTTP é o comportamento esperado, não falha.

### SI-03.3 — Fundação do módulo de vídeos: entidade `Video`, migration e exceções de domínio
- **Status:** completed
- **Tests:** 32 passing (11 entidade + 5 migration + 2 módulo + 14 exceções)
- **Observations:**
  - `size_bytes` é `bigint` na coluna e `string` no TypeScript — é o que o driver `pg` devolve de verdade para bigint. Quem for comparar com `VIDEO_MAX_UPLOAD_BYTES` nos SIs 03.7/03.9 precisa de `Number(...)` explícito; 10GB cabe em `Number.MAX_SAFE_INTEGER`, então a coerção é segura.
  - `public_id` ficou só com `@Column({ unique: true })`, sem `@Index({ unique: true })` junto: a primeira geração de migration emitiu constraint UNIQUE **e** índice único separado para a mesma coluna. Convenção do repo (`Channel.nickname`, `User.email`) é só `unique: true`. Migration regerada.
  - `video.migration.integration-spec.ts` dropa os tipos enum explicitamente no reset (`DROP TYPE IF EXISTS ... CASCADE`), incluindo `verification_tokens_type_enum`. `DROP TABLE` não leva o tipo enum junto, e sem isso o `CREATE TYPE` da migration seguinte falha com "already exists" — o mesmo defeito que já existe no `src/database/migrations.integration-spec.ts` da fundação.
  - `cleanAllTables` (`src/test/create-test-data-source.ts`) não apaga `videos`, e `videos` referencia `channels`. O spec de entidade apaga `videos` antes de chamar o helper. Se outra suíte inserir vídeos e chamar `cleanAllTables`, ela quebra por FK — o helper compartilhado é candidato a ganhar a linha, fora do escopo deste SI.

### SI-03.4 — Gerador de identificador público curto, com retry em colisão
- **Status:** completed
- **Tests:** 21 passing (8 gerador + 8 serviço unit + 5 serviço integração)
- **Observations:**
  - **Constraint ESM × CommonJS resolvida pelo caminho preferido.** `nanoid@3.3.19` (última linha que publica CommonJS) instalado; `docker compose exec nestjs-api node -e "require('nanoid')"` sai com código 0, e o teste unitário carrega o gerador sob o runtime CommonJS do Jest. O fallback `crypto.randomBytes` do TD-06 não foi necessário.
  - **Contrato do `PublicIdService` fechado como envelope de retry:** `allocate<T>(persist: (publicId: string) => Promise<T>): Promise<T>`. A ação técnica 3 escreve `allocate(): Promise<string>`, mas uma função sem argumentos não consegue inserir em `videos` (`title`, `original_filename`, `content_type`, `size_bytes`, `storage_key` são NOT NULL e só existem no SI-03.7), e a assinatura sem parâmetro só fecharia sondando por existência antes de escrever — o que troca a garantia da constraint unique por uma janela de corrida e não satisfaz nem o teste unitário de 23505 nem o de integração do plano. O SI-03.7 chama `allocate` passando a gravação do rascunho inteiro.
  - Retry restrito a violação de unique **nomeando `public_id`** (`e.code === '23505' && e.detail.includes('public_id')`), o mesmo idioma de `ChannelsService.createChannel`. Qualquer outra falha — inclusive unique em outra coluna e violação de FK — propaga sem consumir tentativa. Teto em `PUBLIC_ID_MAX_ATTEMPTS = 5`, exportado do módulo do serviço; ao estourar, o último erro de colisão é propagado intacto.
  - `PublicIdService` entrou em `providers` **e** `exports` do `VideosModule` — sem isso não é injetável no SI-03.7. A ação técnica 3 não menciona o registro; é wiring mecânico, não decisão.
  - O spec de integração força a colisão real com `jest.spyOn(publicIdUtil, 'generatePublicId').mockReturnValueOnce(<id já tomado>)` — o 23505 vem do Postgres de verdade, só o sorteio é determinístico.

### SI-03.5 — Módulo de storage: cliente S3, derivação de chaves e operações presigned
- **Status:** completed
- **Tests:** 21 passing (4 suítes — keys, module, multipart, presign), verdes de primeira em 2026-09-28
- **Observations:**
  - **Rodado de verdade em 2026-09-28**, com o Docker de volta (peça 32 do vault). Os quatro arquivos de teste escritos às cegas na sessão anterior passaram **sem uma única correção**: as três decisões de forma abaixo se sustentaram contra o MinIO real.
  - As cinco ações técnicas já estavam implementadas na sessão anterior (`storage.module.ts`, `storage-keys.ts`, `storage.service.ts`, `storage.tokens.ts`) e não foram tocadas; o que faltava, e foi escrito aqui, são os quatro arquivos de teste da tabela do SI.
  - **Os dois specs de integração assinam com o endpoint interno, de propósito.** A suíte roda dentro do container `nestjs-api`, onde `STORAGE_PUBLIC_ENDPOINT` (`http://localhost:9000`) resolve para o próprio container e nenhuma URL assinada é alcançável. Trocar o host depois de assinar quebraria a assinatura SigV4, que cobre o header `Host`. Então os testes de bytes constroem o `StorageService` com `publicEndpoint = internalEndpoint`, e a garantia de que a configuração real assina com o host público vira asserção própria em `storage.service.integration-spec.ts`, que é operação local e não precisa de rede.
  - `storage.module.spec.ts` lê o endpoint de volta de uma URL assinada em vez de inspecionar `client.config.endpoint`: a forma do config resolvido do SDK é detalhe de implementação e muda entre minors, e a URL assinada também prova, de graça, o `forcePathStyle` (o bucket aparece no path, não no hostname).
  - As partes do multipart usam 5 MiB, que é o mínimo que o MinIO aceita para qualquer parte que não seja a última.

### SI-03.6 — Fila de processamento: registro do BullMQ e produtor do job
- **Status:** completed
- **Tests:** 8 passing (2 suítes — producer unit, module integração contra o Redis), verdes de primeira em 2026-09-28
- **Observations:**
  - **Rodado de verdade em 2026-09-28.** As três decisões de forma abaixo passaram contra o Redis real sem correção. Os quatro arquivos existem: `queue.module.ts`, `video-processing.contract.ts`, `video-processing.producer.ts` e o registro do `QueueModule` no `AppModule`, mais os dois specs da tabela.
  - **A ação técnica 1 pede `BullModule.registerQueue({ ... })` com `attempts` e `backoff` vindos do `queueConfig`, mas `registerQueue` é síncrono e não injeta config.** Usado `registerQueueAsync` com `inject: [queueConfig.KEY]`, que é a única forma de a exigência "retry, backoff e teto vêm da configuração, não de literais" ser satisfeita de verdade. Semântica idêntica, forma diferente.
  - `QueueModule` exporta `BullModule` junto com o produtor, senão o `SI-03.10` (worker standalone) não consegue resolver a fila `video-processing` a partir do seu próprio contexto.
  - O teste de job `failed` sobe um `Worker` descartável que sempre lança, em vez de chamar `job.moveToFailed(...)` à mão — no BullMQ v5 mover um job sem segurar o lock não é caminho legítimo, e o objetivo do AC é justamente que o caminho de falha real deixe o job consultável.

### SI-03.7 — Pré-cadastro do rascunho e início do upload multipart
- **Status:** completed
- **Tests:** 42 passing (35 unit/integração em `src/videos/` + 7 E2E de `test/videos-upload-initiate.e2e-spec.ts`)
- **Observations:**
  - **A assinatura da peça 31 propagou intacta:** `initiateUpload` grava o rascunho inteiro dentro de `publicIdService.allocate(persist)`. O multipart é aberto dentro do envelope, como a ação técnica 2 manda — numa colisão de `public_id` (1 em 64^11) o retry deixaria um multipart órfão sob o prefixo abandonado. É a troca que o plano escolheu; a alternativa (inserir primeiro, abrir o multipart depois) exigiria dois writes e trocaria um órfão de storage por um órfão de linha.
  - **A URL presigned é dialed no endpoint interno com o header `Host` assinado preservado** (`test/videos-upload.helpers.ts` → `putPresignedPart`). Dentro do container `nestjs-api` o host público (`localhost:9000`) resolve para o próprio container, mas reescrever a URL quebraria a SigV4, que assina o `Host`. Rerotear só o socket mantém assinatura e credencial intactas — verificado contra o MinIO real antes de escrever o teste. Isso é o que permite ao E2E rodar com o `storageConfig` **real, sem override**, e portanto asseverar de verdade que `parts[].url` carrega o host público.
  - `InitiateUploadDto` deixa passar `contentType` fora da lista e `sizeBytes` acima do teto de propósito: os dois têm status próprio no Error Catalog (415/413) e decorá-los no DTO colapsaria ambos num 400 genérico. O serviço checa contra `videoConfig` **antes** de qualquer write ou chamada de storage.
  - `VideosModule` passou a importar `ChannelsModule` (o canal do autenticado sai do repositório que ele reexporta), `ConfigModule`, `StorageModule` e `QueueModule`; `videos.module.spec.ts` ganhou o `ConfigModule.forRoot` com os três namespaces, senão a compilação do módulo não resolve mais.
  - **Dívida de lint do `SI-03.4` quitada aqui.** `npm run lint` marcava 162 erros (14 acima da linha de base de 148), todos em `public-id.service.ts` e `public-id.service.spec.ts` — código escrito às cegas em 2026-09-28, depois da última medição. Tipagem estreitada (`QueryFailedError & { code?: unknown; detail?: unknown }`) e tuplas explícitas em `mock.calls`; voltou a 148 exatos. Os arquivos do `SI-03.7` somaram **zero**.

### SI-03.8 — Reassinatura de partes para retomada do upload
- **Status:** completed
- **Tests:** 34 passing na tabela do SI (unit do serviço + integração + `sign-parts.dto.spec.ts`); o E2E derivado do spec roda junto com o `SI-03.9` — ver observação abaixo
- **Observations:**
  - **O E2E de `videos-upload-parts` não fecha sozinho: dois dos seis cenários do spec (`1.2 retomada` e `1.4 upload já concluído`) chamam `POST .../upload/complete`, que é `SI-03.9`.** A tabela `**Tests:**` do SI-03.8 no plano — que é o contrato dos passos 3–5 da skill — lista só as três linhas unit/integração, e o próprio plano diz "Sem linha de E2E nesta tabela por desenho". O arquivo `test/videos-upload-parts.e2e-spec.ts` foi escrito inteiro aqui e medido junto com o `SI-03.9`.
  - **O teto por vídeo (`1..partCount`) é checado no serviço, não no DTO, e sai como `BadRequestException`.** `partCount` vem de `size_bytes` da linha, que a camada de schema não conhece. O `ValidationExceptionFilter` herdado já converte qualquer `BadRequestException` no envelope canônico `{ 400, VALIDATION_ERROR, [...] }`, que é exatamente o que a tabela `#### Validation Rules` pede ("400 validation error", não um código de domínio). É a única exceção HTTP do Nest lançada de dentro de um serviço nesta fase, e é deliberada.
  - `findOwnedVideo` resolve por `public_id` com `relations: ['channel']` e devolve `VideoNotFoundException` tanto para inexistente quanto para vídeo de outro dono — respostas byte a byte idênticas, que é o que protege o `public_id` não enumerável.
  - `putPresignedPart` saiu de `test/videos-upload.helpers.ts` para `src/test/presigned-put.ts`: os specs de integração em `src/` precisam do mesmo reroute de socket, e duas cópias da mesma manobra de `Host` seria a pior forma de mantê-la.

### SI-03.9 — Conclusão e cancelamento do upload, com enfileiramento do processamento
- **Status:** completed
- **Tests:** 11 E2E (5 de `videos-upload-complete` + 6 de `videos-upload-parts`, este último destravado agora) mais as linhas unit/integração da tabela, dentro dos 116 verdes de `src/videos/`
- **Observations:**
  - **`StorageService` ganhou `deleteObject(key)`.** A ação 2 diz "se exceder, aborta", mas depois de `completeMultipartUpload` o multipart não existe mais — `abortMultipartUpload` responderia `NoSuchUpload`. O AC exige que o objeto **não fique no bucket**, e a única operação que entrega isso é o delete. É a única adição a um arquivo do `SI-03.5` feita aqui.
  - **No caminho de 413 o rascunho é descartado inteiro** (objeto apagado + linha removida), a mesma semântica do `abortUpload`. O plano só fala do caminho feliz ("limpa `upload_id`") e o AC só cobra fila e bucket vazios; deixar a linha com um `upload_id` já consumido faria a próxima tentativa de complete bater no storage com um id morto e virar 500. Descartar é a leitura coerente de "aborta".
  - **`enqueue` é estritamente o último passo**, depois de `complete` e de `headObject`. Há um teste unitário que grava a ordem das três chamadas (`['complete', 'head', 'enqueue']`) — sem ele a garantia da TD-09 (job nunca chega antes dos bytes) seria só intenção.
  - `complete-upload.dto.spec.ts` precisa de `import 'reflect-metadata'` na primeira linha: `@Type()` lê metadado de design-time, e numa rodada unitária pura nada carregou o polyfill (a aplicação o recebe de graça via `NestFactory`). Foi a única falha da suíte do Lote B, e é de ambiente de teste, não de código.
  - A ordem crescente e sem lacunas de `parts[]` é um `ValidatorConstraint` próprio (`AscendingContiguousParts`). O storage rejeitaria uma lista malformada de qualquer jeito, mas como 500 opaco.
  - O E2E de 413 sobe uma segunda aplicação com `maxUploadBytes` rebaixado e declara `sizeBytes` pequeno no initiate — os bytes enviados são reais e a diferença entre declarado e montado é exatamente o que o AC quer exercitar.
  - **Fora de escopo, para uma peça de higiene:** os cenários que concluem um upload deixam o objeto montado no bucket (14 objetos depois da rodada completa desta sessão). Nenhum teste depende disso e nada quebra, mas o bucket `streamtube` cresce a cada rodada da suíte. O `SI-03.12` provavelmente vai querer esses objetos; quando não quiser mais, o lugar do cleanup é o `afterAll` dos dois E2E que completam upload.

### SI-03.10 — Worker como aplicação NestJS standalone
- **Status:** completed
- **Tests:** 5 passing (`src/worker.module.integration-spec.ts`)
- **Observations:**
  - **`WorkerModule` precisou importar `UsersModule`, que o plano não lista.** `autoLoadEntities` só enxerga o que algum módulo registrou por `forFeature`; `VideosModule` traz `Video` e, por `ChannelsModule`, `Channel` — mas `Channel.user` é relação bidirecional e sem `User` no grafo o TypeORM recusa construir metadado nenhum (`Entity metadata for Channel#user was not found`, em loop de retry de conexão). `UsersModule` é o dono da entidade e não tem superfície HTTP, então é o registro certo a reusar; a alternativa seria um segundo `forFeature([User])` na raiz do worker.
  - O `Dockerfile.worker` passou de `tail -f /dev/null` para `npm run start:worker:dev` — o AC exige `video-worker` em `running` **com a linha de readiness no log**, e o enunciado lista "não ter fila, worker e storage reais subindo no Compose" como falha. Verificado no ar: `[VideoWorker] Video worker ready — consuming the video-processing queue`, nenhuma linha de servidor HTTP escutando, nenhuma porta publicada para o serviço. `nest start --watch` leva ~3min para o primeiro boot (compilação do projeto inteiro em watch).
  - `package.json` ganhou `start:worker` (`nest start --entryFile worker`), `start:worker:dev` (watch, o que o container roda) e `start:worker:prod` (`node dist/worker`), espelhando o trio `start`/`start:dev`/`start:prod` do entrypoint da API.
  - **O `video-worker` vivo consumia a mesma fila que a suíte** — corrida resolvida depois, por `prefix` do BullMQ vindo de configuração. Ver a entrada do `SI-03.12`.

### SI-03.11 — Adaptador FFmpeg: extração de metadados e geração de thumbnail
- **Status:** completed
- **Tests:** 14 passing (6 unit + 8 integração, todas em `nestjs-api`)
- **Observations:**
  - **`-v error` no lugar do `-v quiet` que a ação técnica 1 escreve.** `quiet` cala justamente o `stderr` que a ação técnica 3 e dois ACs exigem de volta na mensagem de erro; `error` deixa o stdout (onde o JSON sai) intacto e preserva o diagnóstico. É a única forma de as duas exigências valerem ao mesmo tempo.
  - **`-y` acrescentado ao comando de thumbnail.** Sem ele o `ffmpeg` pergunta no stdin se pode sobrescrever e o spawn trava para sempre; e uma redelivery do job (`SI-03.12`, idempotência) reescreve o mesmo arquivo temporário.
  - **O recuo de offset dispara em `duration <= offset`, não em `duration < offset`.** Buscar exatamente no fim de um vídeo de 3s com offset 3 não devolve frame nenhum e o `ffmpeg` sai diferente de zero — o AC quer thumbnail, não erro.
  - `src/videos/processing/spawn-binary.ts` (não listado no plano) carrega o spawn, a coleta de `stdout`/`stderr` e o `BinaryExecutionError` que anexa o `stderr` à mensagem. É a ação técnica 3 escrita uma vez em vez de duas; o evento `error` do child (binário fora do `PATH`) também vira erro em vez de pendurar a promise.
  - **Os fixtures de vídeo são gerados pelo próprio `ffmpeg` no `beforeAll`** (`src/test/video-fixture.ts`, `testsrc` + `anullsrc` → H.264/AAC), não commitados como binário. Duração, resolução e frame rate são declarados pelo teste, então continuam sendo valores conhecidos.
  - **As duas suítes de integração deste SI exigem os binários de FFmpeg**, que por TD-05 nasceram só na imagem do worker — e por isso passaram a existir também na imagem de dev da API, que é o container onde a linha de Deliverables do plano manda rodar a suíte unit/integração. O processamento segue sendo do worker; só o binário existe nos dois lugares.
  - A suíte unitária mocka `node:child_process` de propósito: ela precisa rodar onde o binário não existe, e o contrato que ela guarda (linha de comando, projeção do JSON, propagação do `stderr`) é independente do binário.

### SI-03.12 — Processor do job: ciclo de status e falha terminal
- **Status:** completed
- **Tests:** 19 passing, todas em `nestjs-api` (7 unit + 12 integração: 5 caminho feliz, 4 falha terminal, 3 reenfileiramento)
- **Observations:**
  - **O processor vive em `VideoProcessingModule` (`src/videos/processing/video-processing.module.ts`), não no `VideosModule`.** A ação técnica 5 pede "no `VideosModule`, só sob o `WorkerModule`" — mas o `AppModule` importa o `VideosModule`, então um provider `@Processor` ali tornaria a API consumidora, que é exatamente o que a ação proíbe. Um módulo separado, importado só pelo `WorkerModule`, é a única forma de os dois entrypoints compartilharem o domínio com um único worker atado ao Redis.
  - **As três suítes de integração sobem o `WorkerModule` de verdade** (`NestFactory.createApplicationContext`, a mesma chamada do `src/worker.ts`), então o que está sob teste é a cadeia inteira: entrega pela fila, MinIO, FFmpeg e Postgres. Elas exigem FFmpeg — que hoje existe também na imagem de dev da API — e exigem ser o único consumidor da fila *no seu namespace*, garantido pelo `prefix` de teste.
  - **A disputa pela fila com o `video-worker` vivo está resolvida por isolamento, não por contorno.** O serviço do Compose e a suíte falavam com a mesma fila do mesmo Redis, e o consumidor de produção comia o job que o teste acabara de enfileirar — `npm test` ficava vermelho e com resultado diferente a cada rodada. A saída é o **`prefix` do BullMQ vindo de configuração** (`VIDEO_QUEUE_PREFIX` → `queueConfig().keyPrefix`, aplicado na config compartilhada do `QueueModule`, de onde a fila registrada e o worker de cada `@Processor` o herdam juntos): a suíte namespaceia as próprias chaves Redis em `src/test/queue-prefix.ts`, um `setupFiles` dos dois projetos Jest. Preserva a **TD-09** — nome da fila e do job continuam morando só em `video-processing.contract.ts`, importados pelos dois lados — e não exige parar nada: com o worker no ar, `npm test` fecha 53/53 e 379/379 em duas rodadas seguidas. Descartadas: parar o worker para medir (contraria o Critério de Aceite, e o avaliador não vai fazer isso) e renomear a fila nos testes (quebraria a TD-09).
  - **`-y` e `mkdtemp` por job:** o diretório temporário é criado por tentativa e removido num `finally`; o teste unitário captura o caminho que o adaptador recebeu e afirma que o diretório sumiu nos dois caminhos (feliz e de erro).
  - `metadata` sai do probe como alias de tipo (não `interface`) porque `QueryDeepPartialEntity` do TypeORM rejeita membros nullable concretos; a escrita ainda precisa de um cast para `Record<string, any>`, o mesmo motivo pelo qual a coluna da entidade já é tipada solta.
  - **Resíduo de objetos no bucket quitado aqui.** `resetVideosState` (em `test/videos-upload.helpers.ts`) passou a apagar, antes do `DELETE FROM "videos"`, todo objeto sob `videos/<public_id>/` das linhas que vai remover; os dois E2E que concluem upload chamam `purgeVideoObjects` também no `afterAll`, porque o objeto do último cenário sobrevive ao reset por-teste. Os 14 objetos já acumulados foram apagados à mão nesta sessão; o bucket ficou em 0.
  - **AC não verificável nesta máquina:** "`GET /` na API responde em tempo normal enquanto um job está em curso". O container `nestjs-api` sobe com `tail -f /dev/null` por desenho do repo e não serve HTTP; o isolamento em si está provado por construção (processo separado, sem consumidor no `AppModule`) e pelo teste de ausência de listener do `SI-03.10`.

### SI-03.13 — Entrega por streaming: URL de playback presigned
- **Status:** completed
- **Tests:** 20 passing (10 unit em `videos.service.spec.ts` + 3 integração em `videos.playback.integration-spec.ts` + 7 E2E em `test/videos-playback-url.e2e-spec.ts`)
- **Observations:**
  - **Serviço e controller já estavam escritos por uma rodada anterior interrompida**; esta sessão revisou os dois contra `specs/videos-playback-url.plan.md` e a `### Authorization Matrix` e não achou divergência — o incremento atômico de `view_count`, a distinção `VIDEO_NOT_READY`/`VIDEO_PROCESSING_FAILED` e o 404 indistinguível estavam corretos. O que faltava era só a camada de testes de integração e E2E.
  - **`src/test/presigned-get.ts` (novo, não listado no plano) é o par do `presigned-put.ts`:** disca o socket no endpoint interno preservando o `Host` assinado byte a byte. Sem isso nenhum E2E consegue buscar a URL que a aplicação emite, porque ela é assinada com `localhost:9000` — que dentro do container `nestjs-api` resolve para o próprio container. Ele também devolve `chunkCount` e o tempo até o primeiro chunk, que é como o AC "tocar antes do download completo" vira asserção.
  - **`bootstrapVideosApp` ganhou um segundo parâmetro, `storageOverrides`.** Existe para um cenário só: expirar uma URL presigned dentro da rodada, impossível com o TTL de 15 minutos que o projeto embarca. Sobrescrever `storageConfig.KEY` propaga para os dois clientes S3 e para o `StorageService`, porque as três factories injetam a mesma chave.
  - **O spec de integração assina apontando para o endpoint interno** (`publicEndpoint = internalEndpoint`), o mesmo idioma já adotado em `storage.presign.integration-spec.ts`. Que a configuração real assina com o host público fica provado no E2E, que compara `new URL(body.url).host` com `STORAGE.publicEndpoint`.
  - **Os cenários que só leem a linha são semeados direto pelo repositório**, sem subir bytes; só os dois que buscam a URL de verdade (206/200 e expiração do TTL) passam pelo upload multipart inteiro. Depois do `complete`, a suíte faz `queue.obliterate` antes de escrever o estado terminal — o worker não pode disputar a linha com o teste.
  - `VideoProcessingProducer` recebe `undefined` nos dois specs de integração: playback e download nunca enfileiram, e uma `Queue` viva só vazaria conexão Redis numa suíte que não tem job para publicar.

### SI-03.14 — Download do vídeo: URL presigned com disposição de anexo
- **Status:** completed
- **Tests:** 13 passing (4 unit em `videos.service.spec.ts` + 3 integração em `videos.download.integration-spec.ts` + 6 E2E em `test/videos-download-url.e2e-spec.ts`)
- **Observations:**
  - **Serviço e controller também já estavam escritos pela rodada interrompida**, e a revisão contra `specs/videos-download-url.plan.md` bateu: mesmas guardas do playback, `attachmentFilename` no override e nenhum toque em `view_count`.
  - **`Content-Disposition` não carrega nome fora do ASCII na forma entre aspas.** Header HTTP é latin-1 no fio, então `Férias "2026".mp4` volta do MinIO como `FÃ©rias _2026_.mp4` na parte `filename="…"`. É exatamente por isso que o `attachmentDisposition` emite também a forma RFC 5987, e é ela que o teste compara com o `original_filename` — `decodeURIComponent` da parte `filename*=UTF-8''…` devolve o nome intacto. Nenhuma mudança de código: o comportamento está certo, a asserção ingênua é que estava errada.
  - **`npm run lint` roda com `--fix`, e o fixer apaga `as` sobre o `any` do `DataSource.query`** julgando a asserção desnecessária — o que troca uma linha tipada por duas violações de `no-unsafe-*` na rodada seguinte. Aconteceu com `purgeVideoObjects` em `test/videos-upload.helpers.ts` nesta sessão. Corrigido nos três pontos passando o tipo pelo genérico (`query<{ … }[]>(…)`), que o fixer não tem como remover; duas rodadas consecutivas de `npm run lint` devolvem 148/40 idêntico.
  - O byte-a-byte do AC #3 compara o download com o objeto lido do bucket pelo cliente interno, não com o buffer que o teste subiu — a afirmação é que o download é o arquivo armazenado.
