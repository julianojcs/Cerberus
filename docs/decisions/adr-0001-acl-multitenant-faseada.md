# ADR 0001 — Estratégia de ACL multitenant faseada

- **Status:** Aceita (Fase 2 — issue #4)
- **Data:** 2026-07-10
- **Regra relacionada:** [mqtt-multitenant.md](../../.claude/rules/mqtt-multitenant.md)

## Contexto

O isolamento entre operações por `operationId` é o núcleo **Zero Trust** do Cerberus: um
vazamento (um agente/operador de uma missão vendo ou publicando telemetria de outra) é um
incidente de segurança de missão crítica. A Fase 2 (#4) pede "claims JWT com escopo + ACLs de
tópico aplicadas".

Aplicar ACL **dinâmica no broker** (rejeição na camada de rede a partir dos claims do JWT) exige
um broker on-prem com plugin de autenticação (EMQX ou Mosquitto + `mosquitto-go-auth`), infra que
só existe na **Fase 6 (deploy/hardening)**. No MVP custo-zero o broker é o HiveMQ Cloud, com
credenciais gerenciadas e **sem** ACL dinâmica por JWT.

## Decisão

O isolamento multitenant é aplicado em **duas camadas, entregues em fases**:

### 1. MVP (agora) — fronteira na camada da API

Esta é a **única** barreira efetiva no MVP; as verificações não podem ser relaxadas contando com
ACL futura do broker.

- `assertOperationScope(request, reply, operationId)` em **toda rota escopada** → `403` se o
  `operationId` não estiver nos `claims.operationIds` do JWT.
- **Claims JWT com escopo**: o `operationIds` é um *snapshot* resolvido do banco no login (e
  re-emitido por `POST /auth/refresh` quando o escopo muda).
- `parseAgentTopic(topic)` na ponte de ingest: identidade (`operationId`/`agentId`) vem **do
  tópico, nunca do payload**; tópico fora do padrão é descartado.
- **Toda query Mongo filtra por `operationId`** — não existe "buscar tudo" sem escopo, nem para admin.

### 2. On-prem (Fase 6) — ACL dinâmica no broker

- EMQX ou Mosquitto + `mosquitto-go-auth` rejeitando publish/subscribe fora de
  `operacao/{opId}/agente/{agentId}/#` na **camada de rede**, a partir dos claims do JWT.

## Consequências

- **Verificado por teste de integração** (`apps/api/src/modules/routes.test.ts` → describe
  "isolamento multitenant (Zero Trust)"): acesso cross-`operationId` retorna `403` nos dois
  sentidos, e uma consulta escopada nunca retorna dados de outra operação (posições e mensagens).
- A Fase 2 (#4) fecha com a fronteira da **camada da API** enforced e testada; a ACL de **broker**
  fica rastreada para a Fase 6 (#8).
- Enquanto a ACL de broker não existir, qualquer rota nova escopada por operação **deve** chamar
  `assertOperationScope` logo após `app.authenticate` (ver a regra mqtt-multitenant).
