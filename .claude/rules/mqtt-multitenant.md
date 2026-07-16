---
paths:
  - "apps/api/src/plugins/mqtt.ts"
  - "apps/api/src/modules/**"
  - "packages/shared/src/topics.ts"
  - "apps/dashboard/src/lib/mqtt.ts"
  - "apps/mobile/src/services/mqtt.ts"
---

# Tópicos MQTT e Isolamento Multitenant (Zero Trust)

A malha MQTT e o escopo por `operationId` são o **núcleo Zero Trust** do Cerberus. Um vazamento
entre operações (um agente de uma missão vendo/publicando telemetria de outra) é um incidente de
segurança de missão crítica. Esta regra é **obrigatória** para qualquer código que construa, assine,
publique ou faça parse de tópicos, ou que consulte dados escopados por operação.

## Taxonomia de tópicos — FONTE ÚNICA DE VERDADE

Todos os tópicos derivam de `packages/shared/src/topics.ts`. **Nunca** montar string de tópico à mão
(`` `operacao/${id}/...` ``) em nenhum dos três módulos — usar sempre os construtores exportados.

| Necessidade | Função (`@cerberus/shared`) | Formato resultante |
|---|---|---|
| Agente publica posição | `agentPositionTopic(opId, agentId)` | `operacao/{opId}/agente/{agentId}/posicao` |
| Agente publica mensagem | `agentMessageTopic(opId, agentId)` | `operacao/{opId}/agente/{agentId}/mensagem` |
| Agente publica presença | `agentStatusTopic(opId, agentId)` | `operacao/{opId}/agente/{agentId}/status` |
| Central → agentes da operação | `operationBroadcastTopic(opId)` | `operacao/{opId}/broadcast` |
| Dashboard assina a operação | `operationWildcardTopic(opId)` | `operacao/{opId}/#` |
| Ponte da API assina tudo | `bridgeIngestTopic()` | `operacao/+/agente/+/#` |
| Parse de tópico recebido | `parseAgentTopic(topic)` | `{ operationId, agentId, channel } \| null` |

> **Idioma dos tópicos:** as palavras `operacao`/`agente` nos tópicos são intencionalmente **sem acento**
> (identificadores de rede, não texto de UI). Isso é a exceção prevista em
> [pt-br-content.md](pt-br-content.md) — não "corrigir" para `operação`/`agente` acentuado.

## Canal `status` — presença do agente (retido + LWT)

O canal `status` carrega a **presença** do agente e é o sinal **autoritativo** de
"conectado" — **não** inferir presença do frescor da última posição: o GPS hiberna quando
o agente está parado (heartbeat a cada 5 min), então telemetria rala é NORMAL e não
significa queda. Ver [ADR-0004](../../docs/decisions/adr-0004-presenca-do-agente-mqtt-lwt.md).

- **Payload:** `agentStatusSchema` → `{ "online": boolean }`. Sem `agentId` no corpo — a
  identidade vem do tópico (regra 1 abaixo).
- **Ao conectar:** o agente publica `{online:true}` com **`retain: true`** e registra o
  **testamento (LWT)** `{online:false}` (também retido) no mesmo tópico.
- **Queda suja** (rede/processo/bateria): o **broker** publica o testamento quando o
  keepalive expira (~90 s). O aparelho não gasta nada — o keepalive já roda.
- **Saída limpa:** publicar `{online:false}` e só então `end(false)`; o DISCONNECT limpo
  faz o broker descartar o testamento.
- **`clientId` deve ser ESTÁVEL** (`agente_{agentId}`, sem timestamp): garante o takeover
  da sessão zumbi na reconexão, com o testamento dela saindo ANTES do novo `{online:true}`.
  Um id rotativo inverte a ordem e retém um `offline` falso.
- **A ponte da API ignora `status`** de propósito (presença é efêmera, mobile↔dashboard).

## Regras obrigatórias

1. **Identidade vem do tópico, nunca do payload.** Na ponte de ingest
   (`apps/api/src/plugins/mqtt.ts`), `operationId` e `agentId`/`senderId` são extraídos via
   `parseAgentTopic(topic)` — o payload carrega **apenas** a telemetria. Ignorar qualquer
   `operationId`/`agentId` que venha dentro do corpo da mensagem: o tópico é a fronteira de confiança.

2. **Tópico fora do padrão é descartado.** Se `parseAgentTopic` retornar `null`, a mensagem é ignorada
   (não persistir). Payload que falhe na validação Zod (`positionSampleSchema` / `messageSchema`) também
   é descartado com log de aviso — nunca gravar telemetria não validada.

3. **Escopo por operação em TODA rota REST.** Rotas que operam sobre uma operação devem chamar
   `assertOperationScope(request, reply, operationId)` de `apps/api/src/modules/scope.ts` logo após
   `app.authenticate`. Ela retorna `403` se o `operationId` não estiver em `claims.operationIds` do JWT.
   ```ts
   app.get('/operations/:id/positions', { onRequest: [app.authenticate] }, async (request, reply) => {
     const { id } = request.params as { id: string };
     if (!assertOperationScope(request, reply, id)) return;
     // ...toda query DAQUI PARA BAIXO já filtra por operationId
   });
   ```

4. **Toda query Mongo filtra por `operationId`.** Nenhuma consulta a `positions` / `messages` /
   `operations` pode omitir o filtro de operação. Não existe "buscar tudo" sem escopo, mesmo para admin —
   o escopo vem sempre dos `operationIds` do token.

5. **Menor privilégio na assinatura.**
   - **Agente (mobile):** publica/assina apenas o próprio `operacao/{opId}/agente/{agentId}/#` e recebe
     `operacao/{opId}/broadcast`. Nunca assina wildcard de operação inteira.
   - **Dashboard:** assina `operacao/{opId}/#` **somente** para operações no escopo do admin.
   - **Ponte da API:** único cliente privilegiado que assina `operacao/+/agente/+/#` (ingest global).

## ACL do broker — faseado

- **MVP (HiveMQ Cloud):** credenciais gerenciadas + validação de escopo na ponte da API. O broker não
  aplica ACL dinâmica por JWT ainda; a fronteira efetiva é o `parseAgentTopic` + `assertOperationScope`.
- **On-prem (DTI):** ACL dinâmica por claims do JWT migra para EMQX / Mosquitto (`mosquitto-go-auth`),
  rejeitando na **camada de rede** a escuta/publicação fora de `operacao/{opId}/agente/{agentId}/#`.

Ao escrever a lógica de escopo hoje, assuma que o broker **ainda não** protege — a validação na API é
a única barreira. Não relaxar as verificações contando com ACL futura.

## Por que esta regra existe

O isolamento multitenant do Cerberus se apoia em dois pilares que precisam concordar: a **hierarquia de
tópicos** (quem pode falar/ouvir o quê) e o **escopo de `operationId` no JWT** (quem pode ler o quê no
banco). Hardcodar um tópico, confiar num `operationId` vindo do payload, ou esquecer o
`assertOperationScope` numa rota nova abre um vazamento entre operações — exatamente o que a arquitetura
Zero Trust existe para impedir. Centralizar tópicos em `topics.ts` e o escopo em `scope.ts` garante que
essa fronteira seja aplicada de forma idêntica nos três módulos.

## Relação com outras regras

- [geospatial-coordinates.md](geospatial-coordinates.md) — o payload de posição que trafega nos tópicos
  usa `{ lat, lng }` e é transposto para GeoJSON `[lng, lat]` na ponte.
- [database-models.md](database-models.md) — `receivedAt` é gerado no servidor na ingestão; nunca
  confiar em tempo de recepção do agente.
- [pt-br-content.md](pt-br-content.md) — nomes de tópico/payload MQTT ficam fora das regras de acentuação.
