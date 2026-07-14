# Plano — SuperAdmin, Equipes, Chat/Mapa e Zonas multiformato

Faseamento e prompts de implementação da expansão decidida em
[ADR-0003](../decisions/adr-0003-superadmin-equipes-chat-zonas.md). Cada fase vira uma **issue** (com o
bloco *Prompt de implementação* por [issue-prompts.md](../../.claude/rules/issue-prompts.md)). A Fase 1
destrava as demais; a Fase 4 (Zonas) é independente e pode correr em paralelo.

| Fase | Épica | Depende de |
| --- | --- | --- |
| 1 | SuperAdmin + RBAC + Painel Admin (inclui dispositivos/sessões) | — |
| 2 | Equipes + mensageria (equipe/DM) | Fase 1 |
| 3 | Chat UI + abas/split Chat‑Mapa | Fase 2 |
| 4 | Zonas multiformato (retângulo + livre) | — (isolada) |

Reaproveitamentos já mapeados: **CRUD de usuários já existe na API** (`/users`, falta UI); **E2EE já
sela para subconjunto de destinatários** (equipe/DM = escolher o subset); **`ResizableSidebar` já faz
drag-resize** (reusar no divisor do split); **`LiveMap` já tem handles arrastáveis de geofence**;
**`detect.ts` (haversine)** é a base para retângulo/polígono.

---

## Fase 1 — SuperAdmin + RBAC + Painel Admin

**Objetivo.** Introduzir o papel `superadmin` e um painel administrativo (UI) para CRUD de usuários e
operações, broadcast, configurações e **gestão de dispositivos/sessões**.

**Modelo de dados.**
- `Role` (`packages/shared`) += `superadmin`.
- `User`: adicionar `status`/`blocked` (bloqueio de conta) e (opcional) `createdBy`.
- Novo `Device`/`Session`: `{ userId, deviceId, platform, appVersion?, lastSeen, ip?, blocked, revokedAt }`.
- Novo `AuditLog`: `{ actorId, action, targetType, targetId, meta, createdAt }`.

**API.**
- RBAC: SA ignora `assertOperationScope`; `GET /operations` retorna todas para SA; `/users` permite SA
  criar/editar Admins e SAs (Admin só gerencia ACs das suas operações).
- Faltantes: `DELETE /operations/:id`; `POST /users/:id/reset-password`.
- Sessões: registrar/atualizar `Device` no `login` (token carrega `jti`/`deviceId`); `authenticate`
  passa a checar revogação/bloqueio; `GET /users/:id/devices`; `POST /devices/:id/kick` (revoga);
  `POST /devices/:id/block` e `/unblock`; `POST /users/:id/block` e `/unblock`.
- Auditoria: registrar ações sensíveis (criar/excluir usuário, kick/block, broadcast, mudança de zona).

**Enforcement do kick/block (ver ADR-0003).** MVP: revogação na API (401) + app se desloga/para de
publicar ao detectar bloqueio; broker free não permite kick por usuário. On-prem (EMQX): corte na rede.

**UI (dashboard).** Regiões no sidebar (**Admin** | **Equipes**). Painel Admin com sub-abas:
Usuários (tabela + criar/editar/bloquear/reset senha; filtro por papel SA/Adm/AC), Operações
(criar/editar/arquivar/excluir; designar admins), Dispositivos (por usuário: lista + kick/block),
Broadcast institucional, Configurações (reusa `SettingsModal`). Visão global do SA: mapa com todas as
operações/equipes/agentes.

**Fora de escopo desta fase.** Equipes, chat, zonas.

### Prompt de implementação

Ao iniciar esta issue, ativar os prompts de
[docs/prompts/prompts-design-backend-senior.md](../prompts/prompts-design-backend-senior.md):

- **Backend Software Engineer Senior** — **Contexto desta issue:** novo papel `superadmin` com bypass
  de `assertOperationScope`; CRUD de usuários com hierarquia (SA gerencia Admins/ACs); `DELETE
  /operations`, reset de senha; modelo `Device`/`Session` + revogação no `authenticate` (JWT deixa de
  ser stateless — usar `jti` + lookup com cache); rotas de kick/block; `AuditLog`. Isolar SA sem
  vazar escopo entre operações comuns.
- **UX/UI Design Senior** — **Contexto desta issue:** sidebar com regiões (Admin/Equipes); painel Admin
  (tabelas de Usuários/Operações/Dispositivos, formulários, estados de bloqueio); visão global do SA no
  mapa. Dark mode/glassmorphism, acessibilidade e contraste ([ui-contrast.md](../../.claude/rules/ui-contrast.md)).

---

## Fase 2 — Equipes + mensageria (equipe/DM)

**Objetivo.** Equipes como sub-grupos da operação; enviar mensagem/mídia para a equipe (todos os ACs) e
DM para um AC específico, com E2EE e isolamento por tópico.

**Modelo de dados.**
- `Team`: `{ operationId, name, agentIds[] (⊆ agentes da op), leadId?, color?, createdBy }`.
- `Message`: adicionar `teamId?` e `recipientId?` (DM); persistência escopada por `operationId` +
  `teamId`/`recipientId`.

**Tópicos MQTT** (`packages/shared/src/topics.ts` — fonte única):
- `teamBroadcastTopic(op, teamId)` → `operacao/{op}/equipe/{teamId}/broadcast`.
- `agentInboxTopic(op, agentId)` → `operacao/{op}/agente/{agentId}/inbox` (DM central→agente).
- Estender `parseAgentTopic` para reconhecer equipe/inbox (identidade continua vindo do tópico).

**API.**
- `Team` CRUD (`/operations/:id/teams`, `.../teams/:tid`, `.../teams/:tid/members`).
- Envio: `POST /operations/:id/teams/:tid/messages` (sela p/ membros da equipe → publica no
  `teamBroadcastTopic`); `POST /operations/:id/agents/:agentId/messages` (DM: sela p/ o AC → publica no
  `agentInboxTopic`). Persistir só `ciphertext` (nunca claro).
- Leitura: `GET` do histórico filtrado por `teamId`/`recipientId` (escopado).

**E2EE.** `sealMessage(txt, sk, membros)` — subconjunto do diretório (`GET /operations/:id/keys`). Sem
cripto nova; reusa o pipeline de mídia (GridFS opaco + envelope) para fotos/arquivos.

**Mobile.** Assinar `teamBroadcastTopic` da(s) equipe(s) do agente + `agentInboxTopic` próprio; UI para
receber/responder em equipe e DM.

**Fora de escopo.** UI de chat no dashboard (Fase 3).

### Prompt de implementação

- **Backend Software Engineer Senior** — **Contexto desta issue:** modelo `Team` (sub-grupo da
  operação); tópicos de equipe/inbox em `topics.ts` + parse; rotas de mensagem de equipe/DM que **selam
  para o subconjunto** e publicam no tópico certo; escopo multitenant preservado
  ([mqtt-multitenant.md](../../.claude/rules/mqtt-multitenant.md)); nunca persistir conteúdo em claro
  ([ADR-0002](../decisions/adr-0002-e2ee-mensagens.md)). Ajustar a assinatura do serviço MQTT do app.
- **UX/UI Design Senior** — **Contexto desta issue (mobile):** telas de equipe e DM no app (lista de
  equipes, thread, compositor, mídia).

---

## Fase 3 — Chat UI + abas/split Chat‑Mapa (dashboard)

**Objetivo.** Aba **Equipes** no sidebar (árvore equipe → ACs); área central com **Chat | Mapa** em abas
**ou** lado a lado (split) com **divisor arrastável** (DnD).

**UI.**
- Árvore de equipes (2 níveis: equipe → ACs); selecionar equipe = chat do grupo, selecionar AC = DM.
- Container Chat/Mapa: modo abas e modo split; divisor arrastável reusando a lógica de
  `ResizableSidebar`; preferência (abas vs split, larguras) persistida (localStorage + preferência do
  usuário).
- Painel de Chat: lista de mensagens + compositor + upload de mídia/arquivo (reusa E2EE + `AuthImage` +
  GridFS). O dashboard passa a **assinar** os tópicos de equipe/DM via MQTT (hoje faz polling REST).

**Fora de escopo.** Backend (feito na Fase 2).

### Prompt de implementação

- **UX/UI Design Senior** — **Contexto desta issue:** árvore de equipes/ACs no sidebar; container
  Chat/Mapa com abas + split redimensionável (DnD no divisor); painel de chat E2EE com mídia. Dark
  mode, responsividade, estados de conexão do socket, acessibilidade/contraste.
- **Backend Software Engineer Senior** — **Contexto desta issue:** ajuste no cliente MQTT do dashboard
  (assinar equipe/DM; decifrar histórico), reuso do diretório de chaves.

---

## Fase 4 — Zonas multiformato (retângulo + livre) — *isolada*

**Objetivo.** Zonas em 3 formatos (círculo atual + retângulo + livre), com editor no mapa.

**Modelo de dados.** `Geofence` += `shape: 'circle'|'rectangle'|'polygon'` + geometria discriminada
(círculo: `radiusMeters`; retângulo: `widthMeters`+`heightMeters`+`rotationDeg`; polígono: `vertices`).
Retrocompat: sem `shape` ⇒ `circle`.

**Detecção** (`detect.ts` + bridge + `recompute`). Círculo: haversine (atual). Retângulo: rotaciona o
ponto `−rotationDeg` em torno do centro e testa meia-largura/altura. Polígono: `pointInPolygon`
(ray-casting). Manter o índice para consultas (avaliar `$geoWithin` só se necessário).

**UI (`LiveMap` + form de criação).**
- Seletor de forma na criação (círculo/retângulo). A forma **livre** surge de um botão "converter em
  livre" a partir de um círculo/retângulo (gera o polígono inicial).
- Handles por tipo: círculo (centro, raio — já existe); retângulo (centro; borda direita = largura;
  borda inferior = altura; vértice sup. direito = rotação); polígono (arrastar vértice; **duplo-clique
  na aresta adiciona vértice**, estilo clippy — alças nos vértices + "add" nos midpoints).
- Generalizar o render (hoje o círculo já é um anel de 64 pontos) para desenhar qualquer polígono.

**Fora de escopo.** Alertas/UX de lista de zonas mudam pouco (só o editor/criação).

### Prompt de implementação

- **Backend Software Engineer Senior** — **Contexto desta issue:** `Geofence` com `shape` + geometria
  discriminada; `pointInRect`/`pointInPolygon` em `detect.ts`; atualizar bridge e `recompute`; validação
  Zod das geometrias; retrocompat (sem `shape` ⇒ círculo). Coordenadas `[lng,lat]`
  ([geospatial-coordinates.md](../../.claude/rules/geospatial-coordinates.md)).
- **UX/UI Design Senior** — **Contexto desta issue:** editor de zonas no `LiveMap` — seletor de forma,
  handles de retângulo (largura/altura/rotação) e editor de polígono livre (arrastar vértice, duplo-
  clique adiciona), inspirado no clippy. Feedback visual claro, dark mode, acessibilidade.
