'use client';

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { TeamInfo } from '@cerberus/shared';
import { api } from '@/lib/api';
import { AdminModal } from './AdminModal';
import { ColorPalettePicker } from './ColorPalettePicker';

const inputStyle: CSSProperties = {
  width: '100%',
  background: 'var(--bg, #0b0f14)',
  color: 'var(--text, #e6edf3)',
  colorScheme: 'dark',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: 8,
  fontSize: 13,
  boxSizing: 'border-box',
};
const ghostBtn: CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
};

/** Um agente elegível da operação (para o multiselect de membros). */
export interface AgentOption {
  agentId: string;
  name: string;
}

/**
 * Cria (`target=null`) ou edita uma equipe de uma operação. Membros são escolhidos
 * entre os agentes da operação (`agents`); o líder, entre os membros selecionados.
 */
export function TeamFormModal({
  target,
  operationId,
  agents,
  onClose,
  onSaved,
}: {
  target: TeamInfo | null;
  operationId: string;
  agents: AgentOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = target != null;
  const [name, setName] = useState(target?.name ?? '');
  const [color, setColor] = useState(target?.color ?? 'blue');
  const [members, setMembers] = useState<Set<string>>(new Set(target?.agentIds ?? []));
  const [leadId, setLeadId] = useState(target?.leadId ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0;
  const memberList = useMemo(() => [...members], [members]);

  function toggleMember(agentId: string) {
    setMembers((prev) => {
      const n = new Set(prev);
      if (n.has(agentId)) {
        n.delete(agentId);
        if (leadId === agentId) setLeadId(''); // líder removido dos membros
      } else n.add(agentId);
      return n;
    });
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const agentIds = memberList;
      if (editing) {
        const data: Partial<{ name: string; color: string; agentIds: string[]; leadId: string }> = {};
        if (name !== target.name) data.name = name;
        if (color !== target.color) data.color = color;
        const prevMembers = [...(target.agentIds ?? [])].sort().join(',');
        if (agentIds.slice().sort().join(',') !== prevMembers) data.agentIds = agentIds;
        if (leadId !== (target.leadId ?? '')) data.leadId = leadId; // '' limpa
        if (Object.keys(data).length === 0) {
          onClose();
          return;
        }
        await api.updateTeam(operationId, target.id, data);
      } else {
        await api.createTeam(operationId, {
          name: name.trim(),
          color,
          agentIds,
          leadId: leadId || undefined,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminModal title={editing ? 'Editar equipe' : 'Nova equipe'} onClose={onClose} width={520}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Nome">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Cor
          </span>
          <ColorPalettePicker value={color} onChange={setColor} />
        </label>

        <Field label={`Membros (${memberList.length})`}>
          {agents.length === 0 ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Nenhum agente na operação. Atribua agentes à operação primeiro.
            </p>
          ) : (
            <div
              className="thinscroll"
              style={{
                maxHeight: 180,
                overflowY: 'auto',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: 8,
                display: 'grid',
                gap: 4,
              }}
            >
              {agents.map((a) => (
                <label
                  key={a.agentId}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={members.has(a.agentId)}
                    onChange={() => toggleMember(a.agentId)}
                    style={{ accentColor: 'var(--accent)', flexShrink: 0 }}
                  />
                  <span>
                    {a.name} <span className="muted">· {a.agentId}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <Field label="Líder (opcional)">
          <select
            style={inputStyle}
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
            disabled={memberList.length === 0}
          >
            <option value="">— sem líder —</option>
            {memberList.map((agentId) => {
              const a = agents.find((x) => x.agentId === agentId);
              return (
                <option key={agentId} value={agentId}>
                  {a ? `${a.name} · ${agentId}` : agentId}
                </option>
              );
            })}
          </select>
        </Field>

        {msg && <div style={{ fontSize: 12, color: '#c1121f' }}>{msg}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={save}
            disabled={saving || !canSubmit}
            style={{
              flex: 1,
              padding: 10,
              borderRadius: 8,
              border: 'none',
              background: '#3fb950',
              color: '#0b0f14',
              fontWeight: 700,
              cursor: saving || !canSubmit ? 'not-allowed' : 'pointer',
              opacity: saving || !canSubmit ? 0.5 : 1,
            }}
          >
            {saving ? 'Salvando…' : editing ? 'Salvar' : 'Criar'}
          </button>
          <button type="button" className="badge" style={ghostBtn} onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </AdminModal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </label>
  );
}
