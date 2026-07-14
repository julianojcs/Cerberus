'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Role, type AuditLogEntry } from '@cerberus/shared';
import { api } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { AdminHeader } from '@/components/AdminHeader';

const fmt = (iso: string): string =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));

const actionLabel: Record<string, string> = {
  'session.kick': 'Derrubou sessão',
  'user.block': 'Bloqueou conta',
  'user.unblock': 'Desbloqueou conta',
  'device.block': 'Bloqueou dispositivo',
  'device.unblock': 'Desbloqueou dispositivo',
};

export default function AdminAuditPage() {
  const router = useRouter();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    api
      .audit()
      .then(setLogs)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [router]);

  return (
    <div>
      <AdminHeader active="audit" isSA />
      <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
        <h2>Auditoria</h2>
        {error && <p style={{ color: 'var(--accent)' }}>{error}</p>}
        {loading ? (
          <p className="muted">Carregando…</p>
        ) : logs.length === 0 ? (
          <p className="muted">Nenhum registro de auditoria.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {logs.map((l) => (
              <div key={l.id} className="card" style={{ padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <span>
                    <strong>{actionLabel[l.action] ?? l.action}</strong>
                    {l.targetUserId && <span className="muted"> · usuário {l.targetUserId}</span>}
                    {l.targetDeviceId && <span className="muted"> · device {l.targetDeviceId}</span>}
                    {l.targetSid && <span className="muted"> · sessão {l.targetSid}</span>}
                    {l.reason && <span className="muted"> · {l.reason}</span>}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {fmt(l.createdAt)} · por {l.actorId}
                    {l.ip ? ` · ${l.ip}` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
