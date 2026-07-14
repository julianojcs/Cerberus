'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { OperationStatus, OperationType, type Operation } from '@cerberus/shared';
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

/** Rótulos pt-BR dos tipos/estados (os valores no banco/rede ficam em minúsculo). */
export const TYPE_LABELS: Record<string, string> = {
  [OperationType.MANDADO]: 'Mandado de busca',
  [OperationType.ESCOLTA]: 'Escolta',
  [OperationType.PROTECAO]: 'Proteção',
};
export const STATUS_LABELS: Record<string, string> = {
  [OperationStatus.PLANEJADA]: 'Planejada',
  [OperationStatus.ATIVA]: 'Ativa',
  [OperationStatus.ENCERRADA]: 'Encerrada',
};

/** Cria (`target=null`) ou edita uma operação. */
export function OperationFormModal({
  target,
  onClose,
  onSaved,
}: {
  target: Operation | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = target != null;
  const [name, setName] = useState(target?.name ?? '');
  const [type, setType] = useState<string>(target?.type ?? OperationType.MANDADO);
  const [status, setStatus] = useState<string>(target?.status ?? OperationStatus.PLANEJADA);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0;

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      if (editing) {
        const data: Partial<{ name: string; type: string; status: string }> = {};
        if (name !== target.name) data.name = name;
        if (type !== target.type) data.type = type;
        if (status !== target.status) data.status = status;
        if (Object.keys(data).length === 0) {
          onClose();
          return;
        }
        await api.updateOperation(target.id, data);
      } else {
        await api.createOperation({ name: name.trim(), type, status });
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
    <AdminModal title={editing ? 'Editar operação' : 'Nova operação'} onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Nome">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Tipo">
          <select style={inputStyle} value={type} onChange={(e) => setType(e.target.value)}>
            {Object.values(OperationType).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t] ?? t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Situação">
          <select style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.values(OperationStatus).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s] ?? s}
              </option>
            ))}
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
