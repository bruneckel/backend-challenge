# Arquitetura — Wagering Processor

Documento vivo: cresce a cada etapa da implementação. Esta versão registra o resultado da Etapa 0 (base do projeto e spike de compatibilidade), que fixou as versões da stack a partir de testes reais, não de suposições.

## Matriz de versões validada

| Componente | Versão | Como foi validada |
|---|---|---|
| Bun (runtime, gerenciador de pacotes, test runner) | 1.3.14, local e imagem `oven/bun:1.3.14-alpine` | toda a suíte do spike roda com `bun test` |
| TypeScript (só checagem de tipos) | 6.0.3 | `tsc --noEmit` limpo |
| NestJS | 12.1.2 (`common`, `core`, `platform-express`, `testing`) | injeção de dependências por metadados de decorators e validação com Standard Schema |
| Zod | 4.6.5 | `@Body({ schema })` com `StandardSchemaValidationPipe` |
| MikroORM | 7.2.3 (`core`, `postgresql`, `migrations`); `@mikro-orm/nestjs` 7.1.0 | migrations, locks e códigos de erro contra PostgreSQL real |
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

## Decisões em aberto

- **README do enunciado.** O `README.md` atual é o enunciado do desafio. Até a decisão sobre renomeá-lo para `CHALLENGE.md` ou mover a solução para uma subpasta, ele não é alterado, e o código fica na raiz do repositório.
