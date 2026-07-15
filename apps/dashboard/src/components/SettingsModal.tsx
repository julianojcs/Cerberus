'use client';

import { useRef, useState } from 'react';
import { api, type Settings } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Settings as SettingsIcon, Key, X, Download, Upload, Cloud, CloudDownload } from 'lucide-react';
import {
  keyState,
  rotateKey,
  exportBlob,
  importBlob,
  isCloudBackupEnabled,
  setCloudBackup,
  restoreFromCloud,
} from '@/lib/e2ee';
import { Toggle } from './Toggle';

/**
 * Modal de Configurações do sistema. Ajustes básicos de exibição das rotas.
 * Leitura para qualquer usuário; a edição (salvar) é restrita a admin — o backend
 * também impõe isso (403), aqui só desabilitamos os controles e avisamos.
 */
export function SettingsModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}) {
  const me = getUser();
  const isAdmin = me?.role === 'admin';
  // Fase 5e-2 — o operador rotaciona a PRÓPRIA chave E2EE (gera um par novo; a secreta
  // antiga é preservada para decifrar o histórico; a pública nova versiona a anterior).
  const canRotate = me ? keyState(me.id) === 'unlocked' || keyState(me.id) === 'locked' : false;
  const [rotatePass, setRotatePass] = useState('');
  const [rotating, setRotating] = useState(false);
  const [rotateMsg, setRotateMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Fase 5e-3 — portabilidade da chave: export/import (arquivo) + cópia na nuvem (opt-in).
  const [cloudOn, setCloudOn] = useState(me ? isCloudBackupEnabled(me.id) : false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [portMsg, setPortMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [minRoutePoints, setMinRoutePoints] = useState(String(initial.minRoutePoints));
  const [connectRoutes, setConnectRoutes] = useState(initial.connectRoutes);
  const [maxGapMinutes, setMaxGapMinutes] = useState(String(initial.maxGapMinutes));
  const [sidebarMessageCount, setSidebarMessageCount] = useState(
    String(initial.sidebarMessageCount ?? 5),
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const min = Number(minRoutePoints);
  const validMin = Number.isInteger(min) && min >= 1 && min <= 1000;
  const gap = Number(maxGapMinutes);
  const validGap = Number.isInteger(gap) && gap >= 1 && gap <= 1440;
  const cnt = Number(sidebarMessageCount);
  const validCnt = Number.isInteger(cnt) && cnt >= 1 && cnt <= 50;
  const valid = validMin && validGap && validCnt;

  async function save() {
    if (!valid) return;
    setSaving(true);
    setMsg(null);
    try {
      const saved = await api.patchSettings({
        minRoutePoints: min,
        connectRoutes,
        maxGapMinutes: gap,
        sidebarMessageCount: cnt,
      });
      onSaved(saved);
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    if (!me || !rotatePass || rotating) return;
    setRotating(true);
    setRotateMsg(null);
    try {
      const pub = await rotateKey(me.id, rotatePass);
      if (!pub) {
        setRotateMsg({ ok: false, text: 'Senha da chave incorreta.' });
        return;
      }
      setRotatePass('');
      setRotateMsg({ ok: true, text: 'Chave rotacionada. A anterior segue decifrando o histórico.' });
    } catch (e) {
      setRotateMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha ao rotacionar.' });
    } finally {
      setRotating(false);
    }
  }

  // Exporta o blob CIFRADO (a secreta em claro nunca sai) para um arquivo .txt.
  function doExport() {
    if (!me) return;
    setPortMsg(null);
    const blob = exportBlob(me.id);
    if (!blob) return setPortMsg({ ok: false, text: 'Nenhuma chave neste dispositivo para exportar.' });
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cerberus-e2ee-${me.username}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setPortMsg({ ok: true, text: 'Chave exportada (cifrada). Guarde o arquivo e a senha em local seguro.' });
  }

  async function doImport(file: File) {
    if (!me) return;
    setPortMsg(null);
    const text = await file.text();
    if (!importBlob(me.id, text)) {
      return setPortMsg({ ok: false, text: 'Arquivo inválido — não é uma chave do Cerberus.' });
    }
    setPortMsg({
      ok: true,
      text: 'Chave importada. Recarregue a página e desbloqueie com a senha dela.',
    });
  }

  async function doRestoreCloud() {
    if (!me || cloudBusy) return;
    setCloudBusy(true);
    setPortMsg(null);
    try {
      const ok = await restoreFromCloud(me.id);
      setPortMsg(
        ok
          ? { ok: true, text: 'Chave restaurada da nuvem. Recarregue a página e desbloqueie com a senha dela.' }
          : { ok: false, text: 'Nenhuma cópia na nuvem encontrada para esta conta.' },
      );
      if (ok) setCloudOn(true);
    } finally {
      setCloudBusy(false);
    }
  }

  async function toggleCloud(on: boolean) {
    if (!me || cloudBusy) return;
    setCloudBusy(true);
    setPortMsg(null);
    try {
      const ok = await setCloudBackup(me.id, on);
      if (on && !ok) {
        setPortMsg({ ok: false, text: 'Não foi possível subir a cópia (há chave neste dispositivo?).' });
        return;
      }
      setCloudOn(on);
      setPortMsg({
        ok: true,
        text: on
          ? 'Cópia na nuvem ligada — o blob cifrado sobe a cada troca de chave.'
          : 'Cópia na nuvem desligada e removida do servidor.',
      });
    } finally {
      setCloudBusy(false);
    }
  }

  // `colorScheme: 'dark'` faz o navegador desenhar as setinhas do spinner claras
  // sobre fundo escuro (em vez do quadradinho branco padrão).
  const numStyle = (ok: boolean): React.CSSProperties => ({
    width: 90,
    background: 'var(--bg, #0b0f14)',
    color: 'var(--text, #e6edf3)',
    colorScheme: 'dark',
    border: `1px solid ${ok ? 'var(--border)' : '#c1121f'}`,
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    boxSizing: 'border-box',
  });

  // Botões "badge" (Fechar/Cancelar): a classe herda cor apagada; forçamos texto
  // legível para contraste.
  const ghostBtn: React.CSSProperties = {
    cursor: 'pointer',
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text, #e6edf3)',
  };
  const portBtn: React.CSSProperties = {
    ...ghostBtn,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 13,
  };

  return (
    <div
      onClick={onClose}
      className="animate__animated animate__fadeIn animate__faster"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card animate__animated animate__zoomIn animate__faster"
        style={{ width: 420, maxWidth: '92vw', padding: 20 }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 4,
          }}
        >
          <strong style={{ fontSize: 16, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <SettingsIcon size={17} aria-hidden /> Configurações
          </strong>
          <button
            type="button"
            onClick={onClose}
            className="badge"
            style={{ ...ghostBtn, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            Fechar <X size={14} aria-hidden />
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '0 0 16px' }}>
          Ajustes de exibição das rotas dos agentes.
        </p>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 14 }}>Pontos mínimos por rota</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Rotas com menos pontos que isso são ocultadas (trechos insignificantes).
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={1000}
            value={minRoutePoints}
            onChange={(e) => setMinRoutePoints(e.target.value)}
            disabled={!isAdmin}
            style={numStyle(validMin)}
          />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 14 }}>Intervalo que quebra a rota (min)</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Sem transmissão por mais que isso, o trajeto é quebrado (evita o “pulo”).
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={1440}
            value={maxGapMinutes}
            onChange={(e) => setMaxGapMinutes(e.target.value)}
            disabled={!isAdmin}
            style={numStyle(validGap)}
          />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 14 }}>Mensagens no card lateral</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Quantas mensagens o card “Mensagens” exibe (a área rola após 5). 1–50.
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={50}
            value={sidebarMessageCount}
            onChange={(e) => setSidebarMessageCount(e.target.value)}
            disabled={!isAdmin}
            style={numStyle(validCnt)}
          />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 8,
          }}
        >
          <div>
            <div style={{ fontSize: 14 }}>Ligar rotas</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Desenha uma linha ligando o fim de uma rota ao início da próxima.
            </div>
          </div>
          <Toggle
            checked={connectRoutes}
            onChange={setConnectRoutes}
            title="Ligar o fim de uma rota ao início da próxima"
          />
        </div>

        <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 12px', paddingTop: 14 }}>
          <div style={{ fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Key size={15} aria-hidden /> Chave E2EE
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Rotaciona sua chave (gera um par novo). A anterior é preservada localmente para decifrar
            mensagens antigas; a nova passa a selar os envios. Informe a senha da chave para confirmar.
          </div>
          {canRotate ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                autoComplete="off"
                placeholder="Senha da chave"
                value={rotatePass}
                onChange={(e) => setRotatePass(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && rotate()}
                style={{
                  flex: 1,
                  minWidth: 160,
                  background: 'var(--bg, #0b0f14)',
                  color: 'var(--text, #e6edf3)',
                  colorScheme: 'dark',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: 8,
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                onClick={rotate}
                disabled={rotating || !rotatePass}
                style={{
                  ...ghostBtn,
                  borderRadius: 6,
                  padding: '8px 12px',
                  fontSize: 13,
                  cursor: rotating || !rotatePass ? 'not-allowed' : 'pointer',
                  opacity: rotating || !rotatePass ? 0.5 : 1,
                }}
              >
                {rotating ? 'Rotacionando…' : 'Rotacionar chave'}
              </button>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              Desbloqueie sua chave E2EE para poder rotacioná-la.
            </div>
          )}
          {rotateMsg && (
            <div style={{ fontSize: 12, marginTop: 8, color: rotateMsg.ok ? '#3fb950' : '#c1121f' }}>
              {rotateMsg.text}
            </div>
          )}

          {/* Fase 5e-3 — portabilidade: mover a chave entre dispositivos. Sempre o blob
              CIFRADO pela senha; a chave em claro nunca sai do navegador. */}
          <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              Portabilidade da chave — o que sai é sempre o blob <strong>cifrado</strong> pela sua
              senha; a chave em claro nunca deixa este dispositivo.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={doExport}
                disabled={!canRotate}
                style={{ ...portBtn, cursor: canRotate ? 'pointer' : 'not-allowed', opacity: canRotate ? 1 : 0.5 }}
              >
                <Download size={14} aria-hidden /> Exportar
              </button>
              <button
                type="button"
                onClick={() => importRef.current?.click()}
                style={portBtn}
              >
                <Upload size={14} aria-hidden /> Importar
              </button>
              <button
                type="button"
                onClick={doRestoreCloud}
                disabled={cloudBusy}
                title="Baixa a cópia cifrada da nuvem e substitui a chave deste dispositivo"
                style={{ ...portBtn, cursor: cloudBusy ? 'progress' : 'pointer', opacity: cloudBusy ? 0.6 : 1 }}
              >
                <CloudDownload size={14} aria-hidden /> Restaurar da nuvem
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".txt,.json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doImport(f);
                  e.target.value = '';
                }}
              />
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: 'var(--text)',
                cursor: canRotate && !cloudBusy ? 'pointer' : 'not-allowed',
                opacity: canRotate ? 1 : 0.5,
              }}
            >
              <input
                type="checkbox"
                checked={cloudOn}
                disabled={!canRotate || cloudBusy}
                onChange={(e) => void toggleCloud(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              <Cloud size={14} aria-hidden /> Manter cópia na nuvem (recupera em outros dispositivos)
            </label>
            <div className="muted" style={{ fontSize: 11 }}>
              A cópia na nuvem é o mesmo blob cifrado — o servidor nunca vê sua chave. Só é tão forte
              quanto sua senha; use uma senha forte.
            </div>
            {portMsg && (
              <div style={{ fontSize: 12, color: portMsg.ok ? '#3fb950' : '#c1121f' }}>
                {portMsg.text}
              </div>
            )}
          </div>
        </div>

        {!isAdmin && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Apenas administradores podem alterar as configurações.
          </div>
        )}
        {msg && <div style={{ fontSize: 12, marginTop: 8, color: '#c1121f' }}>{msg}</div>}

        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <button
              type="button"
              onClick={save}
              disabled={saving || !valid}
              style={{
                flex: 1,
                padding: 10,
                borderRadius: 8,
                border: 'none',
                background: '#3fb950',
                color: '#0b0f14',
                fontWeight: 700,
                cursor: saving || !valid ? 'not-allowed' : 'pointer',
                opacity: saving || !valid ? 0.5 : 1,
              }}
            >
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            <button type="button" onClick={onClose} className="badge" style={ghostBtn}>
              Cancelar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
