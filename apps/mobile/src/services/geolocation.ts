import { Alert, Platform } from 'react-native';
import BackgroundGeolocation, {
  type Location,
  type MotionActivityEvent,
  type MotionChangeEvent,
} from 'react-native-background-geolocation';
import { addCommandHandler, publishPosition } from './mqtt';
import { AgentCommandType, type PositionSample } from '../shared/contracts';
import { buildRoutePath, pointAtDistance } from '../shared/geo';

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
 * Caminho das posições REAIS. Enquanto a simulação de deslocamento está ligada, o GPS
 * é ignorado: se os dois publicassem, o agente ficaria oscilando entre a posição
 * simulada e a real, e o turn-by-turn (que mede distância até a manobra a cada fix)
 * enlouqueceria. A simulação chama `report` direto.
 */
function reportFromGps(ctx: TrackingContext, sample: PositionSample): void {
  if (simulating) return;
  report(ctx, sample);
}

// --- Simulação de deslocamento (DESENVOLVIMENTO) ------------------------------------
/**
 * Gera posições sintéticas ao longo de um traçado e as injeta no MESMO caminho do GPS
 * (`report`), de modo que tudo a jusante não perceba a diferença: a barra turn-by-turn
 * avança, a locução dispara, o mapa acompanha e — como `report` também publica — a
 * central vê o agente percorrendo a rota.
 *
 * Existe porque a camada de navegação só se comprova em MOVIMENTO, e a alternativa era
 * sair dirigindo com o aparelho na mão a cada ajuste.
 */
let simTimer: ReturnType<typeof setInterval> | null = null;
let simulating = false;
const simListeners = new Set<(active: boolean) => void>();

export interface SimulationOptions {
  /** Velocidade do deslocamento simulado. Padrão: 40 km/h (trânsito urbano). */
  speedKmh?: number;
  /** Intervalo entre posições. Padrão: 1 s (equivale a um GPS em navegação). */
  intervalMs?: number;
}

export function isSimulatingMovement(): boolean {
  return simulating;
}

/** Inscreve um ouvinte do liga/desliga da simulação (recebe o estado atual de imediato). */
export function subscribeSimulation(listener: (active: boolean) => void): () => void {
  simListeners.add(listener);
  listener(simulating);
  return () => {
    simListeners.delete(listener);
  };
}

function emitSimulation(): void {
  for (const listener of simListeners) listener(simulating);
}

/**
 * Percorre `geometry` (GeoJSON `[lng, lat]`, como vem da rota) do início ao fim.
 * Devolve `false` se o traçado for curto demais para simular. Ao chegar ao fim, para
 * sozinha — a última posição fica publicada, então a chegada é detectada normalmente.
 */
export function startSimulatedMovement(
  ctx: TrackingContext,
  geometry: [number, number][],
  options: SimulationOptions = {},
): boolean {
  if (geometry.length < 2) return false;
  stopSimulatedMovement();

  const path = buildRoutePath(geometry);
  const speedMs = ((options.speedKmh ?? 40) * 1000) / 3600;
  const intervalMs = options.intervalMs ?? 1000;
  const stepMeters = (speedMs * intervalMs) / 1000;
  let travelled = 0;

  simulating = true;
  emitSimulation();

  simTimer = setInterval(() => {
    const cursor = pointAtDistance(path, travelled);
    report(ctx, {
      lat: cursor.pos.lat,
      lng: cursor.pos.lng,
      accuracy: 5,
      speed: cursor.done ? 0 : Number(speedMs.toFixed(2)),
      heading: Number(cursor.heading.toFixed(1)),
      // Preserva a bateria real do aparelho; o resto da amostra é sintético.
      battery: lastSample?.battery,
      activity: cursor.done ? 'still' : 'in_vehicle',
      capturedAt: new Date().toISOString(), // UTC absoluto, como o GPS
    });
    if (cursor.done) {
      stopSimulatedMovement();
      return;
    }
    travelled += stepMeters;
  }, intervalMs);

  return true;
}

/** Encerra a simulação e devolve o comando ao GPS real. */
export function stopSimulatedMovement(): void {
  if (simTimer) clearInterval(simTimer);
  simTimer = null;
  if (!simulating) return;
  simulating = false;
  emitSimulation();
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
  if (initialized) return;

  /**
   * Responde ao comando `request_fix` da central: força um fix AGORA e publica. Mesmo
   * caminho do heartbeat — a central usa isto quando a telemetria congelou (GPS
   * hibernando parado, e o Doze podendo adiar o heartbeat por dezenas de minutos).
   * A resposta não é síncrona: sai como uma posição normal no canal `posicao`.
   *
   * Registrado por injeção (`addCommandHandler`) para não criar import circular — este
   * módulo já importa `publishPosition` do mqtt. Sem remoção: o `initialized` acima
   * garante registro único e o handler vive o processo inteiro.
   */
  addCommandHandler((type) => {
    if (type !== AgentCommandType.REQUEST_FIX) return;
    void (async () => {
      try {
        const location = await BackgroundGeolocation.getCurrentPosition({
          samples: 1,
          persist: true,
        });
        reportFromGps(ctx, toSample(location));
      } catch {
        /* sem fix disponível neste momento — a central verá a posição anterior */
      }
    })();
  });

  BackgroundGeolocation.onLocation((location: Location) => {
    reportFromGps(ctx, toSample(location));
  });

  BackgroundGeolocation.onMotionChange((event: MotionChangeEvent) => {
    // event.isMoving indica transição parado <-> em movimento; a posição
    // vem em event.location (o evento NÃO é um Location direto como no onLocation).
    reportFromGps(ctx, toSample(event.location));
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
      reportFromGps(ctx, toSample(location));
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
