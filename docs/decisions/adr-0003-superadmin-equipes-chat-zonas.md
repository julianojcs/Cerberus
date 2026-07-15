# ADR 0003 — SuperAdmin, Equipes, Chat/Mapa e Zonas multiformato

- **Status:** Aceita (planejamento). Implementação **faseada** — ver
  [docs/plans/epico-superadmin-equipes-chat-zonas.md](../plans/epico-superadmin-equipes-chat-zonas.md).
- **Data:** 2026-07-13
- **Regras relacionadas:** [mqtt-multitenant.md](../../.claude/rules/mqtt-multitenant.md),
  [geospatial-coordinates.md](../../.claude/rules/geospatial-coordinates.md),
  [database-models.md](../../.claude/rules/database-models.md),
  [pt-br-content.md](../../.claude/rules/pt-br-content.md)

## Contexto

A coordenação pediu uma expansão em quatro frentes: um **painel administrativo** com um papel
**SuperAdmin** acima do Admin; **Equipes** (grupos de mensagem no estilo WhatsApp); uma **área central
com Chat e Mapa** (em abas ou lado a lado); e **Zonas com três formatos** (círculo, retângulo e livre).
São mudanças estruturais (modelo de dados, RBAC, mensageria, UI) que atravessam os três módulos —
por [refactoring.md](../../.claude/rules/refactoring.md), as decisões precisam ser fixadas antes de
codar. Este ADR registra as decisões; o faseamento e os prompts de implementação estão no plano.

## Decisões

### 1. SuperAdmin como novo papel (`Role = 'superadmin'`)

O RBAC já é baseado em `role` (`requireRole`), então SA entra como **novo valor do enum `Role`**, acima
de `admin`. O SA **ignora o escopo de operação** (`assertOperationScope` retorna `true` para SA; `GET
/operations` devolve todas). Admin continua escopado às suas `operationIds`.

**Escopo funcional do SA:** CRUD global de usuários (SA/Admin/AC), operações (inclui `DELETE`, hoje
inexistente) e equipes; broadcast institucional (todas as operações); **auditoria**; oversight de chaves
E2EE (quem provisionou; forçar rotação/revogação); e **gestão de dispositivos e sessões** (abaixo).

**Gestão de dispositivos/sessões (SA):** listar os dispositivos usados por cada usuário e **derrubar
(kick)** ou **bloquear** qualquer dispositivo ou Agente de Campo. Introduz um modelo `Device`/`Session`
(`userId`, `deviceId`, `platform`, `lastSeen`, `blocked`, `revokedAt`) e um `jti` no JWT. O
*enforcement* é **faseado**, alinhado ao ADR-0001 (ACL do broker é on-prem):

- **MVP (HiveMQ Cloud free + credencial de broker compartilhada):** kick/block é aplicado na **camada
  da API/app** — revogar a sessão (`revokedAt`) → `authenticate` passa a checar a revogação → `401`; a
  flag `blocked` no usuário/dispositivo faz o app se **deslogar e parar de publicar** no próximo
  heartbeat. O broker free **não** permite kick nem ACL por usuário (todos os clientes usam a mesma
  credencial estática — ver ADR do deploy). Logo, no MVP o corte é *best-effort* (o dispositivo pode
  seguir publicando no broker até o app se autoverificar).
- **On-prem (EMQX + ACL por JWT):** kick/block passa a valer na **camada de rede** (o broker rejeita a
  reconexão do token revogado/bloqueado).

**Consequência:** o JWT deixa de ser **puramente stateless** — o `authenticate` passa a consultar a
revogação (lista/lookup, com cache). Mantemos expiração curta + `POST /auth/refresh` para limitar a
janela de um token revogado.

### 2. Equipe como sub-grupo da operação

`Team = { operationId, name, agentIds[] (⊆ agentes da operação), leadId? }`. A equipe **pertence a uma
operação**; isso **preserva o isolamento multitenant** (tudo continua escopado por `operationId`) e
**reusa o diretório de chaves E2EE** da operação. SA vê todas; Admin gerencia as equipes das suas
operações.

### 3. Mensageria de equipe/DM: tópico por equipe + selar só para os membros

Novos tópicos (fonte única em `packages/shared/src/topics.ts`):
`teamBroadcastTopic(op, teamId)` → `operacao/{op}/equipe/{teamId}/broadcast`; DM central→agente
`agentInboxTopic(op, agentId)` → `operacao/{op}/agente/{agentId}/inbox`. O `parseAgentTopic` ganha os
ramos de equipe/inbox.

**E2EE:** a mensagem é selada com `sealMessage` para o **subconjunto** de destinatários (membros da
equipe, ou o AC no DM) — a primitiva já suporta subset por destinatário, então **não há cripto nova**.
Isso dá isolamento **na rede** (só quem assina o tópico recebe) **e na cripto** (só os membros
decifram). O mobile passa a assinar o tópico da sua equipe + o `inbox`; o dashboard passa a **assinar**
esses tópicos (hoje ele faz polling REST das mensagens).

### 4. Zonas: geometria discriminada paramétrica

`Geofence` ganha `shape: 'circle' | 'rectangle' | 'polygon'` + geometria por tipo:

| shape | Geometria | Ajustes (handles) |
| --- | --- | --- |
| `circle` | `center` + `radiusMeters` (atual) | mover centro; raio |
| `rectangle` | `center` + `widthMeters` + `heightMeters` + `rotationDeg` | mover centro; largura (borda direita); altura (borda inferior); rotação (vértice sup. direito) |
| `polygon` (livre) | `vertices: [[lng,lat], …]` | arrastar vértice; **duplo-clique numa aresta adiciona vértice** |

A forma **livre** nasce **convertendo** um círculo/retângulo em polígono (anel de N pontos / 4 cantos).
Detecção por tipo (no bridge e no `recompute`): círculo = haversine (atual); retângulo = transforma o
ponto para o referencial local (rotaciona `−rotationDeg` em torno do centro) e testa meia-largura/
altura; polígono = *ray-casting* (`pointInPolygon`). Guardar os parâmetros nativos (raio/rotação)
mantém os handles simples; a alternativa "tudo vira GeoJSON Polygon" foi descartada por perder esses
parâmetros. Retrocompat: documentos sem `shape` são tratados como `circle`.

## Consequências

- **Migração:** `Role` += `superadmin`; novos modelos `Team` e `Device`/`Session`; `Geofence` ganha
  `shape` + geometria (retrocompatível: sem `shape` ⇒ círculo); `Message` ganha `teamId?`/`recipientId?`.
- **Segurança:** kick/block **real** depende do on-prem (EMQX); no MVP é *best-effort* na API/app.
  Introduz **auditoria** (hoje inexistente) e revogação de sessão (JWT deixa de ser 100% stateless).
- **E2EE de grupo/DM** reusa a primitiva existente (subset de destinatários) — sem cripto nova; o custo
  do envelope cresce com o nº de membros (limite de `ciphertext` já é folgado).
- **Faseamento:** 4 épicas independentes o suficiente para paralelizar (Zonas é isolada); a Fase 1 (SA +
  RBAC) destrava as demais. Detalhe e prompts em
  [docs/plans/epico-superadmin-equipes-chat-zonas.md](../plans/epico-superadmin-equipes-chat-zonas.md).
