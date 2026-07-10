'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Operation } from '@cerberus/shared';
import { api } from '@/lib/api';
import { clearSession, getToken, getUser } from '@/lib/auth';

export default function OperationsPage() {
  const router = useRouter();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    api
      .operations()
      .then(setOperations)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [router]);

  function logout() {
    clearSession();
    router.replace('/login');
  }

  const user = getUser();

  return (
    <div>
      <div className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          CERBERUS
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="muted">{user?.name}</span>
          <button className="btn" style={{ background: 'var(--panel-2)' }} onClick={logout}>
            Sair
          </button>
        </div>
      </div>

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
