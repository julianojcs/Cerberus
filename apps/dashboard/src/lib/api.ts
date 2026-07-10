import type { LoginResponse, Operation } from '@cerberus/shared';
import { getToken } from './auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Erro ${res.status}`);
  }
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

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  operations: () => request<Operation[]>('/operations'),
  operation: (id: string) => request<Operation>(`/operations/${id}`),
  latestPositions: (operationId: string) =>
    request<LatestPosition[]>(`/operations/${operationId}/positions/latest`),
  // Histórico da operação (trilha). Vem ordenado do mais recente para o mais antigo.
  positionHistory: (operationId: string, limit = 2000) =>
    request<LatestPosition[]>(`/operations/${operationId}/positions?limit=${limit}`),
  // Broadcast da central (admin) para todos os agentes da operação.
  broadcast: (operationId: string, text: string) =>
    request<{ id: string; type: string; text?: string }>(`/operations/${operationId}/broadcast`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
};
