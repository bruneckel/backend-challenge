# Wagering Processor

Processador de transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) com entrada por HTTP e por SQS FIFO, saldo e ledger no PostgreSQL e eventos publicados por outbox. Feito em Bun, TypeScript estrito, NestJS e MikroORM.

- Desenho, garantias e provas: [ARCHITECTURE.md](ARCHITECTURE.md)
- Enunciado do desafio: [CHALLENGE.md](CHALLENGE.md)

## Requisitos

- Docker com Docker Compose v2 (testado com Docker 29.8.1 e Compose v5.5.1)
- Bun 1.3.14, para rodar testes, lint e os scripts locais (`curl -fsSL https://bun.sh/install | bash -s bun-v1.3.14`)
- Portas livres: 3000 (api), 5432 (PostgreSQL) e 4566 (MiniStack, o emulador de SQS)

## Subir tudo com Docker Compose

```bash
docker compose up -d --build --wait
```

Sobe, nesta ordem:

| Serviço | O que faz |
|---|---|
| `postgres` | PostgreSQL 18.6 |
| `sqs` | MiniStack 1.5.20 (SQS FIFO), sem credenciais |
| `bootstrap` | aplica as migrations e cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo`; roda uma vez e termina com código 0 |
| `api` | HTTP em `http://localhost:3000` |
| `worker` | consome a fila de entrada, publica os eventos da outbox e resolve referências pendentes |

`--wait` só retorna quando `api` e `worker` estão com `/health/ready` respondendo 200.

```bash
docker compose up -d --scale worker=3 --wait   # três workers
docker compose logs -f api worker              # logs JSON
docker compose stop api worker                 # parada graciosa (SIGTERM)
docker compose down -v                         # remove tudo, inclusive o volume do banco
```

## Usar a API

Abrir uma wallet com saldo inicial:

```bash
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

A resposta traz o `id` da wallet. Com ele, uma aposta (o header `Idempotency-Key` é obrigatório; reenviar com a mesma key devolve o mesmo resultado, com `idempotentReplay: true`):

```bash
WALLET=<id da wallet>
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "'"$WALLET"'",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": {"amount": "25.00", "currency": "BRL"}
  }'
```

Resposta: `200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}`. Um REFUND ou ROLLBACK leva `referenceExternalTransactionId` com o `externalTransactionId` da BET; se a BET ainda não chegou, a resposta é 202 e o worker conclui depois.

| Endpoint | Para quê |
|---|---|
| `POST /wallets` | abre uma wallet (uma por player e moeda) |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?limit=50&cursor=…` | lançamentos, do mais novo para o mais antigo |
| `POST /wagering/transactions` | BET, WIN, LOSS, REFUND, ROLLBACK |
| `GET /wagering/transactions/:transactionId` | uma transação |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | uma transação pelo id do provedor |
| `POST /wallets/:walletId/reconciliation` | compara o saldo com o ledger, sem alterar nada |
| `GET /health/live` · `GET /health/ready` · `GET /metrics` | saúde e métricas Prometheus (api e worker) |

Status: 200 processada, 202 aguardando referência, 422 rejeitada (com `failureCode`), 400/404/409 para requisições inválidas ou conflitantes (corpo `application/problem+json`), 503 para indisponibilidade (pode reenviar com a mesma key). Detalhes em [ARCHITECTURE.md](ARCHITECTURE.md#api-http).

## Mandar uma operação pela fila

Com o Compose de pé e as dependências instaladas (`bun install`):

```bash
bun run demo:send-message --wallet "$WALLET" --player 0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1 --kind BET --amount 10.00
curl -s localhost:3000/wallets/$WALLET
```

O script publica um `WagerTransactionRequested` em `wager-transactions.fifo` (`MessageGroupId` = wallet). O worker aplica a operação e o saldo muda em menos de um segundo. Opções: `--kind`, `--amount`, `--currency`, `--provider` e `--reference <externalTransactionId>`.

## Rodar localmente, sem a imagem da aplicação

```bash
bun install
bun run infra:up                 # só postgres e sqs, com healthcheck
bun run bootstrap                # migrations e filas
bun run start:api                # http://localhost:3000
PORT=3001 bun run start:worker   # em outro terminal (a api já usa a 3000)
```

`bun run migrate:up` e `bun run migrate:down` aplicam e revertem as migrations sem criar filas.

## Testes e qualidade

Os testes precisam do PostgreSQL e do MiniStack de pé (`bun run infra:up`). Cada suíte cria o próprio banco e filas com prefixo único, então não interfere no Compose nem em outra execução.

| Comando | O que roda |
|---|---|
| `bun run test` | toda a suíte: unidade, integração e concorrência (cerca de 2 minutos) |
| `bun run test:unit` | domínio, políticas e utilitários, sem infraestrutura |
| `bun run test:integration` | banco, filas, HTTP e casos de uso contra PostgreSQL e MiniStack reais |
| `bun run test:concurrency` | cenários concorrentes em processo e com vários processos `api` e `worker` (C1 a C9, matriz de shutdown, reinício) |
| `bun run test:spike` | as verificações que fixaram as versões da stack |
| `bun run typecheck` · `bun run lint` · `bun run format` | `tsc --noEmit`; ESLint e Prettier em modo de checagem; formatação |

## Variáveis de ambiente

Todas são validadas no boot; um valor inválido derruba o processo com uma mensagem que cita o nome da variável (nunca o valor).

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | conexão com o PostgreSQL |
| `PORT` | `3000` | porta HTTP (api e worker) |
| `INSTANCE_ID` | `hostname-pid` | identifica a instância em logs, métricas e DLQ |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` ou `silent` |
| `DB_POOL_SIZE` | `10` | conexões por processo |
| `DB_LOCK_TIMEOUT_MS` | `3000` | espera máxima pelo lock da wallet (depois: 503 ou backoff) |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` | tempo máximo de uma instrução |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `30000` | encerra sessões paradas dentro de transação |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | endpoint do SQS (MiniStack) |
| `AWS_REGION` | `us-east-1` | região |
| `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` | `test` · `test` | credenciais fictícias do emulador |
| `SQS_COMMANDS_QUEUE` · `SQS_DEAD_LETTER_QUEUE` · `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` · `wager-transactions-dlq.fifo` · `wagering-events.fifo` | nomes das filas |
| `SQS_PUBLISH_TIMEOUT_MS` | `5000` | timeout do envio de eventos |
| `OUTBOX_PUBLISHER_ENABLED` · `CONSUMER_ENABLED` · `REFERENCE_SCHEDULER_ENABLED` | `true` | liga cada loop do worker |
| `OUTBOX_BATCH_SIZE` | `10` | eventos por lote (máximo 10) |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | intervalo quando a outbox está vazia |
| `OUTBOX_RETRY_BASE_MS` · `OUTBOX_RETRY_MAX_MS` | `1000` · `300000` | backoff de republicação |
| `CONSUMER_NAME` | `wager-transactions-consumer` | nome do consumidor na inbox |
| `CONSUMER_BATCH_SIZE` | `10` | mensagens por recebimento (máximo 10) |
| `CONSUMER_MAX_CONCURRENT_GROUPS` | `5` | grupos FIFO processados em paralelo por worker |
| `SQS_RECEIVE_WAIT_SECONDS` | `20` | long polling |
| `SQS_RECEIVE_TIMEOUT_MS` | `25000` | timeout de leitura do SDK (maior que o long polling) |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | visibility das mensagens recebidas e da fila criada pelo bootstrap |
| `SQS_HEARTBEAT_INTERVAL_MS` | `10000` | extensão periódica da visibility (menor que ela) |
| `CONSUMER_MAX_ATTEMPTS` | `8` | tentativas antes da DLQ por `RETRIES_EXHAUSTED` |
| `CONSUMER_RETRY_BASE_MS` · `CONSUMER_RETRY_MAX_MS` | `2000` · `120000` | backoff das mensagens |
| `REFERENCE_MAX_ATTEMPTS` | `10` | novas verificações de uma referência pendente |
| `REFERENCE_BACKOFF_BASE_MS` · `REFERENCE_BACKOFF_MAX_MS` | `2000` · `120000` | backoff dessas verificações |
| `REFERENCE_SCHEDULER_BATCH_SIZE` | `20` | pendentes por volta do scheduler |
| `REFERENCE_SCHEDULER_POLL_INTERVAL_MS` | `1000` | intervalo do scheduler |
| `REFERENCE_MAX_PROCESSING_FAILURES` | `3` | falhas não negociais antes de FAILED |
| `METRICS_SAMPLE_INTERVAL_MS` | `5000` | amostragem dos gauges de backlog no worker |
| `READINESS_CACHE_MS` | `2000` | cache das checagens de readiness |

## Problemas comuns

| Sintoma | Causa provável e solução |
|---|---|
| `docker compose up` falha com porta em uso | 3000, 5432 ou 4566 já ocupadas por outro processo; libere a porta ou pare o serviço local |
| `bootstrap` termina com código 1 | `docker compose logs bootstrap` mostra o motivo (`bootstrap failed`, com a mensagem do erro) |
| `/health/ready` responde 503 | o corpo diz qual dependência caiu: `{"status":"not_ready","checks":{"database":"up","sqs":"down"}}` |
| api e worker não ficam prontos depois de recriar o container `sqs` | o MiniStack guarda as filas em memória; recrie-as com `docker compose run --rm bootstrap` |
| `QueueDoesNotExist` ao rodar `demo:send-message` | o bootstrap ainda não rodou; use `bun run bootstrap` (local) ou suba o Compose |
| testes falham com conexão recusada | `bun run infra:up` antes de `bun run test` |
| mudança de `SQS_VISIBILITY_TIMEOUT_SECONDS` sem efeito na fila | a fila já existe com o valor antigo; com o MiniStack, recrie o container `sqs` e rode o bootstrap |
| `InvalidChecksumError` ao reenviar uma mensagem com o mesmo id de deduplicação e outro corpo | divergência conhecida do MiniStack; use outro `MessageDeduplicationId` |
| bancos `wagering_test_*` sobrando no PostgreSQL | uma execução de testes foi interrompida; são inofensivos e somem com `docker compose down -v` |

## Estrutura

```
src/
  app/            composição dos papéis (api, worker)
  wallet/         domínio, casos de uso, HTTP, consumidor SQS e scheduler
  messaging/      inbox, outbox, publisher e consumidor genérico
  platform/       configuração, banco e migrations, HTTP, autenticação, ciclo de vida
  observability/  métricas, logs e health
  shared/         portas e utilitários comuns
  main.api.ts · main.worker.ts · main.bootstrap.ts
test/
  unit/ · integration/ · concurrency/ · spike/ · support/
```
