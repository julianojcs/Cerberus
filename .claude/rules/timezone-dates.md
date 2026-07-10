---
paths:
  - "apps/api/src/**/*.ts"
  - "apps/dashboard/src/**/*.ts"
  - "apps/dashboard/src/**/*.tsx"
  - "packages/shared/src/**/*.ts"
---

# Manipulação de Datas e Fuso Horário (UTC-first)

O Cerberus é uma plataforma de monitoramento e coordenação tática em tempo real. Erros no cálculo ou manipulação de horários podem resultar em discrepâncias no histórico de deslocamento de agentes, prejudicando operações em campo.

## Princípio Fundamental: UTC Integral

Todas as datas de telemetria baseadas em GPS e registros de mensagens do sistema operam estritamente sob o fuso horário **UTC (Coordinated Universal Time)**.

1. **Captura no Dispositivo (Agente)**:
   - O timestamp de geração do sinal de localização (`capturedAt`) deve ser gerado pelo hardware/SDK em UTC.
   - Deves ser transmitido como string no formato ISO 8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`).

2. **Recepção no Servidor Central**:
   - A hora de chegada da mensagem (`receivedAt`) deve ser gerada no momento exato em que o barramento MQTT ou o gateway da API interceptar o pacote, utilizando a hora UTC do servidor (`new Date()` no Node.js interpreta o instante absoluto UTC).

3. **Validação**:
   - Rotas HTTP e decodificadores MQTT devem validar os campos de data utilizando Zod com o validador `.datetime()` (que força a presença da notação `Z` de UTC):
     ```ts
     capturedAt: z.string().datetime()
     ```

4. **Armazenamento no MongoDB**:
   - Os modelos salvos no MongoDB (coleções `positions` e `messages`) utilizam o tipo `Date` nativo do Mongoose. O MongoDB armazena nativamente este tipo como hora UTC.

## Diretrizes de Exibição no Dashboard

- A plotagem do console administrativo exibe a trilha de posições históricas ou horários de mensagens.
- **Formatação de Exibição**: Caso seja necessária a formatação para o fuso local do operador (tipicamente `America/Sao_Paulo` ou correspondente à superintendência local), a conversão de exibição deve ser delegada exclusivamente para o navegador cliente (front-end), preservando a integridade nativa do dado em UTC enviado pelo servidor.
- Evitar o uso desnecessário de bibliotecas pesadas de fuso se JavaScript nativo (`Intl.DateTimeFormat`) for suficiente.
