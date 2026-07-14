'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Role, type UserInfo } from '@cerberus/shared';
import { api } from '@/lib/api';
import { AdminModal } from './AdminModal';

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

/** Cria (`target=null`) ou edita um usuário. `canSetRole` = ator é SUPERADMIN. */
export function UserFormModal({
  target,
  canSetRole,
  onClose,
  onSaved,
}: {
  target: UserInfo | null;
  canSetRole: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = target != null;
  const [username, setUsername] = useState(target?.username ?? '');
  const [name, setName] = useState(target?.name ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<string>(target?.role ?? Role.AGENTE);
  const [agentId, setAgentId] = useState(target?.agentId ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const canSubmit = editing
    ? name.trim().length > 0
    : username.trim().length >= 3 &&
      name.trim().length > 0 &&
      password.length >= 6 &&
      (role !== Role.AGENTE || agentId.trim().length > 0);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      if (editing) {
        const data: Partial<{ name: string; role: string; agentId: string; password: string }> = {};
        if (name !== target.name) data.name = name;
        if (canSetRole && role !== target.role) data.role = role;
        if (role === Role.AGENTE && agentId && agentId !== (target.agentId ?? '')) data.agentId = agentId;
        if (password) data.password = password;
        if (Object.keys(data).length === 0) {
          onClose();
          return;
        }
        await api.updateUser(target.id, data);
      } else {
        await api.createUser({
          username,
          name,
          password,
          role: canSetRole ? role : Role.AGENTE,
          agentId: role === Role.AGENTE ? agentId || undefined : undefined,
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
    <AdminModal title={editing ? 'Editar usuário' : 'Novo usuário'} onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        {!editing && (
          <Field label="Usuário (login)">
            <input
              style={inputStyle}
              value={username}
              autoCapitalize="none"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
        )}
        <Field label="Nome">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={editing ? 'Nova senha (vazio = manter)' : 'Senha'}>
          <input
            style={inputStyle}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {canSetRole && (
          <Field label="Papel">
            <select style={inputStyle} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value={Role.AGENTE}>Agente de Campo</option>
              <option value={Role.ADMIN}>Admin</option>
              <option value={Role.SUPERADMIN}>SuperAdmin</option>
            </select>
          </Field>
        )}
        {role === Role.AGENTE && (
          <Field label="agentId (canal do agente)">
            <input style={inputStyle} value={agentId} onChange={(e) => setAgentId(e.target.value)} />
          </Field>
        )}
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
