---
paths:
  - "apps/api/src/models/**"
  - "apps/api/src/plugins/mongo.ts"
---

# Modelagem de Banco de Dados (Mongoose + MongoDB)

Este documento define os padrões para persistência de dados do Cerberus usando Mongoose.

## Diretrizes de Estrutura

- **Definição Única**: Todos os schemas do Mongoose estão centralizados em `apps/api/src/models/index.ts`.
- **Valores Automáticos**:
  - Utilizar `timestamps: true` nas coleções administrativas que requerem auditoria (ex: `User`, `Operation`).
  - Desativar `timestamps` em tabelas de fluxo contínuo de alta frequência (ex: `Position` e `Message`) para economizar processamento e armazenamento, usando campos específicos como `capturedAt` e `receivedAt`.
- **Campos de Auditoria**: IDs, tokens e timestamps de recepção (`receivedAt`) são gerados exclusivamente pelo servidor. Nunca confiar em tempos de recepção vindos dos agentes.
- **Relacionamentos**:
  - Para referências relacionais nos schemas, usar `Schema.Types.ObjectId` com o parâmetro `ref`.
  - Exemplo: `createdBy: { type: Schema.Types.ObjectId, ref: 'User' }`.
- **Uso de Consultas Otimizadas**: Usar o método `.lean()` em queries do Mongoose destinadas à leitura pura, evitando instanciar documentos pesados quando não há métodos de instância ativos.
- **Transação/Atualizações**: Atualizações em campos aninhados devem utilizar a notação de ponto (dot notation) no payload `$set` para evitar sobrescrever outros campos do objeto aninhado.

## Ciclo de Vida da Conexão

- A conexão com o MongoDB é iniciada e encerrada nos ganchos de ciclo de vida do Fastify (`apps/api/src/plugins/mongo.ts`).
- **Sincronização de Índices**: Os índices (incluindo o geográfico `2dsphere` da coleção de posições e índices compostos de busca) são gerados automaticamente na inicialização via `await mongoose.syncIndexes()`. Nunca desative esta instrução.
- Não crie conexões do Mongoose de forma redundante ou manual fora do escopo do plugin da aplicação.

## Relação com `@cerberus/shared`

- As estruturas salvas no banco de dados devem ser compatíveis com os esquemas de validação Zod no pacote `@cerberus/shared/src/schemas.ts`. A tipagem dos documentos deve utilizar `InferSchemaType<typeof schema>` do Mongoose.
