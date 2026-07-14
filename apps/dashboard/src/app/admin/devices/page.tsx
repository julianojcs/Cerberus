'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { Role, type DeviceBlockInfo } from '@cerberus/shared';
import { api } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { AdminHeader } from '@/components/AdminHeader';

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

const rowBtn: CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
};

/** Denylist de dispositivos (SUPERADMIN) — bloqueio permanente por `deviceId`. */
export default function AdminDevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceBlockInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    api
      .blockedDevices()
      .then(setDevices)
      .catch((e) => setError((e as Error).message));
  }

  useEffect(() => {
    const u = getUser();
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    if (u?.role !== Role.SUPERADMIN) {
      router.replace('/operations');
      return;
    }
    reload();
  }, [router]);

  async function unblock(deviceId: string) {
    setError(null);
    try {
      await api.unblockDevice(deviceId);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <AdminHeader active="devices" isSA />
      <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
        <h2>Dispositivos bloqueados</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
          Denylist permanente por dispositivo. Um dispositivo bloqueado não consegue autenticar em
          nenhuma conta até ser desbloqueado.
        </p>
        {error && <p style={{ color: 'var(--accent)' }}>{error}</p>}
        {devices == null ? (
          <p className="muted">Carregando…</p>
        ) : devices.length === 0 ? (
          <p className="muted">Nenhum dispositivo bloqueado.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {devices.map((d) => (
              <div key={d.deviceId} className="card" style={{ padding: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <strong style={{ fontFamily: 'monospace', fontSize: 13 }}>{d.deviceId}</strong>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      bloqueado em {fmt(d.createdAt)} · por {d.blockedBy}
                      {d.reason ? ` · ${d.reason}` : ''}
                    </div>
                  </div>
                  <button style={rowBtn} onClick={() => unblock(d.deviceId)}>
                    Desbloquear
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
