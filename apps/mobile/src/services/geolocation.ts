import { Alert, Platform } from 'react-native';
import BackgroundGeolocation, {
  type Location,
  type MotionActivityEvent,
  type MotionChangeEvent,
} from 'react-native-background-geolocation';
import { publishPosition, setCommandHandler } from './mqtt';
import { AgentCommandType, type PositionSample } from '../shared/contracts';

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

/**
 * Contexto do rastreamento, lido pelo handler de comando. Fica em módulo porque o
 * handler é registrado no LOAD (abaixo) e não dentro do `initTracking`.
 */
let trackingCtx: TrackingContext | null = null;

/**
 * Responde ao `request_fix` da central: força um fix AGORA e publica. Mesmo caminho do
 * heartbeat — a central usa isto quando a telemetria congelou (GPS hibernando parado, e
 * o Doze podendo adiar o heartbeat por dezenas de minutos). A resposta não é síncrona:
 * sai como uma posição normal no canal `posicao`.
 *
 * Registrado no LOAD do módulo, e NÃO dentro do `initTracking` (que roda uma única vez):
 * um hot reload do `mqtt.ts` zera o `commandHandler` de lá, e o `initTracking` não roda
 * de novo — o handler sumia em silêncio e o comando chegava para ninguém. Aqui, ao menos
 * um reload DESTE arquivo o re-registra. Injeção evita import circular (já importamos
 * `publishPosition` do mqtt).
 */
setCommandHandler((type) => {
  if (type !== AgentCommandType.REQUEST_FIX) return;
  const ctx = trackingCtx;
  if (!ctx) {
    console.warn('[gps] request_fix ignorado: rastreamento ainda não iniciado');
    return;
  }
  void (async () => {
    try {
      console.warn('[gps] comando request_fix → buscando posição…');
      const location = await BackgroundGeolocation.getCurrentPosition({
        samples: 1,
        persist: true,
      });
      console.warn('[gps] fix obtido → publicando');
      report(ctx, toSample(location));
    } catch (err) {
      // Sem log, um GPS que não consegue fix (Doze, sem sinal, permissão) é
      // indistinguível de "o comando nunca chegou".
      console.warn('[gps] FALHOU ao obter fix:', err);
    }
  })();
});

// --- Assinatura de posições para a própria UI do agente ---
export type PositionListener = (sample: PositionSample) => void;
const positionListeners = new Set<PositionListener>();
let lastSample: PositionSample | null = null;

// Compartilhamento com a central. Quando FALSE, o rastreamento continua atualizando
// o mapa/UI do agente, mas NADA é publicado no barramento (modo local/privado).
let shareLocation = true;

/** Liga/desliga a publicação das posições no barramento (sem parar o rastreamento). */
export function setShareLocation(value: boolean): void {
  shareLocation = value;
}

export function isSharingLocation(): boolean {
  return shareLocation;
}

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

/** Notifica a UI local e, SE o compartilhamento estiver ligado, publica no barramento. */
function report(ctx: TrackingContext, sample: PositionSample): void {
  lastSample = sample;
  for (const listener of positionListeners) listener(sample);
  if (shareLocation) void publishPosition(ctx.operationId, ctx.agentId, sample);
}

/**
 * Obtém UMA posição sob demanda (ex.: botão "centralizar"), independentemente de o
 * rastreamento estar ligado ou de estar compartilhando. Garante o `ready()` do
 * plugin, NÃO publica no barramento e NÃO acrescenta ponto à trilha (só devolve).
 */
export async function getCurrentPositionOnce(ctx: TrackingContext): Promise<PositionSample | null> {
  try {
    await initTracking(ctx); // idempotente: garante ready() + permissões
    const location = await BackgroundGeolocation.getCurrentPosition({ samples: 1, persist: false });
    const sample = toSample(location);
    lastSample = sample;
    return sample;
  } catch {
    return null;
  }
}

export async function initTracking(ctx: TrackingContext): Promise<void> {
  // Antes do guard: o handler de comando lê daqui, e o ctx pode mudar (troca de operação).
  trackingCtx = ctx;
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
    // Serviço em primeiro plano: enquanto o rastreamento está ligado, o app fica
    // SEMPRE visível na barra de notificações (mesmo minimizado). `sticky` mantém a
    // notificação fixa; `channelName` nomeia o canal nas configurações do Android.
    foregroundService: true,
    notification: {
      title: 'Cerberus — Operação ativa',
      text: 'Rastreando sua posição em segundo plano.',
      channelName: 'Rastreamento Cerberus',
      sticky: true,
    },

    // A publicação é feita pela camada MQTT; o autoSync HTTP do plugin fica off.
    autoSync: false,
    debug: false,
    logLevel: BackgroundGeolocation.LOG_LEVEL_WARNING,
  });

  initialized = true;
}

/**
 * Doze do Android: com o aparelho ocioso (tela apagada, parado, na bateria), o sistema
 * ADIA os alarmes para janelas de manutenção cada vez mais espaçadas. O
 * `heartbeatInterval` é um alarme — então o ping de 5 min vira 30, 60 min, e a central
 * enxerga o agente "congelado" mesmo com o barramento conectado (foi o que observamos:
 * presença online + última posição de 57 min atrás).
 *
 * `foregroundService: true` impede o app de ser MORTO, mas NÃO o isenta do Doze — a
 * isenção só o usuário concede. Pedimos UMA vez: o plugin lembra em `request.seen`, e
 * `showIgnoreBatteryOptimizations()` apenas devolve os metadados (não abre nada) — quem
 * abre a tela é o `show(request)`, e só depois do operador aceitar.
 */
async function ensureBatteryExemption(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    if (await BackgroundGeolocation.deviceSettings.isIgnoringBatteryOptimizations()) return;
    const request = await BackgroundGeolocation.deviceSettings.showIgnoreBatteryOptimizations();
    if (request.seen) return; // já pedimos uma vez — não insistir a cada início
    Alert.alert(
      'Manter o rastreamento ativo',
      'O Android está limitando o Cerberus em segundo plano — sua posição pode ficar ' +
        'dezenas de minutos sem atualizar na central, mesmo com o app conectado.\n\n' +
        'Na próxima tela, permita que o Cerberus ignore a otimização de bateria.',
      [
        { text: 'Agora não', style: 'cancel' },
        {
          text: 'Abrir configuração',
          onPress: () => BackgroundGeolocation.deviceSettings.show(request),
        },
      ],
    );
  } catch {
    /* fabricante sem essa tela / API indisponível — segue sem a isenção */
  }
}

export async function startTracking(): Promise<void> {
  await BackgroundGeolocation.start();
  // Depois de iniciar: o rastreamento já vale, a isenção só melhora a regularidade.
  void ensureBatteryExemption();
}

export async function stopTracking(): Promise<void> {
  await BackgroundGeolocation.stop();
}
