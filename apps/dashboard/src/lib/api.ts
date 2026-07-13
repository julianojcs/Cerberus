import type { KeyDirectoryEntry, LoginResponse, Operation } from '@cerberus/shared';
import { clearSession, getToken } from './auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // Só declara JSON quando há corpo — senão o Fastify rejeita DELETE/GET sem
      // corpo com 400 FST_ERR_CTP_EMPTY_JSON_BODY.
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Sessão expirada/inválida: limpa e volta ao login (senão a tela ficaria
    // vazia sem avisar que o usuário está deslogado).
    if (res.status === 401 && typeof window !== 'undefined') {
      clearSession();
      if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Erro ${res.status}`);
  }
  if (res.status === 204) return undefined as T; // sem corpo (ex.: DELETE)
  return res.json() as Promise<T>;
}

export interface LatestPosition {
  id: string;
  operationId: string;
  agentId: string;
  lng: number;
  lat: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  battery?: number;
  activity?: string;
  capturedAt: string;
}

export interface TacticalMessage {
  id: string;
  operationId: string;
  senderId: string;
  type: string; // 'text' | 'media' | 'broadcast'
  text?: string;
  mediaRef?: string;
  lat?: number; // geotag da mídia (onde a foto foi capturada)
  lng?: number;
  capturedAt: string;
}

/**
 * Baixa um recurso protegido (ex.: mídia do GridFS) com o Bearer token e devolve
 * um object URL — necessário porque `<img src>` não envia o header Authorization.
 * Quem chama deve liberar o URL com `URL.revokeObjectURL` ao desmontar.
 */
export async function fetchBlobUrl(path: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  operations: () => request<Operation[]>('/operations'),
  operation: (id: string) => request<Operation>(`/operations/${id}`),
  // E2EE: registra a própria chave pública e lê o diretório de chaves da operação.
  registerPublicKey: (publicKey: string) =>
    request<{ publicKey: string }>('/auth/public-key', {
      method: 'PUT',
      body: JSON.stringify({ publicKey }),
    }),
  operationKeys: (operationId: string) =>
    request<KeyDirectoryEntry[]>(`/operations/${operationId}/keys`),
  latestPositions: (operationId: string) =>
    request<LatestPosition[]>(`/operations/${operationId}/positions/latest`),
  // Histórico da operação (trilha). Vem ordenado do mais recente para o mais antigo.
  positionHistory: (operationId: string, limit = 2000) =>
    request<LatestPosition[]>(`/operations/${operationId}/positions?limit=${limit}`),
  // Broadcast E2EE da central (admin) → agentes. O corpo já vai cifrado (envelope).
  broadcast: (operationId: string, ciphertext: string) =>
    request<{ id: string; type: string }>(`/operations/${operationId}/broadcast`, {
      method: 'POST',
      body: JSON.stringify({ ciphertext }),
    }),
  // Histórico de mensagens (texto/mídia/broadcast) da operação.
  messages: (operationId: string) =>
    request<TacticalMessage[]>(`/operations/${operationId}/messages`),
  // Caminho da mídia no GridFS (use com fetchBlobUrl por causa do Authorization).
  mediaPath: (operationId: string, fileId: string) => `/operations/${operationId}/media/${fileId}`,
  // --- Geofencing (Fase 4) ---
  geofences: (operationId: string) => request<Geofence[]>(`/operations/${operationId}/geofences`),
  createGeofence: (
    operationId: string,
    data: { name: string; lng: number; lat: number; radiusMeters: number; color?: string },
  ) =>
    request<Geofence>(`/operations/${operationId}/geofences`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  patchGeofence: (
    operationId: string,
    gid: string,
    data: Partial<{ name: string; lng: number; lat: number; radiusMeters: number; color: string }>,
  ) =>
    request<Geofence>(`/operations/${operationId}/geofences/${gid}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteGeofence: (operationId: string, gid: string) =>
    request<void>(`/operations/${operationId}/geofences/${gid}`, { method: 'DELETE' }),
  alerts: (operationId: string) => request<GeofenceAlert[]>(`/operations/${operationId}/alerts`),
  // Reprocessa o histórico de posições contra as zonas atuais e regenera os alertas.
  recomputeAlerts: (operationId: string) =>
    request<{ alertsCreated: number }>(`/operations/${operationId}/geofences/recompute`, {
      method: 'POST',
    }),
  // Configurações globais do sistema (leitura autenticada; escrita restrita a admin).
  settings: () => request<Settings>('/settings'),
  patchSettings: (data: Partial<Settings>) =>
    request<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),
};

export interface Settings {
  /** Nº mínimo de pontos para uma rota ser listada/plotada. */
  minRoutePoints: number;
  /** Ligar rotas: linha do último ponto de uma rota ao primeiro da próxima. */
  connectRoutes: boolean;
  /** Intervalo (min) sem transmissão que quebra a rota em segmentos. */
  maxGapMinutes: number;
}

export interface Geofence {
  id: string;
  operationId: string;
  name: string;
  lng: number;
  lat: number;
  radiusMeters: number;
  color: string; // token de familia Tailwind (ex.: 'green')
  active: boolean;
}

export interface GeofenceAlert {
  id: string;
  operationId: string;
  agentId: string;
  geofenceId: string;
  geofenceName: string;
  type: 'enter' | 'exit';
  lng?: number;
  lat?: number;
  capturedAt: string;
}
