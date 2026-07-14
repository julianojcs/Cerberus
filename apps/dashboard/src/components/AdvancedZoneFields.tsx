'use client';

import type { TeamInfo } from '@cerberus/shared';
import type { GeofenceSeverityName, GeofenceTriggerName } from '@/lib/api';

/**
 * Controles das REGRAS AVANÇADAS de uma zona (Fase 5b), reusados nos formulários de
 * criar e editar: equipe, janela horária (agendamento), gatilho e severidade.
 * A janela é exibida/editada em hora LOCAL (BRT) e persistida em minutos-do-dia UTC.
 */

/** HH:MM local (BRT, UTC−3) → minutos-do-dia UTC (0–1439). '' → null. */
export function localTimeToUtcMin(hhmm: string): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return null;
  return (h * 60 + m + 180) % 1440; // BRT = UTC−3 ⇒ UTC = local + 3h
}

/** Minutos-do-dia UTC → HH:MM local (BRT). null/undefined → ''. */
export function utcMinToLocalTime(min: number | null | undefined): string {
  if (min == null) return '';
  const local = (min - 180 + 1440) % 1440;
  const h = Math.floor(local / 60);
  const m = local % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Cor (hex) por severidade — usada no badge/dot dos alertas. */
export const SEVERITY_COLOR: Record<string, string> = {
  low: '#8b9aa8',
  medium: '#e3b341',
  high: '#f0883e',
  critical: '#c1121f',
};
export const SEVERITY_LABEL: Record<string, string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
  critical: 'Crítica',
};

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  colorScheme: 'dark', // setas do time picker / select claras no fundo escuro
  fontSize: 13,
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--muted)', display: 'block' };

export interface AdvancedZoneValue {
  teamId: string; // '' = todas as equipes
  windowStart: string; // 'HH:MM' local; '' = sem janela
  windowEnd: string;
  trigger: GeofenceTriggerName;
  severity: GeofenceSeverityName;
}

export function AdvancedZoneFields({
  teams,
  value,
  onChange,
}: {
  teams: TeamInfo[];
  value: AdvancedZoneValue;
  onChange: (next: AdvancedZoneValue) => void;
}) {
  const set = (patch: Partial<AdvancedZoneValue>) => onChange({ ...value, ...patch });
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      <label>
        <span style={labelStyle}>Equipe (opcional)</span>
        <select
          value={value.teamId}
          onChange={(e) => set({ teamId: e.target.value })}
          style={fieldStyle}
        >
          <option value="">Todas as equipes</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      <div>
        <span style={labelStyle}>Janela horária (opcional, BRT) — fora dela a zona não alerta</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="time"
            value={value.windowStart}
            onChange={(e) => set({ windowStart: e.target.value })}
            style={fieldStyle}
          />
          <span style={{ color: 'var(--muted)' }}>até</span>
          <input
            type="time"
            value={value.windowEnd}
            onChange={(e) => set({ windowEnd: e.target.value })}
            style={fieldStyle}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <label style={{ flex: 1 }}>
          <span style={labelStyle}>Alertar em</span>
          <select
            value={value.trigger}
            onChange={(e) => set({ trigger: e.target.value as GeofenceTriggerName })}
            style={fieldStyle}
          >
            <option value="both">Entrada e saída</option>
            <option value="enter">Só entrada</option>
            <option value="exit">Só saída</option>
          </select>
        </label>
        <label style={{ flex: 1 }}>
          <span style={labelStyle}>Severidade</span>
          <select
            value={value.severity}
            onChange={(e) => set({ severity: e.target.value as GeofenceSeverityName })}
            style={fieldStyle}
          >
            <option value="low">Baixa</option>
            <option value="medium">Média</option>
            <option value="high">Alta</option>
            <option value="critical">Crítica</option>
          </select>
        </label>
      </div>
    </div>
  );
}
