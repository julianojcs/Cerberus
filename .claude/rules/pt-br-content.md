---
paths:
  - "apps/api/src/**"
  - "apps/dashboard/src/**"
  - "packages/shared/src/**"
---

# Conteúdo em Português (pt-BR)

## Acentuação e Ortografia Obrigatórias

Todas as mensagens em português destinadas ao usuário final ou aos operadores de monitoramento do painel tático devem usar acentuação ortográfica correta e redação formal condizente com a plataforma corporativa:
- Mensagens de UI (tabelas, modais, toast alerts, sidebars, legendas de status)
- Badges e alertas na tela de monitoramento geográfico
- Mensagens de erro de validação (Zod) ou exceções retornadas pela API Fastify
- Logs destinados à auditoria ou relatórios exportáveis pelo painel

**Nunca** escrever termos em português sem acentos apropriados (ex.: escreva "início", "operação", "posição", "agente", e evitar "inicio", "operacao", "posicao", "agente").

## Escopo Técnico (Código em Inglês)

As regras de acentuação e idioma **não** se aplicam a:
- Identificadores de variáveis, propriedades de objetos ou assinaturas de métodos
- Identificadores do banco de dados (chaves/campos do MongoDB)
- Nomes de tópicos ou payloads de tráfego de rede MQTT (ex.: `operacao/+/agente/+/posicao`)
- Logs internos do servidor impressos apenas em shell (`pino` / `console.error`)
- Slugs HTTP e parâmetros de rotas (ex.: `/operations/:id/positions`)
