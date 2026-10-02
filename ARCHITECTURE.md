# Arquitetura — Wagering Processor

Documento vivo: cresce a cada etapa da implementação. Esta versão cobre as Etapas 0 a 6: o spike que fixou as versões da stack, o schema com as garantias no banco, a persistência, o núcleo transacional e a API HTTP. A revisão completa da documentação acontece na Etapa 12.

## Matriz de versões validada

| Componente | Versão | Como foi validada |
|---|---|---|
| Bun (runtime, gerenciador de pacotes, test runner) | 1.3.14, local e imagem `oven/bun:1.3.14-alpine` | toda a suíte do spike roda com `bun test` |
| TypeScript (só checagem de tipos) | 6.0.3 | `tsc --noEmit` limpo |
| NestJS | 12.1.2 (`common`, `core`, `platform-express`, `testing`) | injeção de dependências por metadados de decorators e validação com Standard Schema |
| Zod | 4.6.5 | `@Body({ schema })` com `StandardSchemaValidationPipe` |
| MikroORM | 7.2.3 (`core`, `postgresql`, `migrations`) | migrations, locks e códigos de erro contra PostgreSQL real |
| JSON canônico | `canonicalize` 5.1.0 (RFC 8785) | vetores de teste calculados por fora com `shasum` |
| Driver `pg` | 8.23.0, trazido pelo `@mikro-orm/postgresql` | NUMERIC devolvido como string |
| PostgreSQL | 18.6 (`postgres:18.6-alpine`) | locks, CHECK de escala e `lock_timeout` |
| AWS SDK (SQS) | `@aws-sdk/client-sqs` 3.1145.0 | todas as operações que o consumidor e o publisher vão usar |
| Emulador SQS | MiniStack 1.5.20 | ver evidências abaixo |
| Lint | ESLint 10.11.0 com typescript-eslint 8.71.0 | `eslint .` limpo |
| Orquestração | Docker 29.8.1, Docker Compose v5.5.1 | PostgreSQL e MiniStack com healthcheck |

**Por que TypeScript 6.0.3 e não 7.0.2.** O TypeScript 7 é o compilador reescrito em Go. O typescript-eslint 8.71 aceita apenas versões abaixo de 6.1. Como o Bun transpila o código sozinho, o TypeScript só faz a checagem de tipos, e a escolha não afeta o comportamento em execução.

## Evidências do spike

Os testes ficam em `test/spike/` e rodam com `bun run test:spike` (requer `bun run infra:up`).

### NestJS 12 no Bun

- A injeção de dependências por construtor funciona com os metadados emitidos pelo Bun (`emitDecoratorMetadata`).
- `@Body({ schema })` com um schema Zod e o `StandardSchemaValidationPipe` global devolve 400 para um corpo inválido. O mesmo schema poderá validar HTTP e mensagens SQS.

### MikroORM 7 com PostgreSQL 18

| Comportamento | Resultado |
|---|---|
| Migration escrita à mão, executada por `orm.migrator` com `migrationsList`: up, down e up de novo | funciona, sem CLI e sem transpilador extra |
| Valor NUMERIC com 17 dígitos inteiros | volta como string exata |
| Coluna `numeric` sem escala declarada com `CHECK (scale(col) = 2)` recebendo `10.005` | recusada com SQLSTATE `23514`, sem arredondar |
| Dois `findOne` com `LockMode.PESSIMISTIC_WRITE` na mesma linha | o segundo espera o commit do primeiro e enxerga o valor atualizado (READ COMMITTED) |
| Lock pessimista fora de transação | recusado pelo MikroORM |
| `SET LOCAL lock_timeout` estourado | erro com SQLSTATE `55P03` |
| Chave duplicada | erro com SQLSTATE `23505` |
| `em.transactional` chamado dentro de outro | vira savepoint: a falha interna é absorvida e a transação externa faz commit |

O último resultado confirma por que a unidade de trabalho da aplicação vai recusar transações aninhadas: com o padrão `NESTED`, uma falha numa parte da operação poderia ser engolida enquanto o resto é confirmado.

### MiniStack 1.5.20 (SQS FIFO)

Cada comportamento foi testado numa fila própria, para uma falha não contaminar a outra.

| Comportamento de que o consumidor depende | Resultado |
|---|---|
| `ApproximateReceiveCount`, `MessageGroupId` e atributos de mensagem no recebimento | presentes e corretos |
| Segundo envio com o mesmo `MessageDeduplicationId` e o mesmo corpo | descartado |
| Mensagens do mesmo grupo enquanto uma delas está em processamento | retidas até a primeira ser apagada |
| `ChangeMessageVisibility` para zero | a mensagem volta na hora, com contagem 2 |
| `ChangeMessageVisibility` estendendo o prazo (heartbeat) | a mensagem continua escondida |
| Redrive com `maxReceiveCount` 2 | a mensagem vai para a DLQ FIFO |
| Long polling de 2 s numa fila vazia | a chamada espera o intervalo |
| `SendMessageBatch` | resultado separado por entrada |
| Envio manual para a DLQ com grupo, id de deduplicação e atributos; `ApproximateNumberOfMessages` | funciona |

**Divergência encontrada.** Um segundo envio com o mesmo id de deduplicação mas corpo diferente faz o MiniStack responder com o MD5 do corpo original, e o SDK recusa a resposta com `InvalidChecksumError`. Não afeta o desenho: retries reais reenviam o mesmo corpo, a deduplicação do broker é só otimização e os testes de idempotência usam ids de deduplicação distintos de propósito.

### Desligamento (SIGTERM)

| Cenário | Resultado |
|---|---|
| Processo `bun src/main.api.ts` recebendo SIGTERM | o hook de shutdown do NestJS roda e o processo termina |
| Container iniciado diretamente pelo Bun, com `--init` | para na hora, código de saída 143, hook executado |
| Container com o Bun como PID 1, sem `--init` | para na hora, código de saída 0, hook executado |

O processo é iniciado diretamente pelo Bun no `Dockerfile` (forma exec), sem script intermediário que possa interceptar o sinal.

### Compatibilidade com Bun 1.4.2

O Bun 1.4 reescreveu o runtime, e a versão mais recente é a 1.4.2. O mesmo spike rodou num container `oven/bun:1.4.2-alpine`, sem alterar o runtime local:

| Verificação | Resultado |
|---|---|
| `bun install --frozen-lockfile` com o lockfile atual | instala sem alterar o lockfile |
| Os 20 testes de `test/spike` | todos passam |
| `tsc --noEmit` e `eslint .` | limpos |
| Imagem da api construída com `--build-arg BUN_VERSION=1.4.2`, parada com SIGTERM | com `--init`, saída 143; como PID 1, saída 0; hook executado nos dois |

O projeto segue no 1.3.14 enquanto o runtime local estiver nessa versão. O `Dockerfile` recebe a versão por `ARG BUN_VERSION`, então adotar a 1.4.2 é trocar um valor e atualizar o Bun local.

## Schema e garantias no banco

A migration `src/platform/database/migrations/migration-20261002120000-create-wagering-schema.ts` é escrita à mão, com `up` e `down`, e roda por `bun run migrate:up` / `migrate:down` (sem CLI). Toda constraint, índice e trigger tem nome explícito, e os testes conferem o SQLSTATE e o nome da constraint violada.

**Colunas monetárias.** `numeric` sem precisão declarada, com `CHECK (scale(col) = 2)`, sinal e magnitude menor que 10^17. Com `numeric(p,2)` o PostgreSQL arredondaria `10.005` em silêncio antes de qualquer CHECK; sem precisão declarada, a escrita é recusada.

| Garantia do README | Mecanismo no schema |
|---|---|
| uma wallet por `playerId` + `currency` | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK` de sinal e escala em `wallets.balance_amount` e nos saldos do ledger |
| idempotência | `UNIQUE (idempotency_key)` global e `UNIQUE (provider_id, external_transaction_id)` |
| no máximo um lançamento por transação e por wallet | `UNIQUE (wallet_id, transaction_id)` |
| sem lost update | `UNIQUE (wallet_id, wallet_version)` no ledger |
| reversão uma única vez por tipo (regra literal do README §7.4) | índice único parcial `(reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| ledger imutável | triggers `BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE` levantam `23001` |
| transação terminal imutável | trigger `BEFORE UPDATE` recusa qualquer alteração em linha PROCESSED, REJECTED ou FAILED e qualquer mudança nas colunas imutáveis; `DELETE` também é recusado |
| moeda do lançamento igual à da wallet e à da transação | FKs compostas `(wallet_id, currency)` e `(transaction_id, wallet_id, currency)` |
| conta do lançamento | `CHECK` de `balance_after = balance_before ± amount` conforme a direção |

Outras coerências checadas no banco: status `PENDING` nunca é gravado (só existe em memória); `failure_code` existe se e somente se o status é REJECTED ou FAILED; `processed_at` só em PROCESSED; `next_reference_attempt_at` só em PENDING_REFERENCE; `reference_transaction_id` existe se e somente se a transação foi processada e declarou referência; o provedor reservado `internal` só aparece em OPENING; o saldo observado fica sempre na moeda da wallet.

**Testes.** `test/integration/platform/database/` roda up → down → up e viola cada constraint e cada trigger com o SQLSTATE esperado. Um cruzamento com o catálogo do PostgreSQL confirmou que toda constraint tem um teste com o seu nome, exceto as UNIQUEs que só servem de alvo de FK composta (implícitas pela PK).

## Persistência e unidade de trabalho

- **Records separados do domínio.** Definidos com `defineEntity`, sem decorators, e convertidos por funções explícitas que chamam `rehydrate`. O Money ocupa duas colunas (valor e moeda).
- **Leituras sem identity map** (`disableIdentityMap`) e **escritas explícitas** (`insert`, `insertMany`, `nativeUpdate` com versão esperada exigindo 1 linha afetada, `INSERT … ON CONFLICT DO NOTHING` na inbox). Nenhuma entidade gerenciada existe para um flush implícito; há teste para isso.
- **Unidade de trabalho** (`MikroOrmUnitOfWork`): cada execução usa um fork novo do EntityManager, abre a transação em READ COMMITTED e aplica `lock_timeout` local à transação (`set_config(..., true)`). Execução aninhada é recusada por uma guarda com `AsyncLocalStorage`; o spike mostrou que o padrão do MikroORM transformaria o aninhamento num savepoint.
- **Erros transitórios.** `55P03`, `40P01`, `40001`, `57014`, classe `08`, `57P01-03`, `53300`, `25P03` e erros de socket saem da unidade de trabalho como `TransientFailure(reason)`. Violações de UNIQUE são traduzidas pelo repositório dono da constraint (`WalletAlreadyExistsError`, `DuplicateWagerTransactionError`).
- **Timeouts por conexão:** `statement_timeout` de 10 s e `idle_in_transaction_session_timeout` de 30 s, configuráveis.

**Fingerprint.** SHA-256 em hex do JSON canônico RFC 8785 dos campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` quando existe). Header, `messageId`, `type`, `occurredAt` e `correlationId` ficam de fora. Vetor de teste: a aposta do exemplo do README (`provider-a`, `transaction-123`, `25.00 BRL`) gera `629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344`. O hash da inbox cobre `{type, data}` (inclui `idempotencyKey`); para a mensagem de exemplo do README §10 ele vale `c0c6bae37f6ceee9f633907ef9c19bdbf43fbf3570e3bf0a66a09dda29ef9437`.

## Núcleo transacional

Um único caminho atende HTTP e SQS (`SubmitWagerTransaction`):

1. **Fora da transação:** valida o contrato (`Money.from`, `WagerTransaction.create`) e calcula o fingerprint.
2. Na unidade de trabalho: na entrada SQS, registra a inbox primeiro (mesmo hash → entrega duplicada; hash diferente → `MESSAGE_ID_CONFLICT`).
3. Busca pela idempotency key, ainda sem lock: mesmo hash → replay com o resultado original; hash diferente → `IDEMPOTENCY_KEY_CONFLICT`.
4. `SELECT … FOR UPDATE` na wallet (inexistente → `WALLET_NOT_FOUND`), nova busca pela key sob o lock e busca por `(provider_id, external_transaction_id)` (`EXTERNAL_TRANSACTION_CONFLICT`).
5. Decisão pura da `SettlementPolicy`, com a referência resolvida sob o mesmo lock.
6. Escritas na ordem: transação (com o saldo observado) → wallet com versão esperada → lançamento → eventos na outbox → inbox marcada como processada.

Uma violação de UNIQUE na inserção (corrida com a mesma key em outra wallet) refaz a unidade de trabalho uma vez, e a segunda execução resolve como replay ou conflito. Deadlock refaz no máximo duas vezes, com jitter. `lock_timeout` não é refeito dentro do processo (vira 503 ou backoff).

- **Replay** devolve status, `failureCode` e saldo gravados na primeira execução, mesmo que o saldo atual seja outro. Transação pendente devolve o estado atual.
- **Abertura de wallet:** saldo inicial maior que zero gera OPENING, lançamento CREDIT na versão 1 e os eventos na mesma transação; saldo zero não gera nada além da wallet.
- **Worker de referência** (`ProcessPendingReference`): trava a wallet e depois a transação pendente, revalida status, wallet e vencimento, e aplica a mesma política. Dois workers no mesmo candidato se serializam no lock da wallet; o segundo encontra o estado já atualizado.
- **Reconciliação:** uma única instrução SQL lê o saldo gravado, a soma dos créditos, a soma dos débitos e o número de lançamentos (um snapshot), e a diferença é calculada com o Money. Um ledger corrompido produz saldo calculado negativo com sinal (`-50.00`), não uma exceção. Divergências não são corrigidas.

**Provas de concorrência** (`test/concurrency/`, banco real, paralelismo real): C1 (a mesma aposta 50 vezes → 1 débito e 49 replays idênticos), C2 (duas apostas de 80 contra 100, 25 rodadas com reenvios → exatamente uma processada), C3 (wallets distintas em paralelo e nenhuma espera por lock de outra wallet), C9 (reversões concorrentes do mesmo tipo → exatamente uma; REFUND e ROLLBACK da mesma BET devolvem a aposta duas vezes, como manda a regra literal; ROLLBACK de REFUND sem saldo → `REVERSAL_INSUFFICIENT_FUNDS`). Testes de mutação confirmaram que tirar o lock da wallet derruba C2 (24 de 25 rodadas) e tirar a rechecagem sob o lock derruba C1. Depois de cada cenário, um verificador confere saldo = ledger, cadeia contínua, versão coerente, um lançamento por transação processada que move saldo e nenhuma reversão duplicada.

## API HTTP

| Endpoint | Sucesso | Erros |
|---|---|---|
| `POST /wallets` | 201 `{id, playerId, balance, version, createdAt}` | 400, 409 `WALLET_ALREADY_EXISTS`, 503 |
| `GET /wallets/:walletId` | 200 | 400, 404, 503 |
| `GET /wallets/:walletId/ledger?cursor&limit` | 200 `{items, nextCursor}`, do lançamento mais novo para o mais antigo; `limit` de 1 a 100 (padrão 50); cursor base64url amarrado à wallet | 400 (`INVALID_REQUEST`, `INVALID_CURSOR`), 404, 503 |
| `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 | 400, 404 `TRANSACTION_NOT_FOUND`, 503 |
| `POST /wagering/transactions` | 200 PROCESSED · 202 PENDING_REFERENCE (com `Location`) · 422 REJECTED · 500 FAILED, sempre com o `TransactionResult` | 400, 404, 409, 503 |
| `POST /wallets/:walletId/reconciliation` | 200, inclusive com `consistent: false` | 400, 404, 503 |
| `GET /health/live` / `GET /health/ready` | 200 | `ready`: 503 com o banco fora ou durante o shutdown |

**Regra de corpo.** Se a transação foi persistida, o corpo é o `TransactionResult` `{transactionId, status, balance, failureCode?, idempotentReplay}`. Se nada foi persistido, o corpo é `application/problem+json` (RFC 9457) com `code` estável, `retryable` e `correlationId`:

| `code` | HTTP | `retryable` |
|---|---|---|
| `INVALID_PAYLOAD` (corpo), `INVALID_REQUEST` (caminho ou query), `INVALID_CURSOR`, `IDEMPOTENCY_KEY_REQUIRED`, `UNSUPPORTED_KIND`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `INVALID_AMOUNT` | 400 | não |
| `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` | 404 | não |
| `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT` | 409 | não |
| `SERVICE_UNAVAILABLE` (com `Retry-After: 1`) | 503 | sim |
| `INTERNAL_ERROR` | 500 | sim (nada foi confirmado; reenviar com a mesma key é seguro) |

Um único filtro global aplica essa tabela em todos os endpoints. Erros de validação listam o caminho e a mensagem de cada campo, nunca o valor recebido.

- **Validação:** schemas Zod via Standard Schema, com objetos estritos (campo desconhecido → 400) e valores com no máximo 17 dígitos inteiros.
- **Correlação:** `X-Correlation-Id` aceito quando tem de 1 a 128 caracteres ASCII visíveis, senão substituído por um UUIDv7; devolvido em toda resposta e gravado na transação.
- **Autenticação:** não implementada (vale 0 pontos). Há um `AuthGuard` global no-op, `@Public()` nos health checks e o `ProviderIdentityPort` (`authenticate`, `assertMayActFor`) como ponto de extensão.
- **Várias instâncias:** `test/concurrency/multi-process/` sobe três processos da API (`Bun.spawn`, porta lida do log de boot) contra o mesmo banco e prova C1 e C2 via HTTP.

## Peculiaridades do ambiente

- **Bun SQL** (usado só nos testes) devolve o NUMERIC zero como `"0"` em consultas parametrizadas; os testes leem valores monetários com `::text`. O MikroORM (driver `pg`) devolve `"0.00"`.
- **`toMatchObject` do Bun 1.3.14** com matchers assimétricos troca os valores do objeto recebido pelos matchers; os testes não reutilizam valores conferidos dessa forma.
- **MiniStack:** ver a divergência de MD5 descrita no spike.

## Decisões em aberto

- **README do enunciado.** O `README.md` atual é o enunciado do desafio. Até a decisão sobre renomeá-lo para `CHALLENGE.md` ou mover a solução para uma subpasta, ele não é alterado, e o código fica na raiz do repositório.
