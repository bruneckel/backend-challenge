# Teste de carga

Harness reproduzível que mede vazão, latência, contenção e consistência do Wagering Processor sob carga. Não há meta de RPS: os números valem para o ambiente descrito abaixo e servem de referência para comparar mudanças.

## Como rodar

Pré-requisitos: Docker e Bun 1.3.14, com `bun install` feito. O harness sobe a própria infraestrutura e não depende do Compose de desenvolvimento.

```bash
bun run test:load --preset smoke                  # 7 cenários curtos, cerca de 1 min
bun run test:load --preset baseline               # a matriz de referência, cerca de 40 min
bun run test:load --preset baseline --only http-saturation-1x1,sqs-backlog-1x3
bun run test:load --profile sustained --channel mixed --api 3 --workers 3 --rate 400 --duration 60
bun run test:load --preset scale --keep-infra     # 1 milhão de wallets
bun run test:load --preset retention --keep-infra # 1 milhão de wallets e 10 milhões de eventos
```

- **Saída:** `load-results/<data>/report.md` (relatório), `results.json` (dados brutos) e os logs de cada processo. A pasta é ignorada pelo git.
- **Código de saída:** 1 se algum cenário deixar wallet inconsistente ou não drenar.
- **`--keep-infra`:** mantém a infraestrutura e os bancos-modelo para a próxima execução. O modelo de 1 milhão de wallets leva cerca de 4 min para ser montado na primeira vez.

| Opção | Padrão | Significado |
|---|---|---|
| `--preset` | — | `smoke`, `baseline`, `scale` ou `retention` |
| `--only` | — | roda só os cenários listados, separados por vírgula |
| `--profile` · `--channel` | `sustained` · `http` | perfil (tabela abaixo) e canal: `http`, `sqs` ou `mixed` |
| `--api` · `--workers` | 1 · 1 | processos `api` e `worker` |
| `--rate` · `--duration` | 50 · 30 | operações por segundo e segundos de medição |
| `--steps` | 4,8,16,32,64 | clientes concorrentes de cada degrau da saturação |
| `--hot-share` · `--replay-share` | 0 · 0 | fração das operações na wallet quente e de reenvios |
| `--seed-wallets` | 0 | monta um banco-modelo com essa quantidade de wallets |
| `--app-env NOME=VALOR` | — | variável repassada à aplicação, por exemplo `RETENTION_ENABLED=false` |

As demais opções e seus padrões estão em `test/load/config.ts`.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Apple M4 Pro, 12 núcleos, 24 GB, macOS |
| Docker | 29.8.1, com 12 CPUs e 7,7 GB |
| Runtime | Bun 1.3.14; api e worker rodam nativos, fora do Docker |
| Infraestrutura | PostgreSQL 18.6 e MiniStack 1.5.20, na VM do Docker |

Gerador, aplicação e infraestrutura dividem a mesma máquina.

## Metodologia

**Isolamento.**
- **Infraestrutura própria:** projeto Compose `wagering-load`, com PostgreSQL na porta 25432 e MiniStack na 24566 (`test/load/compose.load.yml`). Nada toca o banco nem as filas de desenvolvimento ou dos testes.
- **PostgreSQL dimensionado:** `shared_buffers` 2 GB, `effective_cache_size` 4 GB, `max_wal_size` 8 GB, `checkpoint_timeout` 15 min e `wal_compression` lz4. Com os padrões da imagem, uma base de 1 milhão de wallets a 600 req/s tinha checkpoints por volume de WAL a cada 20 a 150 s, e eles dominavam a cauda de latência.
- **Estado novo por cenário:** um banco migrado do zero e três filas FIFO próprias.
- **Processos reais:** api e worker iniciados pelo Bun, como em produção, cada um com porta e log próprios.
- **Identidade:** um IdP local, com chave RSA gerada no processo, no lugar do Keycloak. Cada provedor reaproveita o token, como um cliente real.
- **Dados:** wallets abertas pela API com 1.000.000,00; operações BET e WIN de 1,00, meio a meio, para o saldo não acabar.

**Perfis.**

| Perfil | O que mede | Como |
|---|---|---|
| `sustained` | latência e lag numa taxa fixa | malha aberta: as chegadas seguem o relógio, não a resposta anterior |
| `spike` | reação a um degrau de carga | taxa base, pico e base de novo, em terços da duração |
| `saturation` | capacidade e o ponto em que a latência dispara | malha fechada: N clientes concorrentes por degrau, 15 s por degrau por padrão |
| `backlog` | vazão do consumidor da fila | enfileira N mensagens, sobe os workers e mede a drenagem |
| `publish` | vazão da outbox | grava N operações com os workers parados, sobe os workers e mede a publicação |
| `recovery` | comportamento com o banco fora | pausa o PostgreSQL (`docker pause`) durante a medição |

**O que é medido.**
- **Cliente:** vazão de sucessos por segundo e latência p50, p90, p95 e p99. Erros, timeouts e descartes são contados à parte. Na malha aberta, a latência conta a partir do instante planejado de envio, para um gerador atrasado não esconder espera (*coordinated omission*).
- **Fila:** latência do envio até o processamento da mensagem; no `backlog`, a vazão de drenagem.
- **Servidor:** diferença das métricas Prometheus antes e depois da medição: transações por status, replays, conflitos, retries, timeouts de lock, conflitos de versão, DLQ, espera pelo lock e atraso de publicação da outbox.
- **A cada segundo:** maior idade de evento pendente na outbox (outbox lag) e conexões ao banco.
- **Consistência, depois da drenagem:** o mesmo verificador dos testes confere todas as wallets (saldo = ledger, cadeia, versão). O cenário também exige DLQ vazia, outbox publicada e nenhuma referência pendente.
- **Gerador:** CPU do processo do harness. Perto de 100% de um núcleo, a medida deixa de valer.

**Método.** As saturações vêm primeiro e mostram a capacidade. As taxas dos outros perfis são frações dela, e não metas. Cada comparação A/B usa o mesmo cenário, na mesma máquina, com rodadas alternadas dos dois lados.

## Resultados

Execução do preset `baseline` em 2026-10-03 (commit `f3c7602`). O cenário `stream-sustained-3x3`, acrescentado depois, foi medido à parte (tabela de decisões). Latências em ms. Em saturação, a linha mostra o degrau de maior vazão; espera do lock e outbox lag cobrem o cenário inteiro. Na fila, a latência vai do envio ao processamento.

| Cenário | api/worker | Carga | Vazão/s | p50 | p95 | p99 | Erros | Lock p99 | Outbox lag máx. |
|---|---|---|---|---|---|---|---|---|---|
| http-saturation-1x1 | 1/1 | saturação, c=16 | 1.440 | 10,9 | 14,9 | 19,3 | 0 | 4,7 | 358 s ¹ |
| http-saturation-3x3 | 3/3 | saturação, c=32 | 1.793 | 16,8 | 26,2 | 33,2 | 0 | 28,9 | 354 s ¹ |
| http-hot-saturation-3x3 | 3/3 | saturação, 100% numa wallet, c=2 | 372 | 5,2 | 6,8 | 8,0 | 0 | 98,5 | 272 s ¹ |
| sqs-backlog-1x1 | 1/1 | 1.000 mensagens | 459 | — | — | — | 0 | 4,6 | 0,5 s |
| sqs-backlog-1x3 | 1/3 | 1.000 mensagens | 505 | — | — | — | 0 | 8,0 | 0,5 s |
| sqs-hot-backlog-1x3 | 1/3 | 500 mensagens, 100% numa wallet | 141 | — | — | — | 0 | 4,3 | 0,5 s |
| outbox-publish-1x1 | 1/1 | 3.000 operações | 1.559 eventos | — | — | — | 0 | — | 3,8 s |
| outbox-publish-1x3 | 1/3 | 3.000 operações | 2.702 eventos | — | — | — | 0 | — | 2,7 s |
| mixed-sustained-3x3, HTTP | 3/3 | 300/s, 20% quente, 5% replays | 150 | 5,1 | 7,3 | 10,3 | 0 | 4,5 | 14,7 s |
| mixed-sustained-3x3, fila | 3/3 | mesmo cenário | 150 | 2.237 | 38.567 | 44.867 | 0 | | |
| http-spike-3x3 | 3/3 | 300 → 900 → 300/s | 500 | 5,3 | 22,2 | 56,0 | 0 | 5,0 | 78 s |
| mixed-recovery-3x3, HTTP | 3/3 | 200/s, PostgreSQL pausado 10 s | 100 | 5,5 | 7.267 | 9.444 | 15 timeouts | 7,4 | 10,5 s |
| mixed-recovery-3x3, fila | 3/3 | mesmo cenário | 100 | 141 | 8.945 | 9.957 | 0 | | |

¹ A publicação não acompanha a escrita na saturação; a outbox acumula e drena depois, sem perder evento (ver "Onde está o limite").

- **Consistência:** nenhum cenário violou a invariante, inclusive com o PostgreSQL pausado. Todas as wallets bateram com o ledger, a DLQ ficou vazia e nenhum evento se perdeu.
- **Conflitos de concorrência:** timeouts de lock, conflitos de versão e retries de transação ficaram em zero em todos os cenários.
- **Saturação:** nenhum erro em nenhum degrau; acima do ponto de maior vazão, mais concorrência só aumenta a latência.
- **Wallet quente:** a vazão fica entre 340 e 370 operações/s em qualquer concorrência, cerca de 3 ms de lock por operação. A espera cresce com os clientes, e nenhuma operação falha.
- **Pico:** o triplo da taxa por 15 s passa sem erro, com p99 de 56 ms.
- **Queda do PostgreSQL:** 10 s de pausa geram 15 timeouts HTTP (requisições que esperaram mais de 10 s). O primeiro sucesso vem 14 ms depois da volta, e a vazão normal em 1,7 s. As mensagens da fila só atrasam.
- **Fila:** a latência alta do misto vem do emulador; o processamento no servidor fica em p50 de 7 ms e p99 de 23 ms.

**Referência atual.** O baseline acima é anterior à autenticação e usou o PostgreSQL nos padrões da imagem. Com autenticação, com os triggers saldo ⇔ ledger e com o PostgreSQL dimensionado, o `http-saturation-1x1` fez 1.338 req/s com 16 clientes, com p50/p95/p99 de 11,9/15,4/19,2 ms. A diferença fica dentro do custo medido da autenticação e dos triggers (tabela de decisões).

## Onde está o limite

| Caminho | Limite | Evidência |
|---|---|---|
| HTTP, 1 api | a CPU do processo | a api fica em 100% a 116% de CPU (o Bun executa o JavaScript num núcleo) e o PostgreSQL em cerca de 135% de 12 núcleos; a vazão para em cerca de 1.440 req/s a partir de 16 clientes |
| HTTP, 3 apis | a máquina compartilhada | 3 apis, 3 workers, gerador e infraestrutura dividem os mesmos 12 núcleos; a vazão sobe para cerca de 1.790 req/s, não o triplo |
| Wallet quente | o lock da linha, como projetado | 340 a 370 operações/s em qualquer concorrência |
| Fila | o MiniStack | um núcleo a 100% durante a carga mista; cada chamada fica mais lenta com o tamanho e o histórico da fila (`SendMessageBatch`: 2,2 ms depois de 5 mil mensagens, 27,5 ms depois de 40 mil) |

- **Os números de fila medem o emulador**, não o sistema. Servem para comparar versões no mesmo ambiente, não para estimar capacidade com o SQS real.
- **A outbox publica menos do que a escrita produz.** Cada operação gera 2 eventos. Um worker publica cerca de 1.560 eventos/s (780 operações/s) e três, cerca de 2.700, enquanto uma api escreve 1.440 operações/s. Na saturação sustentada, a outbox acumula e drena depois.
- **Drenagens longas ficam lentas no emulador.** Com cerca de 100 mil eventos pendentes, o publisher cai para 185 a 235 eventos/s, pelo histórico da fila no MiniStack. O claim continua abaixo de 0,1 ms no banco.
- **O harness consome a fila de eventos** durante o cenário, como faria o consumidor downstream; sem isso, a fila cresceria sem limite no emulador.

## Escala: 1 milhão de wallets

O preset `scale` monta uma vez um banco-modelo e o copia para cada cenário: 1.000.000 de wallets com 4 operações cada, ou 5 milhões de transações, 5 milhões de lançamentos e 2 milhões de mensagens na inbox (4,7 GB). Todas as constraints ficam ligadas, e o verificador de invariantes roda sobre o modelo inteiro. O tráfego sorteia 200 mil dessas wallets.

| Clientes | Base pequena, `shared_buffers` 128 MB | 1 milhão, 128 MB | 1 milhão, 2 GB |
|---|---|---|---|
| 16 | 1.328 req/s, p99 19 ms | 1.240, p99 22 ms | 1.307, p99 19 ms |
| 32 | 1.326, p99 37 ms | 1.252, p99 43 ms | 1.336, p99 34 ms |
| 64 | 1.400, p99 57 ms | 1.213, p99 138 ms | 1.390, p99 58 ms |

- **O tamanho da base não custa nada.** Com cache suficiente, a base de 1 milhão rende igual à pequena. A diferença com 128 MB vinha do cache: 200 mil wallets ativas e inserções em índices únicos grandes não cabem no padrão da imagem.
- **Consultas quentes:** `bun test/load/plans.ts --database <banco>` roda `EXPLAIN (ANALYZE, BUFFERS)` nelas. Na base de 1 milhão, todas usam índice, com mediana abaixo de 0,1 ms: lock da wallet, busca por idempotency key e por id externo, página do ledger, reconciliação e referências vencidas.

## Retenção

O preset `retention` usa a base de 1 milhão de wallets com mais 10 milhões de eventos publicados e 2 milhões de mensagens, semeados ao longo de 30 dias. Ele roda 600 req/s por 120 s, com a retenção ligada e desligada. É o pior momento: 7,7 milhões de eventos já estão vencidos no início, como numa base que nunca foi limpa.

Latência HTTP em ms, duas rodadas em ordem inversa, separadas por ponto:

| Retenção | p50 | p90 | p95 | p99 | Apagado na janela |
|---|---|---|---|---|---|
| ligada | 3,6 · 3,6 | 5,2 · 5,2 | 5,8 · 5,7 | 9,9 · 8,6 | cerca de 680 mil eventos e 680 mil mensagens |
| desligada | 3,6 · 3,6 | 5,1 · 5,1 | 5,5 · 5,7 | 7,2 · 9,3 | — |

Com a configuração padrão, pôr em dia uma base nunca limpa ficou indistinguível de não limpar, com 0 violações em 1 milhão de wallets. A retenção apaga cerca de 3.600 linhas por segundo em cada tabela, três vezes o que 600 req/s criam.

## Decisões tomadas por medição

Os A/B de vazão (outbox, `LISTEN/NOTIFY`, token e triggers) usaram três rodadas alternadas de cada lado; os de stream, retenção e migration, duas.

| Medição | Resultado | Decisão |
|---|---|---|
| Desfecho do lote da outbox num único `UPDATE … FROM (VALUES …)` | 932 → 1.133 eventos/s (+21%) | adotado |
| Índice `(next_attempt_at, id)` para o claim da outbox | com 106 mil pendentes, o claim já lê 50 buffers em menos de 0,1 ms | não adotado |
| Aviso de commit por `LISTEN/NOTIFY` para o stream | −12,7% de vazão com 3 apis e 3 workers: o PostgreSQL serializa o commit de quem notifica | não adotado; o stream usa varredura |
| Stream com uma leitura do ledger por wallet que mudou | p99 HTTP +1 ms com 100 streams | trocado por uma leitura por varredura, com p99 igual ao de sem streams; entrega com p50 de 255 ms e p99 de 500 ms |
| Validação do token a cada requisição | −3% a −5% da vazão de pico (cerca de 40 µs por requisição) | custo aceito |
| Triggers saldo ⇔ ledger no commit | −1% a −2% da vazão de pico, dentro da variação entre rodadas | adotados |
| Retenção sem pausa entre lotes | p95 da API cerca de 10 vezes maior | pausa de 250 ms entre lotes |
| Lote de retenção recomeçando do início do índice | 3,7 → 8,3 ms por lote, crescendo com as entradas mortas | cada lote continua da posição do anterior (2,7 a 3,3 ms) |
| Troca de `CHECK` numa transação, tabela com 5 milhões de linhas | leitura e escrita paradas por cerca de 420 ms | `NOT VALID` + `VALIDATE` em comandos separados: nada para |
| Índice único da idempotência por provedor, com `CONCURRENTLY`, 6 milhões de linhas | 6,9 s sem parar leitura nem escrita | adotado |
| Reconciliação de uma wallet com 1 milhão de lançamentos | cerca de 0,6 s (0,6 µs por lançamento); cabem uns 10 milhões no `statement_timeout` de 10 s | sem checkpoint: wallets de jogador têm de dezenas a milhares de lançamentos |
| Reconciliação de todas as wallets (`bun run reconcile`) | 1 milhão em 164 s com concorrência 8, 0 divergências | — |

## Limitações

- Gerador, aplicação e infraestrutura dividem a mesma máquina; os números não estimam capacidade de produção.
- O MiniStack não é o SQS real: latência e limites da AWS são outros.
- Os logs em nível `info` vão para arquivo local; com um coletor remoto, o custo seria outro.
- O baseline é uma execução; as comparações A/B usaram duas ou três rodadas de cada lado.
- As saturações deixam a outbox drenando por vários minutos, e por isso o preset `baseline` completo leva cerca de 40 min.
