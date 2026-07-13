# Guia — Deploy do MVP (backend público: Render + Atlas M0 + HiveMQ)

Como publicar a **API do Cerberus** no stack gratuito para o app funcionar sobre **dados móveis**
(4G/Wi‑Fi externo), não só na LAN. O código é 12‑factor — trocar de infra é só variável de ambiente
(ver [config/env.ts](../../apps/api/src/config/env.ts)). O empacotamento está em
[apps/api/Dockerfile](../../apps/api/Dockerfile) e o blueprint em [render.yaml](../../render.yaml).

> **Escopo:** este runbook cobre a **API** + **banco** + **broker**. O deploy do **dashboard**
> (Next.js na Vercel) e a migração **DTI on‑prem** ficam na épica da Fase 6 (#8).

---

## Visão geral

```
Agente (Expo)  ─┐                          ┌─ MongoDB Atlas M0 (mongodb+srv, TLS)
                ├─ HTTPS ─► API no Render ──┤
Dashboard (web)─┘         (Docker, /health) └─ HiveMQ Cloud (mqtts 8883 / wss 8884)
```

A API é o único serviço que hospedamos aqui; banco e broker são serviços gerenciados gratuitos.

---

## 1. MongoDB Atlas (M0 — grátis)

1. Crie uma conta em [mongodb.com/atlas](https://www.mongodb.com/atlas) e um cluster **M0**.
2. **Database Access** → crie um usuário (ex.: `cerberus_api`) com senha forte e papel *readWrite*.
3. **Network Access** → libere o acesso do Render. O jeito simples no MVP é `0.0.0.0/0`
   (qualquer IP) — aceitável porque o usuário/senha + TLS protegem a conexão. Endurecer com a
   lista de IPs de saída do Render é um follow‑up.
4. **Connect** → *Drivers* → copie a URI: `mongodb+srv://cerberus_api:<senha>@<cluster>.mongodb.net/`.
   Acrescente o nome do banco: `.../cerberus`. Essa é a `MONGO_URI`.

## 2. HiveMQ Cloud (Serverless — grátis)

1. Crie uma conta em [hivemq.cloud](https://www.hivemq.cloud/) e um cluster gratuito.
2. **Access Management** → crie credenciais (usuário/senha) para a **ponte da API**.
3. Anote os endpoints do cluster:
   - **API (ponte)** → `MQTT_BROKER_URL = mqtts://<cluster>.hivemq.cloud:8883` (TLS).
   - **Dashboard/App (WebSockets)** → `wss://<cluster>.hivemq.cloud:8884/mqtt` (usado depois em
     `NEXT_PUBLIC_MQTT_WS_URL` / `EXPO_PUBLIC_MQTT_WS_URL`).

> A ponte da API conecta via `mqtts://` com usuário/senha (ver
> [plugins/mqtt.ts](../../apps/api/src/plugins/mqtt.ts)); o TLS é implícito no esquema `mqtts`.

## 3. API no Render (Docker, grátis)

1. Faça push do repositório para o GitHub (já é o caso).
2. No [Render](https://render.com/): **New → Blueprint** e aponte para o repo — ele lê o
   [render.yaml](../../render.yaml) e cria o serviço `cerberus-api` (Docker, plano free,
   health check em `/health`).
3. Preencha os **segredos** (marcados `sync: false` no blueprint) no painel do serviço:

   | Variável | Valor |
   | --- | --- |
   | `MONGO_URI` | a URI do passo 1 (com `/cerberus`) |
   | `MQTT_BROKER_URL` | `mqtts://<cluster>.hivemq.cloud:8883` |
   | `MQTT_USERNAME` / `MQTT_PASSWORD` | credenciais do passo 2 |
   | `CORS_ORIGINS` | URL do dashboard publicado (ex.: `https://cerberus.vercel.app`) |

   `JWT_SECRET` é **gerado pelo Render** (`generateValue`); `NODE_ENV`/`PORT`/`API_HOST`/
   `JWT_EXPIRES_IN` já vêm do blueprint.
4. **Deploy**. Ao subir, valide:
   ```bash
   curl https://cerberus-api.onrender.com/health
   # { "status":"ok", "mongo":"connected", "mqtt":"connected", ... }
   ```
   Se `mongo` vier `disconnected`, o serviço nem inicia (a conexão é aguardada no boot) —
   confira a `MONGO_URI` e o Network Access do Atlas.

> **Plano free do Render:** o serviço **hiberna** após ~15 min ocioso e leva alguns segundos para
> acordar na primeira requisição (cold start). Aceitável para homologação; produção usa um plano pago
> ou o on‑prem DTI.

## 4. Semear o banco (uma vez)

O seed cria admin, operação e um agente de teste. Rode da sua máquina apontando para o Atlas:

```bash
MONGO_URI="mongodb+srv://cerberus_api:<senha>@<cluster>.mongodb.net/cerberus" \
JWT_SECRET="qualquer_coisa_para_o_seed" \
MQTT_BROKER_URL="mqtt://localhost:1883" \
npm run api:seed
```

(O seed não usa MQTT; a `MQTT_BROKER_URL` só satisfaz a validação de env.)

## 5. Apontar dashboard e app para a API pública

> **Credencial do broker (HiveMQ Cloud free):** o HiveMQ gratuito **não valida JWT** (só tier pago),
> então o app e o dashboard apresentam a **credencial estática** `cerberus_api` (a mesma do passo 2)
> via as variáveis `*_MQTT_USERNAME` / `*_MQTT_PASSWORD`. Sem elas, os clientes são recusados pelo
> broker e o tempo real não sobe. No dev local (Mosquitto sem auth) e no on-prem (EMQX/Mosquitto com
> ACL por JWT), **deixe essas duas vazias** — os clientes caem em `jwt` + token automaticamente. A
> troca é só ambiente (12-factor); nenhum código muda.

- **Dashboard** (quando publicado na Vercel):
  ```
  NEXT_PUBLIC_API_URL=https://cerberus-api.onrender.com
  NEXT_PUBLIC_MQTT_WS_URL=wss://<cluster>.hivemq.cloud:8884/mqtt
  NEXT_PUBLIC_MQTT_USERNAME=cerberus_api
  NEXT_PUBLIC_MQTT_PASSWORD=<senha do passo 2>
  ```
- **App móvel** ([apps/mobile/.env](../../apps/mobile/.env), não versionado):
  ```
  EXPO_PUBLIC_API_URL=https://cerberus-api.onrender.com
  EXPO_PUBLIC_MQTT_WS_URL=wss://<cluster>.hivemq.cloud:8884/mqtt
  EXPO_PUBLIC_MQTT_USERNAME=cerberus_api
  EXPO_PUBLIC_MQTT_PASSWORD=<senha do passo 2>
  ```
  Rebuild/reabra o app. Com endpoints explícitos, o app **não** depende mais do IP do Metro/LAN —
  funciona sobre dados móveis.

## 6. Verificação fim‑a‑fim

1. `curl .../health` → `200` com `mongo: connected`.
2. Login no app com o agente semeado → sem "Network request failed".
3. Ligar o Rastreamento → posições chegam no dashboard (barramento HiveMQ) em tempo real.
4. Broadcast/texto/mídia E2EE fluindo (lembre: operador **e** agente precisam logar após o deploy
   para provisionar as chaves — ver [ADR 0002](../decisions/adr-0002-e2ee-mensagens.md)).

---

## Notas / follow‑ups

- **Tamanho da imagem:** o `npm ci` no monorepo instala também as deps de produção do dashboard
  (workspace). A imagem funciona, mas dá para enxugar excluindo o workspace do dashboard do build da
  API — otimização de follow‑up.
- **Segurança:** `CORS_ORIGINS` restrito ao domínio do dashboard; segredos só via env (nunca no
  código); Atlas com usuário/senha + TLS. Endurecer o Network Access do Atlas (IPs do Render) e a ACL
  dinâmica do broker é trabalho da fase on‑prem (ver [ADR 0001](../decisions/adr-0001-acl-multitenant-faseada.md)).
- **Cold start:** para evitar a hibernação no free tier, um ping periódico em `/health` (cron externo)
  mantém o serviço acordado — opcional no MVP.
