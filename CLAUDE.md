# Cerberus — Diretrizes de Desenvolvimento

## Comandos Úteis

### Setup & Infra
* **Subir infraestrutura local (MongoDB + Mosquitto):** `npm run infra:up`
* **Parar infraestrutura local:** `npm run infra:down`
* **Instalar dependências:** `npm install`
* **Semear banco de dados (admin, operação, agente de teste):** `npm run api:seed`

### Compilação & Verificação
* **Compilar pacote compartilhado (obrigatório após alterar types/schemas):** `npm run shared:build`
* **Compilar todo o projeto:** `npm run build`
* **Checar tipagem (TypeScript):** `npm run typecheck`
* **Rodar Linter (ESLint):** `npm run lint`

### Desenvolvimento
* **Rodar API + Dashboard em paralelo:** `npm run dev`
* **Rodar apenas a API:** `npm run api:dev`
* **Rodar apenas o Dashboard:** `npm run dashboard:dev`

### Testes
* **Executar todos os testes:** `npm run test`
* **Executar testes em modo watch:** `npx vitest`

---

## Convenções de Código

### Categoria de Datas e Fuso Horário
* **Timestamps (Instantes)**: Toda data capturada de telemetria baseada em GPS (`capturedAt`), alertas e mensagens utiliza **UTC** absoluto.
* **Validação**: Receber e validar como strings ISO 8601 UTC usando Zod (`z.string().datetime()`).
* **Banco de dados**: Armazenado como Mongoose `Date` (UTC interno).
* Proibido usar `toLocaleDateString()` ou conversões baseadas em fusos locais no servidor ou browser. Toda manipulação de data de telemetria deve ser explícita em UTC.

### Banco de Dados (Mongoose)
* Mongoose models definidos em `apps/api/src/models/index.ts`.
* Utilizar `Lean` queries para leituras rápidas que não exijam métodos Mongoose.
* Conexão e sincronização de índices (`2dsphere` para coordenadas geográficas) gerenciadas via Fastify Plugin em `apps/api/src/plugins/mongo.ts`.

### Mensagens & Traduções
* Logs do sistema e nomes de variáveis/funções/banco são em **inglês**.
* Mensagens de erro da API e interface do usuário destinadas ao operador são em **português (pt-BR)** com acentuação ortográfica obrigatória.

---

## Regras Detalhadas (`.claude/rules/`)

Regras específicas por área. **Antes de mexer** num arquivo que se enquadre no gatilho abaixo, leia a
regra correspondente e siga-a. (O Claude Code não carrega estes arquivos automaticamente — consulte-os
sob demanda.)

| Regra | Ler ao trabalhar em… |
| --- | --- |
| [mqtt-multitenant.md](.claude/rules/mqtt-multitenant.md) | Tópicos MQTT, ponte de ingest, escopo por `operationId`, ACL/Zero Trust |
| [geospatial-coordinates.md](.claude/rules/geospatial-coordinates.md) | Coordenadas (`lat/lng` ↔ GeoJSON `[lng,lat]`), `2dsphere`, geofencing, mapa |
| [database-models.md](.claude/rules/database-models.md) | Schemas Mongoose, índices, `.lean()`, conexão em `plugins/mongo.ts` |
| [timezone-dates.md](.claude/rules/timezone-dates.md) | Qualquer data: `capturedAt`/`receivedAt`, UTC-first, exibição no dashboard |
| [pt-br-content.md](.claude/rules/pt-br-content.md) | Texto voltado ao operador (UI, erros da API, validações Zod) |
| [ui-contrast.md](.claude/rules/ui-contrast.md) | Cor de texto/contraste no dashboard dark: botões, badges, inputs, `color-scheme` |
| [testing.md](.claude/rules/testing.md) | Testes Vitest, `app.inject()`, mocks de MQTT/Mongoose |
| [refactoring.md](.claude/rules/refactoring.md) | Refatoração não-trivial (abrir issue antes de codar) |
| [issue-prompts.md](.claude/rules/issue-prompts.md) | Redigir issues (anexar prompt de implementação sênior) |
