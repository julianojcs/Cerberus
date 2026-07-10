import BackgroundGeolocation, {
  type Location,
  type MotionActivityEvent,
  type MotionChangeEvent,
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

// --- Assinatura de posições para a própria UI do agente ---
export type PositionListener = (sample: PositionSample) => void;
const positionListeners = new Set<PositionListener>();
let lastSample: PositionSample | null = null;

/** Inscreve um ouvinte que recebe cada amostra publicada (para a tela do agente). */
export function subscribePositions(listener: PositionListener): () => void {
  positionListeners.add(listener);
  if (lastSample) listener(lastSample);
  return () => {
    positionListeners.delete(listener);
  };
}

/** Última amostra conhecida (inicializa a UI sem esperar o próximo fix). */
export function getLastSample(): PositionSample | null {
  return lastSample;
}

/** Publica no barramento MQTT e notifica a UI local com a mesma amostra. */
function report(ctx: TrackingContext, sample: PositionSample): void {
  lastSample = sample;
  for (const listener of positionListeners) listener(sample);
  void publishPosition(ctx.operationId, ctx.agentId, sample);
}

export async function initTracking(ctx: TrackingContext): Promise<void> {
  if (initialized) return;

  BackgroundGeolocation.onLocation((location: Location) => {
    report(ctx, toSample(location));
  });

  BackgroundGeolocation.onMotionChange((event: MotionChangeEvent) => {
    // event.isMoving indica transição parado <-> em movimento; a posição
    // vem em event.location (o evento NÃO é um Location direto como no onLocation).
    report(ctx, toSample(event.location));
  });

  BackgroundGeolocation.onActivityChange((event: MotionActivityEvent) => {
    // Reservado para ajustes finos do perfil de energia por tipo de atividade.
    void event;
  });

  BackgroundGeolocation.onHeartbeat(async () => {
    // Parado, o GPS hiberna. A cada heartbeat forçamos um fix fresco para manter
    // posição/bateria/horário vivos no painel mesmo sem deslocamento.
    try {
      const location = await BackgroundGeolocation.getCurrentPosition({
        samples: 1,
        persist: true,
      });
      report(ctx, toSample(location));
    } catch {
      /* sem fix disponível neste ciclo — ignora */
    }
  });

  await BackgroundGeolocation.ready({
    // --- Precisão / amostragem em deslocamento ---
    desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
    distanceFilter: 10, // metros entre amostras em movimento (rastro mais denso)

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
