# Arquitetura — Wagering Processor

Processador de transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) de vários provedores, com entrada por HTTP e por SQS FIFO e o PostgreSQL como árbitro. Este documento explica o desenho, as garantias e onde cada uma é provada por teste. O passo a passo para subir e testar o sistema fica no [README](README.md), e o enunciado do desafio, sem alterações, em [CHALLENGE.md](CHALLENGE.md).

Invariante central: em qualquer situação, `wallet.balance` é igual ao saldo reconstruído pelo ledger, sem débito ou crédito duplicado e sem saldo negativo — com mensagens duplicadas, fora de ordem, simultâneas, com várias instâncias e com processos caindo no meio.

## Visão geral

```mermaid
flowchart LR
  provider([Provedor]) -- "client_credentials" --> keycloak[Keycloak]
  provider -- "POST /wagering/transactions + Bearer" --> api
  api -. "JWKS (cache)" .-> keycloak
  operator([Operador]) -- "GET /wallets/:id/events (SSE)" --> api
  provider -- SendMessage --> commands[(wager-transactions.fifo)]
  commands -- "consumer (long poll)" --> worker
  worker -- "DLQ manual" --> dlq[(wager-transactions-dlq.fifo)]
  commands -. "redrive (10 recebimentos)" .-> dlq
  api -- "transação + outbox" --> pg[(PostgreSQL)]
  worker -- "transação + inbox + outbox" --> pg
  worker -- "publisher da outbox" --> events[(wagering-events.fifo)]
  bootstrap -- "migrations" --> pg
  bootstrap -- "cria as 3 filas" --> commands
```

| Papel | Entrypoint | Responsabilidade |
|---|---|---|
| `bootstrap` | `src/main.bootstrap.ts` | aplica as migrations pendentes e cria as três filas FIFO; idempotente; roda uma vez antes dos outros |
| `api` | `src/main.api.ts` | HTTP (wallets, transações, ledger, reconciliação), health e métricas; valida o token de toda rota que não é health |
| `worker` | `src/main.worker.ts` | consumidor da fila de entrada, publisher da outbox e scheduler de referências pendentes, cada um ligado ou desligado por variável de ambiente; health e métricas |

As instâncias se coordenam **só pelo PostgreSQL**: lock de linha na wallet, `FOR UPDATE SKIP LOCKED` na outbox, constraints UNIQUE e o trigger de imutabilidade. Nada em memória é garantia; o FIFO e a deduplicação do SQS são otimizações.

| Pasta | Conteúdo |
|---|---|
| `src/wallet` | domínio (`Money`, `Wallet`, `WagerTransaction`, `SettlementPolicy`, eventos), aplicação (casos de uso e portas) e infraestrutura (MikroORM, HTTP, consumidor SQS, scheduler) |
| `src/messaging` | inbox e outbox (domínio e persistência), publisher, consumidor genérico em lote, provisionamento de filas |
| `src/platform` | configuração, banco (ORM, migrations, unidade de trabalho), HTTP (filtro de problemas, correlação), autenticação, ciclo de vida |
| `src/observability` | métricas Prometheus, logger pino, health |
| `src/shared` | portas transversais (relógio, ids, métricas, logger, unidade de trabalho) e backoff |
| `src/app` | composição dos módulos Nest de cada papel |

O ESLint impõe as fronteiras: domínio e aplicação não importam NestJS, MikroORM, AWS SDK, `pg` nem infraestrutura; o domínio não importa a aplicação; nessas camadas, `Number()`, `parseFloat`, `parseInt` e `toNumber` são proibidos, para o dinheiro nunca virar `number`. Os imports usam aliases (`@wallet/*`, `@platform/*`…), sem caminhos relativos para pastas acima.

## Matriz de versões validada

| Componente | Versão | Como foi validada |
|---|---|---|
| Bun (runtime, gerenciador de pacotes, test runner) | 1.3.14, local e imagem `oven/bun:1.3.14-alpine` | toda a suíte roda com `bun test` |
| TypeScript (só checagem de tipos) | 6.0.3 | `tsc --noEmit` limpo |
| NestJS | 12.1.2 (`common`, `core`, `platform-express`, `testing`) | injeção de dependências por metadados de decorators e validação com Standard Schema |
| Zod | 4.6.5 | `@Body({ schema })` com `StandardSchemaValidationPipe` |
| MikroORM | 7.2.3 (`core`, `postgresql`, `migrations`) | migrations, locks e códigos de erro contra PostgreSQL real |
| JSON canônico | `canonicalize` 5.1.0 (RFC 8785) | vetores de teste calculados por fora com `shasum` |
| Driver `pg` | 8.23.0, trazido pelo `@mikro-orm/postgresql` | NUMERIC devolvido como string |
| PostgreSQL | 18.6 (`postgres:18.6-alpine`) | locks, CHECK de escala e `lock_timeout` |
| AWS SDK (SQS) | `@aws-sdk/client-sqs` 3.1145.0 | todas as operações usadas pelo consumidor e pelo publisher |
| Emulador SQS | MiniStack 1.5.20 | ver evidências abaixo |
| Métricas e logs | `prom-client` 15.1.3, `pino` 10.3.1 | catálogo exposto em `/metrics`; logs JSON |
| JWT e JWKS | `jose` 6.2.12 | verificador testado contra chaves locais e contra o Keycloak |
| IdP | Keycloak 26.8.0 (imagem otimizada a partir de `quay.io/keycloak/keycloak:26.8.0`, `start --optimized`, banco no PostgreSQL) | realm importado na primeira subida; `bun run test:e2e` |
| Painel de métricas | Prometheus 3.15.0, Grafana 13.2.3 (profile `observability`) | coleta autenticada e painel provisionado; `bun run test:e2e` |
| Lint e formatação | ESLint 10.11.0 com typescript-eslint 8.71.0; Prettier 3.9.9 | `bun run lint` limpo |
| Orquestração | Docker 29.8.1, Docker Compose v5.5.1 | stack completa com healthchecks e `--scale worker=3` |

**Por que TypeScript 6.0.3 e não 7.0.2.** O TypeScript 7 é o compilador reescrito em Go. O typescript-eslint 8.71 aceita apenas versões abaixo de 6.1. Como o Bun transpila o código sozinho, o TypeScript só faz a checagem de tipos, e a escolha não afeta o comportamento em execução.

## Evidências do spike

Os testes ficam em `test/spike/` e rodam com `bun run test:spike` (requer `bun run infra:up`).

### NestJS 12 no Bun

- A injeção de dependências por construtor funciona com os metadados emitidos pelo Bun (`emitDecoratorMetadata`).
- `@Body({ schema })` com um schema Zod e o `StandardSchemaValidationPipe` global devolve 400 para um corpo inválido. O mesmo schema valida HTTP e mensagens SQS.

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

O último resultado explica por que a unidade de trabalho da aplicação recusa transações aninhadas: com o padrão `NESTED`, uma falha numa parte da operação poderia ser engolida enquanto o resto é confirmado.

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
| Envio manual para a DLQ com grupo, id de deduplicação e atributos; `ApproximateNumberOfMessages`, `…NotVisible` e `…Delayed` | funciona |

**Divergência encontrada.** Um segundo envio com o mesmo id de deduplicação mas corpo diferente faz o MiniStack responder com o MD5 do corpo original, e o SDK recusa a resposta com `InvalidChecksumError`. Não afeta o desenho: retries reais reenviam o mesmo corpo, a deduplicação do broker é só otimização e os testes de idempotência usam ids de deduplicação distintos de propósito.

### Desligamento (SIGTERM)

| Cenário | Resultado |
|---|---|
| Processo `bun src/main.api.ts` recebendo SIGTERM | o hook de shutdown do NestJS roda e o processo termina |
| Container iniciado diretamente pelo Bun, com `--init` | para na hora, código de saída 143, hook executado |
| Container com o Bun como PID 1, sem `--init` | para na hora, código de saída 0, hook executado |

O processo é iniciado diretamente pelo Bun no `Dockerfile` e no Compose (forma exec), sem script intermediário que possa interceptar o sinal.

### Compatibilidade com Bun 1.4.2

O Bun 1.4 reescreveu o runtime, e a versão mais recente é a 1.4.2. O spike rodou num container `oven/bun:1.4.2-alpine`, sem alterar o runtime local:

| Verificação | Resultado |
|---|---|
| `bun install --frozen-lockfile` com o lockfile atual | instala sem alterar o lockfile |
| Os 20 testes de `test/spike` | todos passam |
| `tsc --noEmit` e `eslint .` | limpos |
| Imagem da api construída com `--build-arg BUN_VERSION=1.4.2`, parada com SIGTERM | com `--init`, saída 143; como PID 1, saída 0; hook executado nos dois |

O projeto segue no 1.3.14 enquanto o runtime local estiver nessa versão. O `Dockerfile` fixa a imagem por versão e digest, então adotar a 1.4.2 é trocar essa linha (tag e digest) e atualizar o Bun local.

## Schema e garantias no banco

A migration `src/platform/database/migrations/migration-20261002120000-create-wagering-schema.ts` é escrita à mão, com `up` e `down`, e roda pelo papel `bootstrap` ou por `bun run migrate:up` / `migrate:down` (sem CLI do ORM). Toda constraint, índice e trigger tem nome explícito, e os testes conferem o SQLSTATE e o nome da constraint violada. As migrations seguintes (código de falha `BALANCE_LIMIT_EXCEEDED`, índice de retenção da inbox e guardas saldo ⇔ ledger) rodam cada uma por conta própria (`allOrNothing: false`). Em tabela que pode ser grande, valem duas regras:
- **Índice:** criado com `CREATE INDEX CONCURRENTLY`, fora de transação.
- **Troca de `CHECK`:** a constraint nova entra como `NOT VALID`, e o `VALIDATE CONSTRAINT` roda num comando separado, sem bloquear leitura nem escrita. Numa cópia com 5 milhões de transações, a troca numa transação só parou toda leitura e escrita da tabela por cerca de 0,4 s. A troca em duas etapas não parou nenhuma (ver LOAD-TEST.md).

**Mapeamento do Money.** Duas colunas: valor `numeric` e moeda `text` com `CHECK` de três letras maiúsculas. O valor não tem precisão declarada e tem `CHECK (scale(col) = 2)`, sinal e magnitude menor que 10^17. Com `numeric(p,2)` o PostgreSQL arredondaria `10.005` em silêncio antes de qualquer CHECK; sem precisão declarada, a escrita é recusada. Na aplicação, o valor é uma string decimal convertida para `big.js` dentro de `Money`, e volta do driver como string exata. O limite também está no domínio: um crédito que levaria o saldo a 10^17 ou mais é rejeitado com `BALANCE_LIMIT_EXCEEDED` antes de chegar ao banco (a migration `20261003140000` acrescentou o código ao `CHECK`).

| Garantia do enunciado | Mecanismo no schema |
|---|---|
| uma wallet por `playerId` + `currency` | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK` de sinal e escala em `wallets.balance_amount` e nos saldos do ledger |
| idempotência | `UNIQUE (idempotency_key)` global e `UNIQUE (provider_id, external_transaction_id)` |
| no máximo um lançamento por transação e por wallet | `UNIQUE (wallet_id, transaction_id)` |
| sem lost update | `UNIQUE (wallet_id, wallet_version)` no ledger |
| reversão uma única vez por tipo (regra literal do enunciado §7.4) | índice único parcial `(reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| ledger imutável | triggers `BEFORE UPDATE OR DELETE` e `BEFORE TRUNCATE` levantam `23001` |
| transação terminal imutável | trigger `BEFORE UPDATE` recusa qualquer alteração em linha PROCESSED, REJECTED ou FAILED e qualquer mudança nas colunas imutáveis; `DELETE` também é recusado |
| moeda do lançamento igual à da wallet e à da transação | FKs compostas `(wallet_id, currency)` e `(transaction_id, wallet_id, currency)` |
| conta do lançamento | `CHECK` de `balance_after = balance_before ± amount` conforme a direção |
| saldo da wallet igual ao ledger, cadeia contínua | constraint triggers `DEFERRABLE INITIALLY DEFERRED`, conferidas no commit (abaixo); levantam `23514` com o nome do trigger |
| mensagem processada uma vez por consumidor | PK `(consumer_name, message_id)` na inbox |

**Saldo ⇔ ledger no banco.** Duas constraint triggers da migration `20261003170000`, adiadas para o commit porque a aplicação grava a wallet e o lançamento em comandos separados da mesma transação:
- `wallets_balance_matches_ledger`, na criação da wallet e em toda mudança de saldo ou versão: o saldo é o `balance_after` do lançamento da versão atual. A exceção é a wallet aberta com saldo zero, que fica na versão 1 sem lançamento.
- `wallet_ledger_entries_follow_chain`, em todo lançamento: `balance_before` é o `balance_after` da versão anterior, ou zero no primeiro lançamento (versão 1 ou 2, conforme a wallet tenha sido aberta com saldo ou não). Nenhuma versão é pulada, e o lançamento nunca fica à frente da wallet.

Cada operação paga três buscas por índice único no commit: o lançamento anterior, a wallet e o lançamento da versão. Numa A/B de saturação com 3 apis e 3 workers, isso custou de 1% a 2% da vazão de pico, dentro da variação entre rodadas (ver LOAD-TEST.md). As mensagens de erro trazem ids e versões, nunca valores.

Uma wallet que já diverge do ledger fica fechada até ser corrigida. A próxima operação falha no commit (`23514`) e nada é gravado. A API responde 500. A mensagem da fila vai para a DLQ como `RETRIES_EXHAUSTED` depois dos retries, e `bun run dlq redrive` a devolve depois da correção. Numa base existente, os triggers só valem para escritas novas. Por isso, reconciliar todas as wallets antes de aplicar a migration mostra quais ficariam fechadas (`bun run reconcile`). A reconciliação continua como controle de detecção para o que contorna os triggers, como um restore ou uma sessão de replicação (`session_replication_role = replica`), que é como os testes dela injetam a divergência.

Outras coerências checadas no banco: status `PENDING` nunca é gravado (só existe em memória); `failure_code` existe se e somente se o status é REJECTED ou FAILED; `processed_at` só em PROCESSED; `next_reference_attempt_at` só em PENDING_REFERENCE; `reference_transaction_id` existe se e somente se a transação foi processada e declarou referência; o provedor reservado `internal` só aparece em OPENING; o saldo observado fica sempre na moeda da wallet.

**Testes.** `test/integration/platform/database/` roda up → down → up e viola cada constraint e cada trigger com o SQLSTATE esperado. Um cruzamento com o catálogo do PostgreSQL confirmou que toda constraint tem um teste com o seu nome, exceto as UNIQUEs que só servem de alvo de FK composta (implícitas pela PK).

## Persistência e unidade de trabalho

**Por que MikroORM.** É a opção preferencial do enunciado e oferece o que a estratégia transacional precisa sem contornos: `em.transactional` com nível de isolamento explícito, `LockMode.PESSIMISTIC_WRITE` e `PESSIMISTIC_PARTIAL_WRITE` (`SKIP LOCKED`) nativos, `nativeUpdate` com o número de linhas afetadas e migrations programáticas. O spike não encontrou motivo técnico para trocar pelo TypeORM. O ORM é usado de forma deliberadamente explícita: entidades com `defineEntity` (sem decorators, fora do domínio), leituras sem identity map e escritas sem flush implícito, para que cada instrução SQL de uma operação financeira seja visível no código.

- **Records separados do domínio.** Definidos com `defineEntity`, sem decorators, e convertidos por funções explícitas que chamam `rehydrate`.
- **Leituras sem identity map** (`disableIdentityMap`) e **escritas explícitas** (`insert`, `insertMany`, `nativeUpdate` com versão esperada exigindo 1 linha afetada, `INSERT … ON CONFLICT DO NOTHING` na inbox). Nenhuma entidade gerenciada existe para um flush implícito; há teste para isso.
- **Unidade de trabalho** (`MikroOrmUnitOfWork`): cada execução usa um fork novo do EntityManager, abre a transação em READ COMMITTED e aplica `lock_timeout` local à transação (`set_config(..., true)`). Execução aninhada é recusada por uma guarda com `AsyncLocalStorage`.
- **Erros transitórios.** `55P03`, `40P01`, `40001`, `57014`, classe `08`, `57P01-03`, `53300`, `25P03`, erros de socket e as mensagens do `pg` para conexão perdida (que chegam sem código) saem da unidade de trabalho como `TransientFailure(reason)`. Violações de UNIQUE são traduzidas pelo repositório dono da constraint (`WalletAlreadyExistsError`, `DuplicateWagerTransactionError`).
- **Timeouts por conexão:** `statement_timeout` de 10 s e `idle_in_transaction_session_timeout` de 30 s, configuráveis. O segundo solta os locks de uma sessão travada.

**Fingerprint.** SHA-256 em hex do JSON canônico RFC 8785 dos campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` quando existe). Header, `messageId`, `type`, `occurredAt` e `correlationId` ficam de fora. Vetor de teste: a aposta do exemplo do enunciado (`provider-a`, `transaction-123`, `25.00 BRL`) gera `629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344`. O hash da inbox cobre `{type, data}` (inclui `idempotencyKey`); para a mensagem de exemplo do enunciado §10 ele vale `c0c6bae37f6ceee9f633907ef9c19bdbf43fbf3570e3bf0a66a09dda29ef9437`.

## Núcleo transacional

Um único caminho atende HTTP e SQS (`SubmitWagerTransaction`):

1. **Fora da transação:** valida o contrato (`Money.from`, `WagerTransaction.create`) e calcula o fingerprint.
2. Na unidade de trabalho: na entrada SQS, registra a inbox primeiro (mesmo hash → entrega duplicada; hash diferente → `MESSAGE_ID_CONFLICT`).
3. Busca pela idempotency key, ainda sem lock: mesmo hash → replay com o resultado original; hash diferente → `IDEMPOTENCY_KEY_CONFLICT`.
4. `SELECT … FOR UPDATE` na wallet (inexistente → `WALLET_NOT_FOUND`), nova busca pela key sob o lock e busca por `(provider_id, external_transaction_id)` (`EXTERNAL_TRANSACTION_CONFLICT`).
5. Decisão pura da `SettlementPolicy`, com a referência resolvida sob o mesmo lock.
6. Escritas na ordem: transação (com o saldo observado) → wallet com versão esperada → lançamento → eventos na outbox → inbox marcada como processada.

Uma violação de UNIQUE na inserção (corrida com a mesma key em outra wallet) refaz a unidade de trabalho uma vez, e a segunda execução resolve como replay ou conflito. Deadlock refaz no máximo duas vezes, com jitter. `lock_timeout` não é refeito dentro do processo (vira 503 ou backoff do consumidor).

**Por que lock pessimista na wallet, com versão esperada como verificação.** A unidade de concorrência é a wallet, e uma wallet disputada é o caso normal (várias apostas da mesma rodada chegando juntas).

| Estratégia | A favor | Contra | Uso |
|---|---|---|---|
| `SELECT … FOR UPDATE` na wallet | serializa por wallet sem tempestade de retries; a wallet disputada vira uma fila; as regras ficam no agregado | a espera ocupa uma conexão; exige `lock_timeout` | **base** |
| otimista com retry (`version`) | não espera | sob disputa gera retries em cascata, esgotamento e 503 | só como verificação: `UPDATE … WHERE version = :esperada` exigindo 1 linha |
| update atômico condicional | uma instrução | a regra vai para o SQL e não serializa as checagens de idempotência e de referência | não |
| SERIALIZABLE | simples de explicar | falhas de serialização sob disputa | não |
| advisory lock por hash da wallet | — | colisões serializam wallets sem relação | não |

**Por que READ COMMITTED.** Depois de esperar pelo lock, o PostgreSQL devolve a versão já atualizada da linha, e cada instrução seguinte enxerga o que foi confirmado antes dela, inclusive pela transação que segurava o lock. Em REPEATABLE READ, o mesmo cenário termina em `could not serialize access due to concurrent update`. A transação é curta, sem I/O externo, e abrange tudo o que precisa ser atômico: inbox, transação, saldo, lançamento e outbox.

**Ordem global de locks.** Em todas as rotas de escrita (HTTP, SQS, scheduler e falha de pendente), a wallet é travada antes de qualquer linha de transação, e cada unidade de trabalho trava uma única wallet. No SQS, a inbox vem antes da wallet, e nenhuma rota pega a wallet antes da inbox. Não há ciclo possível.

- **Replay** devolve status, `failureCode` e saldo gravados na primeira execução, mesmo que o saldo atual seja outro. Transação pendente devolve o estado atual.
- **Abertura de wallet:** saldo inicial maior que zero gera OPENING (provedor reservado `internal`), lançamento CREDIT na versão 1 e os eventos na mesma transação; saldo zero não gera nada além da wallet.

### Operações

| Tipo | Saldo | Ledger | Referência | Regras |
|---|---|---|---|---|
| BET | − valor | 1 DEBIT | proibida | saldo ≥ valor, senão `INSUFFICIENT_FUNDS` |
| WIN | + valor | 1 CREDIT | opcional (BET) | se vier, é validada como abaixo |
| LOSS | 0 | nenhum | opcional (BET) | valor ≥ 0 |
| REFUND | + valor | 1 CREDIT | obrigatória: BET | mesmo valor; referência PROCESSED; ainda não reembolsada |
| ROLLBACK | inverso da referência | 1 lançamento invertido | obrigatória: BET, WIN ou REFUND | idem; se o inverso for débito, saldo ≥ valor, senão `REVERSAL_INSUFFICIENT_FUNDS` |
| OPENING | + saldo inicial | 1 CREDIT | — | só interno (`POST /wallets`) |

BET, WIN, REFUND e ROLLBACK exigem valor maior que zero; LOSS aceita zero.

**Ordem fixa das validações:** wallet existe → o player é dono da wallet (`WALLET_PLAYER_MISMATCH`) → moeda (`CURRENCY_MISMATCH`) → referência: ausente (fica pendente), de outro provedor, player, wallet, rodada ou moeda (`REFERENCE_MISMATCH`), de tipo não permitido (`INVALID_REFERENCE_KIND`), com valor diferente (`REFERENCE_AMOUNT_MISMATCH`), ainda pendente (a dependente continua pendente), REJECTED ou FAILED (`REFERENCE_NOT_PROCESSED`), já revertida pelo mesmo tipo (`REFERENCE_ALREADY_REVERSED`) → saldo.

### Máquina de estados

```mermaid
stateDiagram-v2
  [*] --> PENDING: create (só em memória)
  PENDING --> PROCESSED: aplicada
  PENDING --> REJECTED: regra de negócio
  PENDING --> PENDING_REFERENCE: referência ausente ou pendente
  PENDING_REFERENCE --> PENDING_REFERENCE: nova tentativa agendada
  PENDING_REFERENCE --> PROCESSED: referência chegou
  PENDING_REFERENCE --> REJECTED: regra de negócio ou tentativas esgotadas
  PENDING_REFERENCE --> FAILED: erro não negocial repetido
  PROCESSED --> [*]
  REJECTED --> [*]
  FAILED --> [*]
```

Estados terminais são imutáveis no domínio (`InvalidTransactionStateError`) e no banco (trigger). Só o scheduler grava numa transação pendente.

### failureCodes

| Código | Quando | Status gravado | HTTP |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | REJECTED | 422 |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de crédito maior que o saldo | REJECTED | 422 |
| `CURRENCY_MISMATCH` | moeda da operação diferente da wallet | REJECTED | 422 |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é o dono da wallet | REJECTED | 422 |
| `REFERENCE_MISMATCH` | referência de outro provedor, player, wallet, rodada ou moeda | REJECTED | 422 |
| `INVALID_REFERENCE_KIND` | tipo de referência não permitido | REJECTED | 422 |
| `REFERENCE_AMOUNT_MISMATCH` | REFUND ou ROLLBACK com valor diferente da referência | REJECTED | 422 |
| `REFERENCE_NOT_PROCESSED` | referência REJECTED/FAILED, ou ainda pendente quando as tentativas acabam | REJECTED | 422 |
| `REFERENCE_ALREADY_REVERSED` | a referência já tem uma reversão PROCESSED do mesmo tipo | REJECTED | 422 |
| `REFERENCE_NOT_FOUND` | a referência não apareceu dentro das tentativas | REJECTED | 422 (replay) |
| `BALANCE_LIMIT_EXCEEDED` | crédito (WIN, REFUND ou ROLLBACK de débito) que levaria o saldo ao limite de armazenamento, 10^17 | REJECTED | 422 |
| `PROCESSING_FAILED` | o scheduler falhou repetidamente por erro que não é de negócio nem transitório | FAILED | 500 (replay) |

Nada disso cobre indisponibilidade (503, nada gravado) nem conflitos de chave (409 ou DLQ, nada gravado).

## API HTTP

| Endpoint | Sucesso | Erros |
|---|---|---|
| `POST /wallets` | 201 `{id, playerId, balance, version, createdAt}` | 400, 409 `WALLET_ALREADY_EXISTS` (com o `walletId` da wallet existente), 503 |
| `GET /wallets/:walletId` | 200 | 400, 404, 503 |
| `GET /wallets/:walletId/ledger?cursor&limit` | 200 `{items, nextCursor}`, do lançamento mais novo para o mais antigo; `limit` de 1 a 100 (padrão 50); cursor base64url amarrado à wallet | 400 (`INVALID_REQUEST`, `INVALID_CURSOR`), 404, 503 |
| `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 | 400, 404 `TRANSACTION_NOT_FOUND`, 503 |
| `POST /wagering/transactions` | 200 PROCESSED · 202 PENDING_REFERENCE (com `Location`) · 422 REJECTED · 500 FAILED, sempre com o `TransactionResult` | 400, 404, 409, 503 |
| `POST /wallets/:walletId/reconciliation` | 200, inclusive com `consistent: false` | 400, 404, 503 |
| `GET /wallets/:walletId/events` | 200 `text/event-stream` (ver [Tempo real](#tempo-real-sse)) | 400 (`Last-Event-ID` inválido ou à frente da wallet), 404, 503 `STREAM_CAPACITY_EXCEEDED` |
| `GET /metrics` | 200 | 401, 403 sem o papel `metrics-reader` |
| `GET /health/live` · `GET /health/ready` | 200, sem token | `ready`: 503 com o banco ou o SQS fora, e durante o shutdown |

Toda rota, menos as de health, responde 401 sem token válido e 403 quando o token não dá acesso (ver [Autenticação e autorização](#autenticação-e-autorização)); a tabela acima lista só os erros próprios de cada rota.

**Regra de corpo.** Se a transação foi persistida, o corpo é o `TransactionResult` `{transactionId, status, balance, failureCode?, idempotentReplay}`. Se nada foi persistido, o corpo é `application/problem+json` (RFC 9457) com `code` estável, `retryable` e `correlationId`:

| `code` | HTTP | `retryable` |
|---|---|---|
| `INVALID_PAYLOAD` (corpo), `INVALID_REQUEST` (caminho ou query), `INVALID_CURSOR`, `IDEMPOTENCY_KEY_REQUIRED`, `UNSUPPORTED_KIND`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `INVALID_AMOUNT` | 400 | não |
| `AUTHENTICATION_REQUIRED` (sem token Bearer), `INVALID_TOKEN` (com `WWW-Authenticate: Bearer realm="wagering"`, e `error="invalid_token"` no segundo) | 401 | não |
| `ACCESS_DENIED` | 403 | não |
| `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` | 404 | não |
| `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT` | 409 | não |
| `SERVICE_UNAVAILABLE` (com `Retry-After: 1`), `STREAM_CAPACITY_EXCEEDED` (com `Retry-After: 5`) | 503 | sim |
| `INTERNAL_ERROR` | 500 | sim (nada foi confirmado; reenviar com a mesma key é seguro) |

Um único filtro global aplica essa tabela em todos os endpoints. Erros de validação listam o caminho e a mensagem de cada campo, nunca o valor recebido. O 409 `WALLET_ALREADY_EXISTS` traz o membro de extensão `walletId`, com o id da wallet que já existe para aquele player e moeda, para o cliente repetir a criação com segurança.

- **Validação:** schemas Zod via Standard Schema, com objetos estritos (campo desconhecido → 400) e valores com exatamente duas casas e no máximo 17 dígitos inteiros.
- **Idempotência:** header `Idempotency-Key` obrigatório no `POST /wagering/transactions`.
- **Correlação:** `X-Correlation-Id` aceito quando tem de 1 a 128 caracteres ASCII visíveis, senão substituído por um UUIDv7; devolvido em toda resposta, gravado na transação e presente em todos os logs da requisição.

## Entrada por SQS

Fila `wager-transactions.fifo`, mensagem `WagerTransactionRequested` com o mesmo contrato Zod do HTTP em `data` (mais `idempotencyKey`). O `messageId` do envelope vira `correlationId` e `causationId` da transação.

**Fluxo por mensagem:** validar o envelope → calcular o hash da inbox e o de negócio → unidade de trabalho com inbox, idempotência, lock da wallet e escritas (§ Núcleo transacional) → **commit** → `DeleteMessage`. Qualquer rollback descarta a linha da inbox: uma mensagem nunca fica marcada como processada sem o efeito.

| Desfecho | Ação |
|---|---|
| PROCESSED, REJECTED, PENDING_REFERENCE, replay ou entrega duplicada | commit e ack |
| JSON ou schema inválido, OPENING, valor inválido | DLQ `INVALID_MESSAGE` |
| `messageId` reutilizado com outro conteúdo | DLQ `MESSAGE_ID_CONFLICT` |
| key ou `externalTransactionId` reutilizado com outro payload | DLQ `IDEMPOTENCY_KEY_CONFLICT` / `EXTERNAL_TRANSACTION_CONFLICT` |
| wallet inexistente | DLQ `WALLET_NOT_FOUND` |
| erro transitório ou inesperado | sem ack; `ChangeMessageVisibility` com backoff por `ApproximateReceiveCount` (2 s dobrando, teto de 120 s, jitter); na 8ª tentativa, DLQ `RETRIES_EXHAUSTED` |
| conexão com o PostgreSQL perdida | como transitório, e o consumidor pausa o `Receive` (circuit breaker com backoff) e devolve as mensagens ainda não iniciadas |

- **Lote e ordem:** até 10 mensagens por `Receive` (long polling de 20 s, cancelável). Mensagens do mesmo grupo são processadas em sequência; grupos diferentes, em paralelo, até `CONSUMER_MAX_CONCURRENT_GROUPS` (5). Se uma mensagem entra em backoff, as seguintes do mesmo grupo voltam para a fila com visibility 0, e o FIFO mantém a ordem.
- **Heartbeat:** a cada 10 s, `ChangeMessageVisibilityBatch` estende a visibilidade (30 s) de todas as mensagens retidas, em processamento ou esperando a vez. Se o processo morre, o heartbeat morre junto e as mensagens reaparecem.
- **DLQ manual:** envia para `wager-transactions-dlq.fifo` (retenção de 14 dias) com o corpo e o grupo originais, `MessageDeduplicationId` = MessageId do SQS e atributos `reason`, `originalMessageId`, `sqsMessageId`, `receiveCount`, `instanceId` e `deadLetteredAt`; **só depois do envio confirmado** apaga da origem. Se o envio falha, a mensagem fica na origem em backoff. A redrive policy com `maxReceiveCount` 10 é a rede de segurança contra crash em loop.
- **Contrato do produtor:** `MessageGroupId = walletId` e `MessageDeduplicationId = messageId`. É otimização: a correção não depende disso, e o teste C4 manda cada mensagem num grupo diferente de propósito.
- `bun run demo:send-message --wallet <id> --player <id>` publica uma mensagem de exemplo.
- **Reprocessar a DLQ:** `bun run dlq list` mostra as mensagens visíveis com o motivo, sem consumi-las. `bun run dlq redrive --reason RETRIES_EXHAUSTED` (ou `WALLET_NOT_FOUND`, quando a wallet passa a existir com aquele id, como numa importação que preserva os ids; `--limit`, `--dry-run`) devolve à fila de entrada o mesmo corpo, no mesmo grupo, com novo id de deduplicação e o atributo `redrivenFrom`, e só então apaga da DLQ. Conflitos e mensagens inválidas precisam de correção na própria mensagem e são recusados; mensagens movidas pela redrive policy chegam sem motivo e ficam onde estão. A ordem de cada wallet é preservada: se uma mensagem fica retida, as seguintes da mesma wallet também ficam. Reenviar é seguro porque a inbox deduplica pelo `messageId`.

## Saída: outbox e publisher

Os eventos são gravados na tabela `outbox_messages` **na mesma transação** do efeito financeiro, e um loop do worker os publica em `wagering-events.fifo`:

1. Na unidade de trabalho: `SELECT … WHERE published_at IS NULL AND next_attempt_at <= agora ORDER BY next_attempt_at, id LIMIT 10 FOR UPDATE SKIP LOCKED`. Vários publishers nunca pegam a mesma linha.
2. `SendMessageBatch` com `MessageGroupId` = `walletId` e `MessageDeduplicationId` = `eventId`, com timeout curto (`SQS_PUBLISH_TIMEOUT_MS`, 5 s) e poucas tentativas do SDK.
3. Resultado por entrada: sucesso → `published_at`; falha → nova tentativa com backoff (1 s dobrando, teto de 5 min, sem limite de tentativas); exceção ou timeout (resposta ambígua) → o lote inteiro é reagendado.
4. Commit.

Nenhum evento é publicado antes do commit da transação financeira (ele só existe na outbox depois do commit), e nenhum evento é descartado. Se o publisher cai entre o envio e o commit, o rollback devolve as linhas e outro publisher reenvia com o **mesmo `eventId`**: duplicata possível, perda impossível.

**Retenção.** Cada operação deixa 2 eventos na outbox e, se veio pela fila, 1 mensagem na inbox; sem limpeza, as duas tabelas crescem para sempre. Um loop do worker (`RETENTION_ENABLED`) apaga em lotes de `RETENTION_BATCH_SIZE` (1.000), cada um numa transação curta:
- os eventos **publicados** há mais de `OUTBOX_RETENTION_HOURS` (168 h);
- as mensagens **processadas** da inbox recebidas há mais de `INBOX_RETENTION_HOURS` (360 h; o mínimo aceito é 168).

Enquanto os lotes vêm cheios, o loop pausa `RETENTION_BATCH_PAUSE_MS` (250 ms) entre um e outro e continua do último registro apagado. Quando um lote vem incompleto, espera `RETENTION_INTERVAL_MS` (60 s) e recomeça do início. Pendentes e não processadas nunca são apagadas.
- **Ritmo:** cada tabela perde no máximo `RETENTION_BATCH_SIZE / (duração do lote + pausa)` linhas por segundo, cerca de 3.600 com os padrões. É três vezes o que 600 req/s criam. O teto vale por réplica do worker: com N workers, o expurgo e a carga que ele põe no banco se multiplicam por N. Numa frota grande, basta ligar `RETENTION_ENABLED` em uma ou duas réplicas. Sem a pausa, pôr em dia uma base nunca limpa (7,7 milhões de eventos vencidos) levou o p95 da API de 6–12 para 63–77 ms. Com 250 ms, ficou no ruído (ver LOAD-TEST.md).
- **Posição:** cada lote continua depois do último registro apagado: o id na outbox, e o `received_at` na inbox, inclusivo e truncado ao milissegundo para não pular ninguém. Recomeçar do início faria cada lote atravessar as entradas mortas dos anteriores até o autovacuum passar, o que só acontece com 20% da tabela morta. Num teste com 2 milhões de exclusões, o lote foi de 3,7 para 8,3 ms recomeçando do início e ficou em cerca de 3 ms com a posição. Um registro que fica elegível atrás da posição, como um evento publicado tarde ou uma linha travada por outra réplica, é apagado no ciclo seguinte.
- **Outbox sem índice novo:** os ids são UUIDv7 gerados pela aplicação no momento do evento, então "criado antes do corte" é uma faixa da chave primária (`id < UUIDv7 do instante de corte`). Um índice em `published_at` também resolveria, mas custaria uma escrita a mais em toda publicação.
- **Inbox com índice em `received_at`:** criado com `CREATE INDEX CONCURRENTLY` numa migration fora de transação, que não bloqueia escrita numa tabela grande.
- **Várias réplicas:** a subconsulta de cada lote usa `FOR UPDATE SKIP LOCKED`, e os workers apagam lotes disjuntos.
- **Por que é seguro:** o evento já foi entregue e o consumidor deduplica por `eventId`. A inbox só protege contra reentregas, que acontecem dentro da retenção da fila (4 dias por padrão). A proteção financeira continua na idempotency key e em `(provider, externalTransactionId)`, porque transações e lançamentos nunca são apagados.
- **Métricas:** `outbox_events_purged_total` e `inbox_messages_purged_total`.

## Eventos e garantias de ordem

| Evento | Quando | Grupo | `data` |
|---|---|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS e OPENING | `walletId` | identificadores da operação, `kind`, `money`, `referenceTransactionId`, `balanceAfter`, `processedAt` |
| `WagerTransactionRejected` | REJECTED, inclusive por tentativas esgotadas | `walletId` | identificadores, `kind`, `money`, `failureCode`, `balance` (inalterado) |
| `WalletBalanceChanged` | junto com cada lançamento no ledger | `walletId` | `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` |
| `WagerTransactionPendingReference` | na primeira vez que a transação fica pendente | `walletId` | identificadores, `kind`, `money`, `referenceExternalTransactionId`, `nextAttemptAt` |
| `WagerTransactionFailed` | quando uma pendente vira FAILED (`PROCESSING_FAILED`) | `walletId` | identificadores, `kind`, `money`, `failureCode`, `balance` (o observado ao gravar a transação) |

Envelope: `eventId` (UUIDv7), `eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version` (1). Replays e entregas duplicadas não geram eventos. Todo desfecho terminal é anunciado: PROCESSED, REJECTED e FAILED.

**Garantia de ordem:** entrega FIFO por wallet na ordem de *publicação*, que pode diferir da ordem de commit quando há vários publishers ou retries; sem ordem global; at-least-once. O consumidor de eventos deve deduplicar por `eventId` (a deduplicação do FIFO dura só 5 minutos) e usar `walletVersion` para detectar lacunas e reordenação em `WalletBalanceChanged`.

## Referências pendentes

Um REFUND, ROLLBACK (ou WIN/LOSS com referência) cuja referência ainda não existe, ou ainda está pendente, é gravado como `PENDING_REFERENCE` com o saldo observado e `next_reference_attempt_at`, e responde 202.

- **Seleção sem lock:** o scheduler do worker busca as pendentes vencidas pelo índice parcial de `next_reference_attempt_at`, em lotes de `REFERENCE_SCHEDULER_BATCH_SIZE`. É seguro porque `wallet_id` é imutável (trigger).
- **Processamento de cada candidata** (`ProcessPendingReference`): lock da wallet → lock da transação → revalidação de status, wallet e vencimento → mesma `SettlementPolicy` do caminho síncrono → commit. Não há `SKIP LOCKED` nas pendentes: travar a pendente antes da wallet inverteria a ordem global. Dois schedulers na mesma candidata se serializam no lock da wallet; o segundo encontra o estado já atualizado e não gera efeito nem evento.
- **Limites:** depois da primeira verificação (síncrona), o scheduler verifica de novo até `REFERENCE_MAX_ATTEMPTS` (10) vezes, com backoff de 2 s dobrando até 120 s e jitter (de 5 a 10 minutos no total, no padrão). Se a referência ainda faltar na última → REJECTED (`REFERENCE_NOT_FOUND`, ou `REFERENCE_NOT_PROCESSED` se ela existir mas continuar pendente) e `WagerTransactionRejected`.
- **Por que esses limites:** entregas fora de ordem vêm de redelivery e de publicação concorrente no provedor, e costumam se resolver em segundos ou poucos minutos. Cinco a dez minutos cobrem esse atraso com folga, sem deixar a operação pendente por tempo indefinido nem martelar o banco (o backoff exponencial espaça as verificações). Os valores são configuráveis, e os testes usam valores curtos.
- **Falhas:** erro transitório deixa a candidata para a próxima volta sem contar tentativa. Outro erro conta em memória, por transação; na terceira (`REFERENCE_MAX_PROCESSING_FAILURES`), `FailPendingTransaction` grava FAILED `PROCESSING_FAILED` e o evento `WagerTransactionFailed` na mesma transação (lock da wallet e depois da transação, saldo observado mantido).
- **Único escritor:** nenhuma outra rota grava numa pendente. Um replay apenas lê o estado atual.

## Reconciliação

`POST /wallets/:walletId/reconciliation` lê numa única instrução SQL (um snapshot) o saldo e a versão gravados, a soma dos créditos e dos débitos, o número de lançamentos, a primeira e a última versão do ledger e as quebras de cadeia. Uma quebra é um lançamento cujo `balance_before` difere do `balance_after` do anterior, ou cuja versão não é a anterior + 1. O cálculo do saldo usa o `Money`.

A resposta traz os seis campos do enunciado (`walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`) e mais dois:
- `chainBreaks`: quantas quebras de cadeia;
- `versionConsistent`: se a versão da wallet é a do último lançamento (ou 1 sem lançamentos) e se o primeiro lançamento é a versão 1 ou 2.

`consistent` é o veredito geral: saldo igual ao ledger, nenhuma quebra e versão coerente. Assim, uma cadeia quebrada nunca aparece como consistente só porque as somas fecham. Um ledger corrompido produz saldo calculado negativo com sinal (`-50.00`), não uma exceção. Divergências **não são corrigidas**: o endpoint só lê, conta `wallet_reconciliations_total{result}` e `wallet_reconciliation_divergences_total{kind}` (`balance`, `chain` ou `version`) e registra um log de erro por tipo, com `walletId` e contagens, nunca valores.

**Custo.** A leitura percorre o ledger inteiro da wallet pelo índice `(wallet_id, wallet_version)`, cerca de 0,6 s por milhão de lançamentos (medido numa wallet com 1.000.001 lançamentos, ver LOAD-TEST.md).
- **Limite atual:** com o `statement_timeout` de 10 s, cabem uns 10 milhões de lançamentos por wallet com os dados no cache. Numa base muito maior, com os lançamentos de uma wallet espalhados um por página, o custo passa a ser de leitura em disco.
- **Todas as wallets:** a CLI `bun run reconcile` percorre as wallets em páginas, por ordem de id, e roda a mesma reconciliação em cada uma, com concorrência limitada (`--concurrency`). Ela lista as divergentes sem valores, devolve a última wallet conferida para retomar com `--after` e sai com 1 quando acha divergência. Na base de 1 milhão de wallets do harness de carga, levou 164 s com 8 de cada vez.
- **Por que sem checkpoint:** wallets de jogador têm de dezenas a milhares de lançamentos. Uma conta de casa ou de bot com dezenas de milhões pediria checkpoints verificados: somas até uma versão, gravadas por uma reconciliação completa, com a conferência completa repetida periodicamente.

## Observabilidade

**Métricas** (`GET /metrics` na api e no worker, formato Prometheus, rótulos padrão `role` e `instance`; exige um token com o papel `metrics-reader`, que o Prometheus obtém sozinho com `oauth2` `client_credentials` no `scrape_config`). Os contadores são registrados depois do commit, então rollbacks e retries não os inflam. O profile `observability` do Compose sobe esse Prometheus (`observability/prometheus/prometheus.yml`, com `honor_labels` para manter os rótulos da aplicação) e um Grafana com o painel provisionado. Um teste confere que cada consulta do painel usa uma métrica exportada e que toda métrica exportada tem painel.

**Tracing (PoC).** Uma PoC de OpenTelemetry, na branch `poc/opentelemetry`, que não entra na `main`, confirmou que spans manuais funcionam no Bun.
- **Spans:** HTTP, caso de uso, unidade de trabalho, consumo e publicação SQS, com `traceparent` nos atributos das mensagens.
- **Custo:** de 3% a 5% da vazão de pico da api com 100% das requisições rastreadas.
- **Ausências:** a PoC não atravessa a outbox, o que pediria uma coluna para o `traceparent` do enqueue, nem guarda valores nos spans.

Os números e o que falta para adotar estão em LOAD-TEST.md.

| Métrica | Tipo | Rótulos |
|---|---|---|
| `wager_transactions_total` | contador | `kind`, `status`, `channel` (`http`, `sqs`, `worker`) |
| `idempotency_replays_total` · `idempotency_conflicts_total` | contador | `channel` · `channel`, `type` |
| `inbox_duplicates_total` | contador | — |
| `sqs_message_retries_total` · `sqs_messages_dead_lettered_total` | contador | `reason` |
| `db_transaction_retries_total` | contador | `sqlstate` (`23505`, `40P01`) |
| `outbox_publish_retries_total` · `pending_reference_retries_total` | contador | — |
| `wallet_lock_timeouts_total` · `db_deadlocks_total` · `wallet_version_conflicts_total` | contador | — (o último deve ficar em zero) |
| `wallet_reconciliations_total` · `wallet_reconciliation_divergences_total` | contador | `result` · `kind` (`balance`, `chain`, `version`) |
| `pending_reference_transactions` · `outbox_pending_events` · `outbox_oldest_pending_age_seconds` · `sqs_dlq_approximate_messages` | gauge, amostrado pelo worker a cada 5 s | — |
| `wallet_lock_wait_seconds` · `outbox_publish_delay_seconds` | histograma | — |
| `wager_processing_duration_seconds` | histograma | `channel`, `kind`, `outcome` |
| `http_request_duration_seconds` | histograma | `method`, `route`, `status` (os streams SSE ficam de fora: duram minutos e distorceriam a latência das requisições) |
| `wallet_event_streams` · `wallet_events_streamed_total` · `wallet_event_delivery_seconds` | gauge · contador · histograma | — (streams abertos na réplica, lançamentos entregues e tempo do lançamento até o stream) |
| `outbox_events_purged_total` · `inbox_messages_purged_total` | contador | — (linhas apagadas pela retenção) |

Famílias exigidas pelo enunciado: transações por status (`wager_transactions_total`), duplicatas detectadas (`idempotency_replays_total`, `inbox_duplicates_total`), retries (`sqs_message_retries_total`, `db_transaction_retries_total`, `outbox_publish_retries_total`, `pending_reference_retries_total`), mensagens em DLQ (`sqs_messages_dead_lettered_total`, `sqs_dlq_approximate_messages`), conflitos de lock (`wallet_lock_timeouts_total`, `wallet_lock_wait_seconds`, `db_deadlocks_total`, `wallet_version_conflicts_total`), outbox lag (`outbox_oldest_pending_age_seconds`, `outbox_pending_events`, `outbox_publish_delay_seconds`) e latência de processamento (`wager_processing_duration_seconds`, `http_request_duration_seconds`).

**Logs:** JSON (pino) com `role`, `instanceId`, e o contexto da requisição ou mensagem (`correlationId`; `messageId` e `sqsMessageId` nas entregas) propagado por `AsyncLocalStorage`. Os logs **nunca** levam valores, saldos, payloads nem `playerId`; o pino ainda censura esses campos como rede de segurança. Requisições HTTP são registradas com método, rota, status e duração, exceto `/health` e `/metrics`.

**Health:** `GET /health/live` responde se o processo está de pé. `GET /health/ready` checa PostgreSQL (`select 1`) e SQS (`GetQueueAttributes` na fila de entrada), com timeout de 1 s e cache de 2 s, e responde `{status, checks: {database, sqs}}`; durante o shutdown, `{status: 'shutting_down'}` com 503.

## Processos, desligamento e Compose

**Bootstrap.** Aplica as migrations pendentes, cria a DLQ (retenção de 14 dias), a fila de entrada (visibility de `SQS_VISIBILITY_TIMEOUT_SECONDS` e redrive para a DLQ com `maxReceiveCount` 10) e a fila de eventos, e registra `bootstrap complete`. Uma segunda execução não aplica nada e não muda nada.

**Compose.** `postgres`, `sqs` e `keycloak` com healthcheck (o do Keycloak, na porta de gerenciamento 9000). Antes do Keycloak, `keycloak-database` roda uma vez e cria o papel e o banco `keycloak` no PostgreSQL, se não existirem. `bootstrap` roda uma vez depois de `postgres` e `sqs`; `api` (porta 3000) e `worker` (sem porta publicada, escalável com `--scale worker=3`) esperam `service_completed_successfully` do bootstrap. Os três papéis usam a mesma imagem, com o processo iniciado direto pelo Bun (forma exec), usuário sem privilégio, `init: true`, `stop_grace_period: 30s` e healthcheck em `/health/ready`. O `INSTANCE_ID` padrão é `hostname-pid`, único por réplica.

**Hardening.** Todo serviço roda com:
- raiz somente leitura (`read_only`), com `tmpfs` só onde o processo precisa escrever;
- `cap_drop: ALL` e `no-new-privileges`. O PostgreSQL devolve só as cinco capabilities que o entrypoint usa para entregar os diretórios ao usuário `postgres`;
- limites de CPU e de memória;
- imagens fixadas por versão e digest, inclusive no `FROM` do `Dockerfile` e no da imagem do Keycloak.

O Bun roda sem cache de transpilação em disco (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`). O teste `test/integration/infra/compose-policy.test.ts` lê o `docker compose --profile observability config` e falha se algum serviço perder uma dessas propriedades. O override do harness de carga só aumenta os limites do PostgreSQL e do MiniStack.

**SIGTERM** (`enableShutdownHooks`):

1. readiness passa a responder 503 (`shutting_down`);
2. o consumidor aborta o long poll, termina as mensagens em andamento (o heartbeat continua só para elas) e devolve as não iniciadas com visibility 0; o publisher termina o lote atual (envio e commit); o scheduler termina a candidata atual;
3. os streams SSE são encerrados (o cliente reconecta em outra réplica com `Last-Event-ID`), e o servidor HTTP para de aceitar conexões e termina as requisições em andamento;
4. os clientes SQS são destruídos e o pool do PostgreSQL é fechado, o que também espera transações ativas;
5. `shutdown complete` no log; o Nest re-levanta o sinal e o processo sai com 143.

Num SIGKILL nada disso roda, e a correção vem do banco: a transação aberta sofre rollback quando a conexão cai, a mensagem sem ack reaparece depois da visibility, e o lote da outbox sem commit volta a ficar pendente.

**Dependência fora do ar:**

| Falha | api | consumidor | publisher | scheduler | ready |
|---|---|---|---|---|---|
| PostgreSQL fora | 503 | pausa o consumo; mensagens em voo entram em backoff | backoff | backoff | 503 |
| SQS fora | escritas continuam (a outbox acumula) | `Receive` com backoff | reagenda; o lag cresce | continua | 503 |

## Provas por teste

A suíte (`bun run test`, 1.081 testes, cerca de 2,7 minutos) roda contra PostgreSQL e MiniStack reais; a da versão avaliada (799 testes) passou 10 vezes seguidas sem falha. Cada suíte de integração e de concorrência usa um banco criado para ela e filas com prefixo único. **Todo teste que opera o sistema** — pelos casos de uso, pela API HTTP, pelo consumidor, pelo scheduler, pelo publisher ou por processos reais — termina com um verificador que confere, para cada wallet do banco: saldo = ledger, cadeia de lançamentos contínua, versão coerente, exatamente um lançamento por transação PROCESSED que move saldo (zero para REJECTED e LOSS) e nenhuma reversão duplicada do mesmo tipo. Só ficam de fora as wallets corrompidas de propósito pelos testes de reconciliação, excluídas pelo nome. Os testes de schema e de repositório montam linhas à mão para exercitar uma constraint ou uma primitiva por vez. Desde as constraint triggers saldo ⇔ ledger, essas linhas também formam estados coerentes no commit.

| Id | Cenário | Onde |
|---|---|---|
| C1 | a mesma BET 50 vezes em paralelo → 1 débito e 49 replays idênticos: em processo, via 3 processos da api e com 25 cópias via HTTP e 25 via SQS (grupos e ids de deduplicação distintos) em 3 api e 3 workers | `concurrency/in-process/same-bet-fifty-times`, `multi-process/http-instances`, `multi-process/mixed-load` |
| C2 | duas BETs de 80 contra 100, com reenvios, 25 rodadas → exatamente uma processada | `in-process/competing-bets`, `multi-process/http-instances` |
| C3 | wallets distintas em paralelo, e uma wallet travada não bloqueia outra | `in-process/distinct-wallets` |
| C4 | 3 processos `api` e 3 `worker`, carga mista HTTP e SQS, mensagens da mesma wallet em grupos distintos, reversões correndo com as BETs | `multi-process/mixed-load` |
| C5 | worker morto depois do commit e antes do ack → um único efeito | `multi-process/shutdown-matrix` |
| C6 | dois publishers em processos separados; SIGKILL entre envio e commit → só duplicatas com o mesmo `eventId` | `multi-process/outbox-publishers`, `multi-process/shutdown-matrix` |
| C7 | REFUND e ROLLBACK antes da referência, com e sem expiração, dois schedulers e operação concorrente → uma única transição | `in-process/pending-references`, `multi-process/reference-schedulers` |
| C8 · I10 | reinício total (SIGTERM e SIGKILL) no meio da carga, com pendentes e requisições sem resposta atravessando o reinício → nova geração drena tudo, replays devolvem o mesmo `transactionId` | `multi-process/restart` |
| C9 | reversões concorrentes do mesmo tipo → 1; REFUND e ROLLBACK da mesma BET → ambos; ROLLBACK de REFUND sem saldo → `REVERSAL_INSUFFICIENT_FUNDS` | `in-process/reversals` |
| I1 · I2 | migrations up → down → up; cada constraint e trigger violado com o SQLSTATE esperado | `integration/platform/database` |
| I3 · I4 · I11 | atomicidade com falha injetada, rollback sem evento, saldo inicial zero e positivo, aninhamento recusado | `integration/wallet/use-cases`, `integration/platform/database/unit-of-work` |
| I5 · I6 | inbox com duplicatas reais, conflito de `messageId`, retry com backoff e heartbeat, esgotamento, erro permanente, DLQ recusando o envio | `integration/wallet/messaging`, `integration/messaging/message-batch-consumer` |
| I7 | publishers concorrentes, lote com sucesso parcial e resposta ambígua | `integration/messaging/outbox-publisher` |
| I8 | SIGTERM termina o que está em andamento e devolve o resto | `multi-process/shutdown-matrix` |
| I9 | PostgreSQL cortado (proxy TCP) → readiness 503 e consumidor pausado, depois retomada | `multi-process/database-outage` |

**Matriz de shutdown** (`multi-process/shutdown-matrix`, processos reais; as pausas vêm de entrypoints de teste em `test/support/entrypoints` que sobrescrevem providers do Nest, e o teste envia o sinal de fora — o código de produção não tem ganchos de falha):

| Momento | SIGTERM | SIGKILL |
|---|---|---|
| mensagem recebida e não iniciada | termina as iniciadas e devolve as outras (I8) | reaparecem depois da visibility e são aplicadas uma vez |
| durante a transação | espera o commit e o ack | rollback total (nada de transação, inbox ou outbox); a reentrega aplica uma vez |
| depois do commit, antes do ack | termina o ack; nada é reentregue | reentrega com um único efeito (C5) |
| publisher entre envio e commit | faz o commit; cada evento publicado uma vez | só duplicatas com o mesmo `eventId` (C6) |

**Testes de mutação** (o código de produção foi quebrado de propósito e o teste certo ficou vermelho): tirar o lock da wallet derruba C2; tirar a rechecagem sob o lock derruba C1; tirar `enableShutdownHooks` derruba as quatro células SIGTERM e a variante SIGTERM do C8; rodar a unidade de trabalho fora de transação derruba as duas células "durante a transação"; confirmar a mensagem no recebimento derruba "SIGKILL antes de iniciar". O C4 só fica vermelho quando as três camadas contra lost update somem juntas (lock, versão esperada e `UNIQUE (wallet_id, wallet_version)`): com qualquer uma delas, o sistema continua correto.

## Garantia → mecanismo

| Garantia | Mecanismo principal | Reforço | Prova |
|---|---|---|---|
| sem débito ou crédito duplicado | idempotency key única + replay | `UNIQUE (provider_id, external_transaction_id)`, inbox, `UNIQUE (wallet_id, transaction_id)` no ledger | C1, C4, C5, I5 |
| saldo nunca negativo | `SettlementPolicy` sob lock | `CHECK` de sinal no saldo e no ledger | C2 |
| sem lost update | `SELECT … FOR UPDATE` na wallet | versão esperada no `UPDATE`; `UNIQUE (wallet_id, wallet_version)` | C2, C4 |
| ledger imutável e coerente | só `INSERT` | triggers de imutabilidade; constraint triggers de cadeia e de saldo; `CHECK` aritmético; FKs compostas de moeda | I2 |
| reversão uma vez por tipo | checagem sob lock | índice único parcial | C9 |
| evento só depois do commit e nunca perdido | outbox na mesma transação | publisher at-least-once com `eventId` estável | I4, I7, C6 |
| mensagem processada uma vez | inbox na mesma transação do efeito; ack depois do commit | idempotency key | I5, C5, matriz |
| várias instâncias corretas | coordenação só pelo banco | FIFO como otimização | C4, C8 |
| processo caindo no meio | atomicidade da transação | visibility + heartbeat; outbox sem commit volta a pendente | matriz, C8 |
| nenhum lock global | lock por wallet | uma wallet por unidade de trabalho | C3 |

## Autenticação e autorização

Entregue depois da versão avaliada do desafio (tag `desafio-v1`, que tinha só o ponto de extensão no-op). O IdP é o **Keycloak 26.8.0**, no Compose, com o realm `wagering` importado de [keycloak/wagering-realm.json](keycloak/wagering-realm.json). Todos os clientes são sistemas (provedores, back office, Prometheus), então todos usam `client_credentials`; o serviço não guarda usuário nem senha.

**Modo produção.**
- **Imagem e banco:** o Keycloak roda com `start --optimized`, numa imagem construída por [keycloak/Dockerfile](keycloak/Dockerfile) (`kc.sh build` com `KC_DB=postgres` e health), e guarda o realm no banco `keycloak` do PostgreSQL.
- **Credenciais:** as de administração e a do banco vêm de variáveis (`KEYCLOAK_ADMIN_USERNAME`, `KEYCLOAK_ADMIN_PASSWORD`, `KEYCLOAK_DB_PASSWORD`). Os padrões só servem para o ambiente local.
- **Escopo dos clientes:** nenhum cliente tem escopo total (`fullScopeAllowed: false`). O token de cada um leva só os papéis mapeados para ele: `operator` para `wagering-operator` e `metrics-reader` para `wagering-metrics`. Um teste confere o realm.
- **HTTP no ambiente local:** fora dele, o TLS termina num proxy ou no próprio Keycloak (`KC_HTTPS_*`), e `KC_HOSTNAME` passa a ser o endereço público.
- **Importação do realm:** acontece na primeira subida e não sobrescreve um realm existente. Depois de editar o JSON, a reimportação está no README.

**Contrato do token** (montado pelos mappers de cada cliente do realm):

| Claim | Valor |
|---|---|
| `iss` | `http://localhost:8080/realms/wagering` em qualquer endereço usado para pedir o token (`KC_HOSTNAME` fixo); a api busca as chaves pela rede interna, em `http://keycloak:8080` |
| `aud` | contém `wagering-api` (mapper de audiência) |
| `exp` | obrigatório; tokens de 5 minutos |
| `sub` | a conta de serviço do cliente |
| `provider_id` | só nos clientes de provedor (`provider-a`, `provider-b`), fixo por cliente |
| `roles` | papéis do realm: `operator` (back office) e `metrics-reader` (Prometheus) |

**Validação** (`JwtTokenVerifier`, com `jose`): assinatura RS256 pela chave do JWKS com o `kid` do token (outros algoritmos, inclusive `none` e HS256, são recusados); `iss` e `aud` conferidos; `exp` obrigatório e `nbf` respeitado, com tolerância de relógio de 5 s; `sub` obrigatório; `provider_id` e `roles` com tipo errado invalidam o token. Um token recusado vira 401 `INVALID_TOKEN`; a falta do header Bearer, 401 `AUTHENTICATION_REQUIRED`.

**JWKS.** As chaves ficam em cache por até 10 minutos. Um `kid` desconhecido dispara uma nova busca, no máximo uma a cada 30 s, o que cobre a rotação de chaves do Keycloak. Com o Keycloak fora do ar, os tokens seguem validados pelo cache. Se não há chave em cache, ou se o cache venceu e a busca falha, a resposta é **503 `SERVICE_UNAVAILABLE`, retryable, e não 401**: o problema é do IdP, e o cliente não deve descartar um token válido. O log da api registra `identity provider unavailable` com o motivo. Na prática, uma queda do Keycloak mais longa que a vida do token (5 minutos) já impede os clientes de obter tokens novos, então o cache cobre as quedas curtas. Fora do ambiente local, o JWKS precisa chegar por HTTPS ou por uma rede interna confiável: quem controla essa resposta controla quais tokens a api aceita.

**Autorização** (guard global com `@RequiresRole` e duas checagens nos controllers):

| Rota | Exige |
|---|---|
| `/health/live`, `/health/ready` | nada (o enunciado pede health aberto) |
| `/metrics` (api e worker) | papel `metrics-reader` |
| `POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/ledger`, `POST /wallets/:id/reconciliation` | papel `operator` |
| `POST /wagering/transactions` | `provider_id` do token igual ao `providerId` do corpo; o operador, que não é provedor, recebe 403 |
| `GET /wagering/transactions/:id` | ser o provedor da transação ou `operator`; para outro provedor a resposta é 404, como se ela não existisse |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `provider_id` igual ao do caminho, ou `operator` |

A autenticação roda antes de tudo: antes da validação do corpo, da `Idempotency-Key` e de qualquer acesso ao banco. A checagem do provedor vem depois da validação do corpo e antes do caso de uso, então uma operação negada não grava nada.

**Por que este modelo de autorização.** No modelo *seamless wallet*, a wallet é do jogador no operador, e os provedores (estúdios de jogos) debitam e creditam essa mesma wallet. Por isso qualquer provedor autenticado opera qualquer wallet, mas só em nome próprio: o `provider_id` do token precisa ser o `providerId` da operação, que também compõe a idempotência e a unicidade `(provider_id, external_transaction_id)`. Abrir wallets, ler saldo e ledger e reconciliar são funções do operador; o provedor recebe o saldo na resposta de cada transação. O schema não tem vínculo provedor ⇔ wallet; criá-lo seria o próximo passo se o produto quiser restringir quais provedores atendem quais jogadores.

**Fila.** Continua um canal interno confiável, como pede o enunciado: quem publica em `wager-transactions.fifo` é controlado pela IAM da AWS, não por token, e o `providerId` da mensagem segue sujeito às validações de domínio.

**Testes.** A suíte principal assina tokens com uma chave RSA gerada no próprio processo e serve o JWKS num servidor local ([test/support/identity.ts](test/support/identity.ts)), então não depende do Keycloak.

- **Verificador:** token válido de provedor e de operador; audiência em lista; expiração dentro da tolerância; 15 formas de token inválido (expirado, `nbf` no futuro, outro emissor, outra audiência, sem `exp`, sem `sub`, chave desconhecida, assinatura forjada sob um `kid` conhecido, `none`, HS256, malformado, `provider_id` e `roles` com tipo errado); rotação de chave; JWKS fora do ar com e sem cache; timeout.
- **Matriz 401:** toda rota protegida sem token e com token expirado; outro esquema; credencial malformada; autenticação antes da validação; nada gravado.
- **Matriz 403:** provedor nas rotas de operador; provedor agindo por outro, sem gravar nada; operador enviando transação; transação de outro provedor como 404; métricas só com `metrics-reader`.
- **Realm real:** `bun run test:e2e` confere com tokens emitidos pelo Keycloak (precisa de `docker compose up -d --wait keycloak`): operador abre wallet e provedor aposta; `provider_id` amarrado ao cliente; métricas só para o scraper; token adulterado recusado.

**Custo medido:** cerca de 40 µs de CPU por requisição na api, ou 3 a 5% da vazão de um processo saturado (A/B em [LOAD-TEST.md](LOAD-TEST.md#custo-da-autenticação)); a latência fora da saturação não muda.

**Fora desta etapa:** o painel futuro usaria Authorization Code com PKCE e cliente público, com papéis de operação e auditoria separados dos provedores; mTLS entre serviços; escopo da idempotência por provedor (adiado no plano; como a `Idempotency-Key` é global, um provedor consegue saber, pelo 409 `IDEMPOTENCY_KEY_CONFLICT`, que uma key já foi usada por outro, sem ver o resultado nem reaproveitá-lo, porque o corpo dele leva o próprio `providerId`); revogação imediata (o token vale 5 minutos; revogar uma chave é removê-la do JWKS, e o cache a abandona em até 10 minutos).

## Tempo real (SSE)

`GET /wallets/:walletId/events`, com o papel `operator` (como as demais leituras de wallet), entrega o saldo e os lançamentos de uma wallet em tempo real, por Server-Sent Events. É um canal de leitura para o painel: a fonte da verdade continua sendo o banco, e os eventos de integração continuam saindo pela outbox.

**Eventos.** Uma assinatura nova recebe primeiro `wallet`, com o estado atual, e depois um `ledger-entry` por lançamento (com o `walletId`), venha a operação da api, do worker ou do scheduler, de qualquer réplica. O `id` de todo evento é a `walletVersion`. Um comentário `keep-alive` sai a cada 15 s e `retry: 3000` orienta a reconexão.

**Sem lacuna e sem repetição.** A versão da wallet só sobe junto com um lançamento (a cadeia contínua é conferida pelo verificador de invariantes), e o lock da linha faz a versão v+1 ficar visível só depois da v. O stream lê o ledger em ordem, a partir do cursor de cada cliente. Ao reconectar com `Last-Event-ID`, o cliente recebe os lançamentos seguintes, relidos do ledger, que é imutável. Um `Last-Event-ID` inválido ou à frente da wallet responde 400.

**Entrega entre réplicas.** Cada réplica da api guarda as assinaturas dos próprios clientes. A cada `STREAM_SWEEP_INTERVAL_MS` (500 ms), ela faz duas consultas:
- as versões das wallets assinadas;
- os lançamentos de todas as que mudaram, depois do cursor de cada uma, numa única leitura sobre o índice único `(wallet_id, wallet_version)`, com até 1.000 lançamentos; o resto fica para a varredura seguinte.

A latência de entrega fica limitada pelo intervalo da varredura, e o custo cresce com o número de wallets assistidas, não com o volume de escrita. Com 3 réplicas, 300 operações/s e 100 streams, a entrega ficou em p50 de 255 ms e p99 de 500 ms. O p95 e o p99 das requisições HTTP ficaram iguais aos da mesma carga sem streams, e o p50 subiu cerca de 0,3 ms ([LOAD-TEST.md](LOAD-TEST.md#streams-de-tempo-real-etapa-3)). Uma primeira versão, com uma leitura por wallet que mudou, subia o p99 HTTP em cerca de 1 ms e foi trocada pela leitura única.

**Por que não `LISTEN/NOTIFY`.** O plano recomendava o NOTIFY do PostgreSQL como campainha depois do commit. Uma PoC (trigger `AFTER INSERT` no ledger chamando `pg_notify`) foi medida no harness de carga contra a mesma versão sem ela, em três rodadas alternadas. Com 1 api, a vazão de pico caiu 3,6%, com faixas sobrepostas. Com 3 apis e 3 workers, caiu **12,7%**, sem sobreposição, e o p99 com 64 clientes subiu de 74 para 91 ms. O PostgreSQL serializa o commit das transações que fizeram NOTIFY num lock do banco inteiro, então o custo cresce com os commits concorrentes e seria pago por toda transação financeira, haja ou não alguém assistindo. A varredura não toca o caminho de escrita. O hub mantém `wake(walletId)`, de modo que uma campainha fora da transação financeira pode ser somada depois sem mudar a entrega, se a latência da varredura não bastar.

**Cliente lento.** Nada se acumula em memória. Quando o socket deixa de aceitar dados, o stream daquele cliente pausa; no `drain`, retoma do próprio cursor, relendo do banco.

**Fim do stream.** O stream termina:
- quando o token vence, e o cliente reconecta com outro token e o `Last-Event-ID`;
- quando o cliente desconecta;
- no SIGTERM, antes de o servidor HTTP fechar, para não segurar o processo.

Cada réplica aceita até `STREAM_MAX_STREAMS` (1000) streams; acima disso responde 503 `STREAM_CAPACITY_EXCEEDED`, com `Retry-After: 5`. No Bun, a resposta HTTP não emite `close` quando o cliente desconecta, mas o socket emite; por isso o stream observa o `close` do socket.

**Navegador.** O `EventSource` não envia o header `Authorization`; o painel lê o stream com `fetch` e `ReadableStream`.

**Testes.**
- **Hub:** snapshot, replay a partir do `Last-Event-ID`, `Last-Event-ID` à frente, wallet inexistente, capacidade, entrega única e em ordem para vários assinantes, isolamento entre wallets, pausa e retomada no cliente lento, varredura, `keep-alive`, expiração do token, desconexão, desligamento, wake-ups sobrepostos, recuperação depois de leitura com falha e métricas.
- **HTTP:** cabeçalhos e eventos, replay, continuação ao vivo sem lacuna, 401, 403, 404, 400, expiração do token fora do histograma, gauge de streams, capacidade e desligamento.
- **Processos reais:** assinante numa api, escritas pela outra api e pela fila em paralelo, com as 40 versões chegando em ordem e sem lacuna; retomada em outra réplica pelo `Last-Event-ID`; SIGTERM saindo com 143 sem esperar os clientes. Sem a varredura, os dois primeiros ficam vermelhos.

## Interpretações do enunciado

- **Reversões — regra literal do §7.4:** no máximo uma reversão PROCESSED por referência **e por tipo**. Consequência: um REFUND e um ROLLBACK da mesma BET são ambos aceitos e devolvem o valor da aposta duas vezes. Não é tratado como contradição com "não duplicar créditos": esse invariante trata da mesma operação aplicada mais de uma vez, e REFUND e ROLLBACK são operações distintas, cada uma aplicada uma única vez. O efeito econômico está coberto pelo C9.
- **WIN e LOSS** aceitam referência opcional (BET), validada se vier; se ainda não existir, ficam pendentes.
- **Replay:** de transação terminal, resposta idêntica à original (status HTTP, corpo e saldo daquele momento); de transação pendente, o estado atual (202 enquanto pendente, depois a resposta terminal com `idempotentReplay: true`). A mesma operação nunca é reprocessada.
- **Três situações diferentes:** `FAILED` só para transação já persistida cujo processamento assíncrono falha repetidamente por erro que não é de negócio nem transitório; indisponibilidade de banco ou fila vira 503 ou backoff, sem gravar nada; mensagem inválida ou conflitante vai para a DLQ, sem virar transação.
- **`PENDING`** só existe em memória; **`WALLET_NOT_FOUND`** não é persistido (não há wallet para a FK); **OPENING** usa o provedor reservado `internal`.
- **Escala fixa de 2 casas** vale também na entrada: `10.5` e `10.005` são recusados, nunca arredondados.

## Opcionais (Etapa 13)

| Item | Decisão |
|---|---|
| Evento `WagerTransactionFailed` | **entregue**: todo desfecho terminal assíncrono é anunciado |
| 409 de wallet duplicada com o `walletId` existente | **entregue**: o cliente pode repetir a criação com segurança |
| Triggers de reforço saldo ⇔ ledger | **entregue na Etapa 4**, depois da versão avaliada, com os fixtures de schema e de repositório refeitos para gravar estados coerentes (ver "Saldo ⇔ ledger no banco"). Na versão avaliada, o "saldo = ledger" tinha três camadas (lock, versão esperada, `UNIQUE (wallet_id, wallet_version)`), conferidas depois de todo teste |
| Teste de carga | fora da versão avaliada; entregue depois, em [LOAD-TEST.md](LOAD-TEST.md) |
| IdP | fora da versão avaliada; entregue depois com Keycloak (ver [Autenticação e autorização](#autenticação-e-autorização)) |
| Double-entry, OpenTelemetry, dashboard | **não**, decididos no plano |

## Trade-offs e limitações

- **Transação aberta durante o envio ao SQS** no publisher: mantém o modelo `OutboxMessage` simples e o claim seguro com `SKIP LOCKED`, ao custo de segurar as linhas da outbox (nunca a wallet) por até `SQS_PUBLISH_TIMEOUT_MS`.
- **Contador de falhas do scheduler em memória:** com N instâncias, chegar a FAILED pode levar até N vezes mais tentativas (`REFERENCE_MAX_PROCESSING_FAILURES`, 3 por padrão, vale por instância), e um restart zera a contagem. Só afeta o caminho de erro não negocial. Decidido na Etapa 4 (N3): fica em memória. O total continua limitado, nenhuma medição passou por esse caminho, e persistir a contagem pediria uma coluna e uma escrita a mais a cada falha.
- **Realm importado só na primeira subida:** com o banco persistente, o Keycloak não reaplica o `wagering-realm.json` a cada subida, como fazia o `start-dev`. Editar o JSON pede a reimportação descrita no README.
- **Ordem dos eventos** é a de publicação, não a de commit; o consumidor usa `eventId` e `walletVersion`.
- **Uma wallet muito disputada** serializa no lock da linha: a vazão por wallet é limitada pela duração da transação (curta, sem I/O externo); `lock_timeout` de 3 s vira 503 ou backoff.
- **Várias instâncias da api** são demonstradas pelo harness de testes (portas distintas); o Compose não tem load balancer.
- **Tempo real por varredura:** a entrega pelo stream leva até o intervalo da varredura (500 ms por padrão; configurável). É o preço de não tocar o caminho de escrita, e o desenho do hub aceita um aviso de baixa latência se for preciso.
- **Disponibilidade amarrada ao Keycloak:** sem ele, nenhum cliente obtém token novo; a api segue validando pelo cache de chaves só enquanto os tokens já emitidos valem.
- **Bootstrap e mudança de atributos de fila:** `CreateQueue` com atributos diferentes dos existentes é recusado pela AWS; mudar a visibility de uma fila já criada exige `SetQueueAttributes` manual.

## Peculiaridades do ambiente

- **Bun SQL** (usado só nos testes) devolve o NUMERIC zero como `"0"` em consultas parametrizadas; os testes leem valores monetários com `::text`. O MikroORM (driver `pg`) devolve `"0.00"`.
- **`toMatchObject` do Bun 1.3.14** com matchers assimétricos troca os valores do objeto recebido pelos matchers; os testes não reutilizam valores conferidos dessa forma.
- **`pg`** informa conexão perdida como `Error('Connection terminated unexpectedly')`, sem código; a classificação de falhas reconhece essas mensagens.
- **AWS SDK:** `requestTimeout` só emite aviso sem `throwOnRequestTimeout: true`; os clientes ligam essa opção para o timeout de leitura valer.
- **MiniStack:** ver a divergência de MD5 descrita no spike.
