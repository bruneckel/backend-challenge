# Teste de carga

Harness reproduzível para medir vazão, latência, contenção e consistência do Wagering Processor sob carga. Não existe meta de RPS: os números valem para o ambiente descrito em cada relatório e servem de baseline para comparar mudanças.

## Como rodar

Pré-requisitos: Docker e Bun 1.3.14, com as dependências instaladas (`bun install`). Nada depende do Compose de desenvolvimento — o harness sobe a própria infraestrutura.

```bash
bun run test:load --preset smoke      # 6 cenários curtos, valida o harness (~1 min)
bun run test:load --preset baseline   # a matriz de referência (~15 min)
bun run test:load --preset baseline --only http-saturation-1x1,sqs-backlog-1x3
bun run test:load --profile sustained --channel mixed --api 3 --workers 3 --rate 400 --duration 60
```

O relatório (`report.md`), os dados brutos (`results.json`) e os logs de cada processo ficam em `load-results/<data>/`, ignorado pelo git. O comando termina com código 1 se algum cenário deixar wallet inconsistente ou não drenar.

| Opção | Padrão | Significado |
|---|---|---|
| `--preset` | — | `smoke` ou `baseline`; as demais opções sobrescrevem todos os cenários do preset |
| `--only` | — | roda só os cenários listados (separados por vírgula) |
| `--profile` | `sustained` | `sustained`, `spike`, `saturation`, `backlog` ou `recovery` |
| `--channel` | `http` | `http`, `sqs` ou `mixed` |
| `--api`, `--workers` | 1, 1 | processos `api` e `worker` |
| `--wallets` | 200 | wallets independentes (mais 1 wallet quente) |
| `--hot-share` | 0 | fração das operações na wallet quente |
| `--sqs-share` | 0.5 | fração enviada pela fila no canal `mixed` |
| `--replay-share` | 0 | fração de reenvios de operações já feitas (replays) |
| `--rate`, `--spike-rate` | 50, 150 | operações por segundo (malha aberta) |
| `--warmup`, `--duration` | 5, 30 | segundos de aquecimento (não medido) e de medição |
| `--steps`, `--step-seconds` | 4,8,16,32,64 · 15 | concorrência de cada degrau da saturação |
| `--backlog` | 2000 | mensagens enfileiradas antes de subir os workers |
| `--outage` | 10 | segundos com o PostgreSQL pausado no perfil de recuperação |
| `--timeout-ms`, `--max-in-flight` | 10000, 2000 | timeout por requisição e limite de requisições em voo |
| `--max-error-rate`, `--max-p99-ms` | 0.05, 5000 | interrompe a saturação quando um degrau passa desses limites |
| `--log-level`, `--pool` | `info`, 10 | nível de log e pool de conexões dos processos |
| `--keep-infra`, `--keep-data` | — | mantém a infraestrutura e os bancos/filas para inspeção |

## Isolamento

- **Infraestrutura própria:** projeto Compose `wagering-load`, com PostgreSQL na porta 25432 e MiniStack na 24566 (`test/load/compose.load.yml`). Ela é removida no fim (`down -v`), salvo com `--keep-infra`. Nada toca o banco nem as filas de desenvolvimento ou dos testes.
- **Estado novo por cenário:** um banco `load_<id>` migrado do zero e três filas FIFO com prefixo próprio.
- **Processos reais:** `api` e `worker` são iniciados pelo Bun, como em produção. Cada um tem porta própria e grava o log em arquivo, para não sobrecarregar o gerador.
- **Dados sintéticos:** as wallets são abertas pela API (saldo inicial 1.000.000,00). As operações são BET e WIN de 1,00, sorteadas meio a meio, para o saldo não acabar; usam `operationFor`, o mesmo construtor dos testes.

## Perfis

| Perfil | O que mede | Como |
|---|---|---|
| `sustained` | latência e lag numa taxa fixa | malha aberta: as chegadas seguem o relógio, não a resposta anterior |
| `spike` | reação a um degrau de carga | taxa base, pico e base de novo, em terços da duração |
| `saturation` | capacidade e o ponto em que a latência dispara | malha fechada: N clientes concorrentes por degrau |
| `backlog` | vazão máxima do consumidor SQS | enfileira N mensagens, sobe os workers e mede a drenagem |
| `recovery` | comportamento com o PostgreSQL fora | `docker pause` no PostgreSQL do projeto de carga durante a medição |

## O que é medido

- **Cliente:** vazão de sucessos por segundo e latência (média, p50, p90, p95, p99, máximo) das requisições bem-sucedidas (`ok`, `replay`, `rejected`). Erros, timeouts e descartes por limite de requisições em voo são contados à parte.
  - Na malha aberta, a latência é contada a partir do instante **planejado** de envio. Um gerador atrasado aparece como latência, e não some da medida (*coordinated omission*).
- **SQS:** latência do envio até `inbox_messages.processed_at`. Não inclui o commit nem o ack. No `backlog`, a vazão é a drenagem entre a primeira e a última mensagem processada.
- **Servidor:** diferença entre a métrica Prometheus raspada antes e depois da medição, somada entre as instâncias:
  - transações por canal e status, replays, conflitos, duplicatas na inbox;
  - retries de transação, timeouts de lock, conflitos de versão;
  - retries SQS e mensagens na DLQ;
  - quantis de espera pelo lock da wallet, de processamento por canal e de atraso de publicação da outbox (interpolados nos buckets, como o `histogram_quantile`).
- **Amostras a cada segundo:** maior idade pendente e maior fila da outbox (gauges do worker) e o máximo de conexões ao banco do cenário (`pg_stat_activity`).
- **Consistência, depois da drenagem:** o verificador dos testes (`inconsistentWallets`) roda sobre **todas** as wallets do banco, e o cenário confere ainda DLQ vazia, outbox publicada e nenhuma referência pendente.
- **Gerador:** CPU consumida pelo processo do harness. Perto de 100% de um núcleo, o próprio gerador é o gargalo e a medida deixa de valer.

## Método

1. As saturações vêm primeiro: com 1 e 3 instâncias e com uma única wallet quente, elas mostram onde a vazão para de crescer e a latência dispara.
2. As taxas dos perfis sustentado, de pico e de recuperação são escolhidas como frações dessa capacidade medida, e não como metas.
3. Cada comparação (por exemplo, uma PoC contra o baseline) usa o mesmo cenário, na mesma máquina, com o mesmo commit de referência para todo o resto.

## Limitações

- Gerador, aplicação e infraestrutura dividem a mesma máquina. No macOS, PostgreSQL e MiniStack rodam na VM do Docker, e a aplicação roda nativa.
- O MiniStack não é o SQS real: latência e limites de API da AWS são outros.
- Os logs em nível `info` são escritos em arquivo local; com coletor remoto, o custo seria outro.
- Uma rodada é uma amostra. Comparações justas usam várias execuções de cada lado.
