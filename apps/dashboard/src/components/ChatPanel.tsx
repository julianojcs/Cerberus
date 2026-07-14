'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Role,
  encryptBytes,
  openMessage,
  sealMessage,
  type KeyDirectoryEntry,
  type TeamInfo,
} from '@cerberus/shared';
import { api, type OperationMember, type TacticalMessage } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { getSecretKey, E2EE_UNLOCK_EVENT } from '@/lib/e2ee';
import { resolveColor } from '@/lib/tailwind-colors';
import { AuthImage } from '@/components/AuthImage';
import { Avatar } from '@/components/Avatar';
import type { IncomingMessage } from '@/lib/mqtt';

/** Mensagem já decifrada para exibição. `text: null` = não decifrável por este operador. */
interface ChatMsg {
  key: string;
  senderId: string;
  text: string | null;
  capturedAt: string;
  mine: boolean;
  mediaRef?: string;
  mime?: string;
  crypto?: { k: string; n: string } | null;
  caption?: string | null;
}

/** Conversa da lista (WhatsApp-like): equipe ou DM com um agente. */
interface Conversation {
  key: string; // 'team:<id>' | 'dm:<agentId>'
  kind: 'team' | 'dm';
  id: string;
  name: string;
  color?: string | null;
  lastAt: number;
  lastPreview: string;
  unread: number;
}

function parseMediaMeta(
  raw: string | null,
): { caption?: string; mime?: string; k?: string; n?: string } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const fmtTime = (iso: string): string =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

/** Chave de dedupe (o payload MQTT não traz `id`; casa com a resposta REST). */
const msgKey = (m: { capturedAt: string; ciphertext?: string; text?: string }): string =>
  `${m.capturedAt}::${(m.ciphertext ?? m.text ?? '').slice(0, 48)}`;

const POLL_MS = 15_000;
const READ_KEY = (op: string) => `cerberus_chat_read:${op}`;

/**
 * Painel de chat E2EE estilo WhatsApp (Fase 5 · redesign). Lista PLANA de conversas
 * (equipes + agentes) ordenada pela última mensagem, com busca, avatar e pill de
 * não-lidas; à direita, o header (avatar+nome) + busca de mensagens + histórico +
 * composer. O envelope é selado no cliente só para o subconjunto de destinatários.
 */
export function ChatPanel({
  operationId,
  incoming,
  focusKey,
  focusNonce,
}: {
  operationId: string;
  incoming: IncomingMessage[];
  focusKey?: string | null;
  focusNonce?: number;
}) {
  const user = useMemo(() => getUser(), []);
  const myDirId = user?.agentId ?? user?.id ?? '';
  const isAdmin = user?.role === Role.ADMIN || user?.role === Role.SUPERADMIN;

  // Fase 5e-1 — a chave existe só após o desbloqueio; segue o evento de unlock.
  const [secretKey, setSecretKey] = useState<string | null>(() =>
    user ? getSecretKey(user.id) : null,
  );
  useEffect(() => {
    const sync = () => setSecretKey(user ? getSecretKey(user.id) : null);
    sync();
    window.addEventListener(E2EE_UNLOCK_EVENT, sync);
    return () => window.removeEventListener(E2EE_UNLOCK_EVENT, sync);
  }, [user]);

  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [members, setMembers] = useState<OperationMember[]>([]);
  const [directory, setDirectory] = useState<KeyDirectoryEntry[]>([]);
  const [rawMsgs, setRawMsgs] = useState<TacticalMessage[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [convSearch, setConvSearch] = useState('');
  const [msgSearch, setMsgSearch] = useState('');
  const [lastRead, setLastRead] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Diretório + equipes + membros da operação.
  useEffect(() => {
    api.operationTeams(operationId).then(setTeams).catch(() => {});
    api.operationMembers(operationId).then(setMembers).catch(() => {});
    api.operationKeys(operationId).then(setDirectory).catch(() => {});
  }, [operationId]);

  // Preferência de leitura (localStorage) por operação.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(READ_KEY(operationId));
      if (raw) setLastRead(JSON.parse(raw) as Record<string, number>);
    } catch {
      /* ignora */
    }
  }, [operationId]);

  // Histórico (todas as mensagens da operação) — busca inicial + poll leve.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .messages(operationId)
        .then((m) => alive && setRawMsgs(m))
        .catch(() => {});
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [operationId]);

  // Converte uma IncomingMessage (MQTT) para o formato de mensagem.
  const incomingAsRaw = useMemo<TacticalMessage[]>(
    () =>
      incoming.map((m) => ({
        id: msgKey(m),
        operationId,
        senderId: m.senderId,
        type: m.type,
        teamId: m.teamId,
        recipientId: m.recipientId,
        text: m.text,
        ciphertext: m.ciphertext,
        mediaRef: m.mediaRef,
        capturedAt: m.capturedAt,
      })),
    [incoming, operationId],
  );

  // Todas as mensagens (REST + ao vivo), deduplicadas por chave.
  const allMsgs = useMemo<TacticalMessage[]>(() => {
    const map = new Map<string, TacticalMessage>();
    for (const m of rawMsgs) map.set(msgKey(m), m);
    for (const m of incomingAsRaw) if (!map.has(msgKey(m))) map.set(msgKey(m), m);
    return [...map.values()];
  }, [rawMsgs, incomingAsRaw]);

  // Conjunto de agentIds conhecidos (para classificar mensagens diretas do agente).
  const agentIds = useMemo(() => {
    const s = new Set<string>();
    for (const m of members) if (m.agentId) s.add(m.agentId);
    for (const t of teams) for (const a of t.agentIds) s.add(a);
    return s;
  }, [members, teams]);

  // Conversa de uma mensagem: equipe (teamId) ou DM (recipientId / senderId do agente).
  const convKeyForMsg = useCallback(
    (m: TacticalMessage): string | null => {
      if (m.teamId) return `team:${m.teamId}`;
      if (m.recipientId) return `dm:${m.recipientId}`;
      if (agentIds.has(m.senderId)) return `dm:${m.senderId}`;
      return null; // broadcast op-wide / não classificável
    },
    [agentIds],
  );

  const toChatMsg = useCallback(
    (m: TacticalMessage): ChatMsg => {
      const base = {
        key: msgKey(m),
        senderId: m.senderId,
        capturedAt: m.capturedAt,
        mine: m.senderId === myDirId,
      };
      const senderKey = directory.find((e) => e.id === m.senderId)?.publicKey;
      if (m.type === 'media' && m.mediaRef) {
        const meta =
          m.ciphertext && secretKey
            ? parseMediaMeta(openMessage(m.ciphertext, myDirId, secretKey, senderKey))
            : null;
        return {
          ...base,
          text: null,
          mediaRef: m.mediaRef,
          mime: meta?.mime ?? 'image/jpeg',
          crypto: meta?.k && meta?.n ? { k: meta.k, n: meta.n } : null,
          caption: meta?.caption ?? null,
        };
      }
      return {
        ...base,
        text:
          m.ciphertext && secretKey
            ? openMessage(m.ciphertext, myDirId, secretKey, senderKey)
            : (m.text ?? null),
      };
    },
    [secretKey, myDirId, directory],
  );

  // Decifra todas as mensagens uma vez (preview da lista + thread).
  const decrypted = useMemo(() => {
    const map = new Map<string, ChatMsg>();
    for (const m of allMsgs) map.set(msgKey(m), toChatMsg(m));
    return map;
  }, [allMsgs, toChatMsg]);

  const previewOf = (dec?: ChatMsg): string =>
    dec ? (dec.mediaRef ? '📷 Foto' : (dec.text ?? '🔒 cifrada')) : '';

  // Lista de conversas (equipes + agentes), com última msg / preview / não-lidas.
  const conversations = useMemo<Conversation[]>(() => {
    const map = new Map<string, Conversation>();
    for (const t of teams)
      map.set(`team:${t.id}`, {
        key: `team:${t.id}`,
        kind: 'team',
        id: t.id,
        name: t.name,
        color: resolveColor(t.color),
        lastAt: 0,
        lastPreview: '',
        unread: 0,
      });
    for (const mb of members)
      if (mb.agentId)
        map.set(`dm:${mb.agentId}`, {
          key: `dm:${mb.agentId}`,
          kind: 'dm',
          id: mb.agentId,
          name: mb.name || mb.agentId,
          color: null,
          lastAt: 0,
          lastPreview: '',
          unread: 0,
        });
    for (const m of allMsgs) {
      const key = convKeyForMsg(m);
      if (!key) continue;
      let c = map.get(key);
      if (!c) {
        if (!key.startsWith('dm:')) continue;
        const id = key.slice(3);
        c = { key, kind: 'dm', id, name: id, color: null, lastAt: 0, lastPreview: '', unread: 0 };
        map.set(key, c);
      }
      const at = +new Date(m.capturedAt);
      if (at >= c.lastAt) {
        c.lastAt = at;
        c.lastPreview = previewOf(decrypted.get(msgKey(m)));
      }
      if (at > (lastRead[key] ?? 0) && m.senderId !== myDirId) c.unread++;
    }
    return [...map.values()].sort((a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name));
  }, [teams, members, allMsgs, convKeyForMsg, decrypted, lastRead, myDirId]);

  const filteredConvs = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    return q ? conversations.filter((c) => c.name.toLowerCase().includes(q)) : conversations;
  }, [conversations, convSearch]);

  const active = useMemo(
    () => conversations.find((c) => c.key === activeKey) ?? null,
    [conversations, activeKey],
  );

  // Mensagens do thread ativo (decifradas, ordem crescente) + filtro de busca.
  const threadMsgs = useMemo<ChatMsg[]>(() => {
    if (!activeKey) return [];
    const list = allMsgs
      .filter((m) => convKeyForMsg(m) === activeKey)
      .map((m) => decrypted.get(msgKey(m)))
      .filter((m): m is ChatMsg => !!m)
      .sort((a, b) => +new Date(a.capturedAt) - +new Date(b.capturedAt));
    const q = msgSearch.trim().toLowerCase();
    return q
      ? list.filter((m) => (m.text ?? m.caption ?? '').toLowerCase().includes(q))
      : list;
  }, [activeKey, allMsgs, convKeyForMsg, decrypted, msgSearch]);

  // Abertura externa (clique no card "Mensagens" da barra lateral).
  useEffect(() => {
    if (focusKey) setActiveKey(focusKey);
  }, [focusNonce, focusKey]);

  // Marca a conversa ativa como lida (persiste).
  useEffect(() => {
    if (!activeKey) return;
    setLastRead((prev) => {
      const next = { ...prev, [activeKey]: Date.now() };
      try {
        localStorage.setItem(READ_KEY(operationId), JSON.stringify(next));
      } catch {
        /* ignora */
      }
      return next;
    });
    setMsgSearch('');
  }, [activeKey, operationId, threadMsgs.length]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [threadMsgs]);

  function recipientsForActive(): { id: string; publicKey: string }[] {
    if (!active) return [];
    const ids =
      active.kind === 'team'
        ? new Set([...(teams.find((t) => t.id === active.id)?.agentIds ?? []), myDirId])
        : new Set([active.id, myDirId]);
    return directory.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, publicKey: e.publicKey }));
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || !active || sending) return;
    if (!user || !secretKey) return setError('Chave E2EE bloqueada — desbloqueie para enviar.');
    setSending(true);
    setError(null);
    try {
      const recipients = recipientsForActive();
      if (recipients.length === 0) return setError('Nenhum destinatário com chave E2EE registrada.');
      const ciphertext = sealMessage(text, secretKey, recipients);
      const resp =
        active.kind === 'team'
          ? await api.sendTeamMessage(operationId, active.id, ciphertext)
          : await api.sendAgentMessage(operationId, active.id, ciphertext);
      setRawMsgs((prev) => [resp, ...prev]);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function handlePickMedia(file: File) {
    if (!active || sending) return;
    if (!user || !secretKey) return setError('Chave E2EE bloqueada — desbloqueie para enviar.');
    setSending(true);
    setError(null);
    try {
      const recipients = recipientsForActive();
      if (recipients.length === 0) return setError('Nenhum destinatário com chave E2EE registrada.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { cipher, key, nonce } = encryptBytes(bytes);
      const envelope = sealMessage(
        JSON.stringify({ caption: draft.trim() || undefined, mime: file.type, k: key, n: nonce }),
        secretKey,
        recipients,
      );
      const blobBuf = cipher.buffer.slice(
        cipher.byteOffset,
        cipher.byteOffset + cipher.byteLength,
      ) as ArrayBuffer;
      const form = new FormData();
      form.append('ciphertext', envelope);
      form.append('file', new Blob([blobBuf], { type: 'application/octet-stream' }), 'media.bin');
      const resp =
        active.kind === 'team'
          ? await api.uploadTeamMedia(operationId, active.id, form)
          : await api.uploadAgentMedia(operationId, active.id, form);
      setRawMsgs((prev) => [resp, ...prev]);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const canSend = !!active && isAdmin;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Coluna esquerda: busca + lista de conversas */}
      <div style={listCol}>
        <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
          <input
            value={convSearch}
            onChange={(e) => setConvSearch(e.target.value)}
            placeholder="Buscar equipe ou usuário…"
            style={searchInput}
          />
        </div>
        <div className="thinscroll" style={{ flex: 1, overflowY: 'auto' }}>
          {filteredConvs.length === 0 && (
            <div className="muted" style={{ fontSize: 12, padding: 12 }}>
              Nenhuma conversa.
            </div>
          )}
          {filteredConvs.map((c) => {
            const sel = c.key === activeKey;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setActiveKey(c.key)}
                style={{ ...convRow, ...(sel ? convSel : null) }}
              >
                <Avatar name={c.name} color={c.color} size={38} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={rowLine}>
                    <span style={convName}>
                      {c.kind === 'team' ? '👥 ' : ''}
                      {c.name}
                    </span>
                    {c.lastAt > 0 && (
                      <span className="muted" style={{ fontSize: 10, flexShrink: 0 }}>
                        {fmtTime(new Date(c.lastAt).toISOString())}
                      </span>
                    )}
                  </div>
                  <div style={rowLine}>
                    <span style={convPreview}>{c.lastPreview || '—'}</span>
                    {c.unread > 0 && <span style={unreadPill}>{c.unread}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Coluna direita: conversa ativa */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!active ? (
          <div style={emptyThread}>Selecione uma equipe ou usuário para conversar.</div>
        ) : (
          <>
            <div style={threadHeader}>
              <Avatar name={active.name} color={active.color} size={38} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 14, display: 'block' }}>{active.name}</strong>
                <span className="muted" style={{ fontSize: 11 }}>
                  {active.kind === 'team'
                    ? `Equipe · ${teams.find((t) => t.id === active.id)?.agentIds.length ?? 0} membros`
                    : 'Agente de campo'}
                </span>
              </div>
              <input
                value={msgSearch}
                onChange={(e) => setMsgSearch(e.target.value)}
                placeholder="Buscar mensagens…"
                style={{ ...searchInput, maxWidth: 200 }}
              />
            </div>
            <div ref={listRef} className="thinscroll" style={msgListStyle}>
              {threadMsgs.length === 0 ? (
                <div className="muted" style={{ fontSize: 13, textAlign: 'center', marginTop: 20 }}>
                  {msgSearch ? 'Nenhuma mensagem encontrada.' : 'Sem mensagens ainda.'}
                </div>
              ) : (
                threadMsgs.map((m) => (
                  <div
                    key={m.key}
                    style={{
                      alignSelf: m.mine ? 'flex-end' : 'flex-start',
                      maxWidth: '78%',
                      background: m.mine ? 'var(--accent)' : 'var(--panel-2)',
                      color: m.mine ? '#fff' : 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '6px 10px',
                    }}
                  >
                    {!m.mine && (
                      <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
                        {m.senderId}
                      </div>
                    )}
                    {m.mediaRef ? (
                      <>
                        {m.crypto ? (
                          <AuthImage
                            path={api.mediaPath(operationId, m.mediaRef)}
                            mediaKey={m.crypto}
                            mime={m.mime}
                            alt={m.caption ?? 'mídia'}
                            style={{
                              maxWidth: 220,
                              maxHeight: 220,
                              borderRadius: 8,
                              display: 'block',
                              background: 'var(--border)',
                            }}
                          />
                        ) : (
                          <span style={{ fontStyle: 'italic', opacity: 0.7, fontSize: 13 }}>
                            🔒 mídia indecifrável
                          </span>
                        )}
                        {m.caption && <div style={{ fontSize: 12, marginTop: 4 }}>{m.caption}</div>}
                      </>
                    ) : (
                      <div style={{ fontSize: 13, lineHeight: 1.35 }}>
                        {m.text ?? (
                          <span style={{ fontStyle: 'italic', opacity: 0.7 }}>🔒 indecifrável</span>
                        )}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 10,
                        opacity: 0.7,
                        marginTop: 2,
                        textAlign: 'right',
                        color: m.mine ? '#fff' : 'var(--muted)',
                      }}
                    >
                      {fmtTime(m.capturedAt)}
                    </div>
                  </div>
                ))
              )}
            </div>
            {error && (
              <div style={{ color: 'var(--accent)', fontSize: 12, padding: '0 12px 6px' }}>{error}</div>
            )}
            {canSend ? (
              <div style={composerRow}>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handlePickMedia(f);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={sending}
                  title="Enviar foto (E2EE)"
                  style={{ ...attachBtn, cursor: sending ? 'not-allowed' : 'pointer', opacity: sending ? 0.5 : 1 }}
                >
                  📷
                </button>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleSend();
                  }}
                  placeholder={`Mensagem para ${active.name}…`}
                  rows={2}
                  style={composerInput}
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={sending || !draft.trim()}
                  style={{
                    ...sendBtn,
                    cursor: sending || !draft.trim() ? 'not-allowed' : 'pointer',
                    opacity: sending || !draft.trim() ? 0.5 : 1,
                  }}
                >
                  {sending ? '…' : 'Enviar'}
                </button>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12, padding: 12 }}>
                Apenas a central (admin) envia mensagens de equipe/DM.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const listCol: CSSProperties = {
  width: 280,
  flexShrink: 0,
  borderRight: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const searchInput: CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  colorScheme: 'dark',
  fontSize: 13,
  boxSizing: 'border-box',
};
const convRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text)',
  cursor: 'pointer',
  textAlign: 'left',
  padding: '8px 10px',
};
const convSel: CSSProperties = { background: 'var(--panel-2)' };
const rowLine: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};
const convName: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const convPreview: CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: 1,
  minWidth: 0,
};
const unreadPill: CSSProperties = {
  flexShrink: 0,
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: 9,
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 700,
  display: 'grid',
  placeItems: 'center',
};
const emptyThread: CSSProperties = {
  flex: 1,
  display: 'grid',
  placeItems: 'center',
  color: 'var(--muted)',
  fontSize: 13,
  padding: 24,
  textAlign: 'center',
};
const threadHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};
const msgListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const composerRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: 12,
  borderTop: '1px solid var(--border)',
  alignItems: 'flex-end',
};
const composerInput: CSSProperties = {
  flex: 1,
  resize: 'vertical',
  background: 'var(--bg, #0b0f14)',
  color: 'var(--text, #e6edf3)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 8,
  fontSize: 13,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
const sendBtn: CSSProperties = {
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '8px 16px',
  fontWeight: 700,
};
const attachBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 16,
  flexShrink: 0,
};
