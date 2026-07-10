# Cerberus — Aplicação Móvel de Campo (Agentes)

App React Native (Expo) que reporta a posição do agente em tempo real via MQTT.

## Por que exige Dev Client (não roda no Expo Go)

Usa o módulo **nativo** `react-native-background-geolocation` (Transistor Software) para telemetria
em segundo plano de nível de kernel — necessário para contornar as restrições do iOS. Isso exige um
build nativo (Dev Client / EAS), não o Expo Go.

## Setup

```bash
cd apps/mobile
npm install
cp .env.example .env        # ajuste os IPs para o IP da sua máquina na LAN

# Gera os projetos nativos e roda em um dispositivo/emulador:
npx expo prebuild
npm run android             # ou: npm run ios (requer macOS/Xcode)
```

> Ao contrário dos demais módulos, este app **não** faz parte dos workspaces npm (particularidades
> do Metro bundler com hoisting). Instale as dependências dentro de `apps/mobile`.

## Fluxo (fatia vertical)

1. Login (`agente01` / `cerberus123` após o seed da API).
2. Conecta ao barramento MQTT usando o JWT.
3. Liga o "Reporte de posição" → o plugin inicia a telemetria em background.
4. Cada posição é publicada em `operacao/{operationId}/agente/{agentId}/posicao`.
5. A central vê o marcador se mover no Dashboard em tempo real.

## Gerenciamento dinâmico de energia

Configurado em `src/services/geolocation.ts`: parado → GPS hiberna (heartbeat de 5 min); em
deslocamento → a taxa de amostragem sobe automaticamente (activity recognition). Em zona de sombra,
as posições vão para o `outbox` local e são descarregadas quando a rede volta.

## Contratos compartilhados

`src/shared/contracts.ts` é um espelho mínimo de `@cerberus/shared` (tópicos + formato de posição).
Mantenha-o em sincronia com `packages/shared`.
