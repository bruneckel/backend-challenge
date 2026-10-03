# Teste de carga

Harness reproduzível para medir vazão, latência, contenção e consistência do Wagering Processor sob carga. Não existe meta de RPS: os números valem para o ambiente descrito em cada relatório e servem de baseline para comparar mudanças.

## Como rodar

Pré-requisitos: Docker e Bun 1.3.14, com as dependências instaladas (`bun install`). Nada depende do Compose de desenvolvimento — o harness sobe a própria infraestrutura.

```bash
bun run test:load --preset smoke      # 6 cenários curtos, valida o harness (~1 min)
bun run test:load --preset baseline   # a matriz de referência (~40 min, a maior parte drenando as saturações)
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

## Achados e decisões

Medições de 2026-10-02/03 numa única máquina (Apple M4 Pro, 12 núcleos, 24 GB; Docker com 12 CPUs e 7,7 GB). Os números do baseline estão na seção seguinte.

### Onde está o limite

| Caminho | Limite observado | Evidência |
|---|---|---|
| HTTP, 1 instância | o processo da api, por CPU | na saturação, a api fica em 100–116% de CPU (o Bun executa o JavaScript num núcleo) e o PostgreSQL em ~135% de 12 núcleos; a vazão para de crescer em ~1.440 req/s a partir de 16 clientes, e mais concorrência só aumenta a latência |
| HTTP, 3 instâncias | a máquina compartilhada | 3 apis, 3 workers, gerador, PostgreSQL e MiniStack dividem os mesmos 12 núcleos; a vazão sobe para ~1.790 req/s com 32 clientes (e cai para ~1.580 com 64 e 128), não o triplo |
| Wallet quente | o lock da linha da wallet, como projetado | 340–370 operações/s em qualquer concorrência a partir de 2 clientes, ou cerca de 3 ms de lock por operação; a espera pelo lock cresce com a concorrência (p99 de 98 ms na saturação, com até 32 clientes) e nenhuma operação falha |
| SQS (consumidor, publisher e leitura de eventos) | o MiniStack | um único núcleo a ~100% durante a carga mista, com o PostgreSQL a 35–53%; cada chamada fica mais lenta com o tamanho da fila (`ReceiveMessage` + `DeleteMessageBatch`: 2 ms com mil mensagens, 28 ms com 30 mil; `SendMessageBatch`: 1,6 ms com 500, 31 ms com 40 mil) |

Consequências:
- **Números de SQS medem o emulador**, não o sistema. Servem para comparar versões no mesmo ambiente, não para estimar capacidade com o SQS real.
- **O harness consome a fila de eventos** durante todo o cenário, como faria o consumidor downstream. Sem isso, a fila `wagering-events.fifo` cresce sem limite no emulador e o publisher parece um gargalo que não existe. As primeiras medições caíram nesse artefato e foram descartadas.
- **A outbox publica menos do que a escrita produz.** Cada operação gera 2 eventos. Com o lote gravado num único `UPDATE` (abaixo), um worker publica ~1.560 eventos/s (cerca de 780 operações/s) e 3 workers, ~2.700 eventos/s, porque o claim com `SKIP LOCKED` escala. Já 1 api escreve ~1.440 operações/s. Em saturação sustentada, a outbox acumula e drena depois: os eventos atrasam, mas nenhum se perde (todo cenário fecha com eventos entregues mais eventos ainda na fila iguais às linhas da outbox).
- **Drenagens longas ficam lentas.** Depois das saturações, com ~200 mil eventos pendentes, o publisher entregou só ~185 eventos/s. Uma causa está comprovada: cada linha publicada deixa uma entrada morta no início do índice parcial `published_at IS NULL` até o vacuum passar, e cada claim atravessa essas entradas. Num banco descartável, o claim foi de 0,05 ms para 4,6 ms com 180 mil publicadas sem vacuum, e voltou a 0,08 ms depois de um `VACUUM`. Ela não explica sozinha a queda de ~8×; as contagens da outbox que cada worker faz a cada segundo para as métricas também pesam.

### Experimentos na outbox

| Alternativa | Medição | Decisão |
|---|---|---|
| Gravar o desfecho do lote num único `UPDATE … FROM (VALUES …)`, em vez de um `UPDATE` por mensagem | A/B no perfil `publish` (1 worker, 6.000 operações, 12.402 eventos), três rodadas alternadas: **932 → 1.133 eventos/s em média (+21%)**; o pior resultado da mudança (1.094) supera o melhor do baseline (953); 12.402 de 12.402 eventos entregues em todas as execuções | **adotada** (`perf: save each outbox batch in one statement`), com a suíte 852/852 |
| Índice `(next_attempt_at, id)` para o claim | `EXPLAIN (ANALYZE, BUFFERS)` num banco descartável com 40 mil pendentes: 0,5 ms → 0,06 ms por claim. O PostgreSQL já usa *Incremental Sort* sobre o índice atual, então o ganho é de cerca de 5% de um lote | adiada: mudança de schema por ganho pequeno |
| Claim com lease, sem transação aberta durante o envio ao SQS | com o emulador local, o envio custa 2–3 ms por lote, então o benefício não aparece neste ambiente | adiada até haver latência real de SQS para medir |
| Lote de operações financeiras de várias wallets numa transação | — | descartada: acoplaria falhas e exigiria ordenar locks entre wallets |
| Autovacuum ajustado só para `outbox_messages` e retenção das publicadas | causa confirmada acima; o efeito na drenagem ainda não foi medido | a medir na Etapa 4 (A/B da drenagem após saturação) |

## Baseline

Execução `bun run test:load --preset baseline` de 2026-10-03, no commit `f3c7602` (com a gravação do lote da outbox num único `UPDATE`). Os dados completos ficam no relatório gerado. Latências em ms; vazão em operações bem-sucedidas por segundo. Em saturação, a linha mostra o degrau de maior vazão; em SQS, a latência vai do envio ao processamento.

| Cenário | Perfil | api/worker | Wallets (quente) | Vazão/s | p50 | p95 | p99 | Erros | Consistência |
|---|---|---|---|---|---|---|---|---|---|
| http-saturation-1x1 | saturação, c=16 | 1/1 | 200 (0%) | 1.440 | 10,9 | 14,9 | 19,3 | 0 | 0 violações; outbox drenando após 5 min |
| http-saturation-3x3 | saturação, c=32 | 3/3 | 200 (0%) | 1.793 | 16,8 | 26,2 | 33,2 | 0 | 0 violações; outbox drenando após 5 min |
| http-hot-saturation-3x3 | saturação, c=2 | 3/3 | 200 (100%) | 372 | 5,2 | 6,8 | 8,0 | 0 | ok |
| sqs-backlog-1x1 | backlog, 1.000 mensagens | 1/1 | 200 (0%) | 459 | — | — | — | 0 | ok |
| sqs-backlog-1x3 | backlog, 1.000 mensagens | 1/3 | 200 (0%) | 505 | — | — | — | 0 | ok |
| sqs-hot-backlog-1x3 | backlog, 500 mensagens | 1/3 | 200 (100%) | 141 | — | — | — | 0 | ok |
| outbox-publish-1x1 | publish, 3.000 operações | 1/1 | 200 (0%) | 1.559 eventos | — | — | — | 0 | ok |
| outbox-publish-1x3 | publish, 3.000 operações | 1/3 | 200 (0%) | 2.702 eventos | — | — | — | 0 | ok |
| mixed-sustained-3x3 (HTTP) | sustentado, 300/s, 5% replays | 3/3 | 200 (20%) | 150 | 5,1 | 7,3 | 10,3 | 0 | ok |
| mixed-sustained-3x3 (SQS) | sustentado | 3/3 | 200 (20%) | 150 | 2.237 | 38.567 | 44.867 | 0 | ok |
| http-spike-3x3 | pico, 300 → 900 → 300/s | 3/3 | 200 (0%) | 500 | 5,3 | 22,2 | 56,0 | 0 | ok |
| mixed-recovery-3x3 (HTTP) | PostgreSQL pausado 10 s, 200/s | 3/3 | 200 (0%) | 100 | 5,5 | 7.267 | 9.444 | 15 timeouts | ok |
| mixed-recovery-3x3 (SQS) | PostgreSQL pausado 10 s | 3/3 | 200 (0%) | 100 | 141 | 8.945 | 9.957 | 0 | ok |

Leitura:
- **Nenhum cenário violou a invariante financeira**, inclusive com o PostgreSQL pausado. Todas as wallets bateram com o ledger, a DLQ ficou vazia e nenhum evento se perdeu.
- **Saturação:** nenhum erro em nenhum degrau. Acima do ponto de maior vazão, mais concorrência só aumenta a latência. As duas saturações sem wallet quente terminam com a outbox ainda drenando, pelos motivos descritos em "Achados e decisões".
- **Wallet quente:** a vazão é limitada pela serialização no lock da linha, e não cresce com a concorrência.
- **SQS:** os números medem o MiniStack (um núcleo a 100%). No misto sustentado, o caminho HTTP fica em p99 de 10 ms, enquanto as mensagens SQS esperam dezenas de segundos na fila do emulador; o processamento no servidor fica em p50 de 7 ms e p99 de 23 ms.
- **Pico:** o triplo da taxa por 15 s passa sem erro, com p99 de 56 ms.
- **Queda do PostgreSQL:** 10 s pausado geram 15 timeouts HTTP (requisições que esperaram mais de 10 s). O primeiro sucesso vem 14 ms depois da volta, e a vazão normal em 1,7 s. As mensagens SQS só atrasam.

## Limitações

- Gerador, aplicação e infraestrutura dividem a mesma máquina. No macOS, PostgreSQL e MiniStack rodam na VM do Docker, e a aplicação roda nativa.
- O MiniStack não é o SQS real: latência e limites de API da AWS são outros.
- Os logs em nível `info` são escritos em arquivo local; com coletor remoto, o custo seria outro.
- Uma rodada é uma amostra. Comparações justas usam várias execuções de cada lado; o baseline acima é uma execução.
- As saturações deixam a outbox drenando por vários minutos, e por isso a execução completa do preset leva cerca de 40 min.
