# Teste de carga

Harness reproduzível para medir vazão, latência, contenção e consistência do Wagering Processor sob carga. Não existe meta de RPS: os números valem para o ambiente descrito em cada relatório e servem de baseline para comparar mudanças.

## Como rodar

Pré-requisitos: Docker e Bun 1.3.14, com as dependências instaladas (`bun install`). Nada depende do Compose de desenvolvimento — o harness sobe a própria infraestrutura.

```bash
bun run test:load --preset smoke      # 7 cenários curtos, valida o harness (~1 min)
bun run test:load --preset baseline   # a matriz de referência (~40 min, a maior parte drenando as saturações)
bun run test:load --preset baseline --only http-saturation-1x1,sqs-backlog-1x3
bun run test:load --profile sustained --channel mixed --api 3 --workers 3 --rate 400 --duration 60
bun run test:load --preset scale --keep-infra        # 1 milhão de wallets; o modelo leva ~4 min na primeira vez
bun run test:load --preset retention --keep-infra    # 1 milhão de wallets com 10 milhões de eventos, retenção ligada e desligada (espera a drenagem por 60 s)
bun test/load/plans.ts --database <banco>            # planos das consultas quentes num banco do projeto de carga
```

Com `--keep-infra`, a infraestrutura e os bancos-modelo continuam de pé para a próxima execução; sem ele, tudo é removido no fim.

O relatório (`report.md`), os dados brutos (`results.json`) e os logs de cada processo ficam em `load-results/<data>/`, ignorado pelo git. O comando termina com código 1 se algum cenário deixar wallet inconsistente ou não drenar.

| Opção | Padrão | Significado |
|---|---|---|
| `--preset` | — | `smoke` ou `baseline`; as demais opções sobrescrevem todos os cenários do preset |
| `--only` | — | roda só os cenários listados (separados por vírgula) |
| `--profile` | `sustained` | `sustained`, `spike`, `saturation`, `backlog`, `publish` ou `recovery` |
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
| `--subscribers` | 0 | streams SSE abertos durante o cenário, um por wallet (a quente primeiro), distribuídos entre as réplicas da api |
| `--seed-wallets`, `--seed-operations` | 0, 4 | monta (uma vez) um banco-modelo com essa quantidade de wallets e operações por wallet, e copia para cada cenário; `--wallets` passa a ser o tamanho da amostra sorteada |
| `--seed-hot-entries` | 0 | uma wallet a mais, com essa quantidade de operações (ledger longo) |
| `--seed-events` | — | semeia também 2 eventos publicados por transação, com datas nos últimos 30 dias |
| `--app-env NOME=VALOR` | — | variável passada aos processos da aplicação; repetível (por exemplo `RETENTION_ENABLED=false`) |
| `--keep-infra`, `--keep-data` | — | mantém a infraestrutura e os bancos/filas para inspeção |

## Isolamento

- **Infraestrutura própria:** projeto Compose `wagering-load`, com PostgreSQL na porta 25432 e MiniStack na 24566 (`test/load/compose.load.yml`). Ela é removida no fim (`down -v`), salvo com `--keep-infra`. Nada toca o banco nem as filas de desenvolvimento ou dos testes.
- **PostgreSQL dimensionado (desde a Etapa 4):** `shared_buffers` 2 GB, `effective_cache_size` 4 GB, `max_wal_size` 8 GB, `checkpoint_timeout` 15 min e `wal_compression` lz4, só no projeto de carga.
  - Com os padrões da imagem (128 MB e 1 GB de WAL), uma base de 1 milhão de wallets a 600 req/s disparava checkpoints por volume de WAL a cada 20 a 150 s, mesmo sem retenção. O motivo são as imagens de página inteira de índices únicos grandes, escritos em posições aleatórias. Esses checkpoints dominavam a cauda de qualquer cenário grande.
  - As medições das Etapas 1 a 3 usaram os padrões da imagem. A execução de referência em "Baseline" mostra o efeito da mudança na base pequena.
- **Estado novo por cenário:** um banco `load_<id>` migrado do zero e três filas FIFO com prefixo próprio.
- **Processos reais:** `api` e `worker` são iniciados pelo Bun, como em produção. Cada um tem porta própria e grava o log em arquivo, para não sobrecarregar o gerador.
- **Identidade:** o harness sobe um IdP local (chave RSA gerada no processo e JWKS servido por HTTP) e aponta os processos para ele, como a suíte de testes; o Keycloak não participa. Cada provedor usa um token assinado uma vez e reaproveitado, como um cliente real faria até o token vencer.
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
- **Streams** (com `--subscribers`): latência de entrega de cada lançamento (do `createdAt` gravado na transação até a chegada ao cliente), lacunas e repetições de `walletVersion` em cada stream e, depois da drenagem, quantas versões ainda faltavam chegar. Qualquer lacuna, repetição ou atraso no fim marca o cenário como "stream com falhas".
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
| SQS (consumidor, publisher e leitura de eventos) | o MiniStack | um único núcleo a ~100% durante a carga mista, com o PostgreSQL a 35–53%; cada chamada fica mais lenta com o tamanho da fila (`ReceiveMessage` + `DeleteMessageBatch`: 2 ms com mil mensagens, 28 ms com 30 mil; `SendMessageBatch`: 1,6 ms com 500, 31 ms com 40 mil) e também com o histórico dela, mesmo esvaziada a cada ciclo (`SendMessageBatch`: 2,2 ms depois de 5 mil mensagens, 27,5 ms depois de 40 mil; medido na Etapa 4) |

Consequências:
- **Números de SQS medem o emulador**, não o sistema. Servem para comparar versões no mesmo ambiente, não para estimar capacidade com o SQS real.
- **O harness consome a fila de eventos** durante todo o cenário, como faria o consumidor downstream. Sem isso, a fila `wagering-events.fifo` cresce sem limite no emulador e o publisher parece um gargalo que não existe. As primeiras medições caíram nesse artefato e foram descartadas.
- **A outbox publica menos do que a escrita produz.** Cada operação gera 2 eventos. Com o lote gravado num único `UPDATE` (abaixo), um worker publica ~1.560 eventos/s (cerca de 780 operações/s) e 3 workers, ~2.700 eventos/s, porque o claim com `SKIP LOCKED` escala. Já 1 api escreve ~1.440 operações/s. Em saturação sustentada, a outbox acumula e drena depois: os eventos atrasam, mas nenhum se perde (todo cenário fecha com eventos entregues mais eventos ainda na fila iguais às linhas da outbox).
- **Drenagens longas ficam lentas, por causa do emulador.** Depois das saturações, com ~100 mil eventos pendentes, o publisher entregou só ~185 a 235 eventos/s.
  - Na Etapa 1 atribuí parte disso às entradas mortas no índice parcial `published_at IS NULL`. Elas existem: num banco descartável, o claim foi de 0,05 ms para 4,6 ms com 180 mil publicadas sem vacuum. Mas a Etapa 4 mostrou que não são a causa.
  - Num banco preservado depois de uma saturação, com 106 mil pendentes, todos estavam vencidos e com 0 tentativas, sem falha de envio. O claim leu 73 buffers antes de um `VACUUM` e 50 depois, menos de 0,1 ms nos dois casos. O autovacuum padrão manteve as tuplas mortas em zero durante a drenagem.
  - Um worker só de publicação, sobre esse banco, começou a 1.532 eventos/s e decaiu a cada 5 s (906, 692, 578, 514, 440, 388). Um worker novo, com fila de eventos nova, voltou a 1.522/s e decaiu igual.
  - A causa é o histórico da fila no MiniStack (linha SQS acima): a 27 ms por lote de 10, o publisher não passa de ~370 eventos/s. Com o SQS real, esse limite não existe.

### Experimentos na outbox

| Alternativa | Medição | Decisão |
|---|---|---|
| Gravar o desfecho do lote num único `UPDATE … FROM (VALUES …)`, em vez de um `UPDATE` por mensagem | A/B no perfil `publish` (1 worker, 6.000 operações, 12.402 eventos), três rodadas alternadas: **932 → 1.133 eventos/s em média (+21%)**; o pior resultado da mudança (1.094) supera o melhor do baseline (953); 12.402 de 12.402 eventos entregues em todas as execuções | **adotada** (`perf: save each outbox batch in one statement`), com a suíte 852/852 |
| Índice `(next_attempt_at, id)` para o claim | `EXPLAIN (ANALYZE, BUFFERS)` num banco descartável com 40 mil pendentes: 0,5 ms → 0,06 ms por claim. O PostgreSQL já usa *Incremental Sort* sobre o índice atual. Na Etapa 4, com 106 mil pendentes depois de uma saturação, o claim lia 50 buffers em menos de 0,1 ms | **descartada** na Etapa 4: não há o que ganhar |
| Claim com lease, sem transação aberta durante o envio ao SQS | com o emulador local, o envio custa 2–3 ms por lote, então o benefício não aparece neste ambiente | adiada até haver latência real de SQS para medir |
| Lote de operações financeiras de várias wallets numa transação | — | descartada: acoplaria falhas e exigiria ordenar locks entre wallets |
| Autovacuum ajustado só para `outbox_messages` | o autovacuum padrão manteve as tuplas mortas em zero durante a drenagem, e o claim não mudou com `VACUUM` | **não adotado** na Etapa 4 |
| Retenção das publicadas e das mensagens processadas | não afeta a drenagem (a causa é o emulador); é necessária pelo volume, porque cada operação deixa 2 eventos e 1 mensagem para sempre | **adotada** na Etapa 4 (ver "Retenção") |

### Custo da autenticação

A/B no cenário `http-saturation-1x1` (1 api, 1 worker, degraus de 16, 32 e 64 clientes, 15 s cada), três rodadas alternadas: sem autenticação (`d785358`) contra a validação de token da Etapa 2 (JWT RS256 conferido a cada requisição, contra o JWKS de um IdP local). Vazão em requisições bem-sucedidas por segundo, média das três rodadas:

| Clientes | Sem token | Com token | Diferença | p99 sem → com (ms) |
|---|---|---|---|---|
| 16 | 1.386 | 1.343 | −3,1% | 18,5 → 18,7 |
| 32 | 1.377 | 1.326 | −3,7% | 32,7 → 37,9 |
| 64 | 1.414 | 1.342 | −5,1% | 60,8 → 61,3 |

- **Pico de cada execução:** 1.406 a 1.432 sem token, 1.327 a 1.373 com token (−5,2% na média); as faixas não se sobrepõem.
- **Custo por requisição:** cerca de 40 µs no processo da api, que é limitado por CPU: no pico, cada requisição passa de ~706 µs para ~745 µs do processo, gastos na verificação da assinatura RS256 e dos claims.
- **Latência fora da saturação:** inalterada; 40 µs somem diante dos milissegundos de uma transação. O p99 maior com 32 clientes vem de uma única rodada (48 ms; as outras duas ficaram em 33 ms).
- **Sem erro e sem violação** em nenhuma das seis execuções; o gerador ficou em 19% de um núcleo nos dois lados, porque cada provedor reaproveita o mesmo token.
- **Decisão:** custo aceito. Um cache dos tokens já verificados (pelo texto do token, até o `exp`) eliminaria quase todo ele, mas é mais um cache para proteger; fica para quando a CPU da api for o gargalo em produção, depois do primeiro recurso, que é escalar a api horizontalmente.

### Aviso de commit por `LISTEN/NOTIFY` (PoC da Etapa 3)

O plano recomendava o NOTIFY do PostgreSQL como aviso, depois do commit, de que uma wallet mudou. A PoC foi uma trigger `AFTER INSERT` no ledger chamando `pg_notify` (sem ninguém escutando, para isolar o custo da escrita), medida contra o mesmo commit sem ela: `http-saturation-1x1` e `http-saturation-3x3`, degraus de 16, 32 e 64 clientes, três rodadas alternadas.

| Cenário | Pico sem NOTIFY | Pico com NOTIFY | Diferença | p99 com 64 clientes (ms) |
|---|---|---|---|---|
| 1x1 (~1.350 transações/s) | 1.374 a 1.422 | 1.311 a 1.392 | −3,6% (faixas se sobrepõem) | 58,4 → 59,0 |
| 3x3 (~1.700 transações/s) | 1.713 a 1.772 | 1.482 a 1.533 | **−12,7%** (sem sobreposição) | 74,1 → 90,6 |

- Nas médias da 3x3, a perda é de 1,6% com 16 clientes, 10,6% com 32 e 13,4% com 64: cresce com os commits concorrentes.
- **Causa:** o PostgreSQL serializa, num lock do banco inteiro, o commit das transações que fizeram NOTIFY, para manter a ordem das notificações.
- **Decisão:** não adotado. O stream de tempo real usa uma varredura por réplica (ver "Streams" abaixo), que não toca o caminho de escrita. As 12 execuções terminaram sem violação.

### Streams de tempo real (Etapa 3)

`stream-sustained-3x3` repete o `mixed-sustained-3x3` (3 apis, 3 workers, 300 operações/s, metade por HTTP e metade pela fila, 20% na wallet quente, 5% de replays, 60 s) com 100 streams abertos, um por wallet, distribuídos entre as 3 réplicas. Médias de duas rodadas pareadas, em ms:

| Versão | HTTP p50 | HTTP p95 | HTTP p99 | Processamento HTTP p50 |
|---|---|---|---|---|
| sem streams | 5,3 | 7,7 | 10,2 | 3,4 |
| 100 streams, uma leitura do ledger por wallet que mudou | 5,7 | 8,3 | 11,3 | 4,2 |
| 100 streams, uma leitura por varredura (adotada) | 5,6 | 7,8 | 10,0 | 3,8 |

- **Primeira versão:** cada varredura relia o ledger de cada wallet assistida que mudou, numa transação própria. Com 100 wallets ativas, isso somava centenas de leituras por segundo disputando o banco e o pool, e o p99 HTTP subia cerca de 1 ms.
- **Versão adotada:** uma única consulta por varredura cobre todas as wallets que mudaram (até 1.000 lançamentos; o resto fica para a varredura seguinte). O p95 e o p99 voltam aos de sem streams, e sobram cerca de 0,3 ms no p50.
- **Entrega:** nas quatro execuções com streams, entre 10.985 e 11.135 lançamentos chegaram aos clientes sem lacuna, sem repetição e sem atraso no fim. O p50 ficou em 255 ms, o p99 em 500 ms e o máximo em 518 ms, limitados pelo intervalo da varredura (500 ms).
- **Smoke:** o preset `smoke` abre 20 streams no cenário misto, em 2 réplicas.

### Escala: 1 milhão de wallets (Etapa 4)

Com `--seed-wallets`, o harness monta uma vez um banco-modelo com o volume pedido e copia esse modelo para cada cenário com `CREATE DATABASE … TEMPLATE … STRATEGY FILE_COPY`.
- **Conteúdo:** cada wallet tem a abertura e N operações alternando BET e WIN de 1,00, com transação, lançamento, metade das WINs na inbox e, com `--seed-events`, 2 eventos publicados por transação. Os ids são UUIDv7.
- **Ordem no tempo:** as wallets são criadas em sequência ao longo dos últimos 30 dias, e cada tabela fica gravada na ordem do tempo, como numa base que cresce em produção. A primeira versão da semente espalhava as datas sem relação com a posição física, e cada exclusão por faixa de tempo virava um pior caso (ver "Retenção").
- **Validação:** todas as constraints ficam ligadas, e o verificador de invariantes roda sobre o modelo inteiro.
- **Tráfego:** sorteia `--wallets` dessas wallets.

| Item | Medida |
|---|---|
| Base | 1.000.000 de wallets × 4 operações: 5,0 milhões de transações, 5,0 milhões de lançamentos, 2,0 milhões de mensagens na inbox; 4,7 GB (2,8 GB só de transações) |
| Montagem do modelo | 236 s; `ANALYZE` e verificador de invariantes sobre tudo, cerca de 9 s |
| Cópia por cenário, api no ar e sorteio de 200 mil wallets | cerca de 5 s |

Saturação `http-saturation-1x1` no mesmo commit, uma execução de cada lado:

| Clientes | Base pequena, `shared_buffers` 128 MB | 1 milhão, 128 MB | 1 milhão, 2 GB |
|---|---|---|---|
| 16 | 1.328 req/s, p99 19 ms | 1.240, p99 22 ms | 1.307, p99 19 ms |
| 32 | 1.326, p99 37 ms | 1.252, p99 43 ms | 1.336, p99 34 ms |
| 64 | 1.400, p99 57 ms | 1.213, p99 138 ms | 1.390, p99 58 ms |

- **Planos:** `bun test/load/plans.ts --database <banco>` roda `EXPLAIN (ANALYZE, BUFFERS)` nas consultas quentes. Na base de 1 milhão, todas usam índice, com mediana abaixo de 0,1 ms: lock da wallet, busca por idempotency key e por `(provider, externalTransactionId)`, página do ledger, ledger depois de uma versão, reconciliação, referências vencidas e versões das wallets assistidas. Nenhum plano piora com o tamanho.
- **Leitura:** o tamanho em si não custa nada. A diferença vinha do cache: 200 mil wallets ativas e inserções em posições aleatórias de índices únicos grandes (a idempotency key, por exemplo) não cabem nos 128 MB padrão da imagem. Com 2 GB, a base de 1 milhão rende igual à pequena.
- **Decisão:** em produção, dimensionar `shared_buffers` (cerca de 25% da RAM) e `effective_cache_size` para o conjunto de trabalho. O harness mantém o padrão da imagem, para os A/Bs continuarem comparáveis com as etapas anteriores.

### Retenção (Etapa 4)

O preset `retention` usa uma base de 1 milhão de wallets com 4 operações cada, mais 10 milhões de eventos publicados e 2 milhões de mensagens na inbox, semeados ao longo de 30 dias. Ele roda 600 req/s por 120 s sobre uma amostra de 200 mil wallets, com a retenção ligada e desligada.
- **O cenário é o pior momento.** Com os padrões (168 h na outbox e 360 h na inbox), 7,7 milhões de eventos e 1 milhão de mensagens já estão vencidos no início. É o que acontece quando a retenção é ligada numa base que nunca foi limpa.
- **Configuração da medição:** semente em ordem de tempo e PostgreSQL dimensionado, duas rodadas em ordem inversa. A espera pela drenagem é de 60 s, o padrão do preset.

Latência HTTP em ms, com as duas rodadas separadas por ponto. O expurgo é o que saiu na janela medida, depois da primeira coleta de métricas.

| Retenção | p50 | p90 | p95 | p99 | Expurgo na janela |
|---|---|---|---|---|---|
| desligada | 4,3 · 3,7 | 7,4 · 5,4 | 12,3 · 6,2 | 84,6 · 12,2 | — |
| sem pausa entre lotes | 5,2 · 4,9 | 28,3 · 18,1 | 77,1 · 62,6 | 180,5 · 156,0 | 6,6 e 6,8 milhões de eventos; a inbox acabou |
| pausa de 250 ms (padrão) | 3,9 · 3,9 | 5,8 · 5,7 | 7,2 · 6,7 | 27,3 · 19,1 | cerca de 676 mil eventos e 676 mil mensagens |
| pausa de 1.000 ms | 3,7 · 4,0 | 5,1 · 6,1 | 5,7 · 7,7 | 9,8 · 22,5 | cerca de 176 mil eventos e 176 mil mensagens |

As oito execuções terminaram com 0 violações em 1 milhão de wallets. A drenagem ficou incompleta em todas, pelo limite do emulador (ver "Onde está o limite").

Leitura:
- **Sem pausa:** o expurgo apaga cerca de 35 mil eventos por segundo e disputa o disco com a API. O p90 sobe de 3 a 5 vezes, e o p95 cerca de 10 vezes.
- **Com 250 ms:** p95 e p99 ficam dentro da variação da execução desligada, e a retenção ainda limpa cerca de 3.600 linhas por segundo em cada tabela. É três vezes o que 600 req/s criam (1.200 eventos/s).
- **Com 1.000 ms:** a cauda é a mesma, mas a capacidade cai para cerca de 950 linhas por segundo, menos do que 600 req/s criam.
- **Decisão:** `RETENTION_BATCH_PAUSE_MS` = 250 por padrão. O teto de cada tabela é `RETENTION_BATCH_SIZE / (duração do lote + pausa)`.

**Configuração final.** O mesmo preset rodou com a pausa de 250 ms e a posição do lote (abaixo), em duas rodadas em ordem inversa:

| Retenção | p50 | p90 | p95 | p99 | Expurgo na janela |
|---|---|---|---|---|---|
| ligada | 3,6 · 3,6 | 5,2 · 5,2 | 5,8 · 5,7 | 9,9 · 8,6 | 678 e 679 mil eventos, e o mesmo número de mensagens |
| desligada | 3,6 · 3,6 | 5,1 · 5,1 | 5,5 · 5,7 | 7,2 · 9,3 | — |

A retenção pondo em dia uma base que nunca foi limpa ficou indistinguível da retenção desligada, com 0 violações em 1 milhão de wallets nas quatro execuções.

**Primeira medição, guardada como pior caso.** Ela usou a semente original, com as datas sem relação com a posição física, e o PostgreSQL nos padrões da imagem.
- Cada lote tocava cerca de 1.000 páginas espalhadas, em vez de umas 125 contíguas.
- Os checkpoints por volume de WAL vinham a cada 20 a 150 s, mesmo com a retenção desligada.
- Resultado, p90 / p99 em ms:
  - sem pausa: 257–316 / 870–990;
  - pausa de 250 ms: 7–44 / 189–699;
  - pausa de 1.000 ms: 7–15 / 223–960;
  - desligada: 6–7 / 149–844.
- O ruído da própria base encobria o efeito. Daí a semente em ordem de tempo e o banco dimensionado (ver "Isolamento").

**Posição do lote.** Numa cópia da base, 2 milhões de exclusões foram feitas em sequência, sem pausa.
- Recomeçando cada lote do início do índice, o lote foi de 3,7 para 8,3 ms. O tempo cresce em linha reta com as entradas mortas (1,9 milhão, antes de o autovacuum passar).
- Continuando depois do último id apagado, o lote ficou entre 2,7 e 3,3 ms: 2 milhões de linhas em 6,3 s, contra 11,0 s.
- Na escala alvo, a outbox guarda centenas de milhões de linhas, e o autovacuum espera 20% delas mortas. Por isso cada lote continua da posição do anterior.
- Os planos (`bun test/load/plans.ts`) mostram os dois expurgos por índice: 1,5 ms de mediana por lote de 1.000 na outbox e 2,6 ms na inbox.

### Reconciliação de todas as wallets

A CLI `bun run reconcile` rodou contra o banco-modelo de 1 milhão de wallets, cada uma com 4 operações:

| Concorrência | Wallets | Tempo | Ritmo |
|---|---|---|---|
| 1 | 100 mil | 89,9 s | cerca de 1.100 por segundo (0,9 ms por wallet) |
| 8 | 100 mil | 15,3 s | cerca de 6.500 por segundo |
| 8 | 1 milhão | 163,8 s | cerca de 6.100 por segundo |

Todas as execuções terminaram com 0 divergências. Cada wallet é uma transação curta de leitura, então o ritmo cresce com a concorrência até o banco virar o limite.

### Custo das guardas saldo ⇔ ledger (Etapa 4)

O teste foi uma A/B no cenário `http-saturation-3x3`, com degraus de 16, 32 e 64 clientes de 15 s cada e três rodadas alternadas. A versão sem as constraint triggers (`2d22f11`, numa worktree) correu contra a versão com elas. O 3x3 põe mais carga no PostgreSQL do que o 1x1, então mostra melhor um custo que é do banco. Vazão em requisições bem-sucedidas por segundo, média das três rodadas:

| Clientes | Sem triggers | Com triggers | Diferença | p99 sem → com (ms, média) |
|---|---|---|---|---|
| 16 | 1.344 | 1.329 | −1,1% | 22,4 → 21,5 |
| 32 | 1.668 | 1.653 | −0,9% | 35,5 → 36,2 |
| 64 | 1.763 | 1.734 | −1,6% | 67,3 → 75,7 |

- **Pico de cada execução:** de 1.724 a 1.795 sem os triggers e de 1.708 a 1.779 com eles. As faixas se sobrepõem.
- **p99 com 64 clientes:** a média maior vem de uma rodada só (92 ms); as outras duas ficaram em 67 e 68 ms.
- **Processamento no servidor:** p50 de 19 a 21 ms nos dois lados.
- **Sem erro e sem violação** em nenhuma das seis execuções.
- **Decisão:** custo aceito. As três buscas por índice único no commit custam cerca de 1% a 2% da vazão de pico, dentro da variação entre rodadas, e o banco passa a recusar sozinho qualquer saldo que não feche com o ledger.

### Reconciliação de ledger longo (Etapa 4)

Com `--seed-hot-entries`, a semente cria uma wallet a mais, com N operações. O modelo de `--seed-wallets 1000000 --seed-hot-entries 1000000` tem 5,7 GB e foi montado em 418 s, com os triggers saldo ⇔ ledger ligados. O ledger tem 6 milhões de lançamentos, dos quais 1.000.001 são da wallet quente.

A reconciliação dessa wallet é uma consulta só, num snapshot. "A frio" é a primeira execução depois de reiniciar o PostgreSQL e limpar o cache da VM do Docker:

| Disposição física | A frio | Aquecida | Páginas lidas |
|---|---|---|---|
| contígua, como a semente grava | 797 ms | 568–577 ms | 19.219 |
| espalhada (ledger reordenado ao acaso com `CLUSTER`) | 723 ms | cerca de 680 ms | cerca de 85 mil: o planejador lê o ledger inteiro |

- **Custo:** cerca de 0,6 µs por lançamento. O `plans.ts` mede 525 ms de mediana pelo índice `(wallet_id, wallet_version)`.
- **Limite:** com o `statement_timeout` de 10 s, cabe uma wallet de uns 10 milhões de lançamentos com os dados no cache. Numa base muito maior, com os lançamentos de uma wallet espalhados um por página, o custo passa a ser de leitura em disco, uma página por lançamento.
- **Decisão:** sem checkpoint por enquanto. Wallets de jogador têm de dezenas a milhares de lançamentos. Uma conta de casa ou de bot com dezenas de milhões é o caso que pediria checkpoints verificados (ver ARCHITECTURE.md, "Reconciliação").
- **Outras consultas da wallet quente:** a página mais recente do ledger e a leitura depois de uma versão ficam abaixo de 0,1 ms, porque dependem do índice e não do tamanho.

### Migrations em tabelas grandes (Etapa 4)

A migration que acrescentou `BALANCE_LIMIT_EXCEEDED` trocava o `CHECK` de `failure_code` numa transação só. O `ADD CONSTRAINT` valida a tabela inteira sob `ACCESS EXCLUSIVE`. O teste usou cópias da base de 1 milhão (`wager_transactions` com 5 milhões de linhas, 2,8 GB), com uma escrita e uma leitura na tabela a cada 5 ms, em duas rodadas:

| Forma | Duração | Escritas e leituras durante a troca |
|---|---|---|
| `DROP` + `ADD CONSTRAINT` na mesma transação | 412–424 ms | todas paradas, por até 420 ms |
| `ADD CONSTRAINT … NOT VALID`, depois `VALIDATE CONSTRAINT` | 411–444 ms | 65 a 75 atendidas, máximo de 8 a 16 ms |

- **Projeção:** em linha reta, com 100 milhões de transações seriam cerca de 8 s com toda operação financeira parada, acima do `lock_timeout` de 3 s da aplicação.
- **Decisão:** a migration foi reescrita antes de ser publicada. Ela roda fora de transação e valida num comando separado, que usa `SHARE UPDATE EXCLUSIVE` e deixa leitura e escrita seguirem.
- **Regra para as próximas** (ARCHITECTURE.md): `CHECK` como `NOT VALID` + `VALIDATE`, índice com `CONCURRENTLY`.
- **Escopo da idempotência por provedor:** a migration seguinte aplicou a regra numa cópia da base com wallet longa, com 6 milhões de transações:
  - o `CREATE UNIQUE INDEX CONCURRENTLY` de `(provider_id, idempotency_key)` levou 6,9 s, com 1.083 escritas e 1.102 leituras atendidas no meio e máximo de 13,6 ms, igual ao de antes;
  - promover o índice a constraint levou 6 ms, e remover a constraint global, 25 ms;
  - a busca nova usa o índice, com 0,013 ms de mediana no `plans.ts`.

### PoC de OpenTelemetry (Etapa 4)

A pergunta do plano era se o OpenTelemetry funciona no Bun. A auto-instrumentação do Node depende de hooks de módulo, então a PoC usou spans manuais. O código está na branch `poc/opentelemetry` e não entra na `main`.

- **Compatibilidade (Bun 1.3.14, API 1.9.1, SDK 2.11.0, exportador OTLP/HTTP 0.222.0, Jaeger 2.21.0):**
  - o contexto em `AsyncLocalStorage` atravessa `await`, `Promise.all` e `setTimeout`, com cada span no pai certo;
  - o `traceparent` W3C é injetado e extraído;
  - a exportação OTLP/HTTP chega ao Jaeger.
- **O que foi instrumentado:**
  - um middleware HTTP abre o span do servidor a partir do `traceparent` recebido, com rota e status;
  - o controller cria "submit wager transaction", com o tipo e o canal, nunca o valor;
  - a unidade de trabalho cria um span por transação;
  - o consumidor SQS continua o trace a partir do `traceparent` nos atributos da mensagem;
  - o publisher da outbox cria o span de publicação e injeta o `traceparent` em cada evento enviado.
- **Conferido no Jaeger:**
  - uma aposta pela api com um `traceparent` de fora gerou o span HTTP pendurado no pai remoto, com "submit wager transaction" e "unit of work" embaixo;
  - um comando pela fila com `traceparent` gerou "process message" pendurado no pai remoto, com "unit of work" embaixo.
- **Atravessar a outbox:** o evento é publicado depois, por outro processo, então a publicação começa um trace próprio. Ligar o evento à requisição de origem pede guardar o `traceparent` do momento do enqueue numa coluna nova da outbox, com cerca de 55 bytes por evento. Com ela, o span de publicação faria um *link* para a origem de cada evento do lote, e não um pai, porque um lote junta eventos de várias requisições. Também injetaria o `traceparent` de origem em cada mensagem. Pôr o `traceparent` no payload mudaria o contrato público do evento. Até lá, o `correlationId` que o envelope já carrega liga os dois lados nos logs.

Custo: A/B no `http-saturation-1x1`, com degraus de 16, 32 e 64 clientes e três rodadas alternadas, tracing desligado contra ligado em 100% das requisições, exportando para um Jaeger na mesma máquina. Durante as seis execuções, o Compose de desenvolvimento com o profile de métricas estava no ar, igual para os dois lados, então os números absolutos ficam abaixo da referência. Vazão média em requisições bem-sucedidas por segundo:

| Clientes | Desligado | Ligado | Diferença |
|---|---|---|---|
| 16 | 1.266 | 1.226 | −3,2% |
| 32 | 1.232 | 1.218 | −1,2% |
| 64 | 1.263 | 1.223 | −3,2% |

- **Pico de cada execução:** de 1.211 a 1.314 com o tracing desligado e de 1.219 a 1.248 com ele ligado. O p50 do processamento no servidor subiu cerca de 1,5 ms na saturação.
- **Sem erro e sem violação** nas seis execuções.
- **Decisão:** a PoC responde que dá para adotar. O custo com 100% de amostragem é da ordem do da autenticação (3% a 5% da vazão de pico da api), e uma amostragem por proporção, herdada do pai, o reduziria na mesma proporção.
- **Para adotar** falta o que a PoC deixou de lado:
  - a configuração no `AppConfig`, com amostragem;
  - o envio dos spans pendentes no desligamento;
  - a coluna da outbox, se o trace do evento ponta a ponta for desejado;
  - os testes.

  Fica como decisão à parte.

## Baseline

Execução `bun run test:load --preset baseline` de 2026-10-03, no commit `f3c7602` (com a gravação do lote da outbox num único `UPDATE`), antes da autenticação; o custo dela está medido em "Custo da autenticação". Os dados completos ficam no relatório gerado. Latências em ms; vazão em operações bem-sucedidas por segundo. Em saturação, a linha mostra o degrau de maior vazão; em SQS, a latência vai do envio ao processamento.

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

**Referência com o PostgreSQL dimensionado (Etapa 4).** O `http-saturation-1x1` rodou de novo no commit `2fad641`, já com autenticação e com os triggers saldo ⇔ ledger, depois da mudança de ambiente descrita em "Isolamento". O degrau de maior vazão (16 clientes) fez 1.338 req/s, com p50/p95/p99 de 11,9/15,4/19,2 ms. A linha da tabela, sem autenticação e com os padrões da imagem, fez 1.440 req/s com p99 de 19,3 ms. A diferença fica dentro do custo medido da autenticação (3% a 5%) somado ao dos triggers (1% a 2%). Na base pequena, a mudança de ambiente não pesa: ela importa nas bases grandes (ver "Escala: 1 milhão de wallets").

## Limitações

- Gerador, aplicação e infraestrutura dividem a mesma máquina. No macOS, PostgreSQL e MiniStack rodam na VM do Docker, e a aplicação roda nativa.
- O MiniStack não é o SQS real: latência e limites de API da AWS são outros.
- Os logs em nível `info` são escritos em arquivo local; com coletor remoto, o custo seria outro.
- Uma rodada é uma amostra. Comparações justas usam várias execuções de cada lado; o baseline acima é uma execução.
- As saturações deixam a outbox drenando por vários minutos, e por isso a execução completa do preset leva cerca de 40 min.
