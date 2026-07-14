# Runbook — Deploy do Dashboard (Vercel)

Publica o **dashboard** (`apps/dashboard`, Next.js) na Vercel, apontando para a API pública
(Render) e o broker (HiveMQ Cloud). Complementa o [deploy da API](deploy-mvp.md) — que já
está no ar (`https://cerberus-api-wic8.onrender.com`).

> O dashboard é um monorepo Turborepo/npm-workspaces; ele importa `@cerberus/shared`, que
> precisa ser compilado **antes** do `next build`. O [vercel.json](../../vercel.json) na raiz
> resolve isso com `turbo run build --filter=@cerberus/dashboard` (compila o `shared` como
> dependência) e aponta o output para `apps/dashboard/.next`.

## Pré-requisitos

- Conta na Vercel (plano Hobby serve) conectada ao repositório GitHub.
- A API já publicada (Render) + broker (HiveMQ). Ver [deploy-mvp.md](deploy-mvp.md).

## Passo 1 — Criar o projeto na Vercel

1. **Add New… → Project** e importe o repositório `Cerberus`.
2. **Root Directory:** deixe a **raiz do repositório** (`.`). O `vercel.json` cuida do build.
3. **Framework Preset:** Next.js (autodetectado). Não altere Build/Output — vêm do `vercel.json`.

## Passo 2 — Variáveis de ambiente (Production + Preview)

As variáveis do dashboard são **`NEXT_PUBLIC_*`** — embutidas no bundle **em tempo de build**
(logo, trocar exige **redeploy**). Configure em **Settings → Environment Variables**:

| Variável | Valor |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://cerberus-api-wic8.onrender.com` |
| `NEXT_PUBLIC_MQTT_WS_URL` | `wss://<cluster>.s1.eu.hivemq.cloud:8884/mqtt` |
| `NEXT_PUBLIC_MQTT_USERNAME` | `cerberus_api` (credencial estática do broker) |
| `NEXT_PUBLIC_MQTT_PASSWORD` | `<senha do usuário cerberus_api>` |

> A auth por credencial estática é necessária porque a HiveMQ Cloud free **não** valida JWT
> (ver [.claude/rules/mqtt-multitenant.md](../../.claude/rules/mqtt-multitenant.md)). Sem
> `NEXT_PUBLIC_MQTT_USERNAME/PASSWORD`, o mapa ao vivo não conecta ao barramento.

## Passo 3 — Liberar o CORS na API (Render)

A API só aceita origens listadas em `CORS_ORIGINS` (hoje `http://localhost:3001`). Após o
primeiro deploy, pegue a URL da Vercel (ex.: `https://cerberus-dashboard.vercel.app`) e **adicione-a**
na env `CORS_ORIGINS` do serviço na Render (valores separados por vírgula), depois redeploy da API:

```
CORS_ORIGINS=http://localhost:3001,https://cerberus-dashboard.vercel.app
```

## Passo 4 — Deploy e verificação

1. **Deploy** (a Vercel builda no push da branch default; PRs geram Preview URLs).
2. Abrir a URL → **login** (`admin` / `cerberus123` após o seed) → conferir:
   - `/operations` lista as operações (API + CORS ok).
   - `/admin/map` (SuperAdmin): marcadores + **trilha ao vivo** aparecem quando um agente
     publica (barramento HiveMQ ok — bolinha verde de conectado).
   - Chat E2EE decifra (diretório de chaves ok).

## Notas

- **Chave E2EE em repouso:** no MVP a chave privada do dashboard fica em `localStorage`. Para
  produção, endurecer com passphrase/WebCrypto (fatia futura — ver Fase 5c).
- **Cold start da API:** a Render free hiberna após ~15 min; um cronjob externo (10 min) mantém
  a API acordada. Se o primeiro acesso demorar, é isso.
- **On-prem (DTI):** o alvo K8s/EMQX/ICP-Brasil continua sendo fase posterior (não coberto aqui).
