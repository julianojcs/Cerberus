import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AgentCommandType,
  ROUTE_ARRIVAL_METERS,
  type GeocodeResult,
  type PositionSample,
  type RouteInfo,
} from '../shared/contracts';
import {
  bearingDegrees,
  buildRoutePath,
  haversineMeters,
  progressAlongPath,
  toLatLng,
  type LatLng,
  type RoutePath,
} from '../shared/geo';
import { spokenInstruction } from '../shared/format';
import { subscribePositions } from './geolocation';
import { authedFetch } from './http';
import { addCommandHandler } from './mqtt';
import { speak, stopSpeaking } from './speech';

/**
 * Navegação por rota no app do agente (issue #131, Fases 4/5/6b).
 *
 * O comando MQTT traz só o `routeId`; o traçado vem por HTTPS e é PERSISTIDO em
 * AsyncStorage. Depois de baixada, seguir a rota não exige conectividade nenhuma —
 * é exatamente o cenário de campo (túnel, zona de sombra) em que a navegação mais
 * importa. AsyncStorage e não SecureStore: a rota não é segredo (o destino já viajou
 * em claro no canal de comando) e o SecureStore trava em ~2048 bytes por chave, que
 * um traçado urbano estoura com folga.
 *
 * O que este módulo NÃO faz: detecção de desvio. Quem detecta é a ponte de ingest no
 * servidor, que recalcula e empurra a rota nova como um `route_assign` — o app só
 * reage a rota nova chegando. Duplicar a detecção aqui geraria duas rotas ativas
 * disputando o mesmo agente.
 */

const ROUTE_KEY = 'cerberus_active_route';

/**
 * Raio (m) que marca a manobra do passo como atingida. 25 m cobre o erro típico de
 * GPS urbano (5–20 m) sem passar de uma esquina para a seguinte.
 */
const STEP_REACHED_METERS = 25;

export interface NavigationContext {
  token: string;
  operationId: string;
  agentId: string;
}

export interface NavigationState {
  route: RouteInfo | null;
  /** Passo atual em `route.steps`; `-1` sem rota ou em traçado direto (fallback). */
  stepIndex: number;
  /** Distância até a manobra do passo atual. `null` sem fix ou em traçado direto. */
  distanceToManeuverMeters: number | null;
  /** Distância que falta ao destino: sobre o traçado, ou em linha reta no fallback. */
  remainingMeters: number | null;
  /** Tempo estimado restante. `null` no fallback (não há estimativa de via). */
  remainingSec: number | null;
  /** Rumo (graus) até o destino — só preenchido no fallback, onde substitui a manobra. */
  bearing: number | null;
  /** Distância do agente ao traçado. Informativo: quem recalcula é o servidor. */
  offRouteMeters: number | null;
  arrived: boolean;
  /** `true` enquanto o traçado está sendo baixado após o comando da central. */
  loading: boolean;
}

const EMPTY: NavigationState = {
  route: null,
  stepIndex: -1,
  distanceToManeuverMeters: null,
  remainingMeters: null,
  remainingSec: null,
  bearing: null,
  offRouteMeters: null,
  arrived: false,
  loading: false,
};

let ctx: NavigationContext | null = null;
let state: NavigationState = EMPTY;
let path: RoutePath | null = null;
let stepIndex = 0;
/** Último passo já falado — garante UMA locução por manobra, não uma por fix de GPS. */
let spokenStep = -1;
let arrivalAnnounced = false;

const listeners = new Set<(s: NavigationState) => void>();

function emit(patch: Partial<NavigationState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function getNavigationState(): NavigationState {
  return state;
}

/** Inscreve um ouvinte do estado de navegação (recebe o estado atual de imediato). */
export function subscribeNavigation(listener: (s: NavigationState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

// --- Persistência local ---

async function cacheRoute(route: RouteInfo | null): Promise<void> {
  try {
    if (route) await AsyncStorage.setItem(ROUTE_KEY, JSON.stringify(route));
    else await AsyncStorage.removeItem(ROUTE_KEY);
  } catch {
    /* falha de armazenamento não pode derrubar a navegação em curso */
  }
}

async function readCachedRoute(): Promise<RouteInfo | null> {
  try {
    const raw = await AsyncStorage.getItem(ROUTE_KEY);
    return raw ? (JSON.parse(raw) as RouteInfo) : null;
  } catch {
    return null;
  }
}

// --- API HTTP ---

function requireContext(): NavigationContext {
  if (!ctx) throw new Error('Navegação não inicializada.');
  return ctx;
}

/**
 * Teto de espera das chamadas de rota. O `fetch` do React Native NÃO tem timeout: uma
 * requisição emitida no instante em que o aparelho troca de Wi-Fi para dados móveis
 * — o que acontece o tempo todo com o agente caminhando — fica pendente para sempre.
 *
 * Isso não trava só a chamada: como `handleMapTap` ignora toques enquanto há criação em
 * curso, uma única requisição pendurada deixa o botão preso em "Traçando rota…" e o
 * agente sem conseguir definir destino nenhum até reiniciar o app. Foi o que apareceu
 * em campo. O servidor responde em ~1 s; 20 s é folga larga para rede ruim.
 */
const ROUTE_REQUEST_TIMEOUT_MS = 20_000;

/**
 * `authedFetch` com teto de espera. Falhar em voz alta é melhor do que pendurar a UI:
 * o agente vê o erro e tenta de novo, em vez de ficar olhando um botão morto.
 */
async function fetchWithTimeout(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_REQUEST_TIMEOUT_MS);
  try {
    return await authedFetch(token, path, { ...init, signal: controller.signal });
  } catch (err) {
    // `AbortError` é o nosso próprio teto disparando — traduz para algo acionável.
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Sem resposta do servidor. Verifique a conexão e tente de novo.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    statusCode?: number;
  } | null;

  // Os erros da NOSSA API vêm como `{ error: '<texto pt-BR>' }` e são para o agente ler.
  // Já o envelope PADRÃO do Fastify (rota inexistente, erro não tratado) traz
  // `statusCode` + `message`, e ali `error` é apenas o nome do status em inglês — um
  // "Not Found" seco. Repassar isso troca uma mensagem útil por duas palavras sem
  // contexto, além de furar o pt-BR da UI.
  if (body?.statusCode != null && body?.message != null) {
    // 404 no envelope padrão = o ENDPOINT não existe (não é "o recurso sumiu"). Na
    // prática significa app novo contra API velha — foi exatamente o que aconteceu no
    // primeiro teste em campo, e a mensagem crua não ajudou a descobrir isso.
    return res.status === 404
      ? `${fallback}: endpoint inexistente nesta API (servidor desatualizado?)`
      : fallback;
  }
  return body?.error ?? fallback;
}

/** Baixa o traçado apontado pelo comando. `null` quando a rota não existe mais (404). */
async function fetchRoute(routeId: string): Promise<RouteInfo | null> {
  const c = requireContext();
  const res = await fetchWithTimeout(c.token, `/operations/${c.operationId}/routes/${routeId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorMessage(res, `Erro ${res.status} ao obter a rota`));
  return (await res.json()) as RouteInfo;
}

/** Rota ativa do agente no servidor. `null` quando não há nenhuma (404). */
async function fetchActiveRoute(): Promise<RouteInfo | null> {
  const c = requireContext();
  const res = await fetchWithTimeout(
    c.token,
    `/operations/${c.operationId}/agents/${c.agentId}/routes/active`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorMessage(res, `Erro ${res.status} ao obter a rota ativa`));
  return (await res.json()) as RouteInfo;
}

/**
 * Fase 6b: o próprio agente escolhe o destino. A ORIGEM não vai no corpo de propósito —
 * o servidor usa a última posição conhecida do agente (contrato de `createRouteSchema`).
 */
export async function requestRouteToDestination(
  destination: LatLng,
  label?: string,
): Promise<RouteInfo> {
  const c = requireContext();
  const res = await fetchWithTimeout(c.token, `/operations/${c.operationId}/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: c.agentId, lat: destination.lat, lng: destination.lng, label }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Erro ${res.status} ao traçar a rota`));
  const route = (await res.json()) as RouteInfo;
  // Aplica direto da resposta: o `route_assign` de volta pelo barramento pode nem
  // chegar (o POST responde 201 mesmo com o MQTT fora) e a rota já está em mãos.
  await applyRoute(route, 'silent');
  return route;
}

// --- Geocodificação (busca de endereço e o inverso) ---

/**
 * Busca de endereço. `near` é a posição ATUAL do agente e vai SEMPRE que existir: sem
 * viés de proximidade, "Rua Bahia" devolve acertos no país inteiro e a lista fica
 * inútil para quem está a dois quarteirões do destino.
 *
 * **Não chamar a cada tecla digitada.** A política de uso do Nominatim proíbe
 * expressamente busca por digitação (autocomplete), e o servidor serializa as chamadas
 * num teto de 1 req/s para o processo INTEIRO — um debounce local não contornaria isso,
 * só encheria a fila e atrasaria a busca de todo mundo na mesma API. A busca dispara no
 * SUBMIT (botão ou tecla de busca do teclado). Não "melhorar" isto para autocomplete.
 */
export async function searchAddresses(
  query: string,
  near?: LatLng | null,
): Promise<GeocodeResult[]> {
  const c = requireContext();
  const params = [`q=${encodeURIComponent(query)}`];
  if (near) params.push(`lat=${near.lat}`, `lng=${near.lng}`);
  const res = await fetchWithTimeout(
    c.token,
    `/operations/${c.operationId}/geocode?${params.join('&')}`,
  );
  if (!res.ok) throw new Error(await errorMessage(res, `Erro ${res.status} na busca de endereço`));
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as GeocodeResult[]) : [];
}

/**
 * Coordenada → endereço, para o toque no mapa mostrar "Rua X, 100 · Centro" em vez de
 * um par de números. NUNCA lança: o endereço é um enfeite do diálogo de confirmação, e
 * o agente não pode perder a capacidade de definir destino porque o geocodificador
 * está fora do ar. `null` (resposta legítima do servidor em meio de mata) e falha de
 * rede colapsam no mesmo caso — quem chama cai no rótulo por coordenada.
 */
export async function reverseGeocode(point: LatLng): Promise<GeocodeResult | null> {
  try {
    const c = requireContext();
    const res = await fetchWithTimeout(
      c.token,
      `/operations/${c.operationId}/geocode/reverse?lat=${point.lat}&lng=${point.lng}`,
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return body && typeof body === 'object' ? (body as GeocodeResult) : null;
  } catch {
    return null;
  }
}

/**
 * Cancela a rota ativa. Limpa o estado local mesmo se o servidor recusar: se ele já
 * concluiu/substituiu a rota (404), insistir em navegar seria pior do que parar.
 */
export async function cancelActiveRoute(): Promise<void> {
  const current = state.route;
  try {
    if (current && ctx) {
      await fetchWithTimeout(ctx.token, `/operations/${ctx.operationId}/routes/${current.id}`, {
        method: 'DELETE',
      });
    }
  } finally {
    await clearRoute();
  }
}

// --- Ciclo de vida da rota ---

/** `announce`: falar a chegada da rota, ou aplicá-la em silêncio (retomada/criação local). */
type ApplyMode = 'announce' | 'silent';

async function applyRoute(route: RouteInfo, mode: ApplyMode): Promise<void> {
  path = buildRoutePath(route.geometry);
  stepIndex = 0;
  spokenStep = -1;
  arrivalAnnounced = false;
  stopSpeaking();
  emit({ ...EMPTY, route });
  await cacheRoute(route);

  if (mode === 'announce') {
    // `recalculatedFrom` = o servidor detectou desvio e refez o trajeto. Dizer isso
    // evita o agente achar que errou o comando quando a instrução muda sozinha.
    speak(route.recalculatedFrom ? 'Rota recalculada.' : 'Nova rota recebida.');
  }
  // A primeira instrução sai no próximo fix de GPS, quando já dá para dizer a
  // distância até a manobra.
}

async function clearRoute(): Promise<void> {
  path = null;
  stepIndex = 0;
  spokenStep = -1;
  arrivalAnnounced = false;
  stopSpeaking();
  emit(EMPTY);
  await cacheRoute(null);
}

async function adoptRoute(routeId?: string): Promise<void> {
  emit({ loading: true });
  try {
    const route = routeId ? await fetchRoute(routeId) : await fetchActiveRoute();
    if (route) await applyRoute(route, 'announce');
    else emit({ loading: false });
  } catch {
    // Sem rede no instante do despacho: a rota fica no servidor e é recuperada pelo
    // `/routes/active` na próxima vez que a tela subir com conectividade.
    emit({ loading: false });
  }
}

/**
 * Reconciliação ao (re)conectar: o cache local pode estar velho (rota cancelada ou
 * substituída enquanto o app estava fora) e o servidor pode ter um despacho que o app
 * nunca recebeu. O cache entra primeiro para a navegação já valer offline; o servidor
 * corrige em seguida, se houver rede.
 */
async function restoreRoute(): Promise<void> {
  const cached = await readCachedRoute();
  const c = ctx;
  if (!c) return;
  if (cached && cached.agentId === c.agentId && cached.operationId === c.operationId) {
    await applyRoute(cached, 'silent');
  } else if (cached) {
    await cacheRoute(null); // rota de outro agente/operação (troca de login) — descarta
  }

  try {
    const active = await fetchActiveRoute();
    if (ctx !== c) return; // a tela foi desmontada durante a requisição
    if (active) {
      if (active.id !== state.route?.id) await applyRoute(active, 'announce');
    } else if (state.route) {
      await clearRoute(); // 404 EXPLÍCITO: o servidor não tem rota ativa para este agente
    }
  } catch {
    /* sem rede: segue com o cache — o traçado baixado não depende de conectividade */
  }
}

// --- Progresso a cada fix de GPS ---

/** Localização da manobra de um passo, já invertida de `[lng, lat]` para `{lat, lng}`. */
function stepLocation(route: RouteInfo, index: number): LatLng | null {
  const step = route.steps[index];
  return step ? toLatLng(step.location) : null;
}

/**
 * Avanço MONOTÔNICO do passo atual: o índice nunca retrocede. Com o jitter do GPS,
 * escolher "o passo mais próximo" faria a barra piscar entre duas manobras quando o
 * traçado passa duas vezes perto do mesmo ponto.
 */
function advanceStep(route: RouteInfo, pos: LatLng): void {
  while (stepIndex < route.steps.length - 1) {
    const location = stepLocation(route, stepIndex);
    if (!location || haversineMeters(pos, location) > STEP_REACHED_METERS) break;
    stepIndex += 1;
  }
}

function announceStep(route: RouteInfo, distanceToManeuver: number | null): void {
  if (stepIndex === spokenStep) return; // já falado — não repetir a cada fix
  const step = route.steps[stepIndex];
  if (!step) return;
  spokenStep = stepIndex;
  speak(spokenInstruction(step.instruction, distanceToManeuver ?? 0));
}

function onPosition(sample: PositionSample): void {
  const route = state.route;
  if (!route) return;
  const pos: LatLng = { lat: sample.lat, lng: sample.lng };
  const destination: LatLng = { lat: route.destination.lat, lng: route.destination.lng };
  const straightToDestination = haversineMeters(pos, destination);

  // Quanto FALTA NO TRAÇADO — é isto que decide a chegada, não a linha reta até o
  // destino. Sem traçado utilizável (fallback degradado), a reta é tudo que há.
  const remainingOnPath = path
    ? progressAlongPath(path, pos).remainingMeters
    : straightToDestination;

  if (route.fallback || !path) {
    // Provedor de rotas fora: o traçado é a reta origem→destino. Não existe manobra
    // para anunciar, então degrada para rumo + distância direta — fingir turn-by-turn
    // sobre uma linha reta mandaria o agente para dentro de quarteirão.
    emit({
      stepIndex: -1,
      distanceToManeuverMeters: null,
      remainingMeters: straightToDestination,
      remainingSec: null,
      bearing: bearingDegrees(pos, destination),
      offRouteMeters: null,
    });
  } else {
    advanceStep(route, pos);
    const location = stepLocation(route, stepIndex);
    const distanceToManeuver = location ? haversineMeters(pos, location) : null;
    const progress = progressAlongPath(path, pos);
    emit({
      stepIndex,
      distanceToManeuverMeters: distanceToManeuver,
      remainingMeters: progress.remainingMeters,
      // Sem duração por trecho no contrato, o ETA é proporcional ao que falta do
      // traçado. Serve para o agente se planejar; não é promessa de precisão.
      remainingSec:
        route.distanceMeters > 0
          ? Math.round(route.durationSec * (progress.remainingMeters / route.distanceMeters))
          : 0,
      bearing: null,
      offRouteMeters: progress.offRouteMeters,
    });
    announceStep(route, distanceToManeuver);
  }

  // Chegada = traçado completado. Comparar a LINHA RETA com o destino produzia falso
  // positivo em quarteirão urbano: o agente passava a 25 m do destino pela rua paralela,
  // com a volta inteira ainda pela frente, e a barra anunciava "você chegou" no meio do
  // caminho (visto em campo, 19/07/2026). Medir pelo traçado também cobre o atalho: quem
  // chega por fora da rota projeta no fim dela, e o restante cai para perto de zero.
  if (remainingOnPath <= ROUTE_ARRIVAL_METERS && !arrivalAnnounced) {
    arrivalAnnounced = true;
    emit({ arrived: true });
    // A chegada é falada mesmo no traçado direto: não é instrução de via, é o fim da
    // tarefa — e é o momento em que o agente mais precisa tirar os olhos da tela.
    speak('Você chegou ao destino.');
  }
}

/**
 * Liga a navegação: assina os comandos de rota, o fluxo de posições e recupera a rota
 * pendente. Retorna a função de desligamento (chamada ao desmontar a tela).
 */
export function startNavigation(context: NavigationContext): () => void {
  ctx = context;
  const offCommand = addCommandHandler((type, routeId) => {
    if (type === AgentCommandType.ROUTE_ASSIGN) {
      void adoptRoute(routeId);
    } else if (type === AgentCommandType.ROUTE_CANCEL) {
      // Sem `routeId` o comando cancela o que estiver ativo; com ele, só a rota
      // apontada (um cancelamento atrasado não pode derrubar a rota seguinte).
      if (!routeId || routeId === state.route?.id) void clearRoute();
    }
  });
  const offPositions = subscribePositions(onPosition);
  void restoreRoute();

  return () => {
    offCommand();
    offPositions();
    stopSpeaking();
    ctx = null;
  };
}
