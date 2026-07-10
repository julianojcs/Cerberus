---
paths:
  - "apps/api/src/**"
  - "apps/dashboard/src/**"
  - "packages/shared/src/**"
---

# Diretrizes para Refatorações

## Regra de Ouro

**Toda e qualquer refatoração estrutural ou não-trivial de código no ecossistema do Cerberus deve ser catalogada por meio de uma issue.**

A rastreabilidade é crítica para evitar fragmentação arquitetural ou tarefas parcialmente concluídas que deixem o monorepo instável.

## Critérios de Ação

Crie uma issue e acompanhe o fluxo formal de branches quando a refatoração:
1. Afetar mais do que um arquivo de lógica ou alterar contratos compartilhados no `@cerberus/shared`.
2. Modificar rotas de controle operacional ou fluxo de ingestão de telemetria baseada em MQTT.
3. Consistir em padronizações sistêmicas (ex: introdução de novos esquemas de persistência ou de renderização).
4. For realizada de forma incremental ao longo de múltiplas sessões de desenvolvimento.

## Convenções de Git e PR

- **Nome da Branch**: `refactor/NOME_DA_ISSUE_OU_CODIGO` (ex.: `refactor/api-auth-middleware` ou `refactor/zod-schema-normalizer`).
- **Commits e Fechamento de Issues**: Commits devem ter descrição clara em inglês (ex.: `refactor: extract validation core into shared schemas`). Associe o encerramento da issue com uma *closing keyword* (`Closes #ID` ou `Resolve #ID`) no corpo do Pull Request. O fechamento automático só dispara quando o PR é mesclado na branch default (`main`); usar apenas `(#ID)` gera menção, não fecha.
- **Validação Automatizada**: Toda refatoração deve passar pelos scripts globais de checagem. Antes de solicitar revisão do código, certifique-se de executar localmente:
  ```bash
  npm run typecheck
  npm run lint
  npm run test
  ```
