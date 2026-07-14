'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { Role, type Operation, type TeamInfo } from '@cerberus/shared';
import { api } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { resolveColor } from '@/lib/tailwind-colors';
import { AdminHeader } from '@/components/AdminHeader';
import { TeamFormModal, type AgentOption } from '@/components/TeamFormModal';

const rowBtn: CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
};
const selectStyle: CSSProperties = {
  background: 'var(--bg, #0b0f14)',
  color: 'var(--text, #e6edf3)',
  colorScheme: 'dark',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: 8,
  fontSize: 14,
  minWidth: 260,
};

export default function AdminTeamsPage() {
  const router = useRouter();
  const [isSA, setIsSA] = useState(false);
  const [ops, setOps] = useState<Operation[]>([]);
  const [opId, setOpId] = useState<string>('');
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // undefined = modal fechado · null = criar · TeamInfo = editar
  const [editing, setEditing] = useState<TeamInfo | null | undefined>(undefined);

  const agentName = useCallback(
    (agentId: string) => agents.find((a) => a.agentId === agentId)?.name ?? agentId,
    [agents],
  );

  const reloadTeams = useCallback((op: string) => {
    if (!op) return;
    api
      .operationTeams(op)
      .then(setTeams)
      .catch((e) => setError((e as Error).message));
  }, []);

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
    api
      .operations()
      .then((list) => {
        setOps(list);
        if (list.length > 0) setOpId(list[0].id);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [router]);

  // Carrega equipes + agentes da operação selecionada.
  useEffect(() => {
    if (!opId) {
      setTeams([]);
      setAgents([]);
      return;
    }
    setError(null);
    reloadTeams(opId);
    api
      .operationMembers(opId)
      .then((members) =>
        setAgents(
          members
            .filter((m) => m.role === Role.AGENTE && m.agentId)
            .map((m) => ({ agentId: m.agentId as string, name: m.name })),
        ),
      )
      .catch((e) => setError((e as Error).message));
  }, [opId, reloadTeams]);

  async function remove(t: TeamInfo) {
    if (!window.confirm(`Excluir a equipe "${t.name}"?`)) return;
    setError(null);
    try {
      await api.deleteTeam(opId, t.id);
      reloadTeams(opId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <AdminHeader active="teams" isSA={isSA} />
      <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ margin: 0 }}>Equipes</h2>
            {ops.length > 0 && (
              <select
                style={selectStyle}
                value={opId}
                onChange={(e) => setOpId(e.target.value)}
                title="Operação"
              >
                {ops.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button className="btn" onClick={() => setEditing(null)} disabled={!opId}>
            + Nova equipe
          </button>
        </div>
        {error && <p style={{ color: 'var(--accent)' }}>{error}</p>}

        {loading ? (
          <p className="muted">Carregando…</p>
        ) : ops.length === 0 ? (
          <p className="muted">Nenhuma operação no seu escopo.</p>
        ) : teams.length === 0 ? (
          <p className="muted">Nenhuma equipe nesta operação.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {teams.map((t) => (
              <div key={t.id} className="card" style={{ padding: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          background: resolveColor(t.color),
                          flexShrink: 0,
                        }}
                      />
                      <strong>{t.name}</strong>
                      <span className="badge">{t.agentIds.length} membro{t.agentIds.length === 1 ? '' : 's'}</span>
                    </span>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      {t.agentIds.length === 0
                        ? 'Sem membros'
                        : t.agentIds
                            .map((a) => (a === t.leadId ? `★ ${agentName(a)}` : agentName(a)))
                            .join(' · ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button style={rowBtn} onClick={() => setEditing(t)}>
                      Editar
                    </button>
                    <button
                      style={{ ...rowBtn, color: '#fff', borderColor: '#c1121f', background: '#c1121f' }}
                      onClick={() => remove(t)}
                    >
                      Excluir
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing !== undefined && opId && (
        <TeamFormModal
          target={editing}
          operationId={opId}
          agents={agents}
          onClose={() => setEditing(undefined)}
          onSaved={() => reloadTeams(opId)}
        />
      )}
    </div>
  );
}
