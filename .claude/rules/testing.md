---
paths:
  - "packages/shared/src/**/*.test.ts"
  - "apps/api/src/**/*.test.ts"
---

# Padrões e Práticas de Testes

O Cerberus utiliza **Vitest** como motor primário de testes para garantir a corretude dos esquemas de validação, parsing de tópicos de mensageria e endpoints de integração de dados em tempo real.

## Níveis e Estrutura de Testes

1. **Testes Unitários de Contratos (`packages/shared`)**:
   - Focar em testar esquemas Zod (`packages/shared/src/schemas.ts`) e o parser taxonômico de tópicos MQTT (`packages/shared/src/topics.ts`).
   - Arquivos nomeados como `*.test.ts` residindo ao lado dos componentes que testam.
   - Proibido uso de `any` para bypassar checagem de tipos (utilizar `Record<string, unknown>` ou fixtures explícitas).

2. **Testes de Integração e API (`apps/api`)**:
   - Para testar rotas Fastify, utilizar a funcionalidade nativa de mock HTTP `app.inject()` fornecida pelo Fastify. Isso permite despachar requisições para a API sem alocar portas de escuta ou expor soquetes TCP de desenvolvimento.
   - **Mocks Requeridos**:
     - Mock de rede para conexões MQTT.
     - Mock de persistência de banco de dados (Mongoose) para evitar misturar estados entre execuções de testes de integração ou poluir o bando de dados dev local.

## Comando de Execução

- Para rodar todos os testes na suite contínua do monorepo: `npm run test` (orquestrado pelo Turborepo).
- Para executar localmente em modo interativo de monitoramento: `npx vitest` na pasta do respectivo subprojeto.
