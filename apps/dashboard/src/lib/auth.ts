import type { LoginResponse } from '@cerberus/shared';

const TOKEN_KEY = 'cerberus_token';
const USER_KEY = 'cerberus_user';

/** Persistência simples de sessão no browser (MVP). */
export function saveSession(res: LoginResponse): void {
  localStorage.setItem(TOKEN_KEY, res.token);
  localStorage.setItem(USER_KEY, JSON.stringify(res.user));
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): LoginResponse['user'] | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as LoginResponse['user']) : null;
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
