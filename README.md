# Wagering Processor

Processador de transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) com entrada por HTTP e por SQS FIFO, saldo e ledger no PostgreSQL e eventos publicados por outbox. Solução do desafio em [CHALLENGE.md](CHALLENGE.md); decisões, trade-offs e limitações em [ARCHITECTURE.md](ARCHITECTURE.md).

**Stack:** Bun 1.3.14 · TypeScript estrito · NestJS 12 · MikroORM 7 · PostgreSQL 18 · SQS FIFO no MiniStack 1.5.20 · Docker Compose · Keycloak 26.8 (autenticação).

## Pré-requisitos

- Docker com Docker Compose v2
- Bun 1.3.14: `curl -fsSL https://bun.sh/install | bash -s bun-v1.3.14`
- Portas livres: 3000 (api), 5432 (PostgreSQL), 4566 (MiniStack) e 8080 (Keycloak)

## Passo a passo

### 1. Instalar as dependências

```bash
bun install
```

### 2. Subir tudo

```bash
docker compose up -d --build --wait
```

Sobe PostgreSQL, MiniStack e Keycloak, roda o `bootstrap` (aplica as migrations e cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo`) e inicia a `api` e o `worker`. O comando só retorna com tudo pronto. As variáveis de ambiente e seus padrões estão em `src/platform/config/app-config.ts`.

### 3. Conferir a saúde

```bash
curl localhost:3000/health/live    # {"status":"ok"}
curl localhost:3000/health/ready   # {"status":"ready","checks":{"database":"up","sqs":"up"}}
```

### 4. Fazer uma operação

As rotas, menos as de health, exigem um token do Keycloak. Os segredos são só de desenvolvimento, e os tokens valem 5 minutos.

**Pelo editor:** abra [requests.http](requests.http) no VS Code ou no Cursor, com a extensão REST Client, e clique em **Send Request** em cada bloco, na ordem. O arquivo pega os tokens, abre uma wallet e passa por aposta, replay, conflito, ganho, saldo insuficiente, referência que chega depois, ledger e reconciliação. Quando os tokens vencerem, rode de novo os dois blocos de token.

**Pelo terminal:**

```bash
token() {
  curl -s http://localhost:8080/realms/wagering/protocol/openid-connect/token \
    -d grant_type=client_credentials -d client_id="$1" -d client_secret="$1-secret" |
    sed -E 's/.*"access_token":"([^"]+)".*/\1/'
}
OPERATOR=$(token wagering-operator)
PROVIDER=$(token provider-a)
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1

# abrir uma wallet com 100.00 (a resposta traz o id)
curl -s -X POST localhost:3000/wallets \
  -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -d '{"playerId":"'"$PLAYER"'","initialBalance":{"amount":"100.00","currency":"BRL"}}'

WALLET=<id da wallet>

# apostar 25.00
curl -s -X POST localhost:3000/wagering/transactions \
  -H "authorization: Bearer $PROVIDER" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"'"$PLAYER"'","walletId":"'"$WALLET"'","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# consultar saldo, ledger e reconciliação
curl -s localhost:3000/wallets/$WALLET -H "authorization: Bearer $OPERATOR"
curl -s localhost:3000/wallets/$WALLET/ledger -H "authorization: Bearer $OPERATOR"
curl -s -X POST localhost:3000/wallets/$WALLET/reconciliation -H "authorization: Bearer $OPERATOR"
```

Repetir a aposta com a mesma `Idempotency-Key` devolve o mesmo resultado, com `idempotentReplay: true`.

### 5. Mandar uma operação pela fila

```bash
bun run demo:send-message --wallet "$WALLET" --player "$PLAYER" --kind BET --amount 10.00
```

O worker consome a mensagem de `wager-transactions.fifo`, e o saldo muda em menos de um segundo.

### 6. Rodar os testes

Os testes usam o PostgreSQL e o MiniStack do passo 2. Cada suíte cria o próprio banco e filas, sem mexer nos dados do Compose.

```bash
bun run test               # unidade, integração e concorrência (cerca de 3 minutos)
bun run typecheck
bun run lint
```

| Comando | O que roda |
|---|---|
| `bun run test:unit` | Money, Wallet, regras das operações, conflito de moeda, idempotência |
| `bun run test:integration` | migrations e constraints, atomicidade, inbox, outbox, retry e DLQ, com PostgreSQL e MiniStack reais |
| `bun run test:concurrency` | os cenários 1 a 8 do enunciado, com até 6 processos reais |

### 7. Migrations

O passo 2 já aplicou as migrations. Para aplicar ou reverter à mão:

```bash
bun run migrate:down   # reverte todas (apaga os dados do banco local)
bun run migrate:up     # aplica as pendentes
```

### 8. Encerrar

```bash
docker compose down -v
```

## Opcionais

| O quê | Como |
|---|---|
| Teste de carga | `bun run test:load --preset smoke` (cerca de 1 min, em infraestrutura própria); metodologia e resultados em [LOAD-TEST.md](LOAD-TEST.md) |
| Painel de métricas | `docker compose --profile observability up -d --build --wait`; Grafana em http://localhost:3001 e Prometheus em http://localhost:9090 |
| Testes ponta a ponta | `bun run test:e2e`, com o painel de métricas no ar |
