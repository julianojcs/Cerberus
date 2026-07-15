'use client';

import { useEffect, useState } from 'react';
import { Lock, TriangleAlert, CloudDownload } from 'lucide-react';
import {
  unlock,
  migrateLegacy,
  createProtectedKeys,
  setCloudBackup,
  cloudBackupExists,
  restoreFromCloud,
  type KeyState,
} from '@/lib/e2ee';

const MIN_LEN = 8;

/**
 * Modal (bloqueante) da chave E2EE em repouso (Fase 5e-1/5e-3). Modos:
 * - `none`   → define uma senha e CRIA a chave (primeiro acesso). Se houver **backup
 *              na nuvem** (5e-3), oferece RESTAURAR em vez de criar uma chave nova.
 * - `legacy` → define uma senha e MIGRA a chave em texto claro (cifra em repouso).
 * - `locked` → DESBLOQUEIA a chave existente (returning user / recarga / pós-restauro).
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
  // Modo efetivo: começa no prop; após restaurar da nuvem vira 'locked' (desbloquear).
  const [effectiveMode, setEffectiveMode] = useState<KeyState>(mode);
  const [cloudAvail, setCloudAvail] = useState(false);
  const [cloudOptIn, setCloudOptIn] = useState(false);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setting = effectiveMode === 'none' || effectiveMode === 'legacy'; // definir senha vs. desbloquear

  // Sem chave local: existe cópia na nuvem? Então oferecemos restaurar.
  useEffect(() => {
    if (mode !== 'none') return;
    let active = true;
    cloudBackupExists().then((yes) => active && setCloudAvail(yes));
    return () => {
      active = false;
    };
  }, [mode]);

  const title = setting ? 'Proteja sua chave E2EE' : 'Desbloqueie sua chave E2EE';
  const help =
    effectiveMode === 'none'
      ? 'Defina uma senha para cifrar sua chave de criptografia neste navegador. Ela protege as mensagens táticas que você decifra.'
      : effectiveMode === 'legacy'
        ? 'Sua chave está sem proteção neste navegador. Defina uma senha para cifrá-la em repouso.'
        : 'Digite sua senha para decifrar as mensagens nesta sessão.';

  async function doRestore() {
    setBusy(true);
    setError(null);
    const ok = await restoreFromCloud(userId);
    setBusy(false);
    if (!ok) return setError('Não foi possível restaurar a chave da nuvem.');
    setCloudAvail(false);
    setEffectiveMode('locked'); // agora é só desbloquear com a senha
  }

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
      if (effectiveMode === 'locked') {
        if (!(await unlock(userId, pass))) {
          setError('Senha incorreta.');
          setBusy(false);
          return;
        }
      } else if (effectiveMode === 'legacy') {
        await migrateLegacy(userId, pass);
        if (cloudOptIn) await setCloudBackup(userId, true);
      } else {
        await createProtectedKeys(userId, pass);
        if (cloudOptIn) await setCloudBackup(userId, true);
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
        <h2
          style={{
            margin: 0,
            fontSize: 18,
            color: 'var(--text)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Lock size={18} aria-hidden /> {title}
        </h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {help}
        </p>

        {/* Chave salva na nuvem e sem chave local → restaurar (evita criar chave nova
            e perder o histórico — o caso do dashboard aberto numa origem nova). */}
        {effectiveMode === 'none' && cloudAvail && (
          <div
            style={{
              display: 'grid',
              gap: 8,
              padding: 12,
              borderRadius: 8,
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: 13, color: 'var(--text)' }}>
              Encontramos uma <strong>cópia da sua chave na nuvem</strong>. Restaure para ler seu
              histórico neste dispositivo.
            </div>
            <button
              type="button"
              onClick={doRestore}
              disabled={busy}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
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
              <CloudDownload size={16} aria-hidden /> Restaurar da nuvem
            </button>
            <div className="muted" style={{ fontSize: 11 }}>
              Ou defina uma senha abaixo para criar uma chave nova (perde o acesso ao histórico).
            </div>
          </div>
        )}

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
          <>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={cloudOptIn}
                onChange={(e) => setCloudOptIn(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              Manter uma cópia cifrada na nuvem (recupera em outros dispositivos)
            </label>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <TriangleAlert size={14} aria-hidden style={{ flexShrink: 0 }} /> Se esquecer esta
              senha, não será possível recuperar a chave nem ler o histórico.
            </p>
          </>
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
