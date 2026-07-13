import * as SecureStore from 'expo-secure-store';
import { config } from '../config';
import { provisionKeys } from './keys';

const TOKEN_KEY = 'cerberus_token';
const SESSION_KEY = 'cerberus_session';

export interface Session {
  token: string;
  userId: string;
  name: string;
  role: string;
  agentId?: string;
  operationIds: string[];
}

/** Autentica na API e guarda o token no armazenamento seguro do dispositivo. */
export async function login(username: string, password: string): Promise<Session> {
  const res = await fetch(`${config.apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Falha no login' }));
    throw new Error(body.error ?? `Erro ${res.status}`);
  }
  const data = (await res.json()) as {
    token: string;
    user: {
      id: string;
      name: string;
      role: string;
      agentId?: string;
      operationIds: string[];
    };
  };

  const session: Session = {
    token: data.token,
    userId: data.user.id,
    name: data.user.name,
    role: data.user.role,
    agentId: data.user.agentId,
    operationIds: data.user.operationIds,
  };

  await SecureStore.setItemAsync(TOKEN_KEY, data.token);
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));

  // Provisiona a chave E2EE do agente (gera + registra a pública). Não bloqueia o
  // login se falhar — o app re-tenta no próximo login e a decifra tolera ausência.
  await provisionKeys({ userId: session.userId, token: session.token }).catch((err) =>
    console.warn('[e2ee] falha ao provisionar chave:', err?.message ?? err),
  );

  return session;
}

export async function getSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function logout(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(SESSION_KEY);
}
