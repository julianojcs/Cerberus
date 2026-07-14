'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { Role, type UserInfo } from '@cerberus/shared';
import { api } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { AdminHeader } from '@/components/AdminHeader';
import { UserFormModal } from '@/components/UserFormModal';
import { DevicesModal } from '@/components/DevicesModal';

const roleLabel: Record<string, string> = {
  superadmin: 'SuperAdmin',
  admin: 'Admin',
  agente: 'Agente',
};

const rowBtn: CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
};

export default function AdminUsersPage() {
  const router = useRouter();
  const [me, setMe] = useState<ReturnType<typeof getUser>>(null);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // undefined = modal fechado · null = criar · UserInfo = editar
  const [editing, setEditing] = useState<UserInfo | null | undefined>(undefined);
  const [devicesFor, setDevicesFor] = useState<UserInfo | null>(null);

  const isSA = me?.role === Role.SUPERADMIN;

  function reload() {
    api
      .users()
      .then(setUsers)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    const u = getUser();
    setMe(u);
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

  async function toggleBlock(u: UserInfo) {
    setError(null);
    try {
      if (u.blocked) await api.unblockUser(u.id);
      else await api.blockUser(u.id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(u: UserInfo) {
    if (!window.confirm(`Excluir o usuário "${u.username}"? Esta ação é irreversível.`)) return;
    setError(null);
    try {
      await api.deleteUser(u.id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <AdminHeader active="users" isSA={!!isSA} />
      <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ margin: 0 }}>Usuários</h2>
          <button className="btn" onClick={() => setEditing(null)}>
            + Novo usuário
          </button>
        </div>
        {error && <p style={{ color: 'var(--accent)' }}>{error}</p>}
        {loading ? (
          <p className="muted">Carregando…</p>
        ) : users.length === 0 ? (
          <p className="muted">Nenhum usuário.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {users.map((u) => {
              const self = u.id === me?.id;
              return (
                <div key={u.id} className="card" style={{ padding: 12, opacity: u.blocked ? 0.6 : 1 }}>
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
                      <strong>{u.name}</strong> <span className="muted">@{u.username}</span>{' '}
                      <span className="badge">{roleLabel[u.role] ?? u.role}</span>
                      {u.agentId && (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          {u.agentId}
                        </span>
                      )}
                      {u.blocked && (
                        <span
                          className="badge"
                          style={{ marginLeft: 6, color: '#fff', background: '#c1121f', borderColor: '#c1121f' }}
                        >
                          bloqueado
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button style={rowBtn} onClick={() => setEditing(u)}>
                        Editar
                      </button>
                      {isSA && (
                        <button style={rowBtn} onClick={() => setDevicesFor(u)}>
                          Dispositivos
                        </button>
                      )}
                      {isSA && !self && (
                        <button style={rowBtn} onClick={() => toggleBlock(u)}>
                          {u.blocked ? 'Desbloquear' : 'Bloquear'}
                        </button>
                      )}
                      {!self && (
                        <button
                          style={{ ...rowBtn, color: '#fff', borderColor: '#c1121f', background: '#c1121f' }}
                          onClick={() => remove(u)}
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
        <UserFormModal
          target={editing}
          canSetRole={!!isSA}
          onClose={() => setEditing(undefined)}
          onSaved={reload}
        />
      )}
      {devicesFor && (
        <DevicesModal user={devicesFor} onClose={() => setDevicesFor(null)} onChanged={reload} />
      )}
    </div>
  );
}
