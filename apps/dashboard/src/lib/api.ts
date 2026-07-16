import type {
  AuditLogEntry,
  DeviceBlockInfo,
  E2eeKeyBackup,
  KeyDirectoryEntry,
  LoginResponse,
  Operation,
  SessionInfo,
  TeamInfo,
  UserInfo,
} from '@cerberus/shared';
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

/** Membro (usuário) de uma operação — resposta de GET /operations/:id/members. */
export interface OperationMember {
  id: string;
  username: string;
  name: string;
  role: string; // 'admin' | 'agente' | 'superadmin'
  agentId?: string;
}

export interface LatestPosition {
  id: string;
  operationId: string;
  agentId: string;
  lng: number;
  lat: number;
  accuracy?: number;
  altitude?: number;
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
  teamId?: string; // presente ⇒ mensagem de equipe (Fase 2b)
  recipientId?: string; // presente ⇒ DM (agente destino)
  text?: string;
  ciphertext?: string; // envelope E2EE (text/broadcast); decifrado no cliente
  mediaRef?: string;
  lat?: number; // geotag da mídia (onde a foto foi capturada)
  lng?: number;
  capturedAt: string;
}

/** Estatísticas de uma mídia (Fase 6b): views + favoritos + se EU favoritei. */
export interface MediaStatInfo {
  mediaId: string;
  views: number;
  favorites: number;
  favorited: boolean;
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

/** Baixa um recurso protegido como bytes crus (ex.: blob de mídia E2EE para decifrar). */
export async function fetchAuthedBytes(path: string): Promise<Uint8Array> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Upload multipart autenticado (mídia E2EE). NÃO usa `request()` — este força
 * `Content-Type: application/json`, o que quebraria a detecção de boundary do
 * multipart. Aqui o browser define o `Content-Type: multipart/form-data; boundary=…`.
 */
async function uploadForm<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Erro ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  operations: () => request<Operation[]>('/operations'),
  operation: (id: string) => request<Operation>(`/operations/${id}`),
  // CRUD de operações (Fase 1 · slice 1c-2). Criar/editar exigem admin (+ escopo no
  // editar; SA transcende); excluir é SUPERADMIN (cascata de alto impacto).
  createOperation: (data: { name: string; type: string; status?: string }) =>
    request<Operation>('/operations', { method: 'POST', body: JSON.stringify(data) }),
  updateOperation: (id: string, data: Partial<{ name: string; type: string; status: string }>) =>
    request<Operation>(`/operations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteOperation: (id: string) => request<void>(`/operations/${id}`, { method: 'DELETE' }),
  // Membros (usuários) no escopo da operação — popula o multiselect de agentes.
  operationMembers: (opId: string) => request<OperationMember[]>(`/operations/${opId}/members`),

  // --- Equipes (Fase 2a) ---
  teams: () => request<TeamInfo[]>('/teams'),
  operationTeams: (opId: string) => request<TeamInfo[]>(`/operations/${opId}/teams`),
  createTeam: (
    opId: string,
    data: { name: string; color?: string; agentIds?: string[]; leadId?: string },
  ) =>
    request<TeamInfo>(`/operations/${opId}/teams`, { method: 'POST', body: JSON.stringify(data) }),
  updateTeam: (
    opId: string,
    tid: string,
    data: Partial<{ name: string; color: string; agentIds: string[]; leadId: string }>,
  ) =>
    request<TeamInfo>(`/operations/${opId}/teams/${tid}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteTeam: (opId: string, tid: string) =>
    request<void>(`/operations/${opId}/teams/${tid}`, { method: 'DELETE' }),
  // E2EE: registra a própria chave pública e lê o diretório de chaves da operação.
  registerPublicKey: (publicKey: string) =>
    request<{ publicKey: string }>('/auth/public-key', {
      method: 'PUT',
      body: JSON.stringify({ publicKey }),
    }),
  operationKeys: (operationId: string) =>
    request<KeyDirectoryEntry[]>(`/operations/${operationId}/keys`),
  // Fase 5e-3 — backup da chave E2EE cifrado no cliente (o servidor guarda opaco).
  putE2eeBackup: (blob: E2eeKeyBackup) =>
    request<void>('/auth/e2ee-backup', { method: 'PUT', body: JSON.stringify(blob) }),
  getE2eeBackup: () => request<E2eeKeyBackup>('/auth/e2ee-backup'),
  deleteE2eeBackup: () => request<void>('/auth/e2ee-backup', { method: 'DELETE' }),
  /**
   * Pede ao AGENTE uma posição fresca (canal `comando`). Fire-and-forget: o 202 diz que
   * o comando foi emitido no barramento, não que o agente respondeu — a resposta chega
   * depois como uma posição normal, pelo MQTT. Necessário porque o GPS hiberna com o
   * agente parado e o Doze pode adiar o heartbeat por dezenas de minutos.
   */
  requestAgentFix: (operationId: string, agentId: string) =>
    request<{ sent: boolean }>(`/operations/${operationId}/agents/${agentId}/command`, {
      method: 'POST',
      body: JSON.stringify({ type: 'request_fix' }),
    }),
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
  // Chat de equipe (Fase 2b) — histórico + envio (corpo cifrado, selado p/ os membros).
  teamMessages: (operationId: string, teamId: string) =>
    request<TacticalMessage[]>(`/operations/${operationId}/teams/${teamId}/messages`),
  sendTeamMessage: (operationId: string, teamId: string, ciphertext: string) =>
    request<TacticalMessage>(`/operations/${operationId}/teams/${teamId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ ciphertext }),
    }),
  // DM central→agente (Fase 2b) — histórico + envio (corpo selado p/ o agente).
  agentMessages: (operationId: string, agentId: string) =>
    request<TacticalMessage[]>(
      `/operations/${operationId}/agents/${encodeURIComponent(agentId)}/messages`,
    ),
  sendAgentMessage: (operationId: string, agentId: string, ciphertext: string) =>
    request<TacticalMessage>(
      `/operations/${operationId}/agents/${encodeURIComponent(agentId)}/messages`,
      { method: 'POST', body: JSON.stringify({ ciphertext }) },
    ),
  // Upload de mídia E2EE escopada (Fase 3b-2). `form` = FormData com `ciphertext`
  // (envelope) ANTES do `file` (blob cifrado). Multipart via uploadForm (não request).
  uploadTeamMedia: (operationId: string, teamId: string, form: FormData) =>
    uploadForm<TacticalMessage>(`/operations/${operationId}/teams/${teamId}/media`, form),
  uploadAgentMedia: (operationId: string, agentId: string, form: FormData) =>
    uploadForm<TacticalMessage>(
      `/operations/${operationId}/agents/${encodeURIComponent(agentId)}/media`,
      form,
    ),
  // Upload op-wide (Fase 6d — documentos): mesma rota de mídia, blob E2EE opaco.
  uploadMedia: (operationId: string, form: FormData) =>
    uploadForm<TacticalMessage>(`/operations/${operationId}/media`, form),
  // Caminho da mídia no GridFS (use com fetchBlobUrl por causa do Authorization).
  mediaPath: (operationId: string, fileId: string) => `/operations/${operationId}/media/${fileId}`,
  // --- Estatísticas de mídia: favoritos + visualizações (Fase 6b) ---
  mediaStats: (operationId: string) =>
    request<MediaStatInfo[]>(`/operations/${operationId}/media-stats`),
  viewMedia: (operationId: string, mediaId: string) =>
    request<{ views: number }>(`/operations/${operationId}/media/${mediaId}/view`, {
      method: 'POST',
    }),
  toggleFavoriteMedia: (operationId: string, mediaId: string) =>
    request<{ favorited: boolean; favorites: number }>(
      `/operations/${operationId}/media/${mediaId}/favorite`,
      { method: 'POST' },
    ),
  // --- Geofencing (Fase 4) ---
  geofences: (operationId: string) => request<Geofence[]>(`/operations/${operationId}/geofences`),
  createGeofence: (operationId: string, data: GeofenceInput & { name: string }) =>
    request<Geofence>(`/operations/${operationId}/geofences`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  patchGeofence: (operationId: string, gid: string, data: GeofenceInput) =>
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

  // --- Admin: usuários / dispositivos / auditoria (Fase 1 · slice 1c) ---
  users: () => request<UserInfo[]>('/users'),
  createUser: (data: {
    username: string;
    name: string;
    password: string;
    role: string;
    agentId?: string;
    operationIds?: string[];
  }) => request<UserInfo>('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (
    id: string,
    data: Partial<{ name: string; role: string; agentId: string; password: string }>,
  ) => request<UserInfo>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),
  userDevices: (id: string) => request<SessionInfo[]>(`/users/${id}/devices`),
  kickSession: (sid: string) => request<void>(`/sessions/${sid}/kick`, { method: 'POST' }),
  blockUser: (id: string) => request<void>(`/users/${id}/block`, { method: 'POST' }),
  unblockUser: (id: string) => request<void>(`/users/${id}/unblock`, { method: 'POST' }),
  /** Revoga a chave E2EE do usuário (Fase 5e-2): para de receber novas mensagens até rotacionar. */
  revokeUserKey: (id: string) => request<void>(`/users/${id}/revoke-key`, { method: 'POST' }),
  blockDevice: (deviceId: string, reason?: string) =>
    request<void>(`/devices/${encodeURIComponent(deviceId)}/block`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unblockDevice: (deviceId: string) =>
    request<void>(`/devices/${encodeURIComponent(deviceId)}/unblock`, { method: 'POST' }),
  blockedDevices: () => request<DeviceBlockInfo[]>('/devices/blocked'),
  audit: (limit = 200) => request<AuditLogEntry[]>(`/audit?limit=${limit}`),
};

export interface Settings {
  /** Nº mínimo de pontos para uma rota ser listada/plotada. */
  minRoutePoints: number;
  /** Ligar rotas: linha do último ponto de uma rota ao primeiro da próxima. */
  connectRoutes: boolean;
  /** Intervalo (min) sem transmissão que quebra a rota em segmentos. */
  maxGapMinutes: number;
}

/** Forma de uma zona. Sem `shape` ⇒ círculo (retrocompat). */
export type GeofenceShapeName = 'circle' | 'rectangle' | 'polygon';

export interface Geofence {
  id: string;
  operationId: string;
  name: string;
  shape: GeofenceShapeName;
  lng?: number; // círculo/retângulo: centro; polígono: centroide
  lat?: number;
  radiusMeters?: number; // círculo
  widthMeters?: number; // retângulo
  heightMeters?: number;
  rotationDeg?: number;
  vertices?: [number, number][]; // polígono
  color: string; // token de familia Tailwind (ex.: 'green')
  active: boolean;
  // Fase 5b — regras avançadas.
  teamId?: string | null; // zona por equipe (null = todas)
  windowStartMin?: number | null; // agendamento: minutos-do-dia UTC
  windowEndMin?: number | null;
  triggerOn?: GeofenceTriggerName; // enter | exit | both
  severity?: GeofenceSeverityName; // low | medium | high | critical
}

export type GeofenceTriggerName = 'enter' | 'exit' | 'both';
export type GeofenceSeverityName = 'low' | 'medium' | 'high' | 'critical';

/** Corpo de criação/edição de zona (geometria por forma). */
export interface GeofenceInput {
  name?: string;
  shape?: GeofenceShapeName;
  lng?: number;
  lat?: number;
  radiusMeters?: number;
  widthMeters?: number;
  heightMeters?: number;
  rotationDeg?: number;
  vertices?: [number, number][];
  color?: string;
  // Fase 5b — regras avançadas.
  teamId?: string | null;
  windowStartMin?: number | null;
  windowEndMin?: number | null;
  triggerOn?: GeofenceTriggerName;
  severity?: GeofenceSeverityName;
}

export interface GeofenceAlert {
  id: string;
  operationId: string;
  agentId: string;
  geofenceId: string;
  geofenceName: string;
  type: 'enter' | 'exit';
  severity?: GeofenceSeverityName; // Fase 5b
  lng?: number;
  lat?: number;
  capturedAt: string;
}
