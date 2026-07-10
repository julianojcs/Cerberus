# Guia — Executar e testar o Cerberus localmente (manual)

Como subir a stack e verificar **a fatia vertical (agente → API/MQTT → mapa ao vivo)** manualmente, na
máquina de desenvolvimento. Para a montagem da infra (WSL, Docker, Mosquitto/Mongo nativos, bloqueios do
Windows), veja [infra-local-windows-wsl.md](infra-local-windows-wsl.md).

---

## 0. Pré-requisitos (uma vez)

| Item | Como |
| --- | --- |
| **MongoDB** ouvindo em `localhost:27017` | Serviço nativo do Windows (ou `docker compose up -d` dentro do WSL) |
| **Mosquitto** ouvindo em `1883` (MQTT) e `9001` (WebSockets) | Serviço nativo do Windows — ver runbook de infra |
| **`.env`** na raiz do repo | `cp .env.example .env` e preencher (abaixo) |
| **Dependências** | `npm install` |

`.env` mínimo (a API carrega via `--env-file-if-exists`; o dashboard usa os defaults se não definir):
```dotenv
MONGO_URI=mongodb://localhost:27017/cerberus
MQTT_BROKER_URL=mqtt://localhost:1883
JWT_SECRET=<um segredo com 8+ caracteres>
# Dashboard (opcional — estes já são os defaults):
# NEXT_PUBLIC_API_URL=http://localhost:3000
# NEXT_PUBLIC_MQTT_WS_URL=ws://localhost:9001
```

> **Nunca** coloque credenciais de produção no `.env`. Só `.env.example` é versionado.

---

## 1. Compilar o pacote compartilhado

Obrigatório após clonar ou alterar `packages/shared` (a API e o dashboard consomem o `dist/`):
```bash
npm run shared:build
```

## 2. Semear o banco (admin, operação, agente)

```bash
npm run api:seed
```
Saída (guarde o `OPERATION_ID`):
```
Senha (ambos):   cerberus123
Admin:           admin
Agente:          agente01  (agentId=AG-0456)
OPERATION_ID:    <id da operação>
AGENT_ID:        AG-0456
```

## 3. Subir os serviços da aplicação

**Tudo junto (API + Dashboard):**
```bash
npm run dev
```
Ou separadamente (dois terminais):
```bash
npm run api:dev        # API Fastify → http://localhost:3000
npm run dashboard:dev  # Dashboard Next.js → http://localhost:3001
```

Checagem rápida da API:
```bash
curl http://localhost:3000/health
# {"status":"ok","service":"cerberus-api",...}
```
Nos logs da API você deve ver `MongoDB connected` e `MQTT bridge connected to broker` +
`subscribed to operacao/+/agente/+/#`.

---

## 4. Verificação da fatia vertical (agente → mapa ao vivo)

### 4a. No browser
1. Abra `http://localhost:3001/login` e entre com **admin / cerberus123**.
2. Abra a operação em **Operações → (a operação semeada)** → mapa ao vivo
   (`/operations/<OPERATION_ID>/live`). O badge deve mostrar *"aguardando telemetria"* até a primeira posição.

### 4b. Simular a telemetria do agente

**Opção A — script utilitário (marcador "caminha" a cada 2s):**
```bash
# bash
OPERATION_ID=<id> AGENT_ID=AG-0456 node apps/api/scripts/publish-fake-position.mjs
```
```powershell
# PowerShell
$env:OPERATION_ID='<id>'; $env:AGENT_ID='AG-0456'; node apps/api/scripts/publish-fake-position.mjs
```

**Opção B — publicar uma posição única com `mosquitto_pub`:**
```bash
mosquitto_pub -h localhost -t "operacao/<id>/agente/AG-0456/posicao" \
  -m '{"lat":-19.9319,"lng":-43.9386,"accuracy":8,"capturedAt":"2026-07-10T12:00:00.000Z"}' -q 1
```
> **Windows/PowerShell:** o PowerShell **remove as aspas** do JSON em `-m` (o payload chega inválido e é
> descartado). Use um arquivo:
> ```powershell
> '{"lat":-19.9319,"lng":-43.9386,"accuracy":8,"capturedAt":"2026-07-10T12:00:00.000Z"}' | Set-Content -Encoding ascii pos.json
> & 'C:\Program Files\mosquitto\mosquitto_pub.exe' -h localhost -t 'operacao/<id>/agente/AG-0456/posicao' -f pos.json -q 1
> ```

### 4c. Resultados esperados
- **Mapa ao vivo:** o marcador do agente aparece/move; o badge vira *"barramento conectado"*
  (o dashboard recebe direto do broker via WebSocket `:9001` — não passa pelo banco).
- **Persistência (via REST):** obtenha um token e consulte a última posição:
  ```bash
  TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
    -H 'content-type: application/json' \
    -d '{"username":"admin","password":"cerberus123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

  curl -s "http://localhost:3000/operations/<OPERATION_ID>/positions/latest" \
    -H "authorization: Bearer $TOKEN"
  ```
  Deve retornar a posição com `lng`/`lat` (transpostos de `[lng,lat]` do GeoJSON).
- **Consulta de proximidade (2dsphere):**
  ```bash
  curl -s "http://localhost:3000/operations/<OPERATION_ID>/positions/nearby?lng=-43.9386&lat=-19.9319&meters=500" \
    -H "authorization: Bearer $TOKEN"
  ```

**Critério de aceite da Fase 1:** a posição publicada aparece no mapa em **< 2 s** e é persistida no Mongo
com índice `2dsphere` válido.

---

## 5. Testes automatizados

```bash
npm run test                          # unit + integração (Vitest) — shared + api
npm run test --workspace @cerberus/api        # só a API (inclui a ponte MQTT: mqtt.ingest.test.ts)
npm run test:e2e --workspace @cerberus/dashboard   # E2E do dashboard (Playwright) — precisa de chromium
npm run lint && npm run typecheck && npm run format:check   # os mesmos gates do CI
```
Primeira vez do E2E: `npx playwright install chromium` (dentro de `apps/dashboard`).

---

## 6. Troubleshooting rápido

| Sintoma | Causa provável / ação |
| --- | --- |
| API sai com "Configuração de ambiente inválida" | `.env` faltando `MONGO_URI`/`MQTT_BROKER_URL`/`JWT_SECRET`, ou rodou fora da raiz do workspace |
| `MQTT bridge error ECONNREFUSED` | Mosquitto não está no ar em `localhost:1883` (suba o serviço) |
| Mapa fica em "aguardando telemetria" | Mosquitto sem o listener **WebSockets 9001**, ou publicou no tópico errado |
| Payload "Invalid MQTT payload — discarded" | JSON malformado — no PowerShell publique por arquivo (`-f`), não por `-m` |
| `docker: command not found` no Windows | Não há `docker` no host; `infra:up`/`down` rodam **dentro do WSL** |
