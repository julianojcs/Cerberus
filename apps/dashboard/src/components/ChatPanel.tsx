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
import { api } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { getSecretKey } from '@/lib/e2ee';
import { resolveColor } from '@/lib/tailwind-colors';
import { AuthImage } from '@/components/AuthImage';
import type { IncomingMessage } from '@/lib/mqtt';

/** Thread ativo: chat de equipe (grupo) ou DM com um agente. */
type Thread = { kind: 'team'; team: TeamInfo } | { kind: 'dm'; agentId: string };

/** Mensagem já decifrada para exibição. `text: null` = não decifrável por este operador. */
interface ChatMsg {
  key: string;
  senderId: string;
  text: string | null;
  capturedAt: string;
  mine: boolean;
  // Mídia (type === 'media'): ref do blob + chave/nonce da imagem (do envelope).
  mediaRef?: string;
  mime?: string;
  crypto?: { k: string; n: string } | null;
  caption?: string | null;
}

/** Faz o parse da metadata E2EE da mídia (JSON no envelope). `null` se inválida. */
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

/**
 * Painel de chat E2EE de equipe/DM (Fase 3a). Árvore equipe→agente à esquerda,
 * thread selecionado à direita (histórico REST + ao vivo via MQTT). O envelope é
 * selado no cliente só para o subconjunto (membros da equipe / o agente do DM).
 */
export function ChatPanel({
  operationId,
  incoming,
}: {
  operationId: string;
  incoming: IncomingMessage[];
}) {
  const user = useMemo(() => getUser(), []);
  const myDirId = user?.agentId ?? user?.id ?? '';
  const isAdmin = user?.role === Role.ADMIN || user?.role === Role.SUPERADMIN;
  const secretKey = useMemo(() => (user ? getSecretKey(user.id) : null), [user]);

  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [directory, setDirectory] = useState<KeyDirectoryEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Diretório de chaves + equipes da operação (para a árvore e o sela por subconjunto).
  useEffect(() => {
    api.operationTeams(operationId).then(setTeams).catch(() => {});
    api.operationKeys(operationId).then(setDirectory).catch(() => {});
  }, [operationId]);

  const toChatMsg = useCallback(
    (m: {
      senderId: string;
      type?: string;
      ciphertext?: string;
      text?: string;
      mediaRef?: string;
      capturedAt: string;
    }): ChatMsg => {
      const base = {
        key: msgKey(m),
        senderId: m.senderId,
        capturedAt: m.capturedAt,
        mine: m.senderId === myDirId,
      };
      // Fase 5c — chave do remetente segundo o diretório (autentica o `senderId`).
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

  const appendMsgs = useCallback((incomingMsgs: ChatMsg[]) => {
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.key));
      const add = incomingMsgs.filter((m) => !seen.has(m.key));
      if (add.length === 0) return prev;
      return [...prev, ...add].sort(
        (a, b) => +new Date(a.capturedAt) - +new Date(b.capturedAt),
      );
    });
  }, []);

  // Histórico do thread selecionado (REST) → decifra e ordena (mais antigo em cima).
  useEffect(() => {
    if (!thread) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const load =
      thread.kind === 'team'
        ? api.teamMessages(operationId, thread.team.id)
        : api.agentMessages(operationId, thread.agentId);
    load
      .then((msgs) => {
        if (cancelled) return;
        setMessages(
          msgs
            .map(toChatMsg)
            .sort((a, b) => +new Date(a.capturedAt) - +new Date(b.capturedAt)),
        );
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [thread, operationId, toChatMsg]);

  // Mensagens ao vivo (MQTT) do thread atual — anexa e deduplica.
  useEffect(() => {
    if (!thread) return;
    const relevant = incoming.filter((m) =>
      thread.kind === 'team'
        ? m.scope === 'equipe' && m.teamId === thread.team.id
        : m.scope === 'dm' && m.recipientId === thread.agentId,
    );
    if (relevant.length) appendMsgs(relevant.map(toChatMsg));
  }, [incoming, thread, appendMsgs, toChatMsg]);

  // Rola para o fim quando chegam mensagens.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  function recipientsFor(t: Thread): { id: string; publicKey: string }[] {
    const ids =
      t.kind === 'team'
        ? new Set([...t.team.agentIds, myDirId])
        : new Set([t.agentId, myDirId]);
    return directory.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, publicKey: e.publicKey }));
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || !thread || sending) return;
    if (!user || !secretKey) {
      setError('Chave E2EE ausente — refaça o login para provisioná-la.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const recipients = recipientsFor(thread);
      if (recipients.length === 0) {
        setError('Nenhum destinatário com chave E2EE registrada.');
        return;
      }
      const ciphertext = sealMessage(text, secretKey, recipients);
      const resp =
        thread.kind === 'team'
          ? await api.sendTeamMessage(operationId, thread.team.id, ciphertext)
          : await api.sendAgentMessage(operationId, thread.agentId, ciphertext);
      appendMsgs([toChatMsg(resp)]); // eco otimista (o MQTT depois deduplica)
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  // Envia uma FOTO E2EE ao thread: cifra a imagem (secretbox), embrulha
  // legenda/mime/chave num envelope selado só para o subconjunto, e faz upload.
  async function handlePickMedia(file: File) {
    if (!thread || sending) return;
    if (!user || !secretKey) {
      setError('Chave E2EE ausente — refaça o login para provisioná-la.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const recipients = recipientsFor(thread);
      if (recipients.length === 0) {
        setError('Nenhum destinatário com chave E2EE registrada.');
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { cipher, key, nonce } = encryptBytes(bytes);
      const envelope = sealMessage(
        JSON.stringify({ caption: draft.trim() || undefined, mime: file.type, k: key, n: nonce }),
        secretKey,
        recipients,
      );
      // Fatia num ArrayBuffer concreto (Blob não aceita Uint8Array<ArrayBufferLike>).
      const blobBuf = cipher.buffer.slice(
        cipher.byteOffset,
        cipher.byteOffset + cipher.byteLength,
      ) as ArrayBuffer;
      const form = new FormData();
      form.append('ciphertext', envelope); // ANTES do arquivo (para file.fields)
      form.append('file', new Blob([blobBuf], { type: 'application/octet-stream' }), 'media.bin');
      const resp =
        thread.kind === 'team'
          ? await api.uploadTeamMedia(operationId, thread.team.id, form)
          : await api.uploadAgentMedia(operationId, thread.agentId, form);
      appendMsgs([toChatMsg(resp)]);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const threadTitle = thread
    ? thread.kind === 'team'
      ? `Equipe ${thread.team.name}`
      : `DM · ${thread.agentId}`
    : null;
  const canSend = !!thread && isAdmin;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Árvore: equipes → agentes */}
      <div className="thinscroll" style={treeCol}>
        <div className="muted" style={{ fontSize: 12, padding: '4px 8px' }}>
          Equipes ({teams.length})
        </div>
        {teams.length === 0 && (
          <div className="muted" style={{ fontSize: 12, padding: 8 }}>
            Nenhuma equipe nesta operação.
          </div>
        )}
        {teams.map((t) => {
          const open = expanded.has(t.id);
          const teamSel = thread?.kind === 'team' && thread.team.id === t.id;
          return (
            <div key={t.id}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((prev) => {
                      const n = new Set(prev);
                      if (n.has(t.id)) n.delete(t.id);
                      else n.add(t.id);
                      return n;
                    })
                  }
                  style={{ ...caretBtn }}
                  title={open ? 'Recolher' : 'Expandir'}
                >
                  {open ? '▾' : '▸'}
                </button>
                <button
                  type="button"
                  onClick={() => setThread({ kind: 'team', team: t })}
                  style={{ ...nodeBtn, ...(teamSel ? nodeSel : null) }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: resolveColor(t.color),
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>{t.name}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {t.agentIds.length}
                  </span>
                </button>
              </div>
              {open &&
                t.agentIds.map((a) => {
                  const dmSel = thread?.kind === 'dm' && thread.agentId === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setThread({ kind: 'dm', agentId: a })}
                      style={{ ...nodeBtn, paddingLeft: 34, ...(dmSel ? nodeSel : null) }}
                      title={`DM com ${a}`}
                    >
                      <span className="muted">💬</span>
                      <span style={{ flex: 1, minWidth: 0 }}>{a}</span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>

      {/* Thread */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!thread ? (
          <div style={emptyThread}>Selecione uma equipe ou agente para conversar.</div>
        ) : (
          <>
            <div style={threadHeader}>
              <strong style={{ fontSize: 14 }}>{threadTitle}</strong>
            </div>
            <div ref={listRef} className="thinscroll" style={msgList}>
              {messages.length === 0 ? (
                <div className="muted" style={{ fontSize: 13, textAlign: 'center', marginTop: 20 }}>
                  Sem mensagens ainda.
                </div>
              ) : (
                messages.map((m) => (
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
                  style={{
                    ...attachBtn,
                    cursor: sending ? 'not-allowed' : 'pointer',
                    opacity: sending ? 0.5 : 1,
                  }}
                >
                  📷
                </button>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleSend();
                  }}
                  placeholder={
                    thread.kind === 'team'
                      ? `Mensagem à equipe ${thread.team.name}…`
                      : `Mensagem para ${thread.agentId}…`
                  }
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

const treeCol: CSSProperties = {
  width: 220,
  flexShrink: 0,
  borderRight: '1px solid var(--border)',
  overflowY: 'auto',
  padding: 8,
};
const caretBtn: CSSProperties = {
  width: 22,
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
};
const nodeBtn: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'transparent',
  border: 'none',
  color: 'var(--text)',
  cursor: 'pointer',
  textAlign: 'left',
  padding: '6px 8px',
  borderRadius: 6,
  fontSize: 13,
  minWidth: 0,
};
const nodeSel: CSSProperties = { background: 'var(--panel-2)' };
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
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};
const msgList: CSSProperties = {
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
