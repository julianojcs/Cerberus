# Plano de Implementação — Plataforma Cerberus

## Contexto

O **Cerberus** é uma plataforma de missão crítica de **monitoramento posicional contínuo** e
**comunicações operacionais táticas** para a Polícia Federal (idealizada pelo NTI/MG, subordinação
DTI/Brasília). Fornece consciência situacional em tempo real para gerência centralizada de múltiplas
equipes de campo em: cumprimento de mandados de busca/apreensão, proteção de dignitários e escolta de
comboios.

A arquitetura (alusão ao cão de três cabeças) possui três camadas sobre um barramento de geolocalização:

1. **API de Serviços (Servidor Central)** — Node.js + Fastify
2. **Aplicação Móvel de Campo (Agentes)** — React Native (Expo)
3. **Dashboard de Controle (Administração Central)** — Next.js / React

Apoiadas por: **barramento MQTT** (tempo real), **MongoDB** (persistência + índices geoespaciais
`2dsphere`), e uma arquitetura **Zero Trust** (multitenant por `operation_id`, JWT, ACL de tópicos,
TLS 1.3, e E2EE AES-256 em fase posterior).

**Estado atual do repositório:** greenfield. Só existem `docs/Documentacao_Tecnica_Cerberus.pdf` e
ativos de marca em [assets/brand/](assets/brand/). Nenhum código-fonte ainda.

**Decisões confirmadas com o usuário:**
- **Ambiente:** código portátil (12-factor via `.env`), mas **deploy inicial no stack gratuito** (Render + MongoDB Atlas M0 + HiveMQ Cloud); migração DTI on-prem é fase posterior.
- **Linguagem:** **TypeScript** em toda a stack, com pacote de tipos/contratos compartilhado.
- **Segurança:** **transporte primeiro** (TLS 1.3 + JWT + ACL de tópico); **E2EE AES-256 em fase dedicada** após a telemetria ponta-a-ponta funcionar.
- **Entrega:** **fatia vertical primeiro** (agente → API/MQTT → mapa ao vivo), depois ampliar.

---

## Arquitetura de Alto Nível

```
┌──────────────┐   MQTTS (publish posição/msg)      ┌──────────────────┐
│  App Móvel   │ ─────────────────────────────────► │  Broker MQTT     │
│ (Expo/RN)    │ ◄───────────────────────────────── │ (HiveMQ→EMQX)    │
└──────────────┘   broadcast central → agente        └───────┬──────────┘
      │ HTTPS (login/auth, upload mídia, histórico)          │ ▲
      ▼                                                       │ │ subscribe (bridge)
┌──────────────┐   REST/HTTPS         ┌──────────────┐        │ │
│  Dashboard   │ ──────────────────►  │ API Fastify  │ ◄──────┘ │ persiste telemetria
│  (Next.js)   │                      │ (Servidor    │ ─────────┘
│              │ ◄── MQTT sobre WSS ──┤  Central)    │
└──────────────┘  (plotagem ao vivo)  └──────┬───────┘
       ▲ subscribe operacao/{id}/#           │ Mongo driver
       └─────────────────────────────────────┼──────────────►┌──────────────┐
                                              └──────────────►│  MongoDB     │
                                                              │ (2dsphere)   │
                                                              └──────────────┘
```

- **Telemetria** trafega **agente → broker → API (bridge/subscriber) → MongoDB** e, em paralelo,
  **broker → dashboard** (MQTT sobre WebSockets) para plotagem, evitando gargalo no banco (conforme doc).
- **Regras de negócio, auth, histórico e mídia** trafegam via **REST na API Fastify**.

---

## Estrutura de Monorepo (npm/pnpm workspaces + Turborepo)

```
Cerberus/
├─ package.json                 # workspaces + scripts raiz (turbo)
├─ turbo.json                   # pipeline build/dev/lint/test
├─ tsconfig.base.json           # config TS compartilhada
├─ docker-compose.yml           # dev local: mongo + mosquitto (espelha prod)
├─ .env.example                 # padrão do doc (PORT, MONGO_URI, MQTT_BROKER_URL, JWT_SECRET…)
├─ packages/
│  └─ shared/                   # tipos, DTOs, zod schemas, taxonomia de tópicos MQTT, constantes
├─ apps/
│  ├─ api/                      # Fastify (Servidor Central)
│  ├─ dashboard/                # Next.js (Administração Central)
│  └─ mobile/                   # Expo React Native (Agentes)
└─ docs/                        # documentação existente
```

Os ativos de marca em [assets/brand/](assets/brand/) serão reaproveitados em
`apps/dashboard/public/` e `apps/mobile/assets/`.

### `packages/shared` (contratos — base de tudo)
- **Tipos/DTOs:** `Position`, `Message`, `Operation`, `AgentStatus`, `AuthClaims` (inclui `operationId`, `agentId`, `role`).
- **Schemas de validação (zod):** reusados na API (validação de entrada) e no cliente.
- **Taxonomia de tópicos MQTT** (funções `buildTopic`/`parseTopic`) — fonte única de verdade:
  - `operacao/{operationId}/agente/{agentId}/posicao`
  - `operacao/{operationId}/agente/{agentId}/mensagem`
  - `operacao/{operationId}/broadcast`
  - Dashboard (admin) assina `operacao/{operationId}/#`.
- **Constantes:** `Role` (`admin` | `agente`), `OperationType` (`mandado` | `escolta` | `protecao`), `OperationStatus`.

---

## Módulo 1 — API de Serviços (`apps/api`, Fastify + TS)

**Stack:** Fastify, `@fastify/jwt`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`,
`@fastify/multipart` (upload mídia), Mongoose (schemas + índice `2dsphere`), `mqtt` (cliente-ponte),
`argon2` (hash de senha), zod/typebox (validação).

**Estrutura:**
```
apps/api/src/
├─ server.ts                # bootstrap Fastify + registro de plugins
├─ config/env.ts            # leitura/validação de .env (12-factor)
├─ plugins/{jwt,mongo,mqtt,security}.ts
├─ modules/
│  ├─ auth/                 # POST /auth/login, /auth/refresh; emissão JWT com escopo
│  ├─ operations/           # CRUD operações (multitenant operation_id)
│  ├─ agents/               # gestão de agentes/dispositivos
│  ├─ positions/            # GET histórico + consultas geoespaciais (proximidade)
│  ├─ messages/             # histórico de mensagens
│  └─ media/                # upload/download (GridFS no MVP)
├─ bridge/mqtt-ingest.ts    # subscriber que persiste posição/mensagem no Mongo
└─ models/                  # schemas Mongoose (users, operations, positions, messages)
```

**Responsabilidades-chave:**
- **Auth/JWT:** login → JWT com claims `{ operationId(s), agentId, role }`. Esse token é reusado como
  credencial de conexão no broker MQTT (base para ACL).
- **Ponte MQTT (ingest):** a API conecta ao broker como cliente privilegiado, assina os tópicos de
  posição/mensagem e **persiste no MongoDB** (desacopla escrita do broker de plotagem no dashboard).
- **Consultas geoespaciais:** endpoints de proximidade/geofencing usando índice `2dsphere`.
- **Multitenant:** toda query obrigatoriamente filtrada por `operationId`; middleware valida escopo do JWT.

**Modelo de dados MongoDB (Mongoose):**
- `users` — `role`, `passwordHash`, `assignedOperations[]`.
- `operations` — `operationId`, `name`, `type`, `status`, `geofences[]`, `createdBy`.
- `positions` — `operationId`, `agentId`, `location:{type:'Point',coordinates:[lng,lat]}`, `accuracy`,
  `speed`, `heading`, `battery`, `activity`, `ts`. **Índices:** `2dsphere` em `location`; composto
  `(operationId, agentId, ts)`.
- `messages` — `operationId`, `senderId`, `type` (`text`|`media`), `payload`/`ciphertext` (E2EE fase 2),
  `mediaRef`, `ts`.
- Mídia via **GridFS** (Atlas no MVP).

---

## Módulo 2 — Aplicação Móvel de Campo (`apps/mobile`, Expo RN + TS)

**Ponto crítico:** `react-native-background-geolocation` (Transistor Software) é módulo nativo →
requer **Expo Dev Client / EAS Build** (não roda no Expo Go). Usar o **config plugin** do pacote.

**Stack:** Expo (Dev Client + EAS), `react-native-background-geolocation`, `mqtt` (MQTT.js sobre WSS),
`expo-secure-store` (JWT/chaves), `react-native-maps` (visualização local), `expo-camera`/image-picker (mídia).

**Estrutura:**
```
apps/mobile/
├─ app.config.ts            # config plugin do background-geolocation + Application Key
├─ src/
│  ├─ screens/{Login,Operation,Map,Messaging,Media,Settings}.tsx
│  ├─ services/
│  │  ├─ geolocation.ts     # config Transistor + handlers onLocation/onMotionChange
│  │  ├─ mqtt.ts            # conexão MQTTS/WSS + publish nos tópicos do shared
│  │  ├─ outbox.ts          # buffer/resiliência offline (zona de sombra)
│  │  └─ auth.ts            # login + storage seguro do JWT
│  └─ store/                # estado do app
```

**Comportamento conforme spec:**
- **Gerenciamento dinâmico de energia:** configurar o plugin (activity recognition via acelerômetro/giroscópio):
  estático → GPS hiberna (heartbeat 5 min); em deslocamento → sobe para intervalo operacional da central
  (`distanceFilter`, `desiredAccuracy`, `stopTimeout`, `heartbeatInterval`).
- **Resiliência de rede:** buffer local criptografado nativo do plugin + `outbox.ts` para republicar via
  MQTT ao restabelecer conectividade (descarga assíncrona em lote).
- **Fluxo:** login → JWT + escopo da operação → inicia BackgroundGeolocation → `onLocation` publica em
  `operacao/{opId}/agente/{agentId}/posicao`. Recebe broadcasts da central; envia mensagens/mídia.
- **Licenciamento:** MVP em modo debug (sem restrição); binário oficial usa plano **Starter (1 Application Key)** por bundle id.

---

## Módulo 3 — Dashboard de Controle (`apps/dashboard`, Next.js + TS)

**Stack:** Next.js (App Router) + React, MQTT.js (sobre WSS) para tempo real, **MapLibre GL JS** (ou
Leaflet + OSM, sem chave) para o mapa, TanStack Query (dados REST/histórico), Tailwind (UI).

**Estrutura:**
```
apps/dashboard/src/
├─ app/(auth)/login/…
├─ app/operations/…              # lista de operações
├─ app/operations/[id]/live/…    # mapa ao vivo (posições + rastros)
├─ app/operations/[id]/history/… # replay histórico (via API/Mongo)
├─ lib/mqtt.ts                   # cliente MQTT sobre WSS + subscribe operacao/{id}/#
├─ lib/api.ts                    # cliente REST (auth, CRUD, histórico)
└─ components/{Map,AgentMarker,MessagesPanel,OperationForm}.tsx
```

**Responsabilidades:**
- **Plotagem em tempo real:** conecta ao broker via **WSS com JWT admin**, assina `operacao/{id}/#`,
  plota marcadores/rotas dos agentes ao vivo (sem passar pelo banco — conforme doc).
- **Gestão:** CRUD de operações/agentes/usuários; atribuição de escopo (`operation_id`).
- **Histórico/geofencing:** replay de rotas e consultas de proximidade via API.
- **Comunicação:** painel de mensagens táticas e broadcast central → agentes.

---

## Segurança (Zero Trust) — faseada

**Fase 1 (com o núcleo):**
- **TLS 1.3** em todo tráfego externo (HTTPS + MQTTS); proibido texto claro.
- **JWT** em toda requisição REST e na conexão MQTT.
- **ACL de tópicos** no broker: agente só publica/assina o próprio `operacao/{opId}/agente/{agentId}/#`;
  escuta fora de escopo rejeitada na camada de rede. (No MVP HiveMQ Cloud, credenciais gerenciadas +
  validação na ponte da API; ACL dinâmica por JWT migra para EMQX/Mosquitto on-prem — `mosquitto-go-auth`/JWT.)
- **Isolamento multitenant** por `operation_id` em todas as queries.
- `helmet`, `cors`, `rate-limit`, hashing `argon2`, validação zod.

**Fase 2 (dedicada):**
- **E2EE AES-256-GCM** de payloads sensíveis/imagens: cifrado no dispositivo do agente; **decifrado
  estritamente na estação do administrador** (dashboard). Banco/broker nunca veem texto claro.
- Troca/derivação de chaves por operação; gestão de ciclo de vida de chaves.

---

## Roadmap de Entrega (fatia vertical primeiro)

- **Fase 0 — Fundações:** monorepo (workspaces + Turborepo), `tsconfig.base`, `packages/shared` (tipos +
  taxonomia MQTT + zod), `docker-compose.yml` (mongo + mosquitto), `.env.example`, lint/format (ESLint+Prettier),
  esqueleto de CI.
- **Fase 1 — Fatia vertical (E2E fino):** ⭐ objetivo = *agente se move → aparece no mapa ao vivo*.
  - API: `/health`, login com usuário semeado (JWT), ponte MQTT → grava `positions`, `GET /positions`.
  - Broker: mosquitto local (dev) / HiveMQ Cloud.
  - Mobile: login + BackgroundGeolocation + publish de posição via MQTT.
  - Dashboard: login + mapa ao vivo assinando MQTT/WSS.
- **Fase 2 — Auth & núcleo multitenant:** modelo completo de usuários/roles, CRUD de operações, escopo
  `operation_id`, claims JWT, **ACLs de tópico** aplicadas.
- **Fase 3 — Comunicações & mídia:** mensagens táticas (texto), captura/upload de mídia (GridFS),
  histórico, broadcast central → agentes.
- **Fase 4 — Telemetria avançada:** ajuste do gerenciamento dinâmico de energia, buffer offline/resiliência,
  **replay histórico** de rotas, **geofencing** (`2dsphere`, alertas enter/exit).
- **Fase 5 — E2EE:** AES-256 no payload + troca de chaves + decrypt no dashboard.
- **Fase 6 — Hardening & deploy:** deploy MVP (Render + Atlas M0 + HiveMQ); depois trilha de migração DTI
  (Docker/K8s, MongoDB Replica Set 3 nós, broker on-prem EMQX/Mosquitto, proxy Nginx/Traefik + certificados
  ICP-Brasil), observabilidade, backups.

---

## Arquivos/artefatos críticos a criar

- Raiz: `package.json` (workspaces), `turbo.json`, `tsconfig.base.json`, `docker-compose.yml`, `.env.example`.
- `packages/shared/src/{types,schemas,topics,constants}.ts`.
- `apps/api/src/server.ts`, `plugins/{mongo,mqtt,jwt}.ts`, `bridge/mqtt-ingest.ts`, `models/*`, `modules/*`.
- `apps/mobile/app.config.ts`, `src/services/{geolocation,mqtt,outbox,auth}.ts`, `src/screens/*`.
- `apps/dashboard/src/lib/{mqtt,api}.ts`, `app/operations/[id]/live/*`, `components/Map.tsx`.

---

## Verificação (end-to-end)

**Ambiente local:**
1. `docker-compose up` (mongo + mosquitto), `turbo dev` (api + dashboard).
2. Semear 1 operação + 1 agente + 1 admin.
3. Rodar mobile via Expo Dev Client em dispositivo/emulador; fazer login.
4. **Teste E2E da fatia vertical:** caminhar/deslocar com o dispositivo → confirmar marcador se movendo no
   mapa do dashboard **em tempo real**.
5. Publicar posição de teste via `mosquitto_pub` no tópico `operacao/{id}/agente/{id}/posicao` → confirmar
   documento em `positions` com `location` GeoJSON e índice `2dsphere`.

**Automatizado:**
- **Unit (vitest):** `buildTopic`/`parseTopic`, validação zod, emissão/verificação de JWT.
- **Integração API:** `fastify.inject()` + `mongodb-memory-server`; testes de escopo multitenant e ACL de tópico.
- **Dashboard (Playwright):** login → mapa recebe atualização MQTT simulada.
- **CI:** `turbo lint build test` em cada push.

**Critério de aceite da Fase 1:** posição publicada pelo app aparece no mapa do dashboard em < 2 s e é
persistida no MongoDB com índice geoespacial válido.
