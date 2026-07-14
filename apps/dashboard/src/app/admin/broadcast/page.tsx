'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { OperationStatus, Role, sealMessage, type Operation } from '@cerberus/shared';
import { api } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { getSecretKey } from '@/lib/e2ee';
import { AdminHeader } from '@/components/AdminHeader';

/** Resultado do envio a uma operação (fan-out do broadcast institucional). */
interface SendResult {
  opId: string;
  opName: string;
  status: 'sent' | 'skipped' | 'failed';
  detail?: string;
}

const textareaStyle: CSSProperties = {
  width: '100%',
  resize: 'vertical',
  background: 'var(--bg, #0b0f14)',
  color: 'var(--text, #e6edf3)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 10,
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

/**
 * Broadcast institucional (SUPERADMIN): uma diretiva cifrada para TODAS as operações
 * abertas de uma vez. O E2EE obriga o selo por-operação (cada uma tem seu diretório
 * de chaves), então o envio é um fan-out no cliente sobre o `POST /operations/:id/broadcast`
 * já existente — o servidor nunca vê o texto em claro.
 */
export default function AdminBroadcastPage() {
  const router = useRouter();
  const [ops, setOps] = useState<Operation[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const u = getUser();
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    if (u?.role !== Role.SUPERADMIN) {
      router.replace('/operations');
      return;
    }
    api
      .operations()
      .then(setOps)
      .catch((e) => setError((e as Error).message));
  }, [router]);

  // Alvo do broadcast: operações abertas (não faz sentido diretiva a encerradas).
  const targets = useMemo(
    () => ops.filter((o) => o.status !== OperationStatus.ENCERRADA),
    [ops],
  );

  async function send() {
    const body = text.trim();
    if (!body) return;
    setError(null);
    setResults(null);

    const user = getUser();
    const secretKey = user ? getSecretKey(user.id) : null;
    if (!user || !secretKey) {
      setError('Chave E2EE ausente — refaça o login no dashboard para provisioná-la.');
      return;
    }

    setSending(true);
    try {
      // Fan-out: sela e envia a cada operação-alvo em paralelo, tolerando falhas
      // parciais (uma operação sem chaves não impede as demais).
      const settled = await Promise.allSettled(
        targets.map(async (op): Promise<SendResult> => {
          const directory = await api.operationKeys(op.id);
          if (directory.length === 0) {
            return { opId: op.id, opName: op.name, status: 'skipped', detail: 'sem chaves registradas' };
          }
          const recipients = directory.map((e) => ({ id: e.id, publicKey: e.publicKey }));
          const ciphertext = sealMessage(body, secretKey, recipients);
          await api.broadcast(op.id, ciphertext);
          return { opId: op.id, opName: op.name, status: 'sent' };
        }),
      );

      const out: SendResult[] = settled.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : {
              opId: targets[i].id,
              opName: targets[i].name,
              status: 'failed',
              detail: r.reason instanceof Error ? r.reason.message : 'falha no envio',
            },
      );
      setResults(out);
      if (out.some((r) => r.status === 'sent')) setText('');
    } finally {
      setSending(false);
    }
  }

  const sentCount = results?.filter((r) => r.status === 'sent').length ?? 0;

  return (
    <div>
      <AdminHeader active="broadcast" isSA />
      <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
        <h2>Broadcast institucional</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
          Diretiva cifrada (E2EE) enviada a todas as <strong>{targets.length}</strong> operações
          abertas de uma só vez. Cada operação é cifrada com o próprio diretório de chaves — o
          servidor nunca vê o texto em claro.
        </p>
        {error && <p style={{ color: 'var(--accent)' }}>{error}</p>}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ex.: Recolher todas as equipes ao ponto de encontro imediatamente."
          rows={4}
          style={textareaStyle}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send();
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !text.trim() || targets.length === 0}
          style={{
            marginTop: 10,
            width: '100%',
            padding: '10px 0',
            borderRadius: 8,
            border: 'none',
            background: '#c1121f',
            color: '#fff',
            fontWeight: 700,
            cursor: sending || !text.trim() || targets.length === 0 ? 'not-allowed' : 'pointer',
            opacity: sending || !text.trim() || targets.length === 0 ? 0.5 : 1,
          }}
        >
          {sending
            ? 'Enviando…'
            : `Enviar a ${targets.length} operação${targets.length === 1 ? '' : 'ões'}`}
        </button>

        {results && (
          <div className="card" style={{ padding: 12, marginTop: 16 }}>
            <strong style={{ fontSize: 14 }}>
              Enviado a {sentCount} de {results.length} operações
            </strong>
            <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
              {results.map((r) => (
                <div
                  key={r.opId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <span>{r.opName}</span>
                  <span
                    style={{
                      color:
                        r.status === 'sent'
                          ? 'var(--ok)'
                          : r.status === 'failed'
                            ? 'var(--accent)'
                            : 'var(--muted)',
                    }}
                  >
                    {r.status === 'sent'
                      ? '✓ enviado'
                      : r.status === 'skipped'
                        ? `— ${r.detail}`
                        : `✕ ${r.detail}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
