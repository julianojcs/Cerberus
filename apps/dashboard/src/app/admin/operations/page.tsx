'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { OperationStatus, Role, type Operation } from '@cerberus/shared';
import { api } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { AdminHeader } from '@/components/AdminHeader';
import { OperationFormModal, STATUS_LABELS, TYPE_LABELS } from '@/components/OperationFormModal';

const fmt = (iso?: string): string =>
  iso
    ? new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
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

/** Cor do badge de situação (contraste sobre --panel). */
function statusStyle(status: string): CSSProperties {
  if (status === OperationStatus.ATIVA)
    return { color: '#0b0f14', background: '#3fb950', borderColor: '#3fb950' };
  if (status === OperationStatus.ENCERRADA)
    return { color: 'var(--muted)', background: 'transparent', borderColor: 'var(--border)' };
  return { color: 'var(--text)', background: 'var(--panel-2)', borderColor: 'var(--border)' };
}

export default function AdminOperationsPage() {
  const router = useRouter();
  const [isSA, setIsSA] = useState(false);
  const [ops, setOps] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // undefined = modal fechado · null = criar · Operation = editar
  const [editing, setEditing] = useState<Operation | null | undefined>(undefined);

  function reload() {
    api
      .operations()
      .then(setOps)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const u = getUser();
    setIsSA(u?.role === Role.SUPERADMIN);
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    if (u && u.role !== Role.ADMIN && u.role !== Role.SUPERADMIN) {
      router.replace('/operations');
      return;
    }
    reload();
  }, [router]);

  async function setStatus(op: Operation, status: string) {
    setError(null);
    try {
      await api.updateOperation(op.id, { status });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(op: Operation) {
    if (
      !window.confirm(
        `Excluir a operação "${op.name}"? Isso apaga em cascata toda a telemetria, ` +
          `zonas, mídias e mensagens dela. Esta ação é irreversível.`,
      )
    )
      return;
    setError(null);
    try {
      await api.deleteOperation(op.id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <AdminHeader active="operations" isSA={isSA} />
      <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ margin: 0 }}>Operações</h2>
          <button className="btn" onClick={() => setEditing(null)}>
            + Nova operação
          </button>
        </div>
        {error && <p style={{ color: 'var(--accent)' }}>{error}</p>}
        {loading ? (
          <p className="muted">Carregando…</p>
        ) : ops.length === 0 ? (
          <p className="muted">Nenhuma operação no seu escopo.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {ops.map((op) => {
              const encerrada = op.status === OperationStatus.ENCERRADA;
              return (
                <div
                  key={op.id}
                  className="card"
                  style={{ padding: 12, opacity: encerrada ? 0.7 : 1 }}
                >
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
                      <strong>{op.name}</strong>{' '}
                      <span className="badge">{TYPE_LABELS[op.type] ?? op.type}</span>{' '}
                      <span className="badge" style={statusStyle(op.status)}>
                        {STATUS_LABELS[op.status] ?? op.status}
                      </span>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        criada em {fmt(op.createdAt)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button style={rowBtn} onClick={() => setEditing(op)}>
                        Editar
                      </button>
                      {encerrada ? (
                        <button
                          style={rowBtn}
                          onClick={() => setStatus(op, OperationStatus.ATIVA)}
                        >
                          Reativar
                        </button>
                      ) : (
                        <button
                          style={rowBtn}
                          onClick={() => setStatus(op, OperationStatus.ENCERRADA)}
                        >
                          Arquivar
                        </button>
                      )}
                      {isSA && (
                        <button
                          style={{
                            ...rowBtn,
                            color: '#fff',
                            borderColor: '#c1121f',
                            background: '#c1121f',
                          }}
                          onClick={() => remove(op)}
                        >
                          Excluir
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing !== undefined && (
        <OperationFormModal
          target={editing}
          onClose={() => setEditing(undefined)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
