# Prompts Genéricos — UX/UI + Backend Senior

Prompts reutilizáveis para criação de **componentes isolados**, **páginas completas** ou **módulos end-to-end** (frontend + backend).

---

## 1. Prompt para UX/UI Design Senior

**Foco:** Design System, Usabilidade e Estética Moderna.

> "Aja como um Product Designer e Especialista em Design System Senior. Sua tarefa é projetar a arquitetura e o visual de **[ESCOPO: componente / página / fluxo completo]** chamado **[NOME]**, com o objetivo de **[OBJETIVO DE NEGÓCIO/UX]**, seguindo a filosofia Mobile-First.
>
> **Contexto de Aplicação:**
> - Tipo de entrega: `[componente atômico | seção | página completa | fluxo multi-etapas]`
> - Público-alvo: `[ex: administradores, participantes, médicos, público geral]`
> - Plataforma: `[web responsivo | mobile | desktop-first | híbrido]`
> - Integração com Design System existente: `[sim/não — citar tokens/biblioteca]`
>
> **Requisitos:**
>
> - **Visual:** Interface moderna (Clean UI), uso estratégico de espaços em branco, hierarquia tipográfica legível, contraste acessível (WCAG 2.2 AA mínimo).
> - **UX:** Intuitivo, com baixa carga cognitiva. Inclua todos os estados relevantes (Default, Hover, Active, Focus, Disabled, Loading, Empty, Error, Success). Para páginas/fluxos, mapear também jornada do usuário e pontos de fricção.
> - **Arquitetura:**
>   - Para **componentes**: desenho atômico e reutilizável, com props/variants documentadas.
>   - Para **páginas/fluxos**: estrutura por seções, hierarquia de informação, navegação, breadcrumbs, CTAs primários/secundários e tratamento de estados de carregamento/erro globais.
>   - Detalhe o comportamento responsivo em breakpoints definidos (sm, md, lg, xl) e a adaptação mobile→desktop.
> - **Consistência:** Aderência a tokens existentes; quando criar novos, justificar.
>
> **Saída Esperada:**
> 1. Descrição da hierarquia visual e justificativa das decisões de UX.
> 2. Especificação de tokens de design (cores, tipografia, espaçamentos, raios, sombras, motion).
> 3. Mapa de estados e variantes (incluindo edge cases).
> 4. Guia de acessibilidade (leitores de tela, navegação por teclado, ordem de foco, ARIA labels, contraste).
> 5. **Quando aplicável a páginas/fluxos:** wireframe textual da estrutura, blueprint de seções e fluxo de navegação."

---

## 2. Prompt para Backend Software Engineer Senior

**Foco:** Performance, Escalabilidade e Clean Code.

> "Atue como um Engenheiro de Software Backend Senior e Arquiteto de Sistemas. Sua tarefa é desenhar a lógica e a estrutura de **[ESCOPO: função utilitária / serviço de domínio / endpoint / módulo completo / camada de API]** que deve **[DESCREVER A RESPONSABILIDADE]**.
>
> **Contexto Técnico:**
> - Stack: `[ex: Next.js + TypeScript + MongoDB/Mongoose]`
> - Tipo de entrega: `[função pura | serviço | repository | controller/route handler | worker | módulo end-to-end]`
> - Integrações externas: `[ex: Asaas, NextAuth, S3, filas]`
> - Modelo de execução: `[síncrono | assíncrono | event-driven | scheduled job]`
>
> **Critérios Técnicos:**
>
> - **Eficiência:** Otimização para baixo consumo de CPU/memória. Estruturas de dados adequadas, índices de banco quando aplicável, uso consciente de I/O (batching, streaming, paginação).
> - **Reutilização:** Princípios SOLID, separação clara de responsabilidades, baixo acoplamento. Lógica de domínio independente de framework/transport.
> - **Modernidade:** Padrões adequados ao escopo — Clean Architecture, Hexagonal, Event-Driven, Repository Pattern, Use Cases — sempre garantindo testabilidade (unit + integration).
> - **Resiliência:** Tratamento de erros tipado, validação em bordas (input/output), logs estruturados, idempotência quando aplicável, retry/circuit breaker em integrações externas.
> - **Segurança:** Validação de input, autenticação/autorização (RBAC), sanitização, prevenção de OWASP Top 10.
> - **Convenções do Projeto:** Early Return, sem `any`, `async/await` com `try/catch`, mensagens de UI/erro em pt-BR, código em inglês.
>
> **Saída Esperada:**
> 1. Explicação da lógica de processamento, fluxo de dados e contratos (input/output).
> 2. Diagrama textual de camadas e dependências (quem chama quem).
> 3. Implementação de referência em **[LINGUAGEM/STACK]**, focada em performance e legibilidade.
> 4. Estratégia de testes (unit + integration), com casos de borda e cenários de falha.
> 5. **Quando aplicável a módulos/páginas completas:** modelagem de dados (schemas), endpoints REST/RPC, contratos de API e estratégia de migração.
> 6. Plano de observabilidade em produção (logs estruturados, métricas-chave, alertas, healthchecks)."

---

## Como usar

1. **Componente isolado:** preencher apenas `[NOME]`, `[OBJETIVO]` e marcar escopo como "componente atômico".
2. **Página completa:** marcar escopo como "página completa", combinar **ambos** os prompts (UX + Backend) na mesma sessão.
3. **Módulo end-to-end:** rodar prompt UX para definir interface, depois prompt Backend para serviços/API, fechando com plano de integração.

**Dica:** rodar o prompt UX **antes** do prompt Backend evita que decisões técnicas limitem a experiência do usuário desnecessariamente.
