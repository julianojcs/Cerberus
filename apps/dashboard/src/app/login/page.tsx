'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { saveSession } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('cerberus123');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(username, password);
      saveSession(res);
      // A chave E2EE é criada/migrada/desbloqueada pelo E2eeUnlockGate (Fase 5e-1),
      // que abre o modal de senha na primeira página autenticada — não mais aqui.
      router.replace('/operations');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <form onSubmit={handleSubmit} className="card" style={{ width: 360 }}>
        <div className="brand" style={{ fontSize: 22, marginBottom: 4 }}>
          <span className="brand-dot" />
          CERBERUS
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Administração Central — acesso restrito
        </p>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            Usuário
          </span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>

        <label style={{ display: 'block', marginBottom: 16 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            Senha
          </span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && <p style={{ color: 'var(--accent)', fontSize: 14, marginTop: 0 }}>{error}</p>}

        <button className="btn" style={{ width: '100%' }} disabled={loading}>
          {loading ? 'Autenticando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
