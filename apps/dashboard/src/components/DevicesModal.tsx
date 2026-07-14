'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { SessionInfo, UserInfo } from '@cerberus/shared';
import { api } from '@/lib/api';
import { AdminModal } from './AdminModal';

const fmt = (iso?: string): string =>
  iso
    ? new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso))
    : '—';

const actionBtn: CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12,
};

/** Sessões (dispositivos) de um usuário — derrubar (kick) ou bloquear o dispositivo. */
export function DevicesModal({
  user,
  onClose,
  onChanged,
}: {
  user: UserInfo;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .userDevices(user.id)
      .then(setSessions)
      .catch((e) => setMsg((e as Error).message));
  }, [user.id]);
  useEffect(reload, [reload]);

  async function act(fn: () => Promise<void>) {
    setMsg(null);
    try {
      await fn();
      reload();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <AdminModal title={`Dispositivos — ${user.name}`} onClose={onClose} width={640}>
      {msg && <div style={{ fontSize: 12, color: '#c1121f', marginBottom: 8 }}>{msg}</div>}
      {sessions == null ? (
        <p className="muted">Carregando…</p>
      ) : sessions.length === 0 ? (
        <p className="muted">Nenhuma sessão registrada.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {sessions.map((s) => {
            const revoked = !!s.revokedAt;
            return (
              <div key={s.id} className="card" style={{ padding: 10, opacity: revoked ? 0.55 : 1 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13 }}>
                      {s.deviceLabel ?? 'Dispositivo'}{' '}
                      <span className="muted">· {s.platform ?? '—'}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      device: {s.deviceId ?? '—'} · visto: {fmt(s.lastSeenAt)}
                      {revoked ? ` · revogada (${s.revokedReason ?? '—'})` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {!revoked && (
                      <button style={actionBtn} onClick={() => act(() => api.kickSession(s.id))}>
                        Derrubar
                      </button>
                    )}
                    {s.deviceId && (
                      <button
                        style={{ ...actionBtn, color: '#fff', borderColor: '#c1121f', background: '#c1121f' }}
                        onClick={() => act(() => api.blockDevice(s.deviceId as string))}
                      >
                        Bloquear
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AdminModal>
  );
}
