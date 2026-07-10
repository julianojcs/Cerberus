---
paths:
  - "apps/api/src/**"
  - "apps/dashboard/src/**"
  - "packages/shared/src/**"
---

# Prompts de Implementação em Issues

Toda issue de refatoração ou novas implementações técnicas criada no repositório de desenvolvimento do Cerberus deve conter uma seção de **"Prompt de implementação"** ao final do corpo. Essa seção deve referenciar as diretrizes de desenvolvimento especializadas descritas em [docs/prompts/prompts-design-backend-senior.md](../../docs/prompts/prompts-design-backend-senior.md).

## Casos de Uso por Especialidade

| Alteração Solicitada | Persona / Prompt Sugerido |
|---|---|
| Componentes do dashboard, fluxo interativo, renderizações de mapa | **UX/UI Design Senior** |
| Rotas de API Fastify, listeners/bridges de mensagens MQTT, esquemas Mongoose | **Backend Software Engineer Senior** |
| Módulos verticais completos, novas features integradas (end-to-end) | **Ambos** (UX executado antes de Backend para orientar a interface do operador) |

## Estrutura Exigida nas Issues

Copie e preencha o seguinte bloco Markdown ao final da descrição do card/issue:

```markdown
## Prompt de implementação

Ao iniciar esta issue, ativar o(s) seguinte(s) prompt(s) de [docs/prompts/prompts-design-backend-senior.md](docs/prompts/prompts-design-backend-senior.md):

- **UX/UI Design Senior** — Product Designer + Especialista em Design System Senior. Foco: Interface do Dashboard de Controle moderna baseada em dark mode/glassmorphism, responsividade, estados completos de carregamento e conectividade de sockets (MQTT). Acessibilidade e visual premium para o operador.

  **Contexto desta issue:** [Descreva o escopo da tela ou fluxo visual]

- **Backend Software Engineer Senior** — Engenheiro de Software Backend Senior. Foco: Alta performance, concorrência, otimização de queries geoespaciais, tratamento resiliente de mensageria de GPS, SOLID, sem `any`, logs estruturados e isolamento multitenant de informações baseando-se em `operationId`.

  **Contexto desta issue:** [Descreva a rota, lógica, payload MQTT ou persistência]
```
