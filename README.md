# Wagering Processor

Processador de transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) com entrada por HTTP e por SQS FIFO, saldo e ledger no PostgreSQL e eventos publicados por outbox. Feito em Bun, TypeScript estrito, NestJS e MikroORM.

- Desenho, garantias e provas: [ARCHITECTURE.md](ARCHITECTURE.md)
- Enunciado do desafio: [CHALLENGE.md](CHALLENGE.md)

## Requisitos

- Docker com Docker Compose v2 (testado com Docker 29.8.1 e Compose v5.5.1)
- Bun 1.3.14, para rodar testes, lint e os scripts locais (`curl -fsSL https://bun.sh/install | bash -s bun-v1.3.14`)
- Portas livres: 3000 (api), 5432 (PostgreSQL), 4566 (MiniStack, o emulador de SQS) e 8080 (Keycloak)

## Subir tudo com Docker Compose

```bash
docker compose up -d --build --wait
```

Sobe, nesta ordem:

| Serviço | O que faz |
|---|---|
| `postgres` | PostgreSQL 18.6 |
| `sqs` | MiniStack 1.5.20 (SQS FIFO), sem credenciais |
| `keycloak-database` | cria o papel e o banco `keycloak` no PostgreSQL, se não existirem; roda uma vez e termina com código 0 |
| `keycloak` | Keycloak 26.8.0 em modo produção (`start --optimized`, imagem de [keycloak/Dockerfile](keycloak/Dockerfile)) em `http://localhost:8080`, com o realm `wagering` importado de [keycloak/wagering-realm.json](keycloak/wagering-realm.json) na primeira subida e guardado no banco `keycloak`; administração com `admin`/`admin` por padrão (`KEYCLOAK_ADMIN_USERNAME`, `KEYCLOAK_ADMIN_PASSWORD`, `KEYCLOAK_DB_PASSWORD`), só para desenvolvimento |
| `bootstrap` | aplica as migrations e cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo`; roda uma vez e termina com código 0 |
| `api` | HTTP em `http://localhost:3000` |
| `worker` | consome a fila de entrada, publica os eventos da outbox, resolve referências pendentes e apaga eventos e mensagens que passaram da retenção |

`--wait` só retorna quando `api` e `worker` estão com `/health/ready` respondendo 200 e o Keycloak está pronto.

Todo container roda com:
- raiz somente leitura;
- sem capabilities (`cap_drop: ALL`) e com `no-new-privileges`;
- limites de CPU e memória;
- imagem fixada por digest.

Um teste confere essas regras no `docker compose config` (ver ARCHITECTURE.md, "Hardening").

**Reimportar o realm.** O Keycloak só importa o realm quando ele não existe. Depois de editar `keycloak/wagering-realm.json`:

```bash
docker compose stop keycloak
docker compose exec postgres dropdb -U wagering --force keycloak
docker compose up -d --wait
```

```bash
docker compose up -d --scale worker=3 --wait   # três workers
docker compose logs -f api worker              # logs JSON
docker compose stop api worker                 # parada graciosa (SIGTERM)
docker compose down -v                         # remove tudo, inclusive o volume do banco
```

### Painel de métricas

```bash
docker compose --profile observability up -d --build --wait
```

O profile `observability` soma dois serviços ao Compose:

| Serviço | O que faz |
|---|---|
| `prometheus` | Prometheus 3.15.0 em `http://localhost:9090`. Coleta `/metrics` da api e do worker a cada 5 s com um token do client `wagering-metrics`, que ele mesmo pede ao Keycloak (`oauth2`, `client_credentials`). |
| `grafana` | Grafana 13.2.3 em `http://localhost:3001`. Abre direto no painel **Wagering Processor**, com acesso anônimo de leitura; a administração usa `admin`/`admin`, só para desenvolvimento. |

O painel cobre todas as métricas da aplicação:
- transações por status, canal e tipo, e a latência de processamento e HTTP;
- replays e conflitos de idempotência, duplicatas na inbox;
- retries e DLQ;
- espera de lock, timeouts, deadlocks e conflitos de versão;
- outbox pendente, idade e atraso de publicação, e retenção;
- referências pendentes, streams e reconciliações.

Um teste garante que cada consulta do painel lê uma métrica que a aplicação exporta, e que toda métrica nova ganha um painel. A configuração está em [observability/](observability/).

## Usar a API

Toda rota, menos `/health/*`, exige um token do Keycloak no header `Authorization: Bearer`. O realm traz quatro clientes `client_credentials`, com segredos só de desenvolvimento:

| Cliente | Segredo | O token carrega | Pode |
|---|---|---|---|
| `provider-a` · `provider-b` | `provider-a-secret` · `provider-b-secret` | `provider_id` | enviar e consultar as próprias transações |
| `wagering-operator` | `wagering-operator-secret` | `roles: ["operator"]` | abrir wallets, ver saldo e ledger, reconciliar, consultar qualquer transação |
| `wagering-metrics` | `wagering-metrics-secret` | `roles: ["metrics-reader"]` | ler `/metrics` |

```bash
token() {
  curl -s http://localhost:8080/realms/wagering/protocol/openid-connect/token \
    -d grant_type=client_credentials -d client_id="$1" -d client_secret="$1-secret" |
    sed -E 's/.*"access_token":"([^"]+)".*/\1/'
}
OPERATOR=$(token wagering-operator)
PROVIDER=$(token provider-a)
```

Os tokens valem 5 minutos; depois disso a API responde 401 `INVALID_TOKEN` e basta pedir outro.

Abrir uma wallet com saldo inicial (operador):

```bash
curl -s -X POST localhost:3000/wallets \
  -H "authorization: Bearer $OPERATOR" \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

A resposta traz o `id` da wallet. Com ele, uma aposta do `provider-a` (o header `Idempotency-Key` é obrigatório; reenviar com a mesma key devolve o mesmo resultado, com `idempotentReplay: true`):

```bash
WALLET=<id da wallet>
curl -s -X POST localhost:3000/wagering/transactions \
  -H "authorization: Bearer $PROVIDER" \
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

| Endpoint | Para quê | Quem pode |
|---|---|---|
| `POST /wallets` | abre uma wallet (uma por player e moeda) | operador |
| `GET /wallets/:walletId` | saldo e versão | operador |
| `GET /wallets/:walletId/ledger?limit=50&cursor=…` | lançamentos, do mais novo para o mais antigo | operador |
| `POST /wallets/:walletId/reconciliation` | compara o saldo com o ledger e confere a cadeia de lançamentos e a versão, sem alterar nada | operador |
| `GET /wallets/:walletId/events` | saldo e lançamentos em tempo real (Server-Sent Events) | operador |
| `POST /wagering/transactions` | BET, WIN, LOSS, REFUND, ROLLBACK | o provedor do `providerId` do corpo |
| `GET /wagering/transactions/:transactionId` | uma transação | o provedor dela ou o operador |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | uma transação pelo id do provedor | esse provedor ou o operador |
| `GET /metrics` | métricas Prometheus (api e worker) | leitor de métricas |
| `GET /health/live` · `GET /health/ready` | saúde (api e worker) | qualquer um, sem token |

Status: 200 processada, 202 aguardando referência, 422 rejeitada (com `failureCode`), 400/404/409 para requisições inválidas ou conflitantes (corpo `application/problem+json`; abrir de novo uma wallet que já existe devolve 409 com o `walletId` dela), 401 sem token ou com token inválido, 403 quando o token não dá acesso à rota ou ao `providerId`, 503 para indisponibilidade (pode reenviar com a mesma key). Detalhes em [ARCHITECTURE.md](ARCHITECTURE.md#api-http) e em [Autenticação e autorização](ARCHITECTURE.md#autenticação-e-autorização).

## Acompanhar uma wallet em tempo real

```bash
curl -N localhost:3000/wallets/$WALLET/events -H "authorization: Bearer $OPERATOR"
```

O stream começa com o estado atual da wallet e depois manda um evento por lançamento, venha a operação pela API, pela fila ou pelo scheduler, de qualquer réplica:

```
retry: 3000

id: 1
event: wallet
data: {"id":"…","playerId":"…","balance":{"amount":"100.00","currency":"BRL"},"version":1,…}

id: 2
event: ledger-entry
data: {"walletId":"…","id":"…","transactionId":"…","direction":"DEBIT","money":{"amount":"25.00","currency":"BRL"},"balanceBefore":{"amount":"100.00","currency":"BRL"},"balanceAfter":{"amount":"75.00","currency":"BRL"},"walletVersion":2,"createdAt":"…"}
```

O `id` de cada evento é a versão da wallet. Para retomar sem perder nada, reconecte com `-H 'Last-Event-ID: <último id recebido>'`: a API reenvia os lançamentos seguintes a partir do ledger, sem lacuna nem repetição. O stream termina quando o token vence (5 minutos) e no desligamento da réplica; basta reconectar com um token novo e o `Last-Event-ID`. No navegador, o `EventSource` não envia o header `Authorization`, então o painel lê o stream com `fetch` e `ReadableStream`.

## Mandar uma operação pela fila

Com o Compose de pé e as dependências instaladas (`bun install`):

```bash
bun run demo:send-message --wallet "$WALLET" --player 0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1 --kind BET --amount 10.00
curl -s localhost:3000/wallets/$WALLET -H "authorization: Bearer $OPERATOR"
```

O script publica um `WagerTransactionRequested` em `wager-transactions.fifo` (`MessageGroupId` = wallet). O worker aplica a operação e o saldo muda em menos de um segundo. Opções: `--kind`, `--amount`, `--currency`, `--provider` e `--reference <externalTransactionId>`.

## Reprocessar a DLQ

```bash
bun run dlq list                                        # o que está na DLQ, com o motivo, sem consumir
bun run dlq redrive --reason RETRIES_EXHAUSTED --dry-run   # o que voltaria para a fila
bun run dlq redrive --reason RETRIES_EXHAUSTED          # devolve à fila de entrada
bun run dlq redrive --reason WALLET_NOT_FOUND           # depois que a wallet passar a existir
```

Só `RETRIES_EXHAUSTED` e `WALLET_NOT_FOUND` podem voltar. O segundo só faz sentido quando a wallet passa a existir com aquele id, por exemplo numa importação que preserva os ids, porque a API gera o id de cada wallet nova. Conflitos e mensagens inválidas precisam de correção na própria mensagem. A ordem de cada wallet é preservada, e reenviar é seguro: a inbox deduplica pelo `messageId`.

## Rodar localmente, sem a imagem da aplicação

```bash
bun install
bun run infra:up                 # só postgres e sqs, com healthcheck
docker compose up -d --wait keycloak
bun run bootstrap                # migrations e filas
bun run start:api                # http://localhost:3000
PORT=3001 bun run start:worker   # em outro terminal (a api já usa a 3000)
```

`bun run migrate:up` e `bun run migrate:down` aplicam e revertem as migrations sem criar filas.

## Testes e qualidade

Os testes precisam do PostgreSQL e do MiniStack de pé (`bun run infra:up`). Cada suíte cria o próprio banco e filas com prefixo único, então não interfere no Compose nem em outra execução. A suíte principal não depende do Keycloak: assina os tokens com uma chave gerada no próprio processo e publica o JWKS dela num servidor local.

| Comando | O que roda |
|---|---|
| `bun run test` | toda a suíte: unidade, integração e concorrência (cerca de 3 minutos) |
| `bun run test:unit` | domínio, políticas e utilitários, sem infraestrutura |
| `bun run test:integration` | banco, filas, HTTP e casos de uso contra PostgreSQL e MiniStack reais |
| `bun run test:concurrency` | cenários concorrentes em processo e com vários processos `api` e `worker` (C1 a C9, matriz de shutdown, reinício) |
| `bun run test:spike` | as verificações que fixaram as versões da stack |
| `bun run test:e2e` | o realm do Keycloak contra a API (tokens reais, papéis e `provider_id`) e o profile de métricas (Prometheus coletando api e worker com token do Keycloak, painel servido pelo Grafana); precisa de `docker compose --profile observability up -d --build --wait` |
| `bun run test:load --preset smoke` | teste de carga em infraestrutura isolada própria; metodologia, presets e baseline em [LOAD-TEST.md](LOAD-TEST.md) |
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
| `AUTH_ISSUER` | `http://localhost:8080/realms/wagering` | emissor exigido no `iss` do token |
| `AUTH_AUDIENCE` | `wagering-api` | audiência exigida no `aud` do token |
| `AUTH_JWKS_URL` | `<AUTH_ISSUER>/protocol/openid-connect/certs` | chaves públicas do IdP; no Compose, `http://keycloak:8080/...` |
| `AUTH_JWKS_TIMEOUT_MS` | `5000` | timeout da busca das chaves |
| `AUTH_CLOCK_SKEW_SECONDS` | `5` | tolerância de relógio para `exp` e `nbf` (máximo 300) |
| `RETENTION_ENABLED` | `true` | liga a limpeza de eventos publicados e mensagens processadas |
| `OUTBOX_RETENTION_HOURS` · `INBOX_RETENTION_HOURS` | `168` · `360` | quanto tempo eventos publicados e mensagens processadas ficam guardados (a inbox aceita no mínimo 168) |
| `RETENTION_BATCH_SIZE` · `RETENTION_BATCH_PAUSE_MS` · `RETENTION_INTERVAL_MS` | `1000` · `250` · `60000` | linhas por lote, pausa entre lotes cheios e espera quando não há o que apagar |
| `STREAM_SWEEP_INTERVAL_MS` | `500` | intervalo em que cada réplica confere as wallets assinadas (latência máxima de entrega) |
| `STREAM_HEARTBEAT_INTERVAL_MS` | `15000` | comentário `keep-alive` nos streams parados |
| `STREAM_MAX_STREAMS` | `1000` | streams abertos por réplica; acima disso, 503 `STREAM_CAPACITY_EXCEEDED` |

## Configuração de produção

O Compose é o ambiente local. Fora dele, estes pontos mudam, cada um com a medição ou a decisão que o justifica:

| Ponto | Local | Produção |
|---|---|---|
| PostgreSQL | padrões da imagem | `shared_buffers` em cerca de 25% da RAM e `effective_cache_size` em 50% a 75%, para o conjunto de trabalho caber no cache. `max_wal_size` dimensionado pelo WAL gerado entre checkpoints (o harness usa 8 GB), `checkpoint_timeout` de 15 min e `wal_compression=lz4`, para os checkpoints não virem por volume de WAL. Com os padrões, uma base de 1 milhão de wallets a 600 req/s tinha checkpoints a cada 20 a 150 s, e eles dominavam a cauda; com essa configuração, não. O harness de carga usa exatamente esses parâmetros (ver [LOAD-TEST.md](LOAD-TEST.md)). |
| Migrations em tabela grande | — | índice com `CONCURRENTLY`, `CHECK` como `NOT VALID` + `VALIDATE` (ver ARCHITECTURE.md) |
| Keycloak | HTTP, `admin`/`admin`, segredos fictícios dos clientes | TLS no proxy ou no Keycloak; `KC_HOSTNAME` no endereço público; segredos de administração, do banco e dos clientes gerados e guardados num cofre; o realm gerido como código |
| JWKS | rede do Compose | HTTPS ou rede interna confiável |
| Retenção | ligada no worker | ligada em uma ou duas réplicas do worker, porque o ritmo vale por réplica |
| api e worker | 1 CPU e 512 MB por container | o Bun usa um núcleo por processo; escalar horizontalmente, com um balanceador na frente das apis |
| SQS | MiniStack | SQS real, com a DLQ e o redrive do bootstrap |

## Problemas comuns

| Sintoma | Causa provável e solução |
|---|---|
| `docker compose up` falha com porta em uso | 3000, 5432 ou 4566 já ocupadas por outro processo; libere a porta ou pare o serviço local |
| 401 `INVALID_TOKEN` com um token que funcionava | o token expirou (5 minutos); peça outro |
| 503 em toda rota protegida | a API não conseguiu buscar as chaves do Keycloak; `docker compose ps keycloak` e os logs da api (`identity provider unavailable`) mostram o motivo |
| `bootstrap` termina com código 1 | `docker compose logs bootstrap` mostra o motivo (`bootstrap failed`, com a mensagem do erro) |
| `/health/ready` responde 503 | o corpo diz qual dependência caiu: `{"status":"not_ready","checks":{"database":"up","sqs":"down"}}` |
| api e worker não ficam prontos depois de recriar o container `sqs` | o MiniStack guarda as filas em memória; recrie-as com `docker compose run --rm bootstrap` |
| `QueueDoesNotExist` ao rodar `demo:send-message` | o bootstrap ainda não rodou; use `bun run bootstrap` (local) ou suba o Compose |
| testes falham com conexão recusada | `bun run infra:up` antes de `bun run test` |
| mudança de `SQS_VISIBILITY_TIMEOUT_SECONDS` sem efeito na fila | a fila já existe com o valor antigo; com o MiniStack, recrie o container `sqs` e rode o bootstrap |
| `InvalidChecksumError` ao reenviar uma mensagem com o mesmo id de deduplicação e outro corpo | divergência conhecida do MiniStack; use outro `MessageDeduplicationId` |
| bancos `wagering_test_*` sobrando no PostgreSQL | uma execução de testes foi interrompida; a próxima execução apaga os que têm mais de 10 minutos e nenhuma conexão |

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
  unit/ · integration/ · concurrency/ · e2e/ · spike/ · load/ · support/
keycloak/         realm importado pelo Compose
observability/    Prometheus e Grafana do profile observability (configuração e painel)
```
