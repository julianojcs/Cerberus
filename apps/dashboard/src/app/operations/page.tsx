'use client';

import { useEffect, useState } from 'react';
import { Users, Settings as SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Operation } from '@cerberus/shared';
import { api, type Settings } from '@/lib/api';
import { clearSession, getToken, getUser } from '@/lib/auth';
import { lockAll } from '@/lib/e2ee';
import { SettingsModal } from '@/components/SettingsModal';

export default function OperationsPage() {
  const router = useRouter();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<Settings>({
    minRoutePoints: 5,
    connectRoutes: false,
    maxGapMinutes: 5,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Usuário lido do localStorage só no cliente (evita mismatch de hidratação SSR).
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null);

  useEffect(() => {
    setUser(getUser());
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    api
      .operations()
      .then(setOperations)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    api
      .settings()
      .then(setSettings)
      .catch(() => {
        /* mantém os padrões */
      });
  }, [router]);

  function logout() {
    lockAll(); // trava a chave E2EE em memória (Fase 5e-1)
    clearSession();
    router.replace('/login');
  }

  return (
    <div>
      <div className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          CERBERUS
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="muted">{user?.name}</span>
          {(user?.role === 'admin' || user?.role === 'superadmin') && (
            <Link
              href="/admin/users"
              className="btn"
              style={{
                background: 'var(--panel-2)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
              title="Painel administrativo"
            >
              <Users size={15} aria-hidden /> Admin
            </Link>
          )}
          <button
            type="button"
            className="btn"
            style={{
              background: 'var(--panel-2)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
            onClick={() => setSettingsOpen(true)}
            title="Configurações do sistema"
          >
            <SettingsIcon size={15} aria-hidden /> Configurações
          </button>
          <button className="btn" style={{ background: 'var(--panel-2)' }} onClick={logout}>
            Sair
          </button>
        </div>
      </div>

      {settingsOpen && (
        <SettingsModal
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
        />
      )}

      <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
        <h2>Operações</h2>
        {loading && <p className="muted">Carregando…</p>}
        {error && <p style={{ color: 'var(--accent)' }}>{error}</p>}
        {!loading && operations.length === 0 && (
          <p className="muted">Nenhuma operação no seu escopo. Rode o seed da API.</p>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          {operations.map((op) => (
            <Link key={op.id} href={`/operations/${op.id}/live`} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{op.name}</strong>
                <span className="badge">{op.status}</span>
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
                Tipo: {op.type} · Monitoramento em tempo real →
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
