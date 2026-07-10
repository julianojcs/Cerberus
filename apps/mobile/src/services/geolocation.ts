import BackgroundGeolocation, {
  type Location,
  type MotionActivityEvent,
} from 'react-native-background-geolocation';
import { publishPosition } from './mqtt';
import type { PositionSample } from '../shared/contracts';

/**
 * Camada de telemetria. Configura o plugin nativo da Transistor Software para:
 *  - Gerenciamento dinâmico de energia: parado -> GPS hiberna (heartbeat 5 min);
 *    em deslocamento -> sobe a taxa de amostragem automaticamente (activity
 *    recognition via acelerômetro/giroscópio).
 *  - Resiliência de rede: buffer nativo criptografado + descarga assíncrona.
 * Cada localização é publicada no barramento MQTT no canal do próprio agente.
 */

let initialized = false;

export interface TrackingContext {
  operationId: string;
  agentId: string;
}

function toSample(location: Location): PositionSample {
  const c = location.coords;
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracy: c.accuracy,
    altitude: c.altitude,
    speed: c.speed,
    heading: c.heading,
    battery: location.battery?.level,
    activity: location.activity?.type,
    capturedAt: location.timestamp,
  };
}

export async function initTracking(ctx: TrackingContext): Promise<void> {
  if (initialized) return;

  BackgroundGeolocation.onLocation((location: Location) => {
    void publishPosition(ctx.operationId, ctx.agentId, toSample(location));
  });

  BackgroundGeolocation.onMotionChange((event: Location) => {
    // event.isMoving indica transição parado <-> em movimento.
    void publishPosition(ctx.operationId, ctx.agentId, toSample(event));
  });

  BackgroundGeolocation.onActivityChange((event: MotionActivityEvent) => {
    // Reservado para ajustes finos do perfil de energia por tipo de atividade.
    void event;
  });

  await BackgroundGeolocation.ready({
    // --- Precisão / amostragem em deslocamento ---
    desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
    distanceFilter: 20, // metros entre amostras em movimento

    // --- Gerenciamento dinâmico de energia (parado) ---
    stopTimeout: 5, // minutos parado antes de hibernar o GPS
    heartbeatInterval: 300, // 5 min de ping quando estático (conforme spec)
    stopOnStationary: false,

    // --- Comportamento em background ---
    stopOnTerminate: false,
    startOnBoot: true,
    foregroundService: true,
    notification: {
      title: 'Cerberus — Operação ativa',
      text: 'Reportando posição tática.',
    },

    // A publicação é feita pela camada MQTT; o autoSync HTTP do plugin fica off.
    autoSync: false,
    debug: false,
    logLevel: BackgroundGeolocation.LOG_LEVEL_WARNING,
  });

  initialized = true;
}

export async function startTracking(): Promise<void> {
  await BackgroundGeolocation.start();
}

export async function stopTracking(): Promise<void> {
  await BackgroundGeolocation.stop();
}
