'use client';

import { useState } from 'react';
import { unlock, migrateLegacy, createProtectedKeys, type KeyState } from '@/lib/e2ee';

const MIN_LEN = 8;

/**
 * Modal (bloqueante) da chave E2EE em repouso (Fase 5e-1). Três modos:
 * - `none`   → define uma senha e CRIA a chave (primeiro acesso).
 * - `legacy` → define uma senha e MIGRA a chave em texto claro (cifra em repouso).
 * - `locked` → DESBLOQUEIA a chave existente (returning user / recarga da página).
 */
export function UnlockKeyModal({
  userId,
  mode,
  onDone,
}: {
  userId: string;
  mode: KeyState;
  onDone: () => void;
}) {
  const setting = mode === 'none' || mode === 'legacy'; // definir senha (vs. desbloquear)
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = setting ? 'Proteja sua chave E2EE' : 'Desbloqueie sua chave E2EE';
  const help =
    mode === 'none'
      ? 'Defina uma senha para cifrar sua chave de criptografia neste navegador. Ela protege as mensagens táticas que você decifra.'
      : mode === 'legacy'
        ? 'Sua chave está sem proteção neste navegador. Defina uma senha para cifrá-la em repouso.'
        : 'Digite sua senha para decifrar as mensagens nesta sessão.';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (setting) {
      if (pass.length < MIN_LEN) return setError(`Use ao menos ${MIN_LEN} caracteres.`);
      if (pass !== confirm) return setError('As senhas não conferem.');
    } else if (!pass) {
      return setError('Informe a senha.');
    }
    setBusy(true);
    try {
      if (mode === 'locked') {
        if (!(await unlock(userId, pass))) {
          setError('Senha incorreta.');
          setBusy(false);
          return;
        }
      } else if (mode === 'legacy') {
        await migrateLegacy(userId, pass);
      } else {
        await createProtectedKeys(userId, pass);
      }
      onDone();
    } catch {
      setError('Falha ao processar a chave.');
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,.6)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <form
        onSubmit={submit}
        className="card"
        style={{
          width: '100%',
          maxWidth: 420,
          padding: 20,
          display: 'grid',
          gap: 12,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, color: 'var(--text)' }}>🔒 {title}</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {help}
        </p>

        <input
          type="password"
          autoFocus
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder={setting ? 'Nova senha' : 'Senha'}
          autoComplete={setting ? 'new-password' : 'current-password'}
          style={inputStyle}
        />
        {setting && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirme a senha"
            autoComplete="new-password"
            style={inputStyle}
          />
        )}

        {setting && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--accent)' }}>
            ⚠️ Se esquecer esta senha, não será possível recuperar a chave nem ler o histórico.
          </p>
        )}
        {error && (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--accent)' }} role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            padding: 10,
            borderRadius: 6,
            border: 'none',
            background: 'var(--accent)',
            color: '#fff',
            fontWeight: 700,
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? 'Processando…' : setting ? 'Proteger chave' : 'Desbloquear'}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  colorScheme: 'dark',
  fontSize: 14,
};
