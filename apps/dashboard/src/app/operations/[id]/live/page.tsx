'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  Map as MapIcon,
  MessageSquare,
  Images,
  FileText,
  FileSpreadsheet,
  FileArchive,
  File as FileIcon,
  Columns2,
  PanelTop,
 // Pin,
  Eye,
  Star,
  Lock,
  Settings as SettingsIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  api,
  type LatestPosition,
  type Geofence,
  type GeofenceAlert,
  type GeofenceInput,
  type MediaStatInfo,
  type Settings,
} from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { getSecretKey, openForMe, E2EE_UNLOCK_EVENT } from '@/lib/e2ee';
import {
  GEOFENCE_SEVERITY_RANK,
  encryptBytes,
  sealMessage,
  type KeyDirectoryEntry,
  type TeamInfo,
} from '@cerberus/shared';
import { putCachedCiphertext } from '@/lib/mediaCache';
import { bytesToObjectUrl, loadDecryptedBytes } from '@/lib/media';
import {
  AdvancedZoneFields,
  localTimeToUtcMin,
  utcMinToLocalTime,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  type AdvancedZoneValue,
} from '@/components/AdvancedZoneFields';
import { subscribeToOperation, type IncomingMessage, type LivePosition } from '@/lib/mqtt';
import { ChatPanel } from '@/components/ChatPanel';
import {
  LiveMap,
  circleRing,
  rectangleRing,
  type AgentPoint,
  type AgentTrails,
  type GeofenceCircle,
  type PlottedRoute,
} from '@/components/LiveMap';
import { AuthImage } from '@/components/AuthImage';
import { MediaViewer } from '@/components/MediaViewer';
import { ResizableSidebar } from '@/components/ResizableSidebar';
import { ColorPalettePicker } from '@/components/ColorPalettePicker';
import { SettingsModal } from '@/components/SettingsModal';
import { NotificationCenter, type NotifItem } from '@/components/NotificationCenter';
import { UserMenu } from '@/components/UserMenu';
import { PeriodRange } from '@/components/PeriodRange';
import { alertBorderFocus, routeBearingAt, type AlertFocus } from '@/lib/geo';
import { resolveColor } from '@/lib/tailwind-colors';
import { buildRoutes, assignAgentColors, splitSegments, type Route } from '@/lib/routes';
import { MapEffectsMenu } from '@/components/MapEffectsMenu';

/** Histórico buscado para montar as rotas por agente. */
const HISTORY_LIMIT = 5000;
/** Máximo de pontos por trilha ao vivo (limita memória/render num turno longo). */
const MAX_LIVE_TRAIL = 2000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Card de agente no sidebar. Com sinal = tem posição (do mapa). Sem sinal = designado
 * à operação (no diretório de chaves) mas ainda não transmitiu — aparece como
 * "aguardando sinal" para o operador ver quem DEVERIA estar na operação.
 */
type AgentCard =
  | (AgentPoint & { hasSignal: true })
  | { agentId: string; hasSignal: false };

/** Mensagem de texto/broadcast já decifrada para exibição (`text: null` = falha). */
interface DecryptedMessage {
  id: string;
  senderId: string;
  type: string;
  text: string | null;
  capturedAt: string;
  teamId?: string; // roteia o clique p/ a conversa da equipe
  recipientId?: string; // roteia o clique p/ o DM
}

/** Mídia com a metadata (legenda/geotag/chave da imagem) decifrada. */
interface DecryptedMedia {
  id: string;
  senderId: string;
  mediaRef: string;
  caption: string | null;
  lat?: number;
  lng?: number;
  mime: string;
  /** Chave/nonce da imagem cifrada; `null` = envelope não decifrável por este operador. */
  crypto: { k: string; n: string } | null;
  capturedAt: string;
  teamId?: string; // roteia o clique p/ a conversa
  recipientId?: string;
}

/** Item unificado do card "Mensagens" (texto/broadcast + foto), ordenado por data. */
interface CardMsg {
  id: string;
  senderId: string;
  type: string;
  text: string | null;
  capturedAt: string;
  teamId?: string;
  recipientId?: string;
  mediaRef?: string;
  mime?: string;
  crypto?: { k: string; n: string } | null;
  caption?: string | null;
}

/** Documento (Fase 6d): mídia E2EE com mime NÃO-imagem + nome de arquivo. */
interface DecryptedDoc {
  id: string;
  senderId: string;
  mediaRef: string;
  filename: string;
  mime: string;
  crypto: { k: string; n: string } | null;
  capturedAt: string;
}

/** Faz o parse da metadata E2EE da mídia (JSON no envelope). `null` se inválida. */
function parseMediaMeta(raw: string | null): {
  caption?: string;
  filename?: string;
  lat?: number;
  lng?: number;
  mime?: string;
  k?: string;
  n?: string;
} | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Data/hora local (America/Sao_Paulo) — exibição das rotas. Dado permanece UTC. */
function fmtDateTime(ms: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** Data e hora em partes (para os badges das extremidades em DUAS linhas). */
function fmtDateParts(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
    }).format(d),
    time: new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d),
  };
}

/** Badge de extremidade: data em cima, hora embaixo. */
function EdgeStamp({ ms, title, align }: { ms: number; title: string; align: 'left' | 'right' }) {
  const { date, time } = fmtDateParts(ms);
  return (
    <span
      style={{
        fontSize: 11,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        minWidth: 44,
        textAlign: align,
        lineHeight: 1.15,
      }}
      title={title}
    >
      <span style={{ display: 'block' }}>{date}</span>
      <span style={{ display: 'block' }}>{time}</span>
    </span>
  );
}

export default function LiveOperationPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const operationId = params.id;
  const colorsKey = `cerberus_agent_colors:${operationId}`;

  const [agents, setAgents] = useState<Record<string, AgentPoint>>({});
  const [connected, setConnected] = useState(false);
  // Chat (Fase 3a): aba Mapa|Chat + buffer de mensagens ao vivo (equipe/DM) do MQTT.
  const [mainTab, setMainTab] = useState<'map' | 'chat' | 'gallery' | 'docs'>('map');
  const [incomingChat, setIncomingChat] = useState<IncomingMessage[]>([]);
  // Clique no card "Mensagens" → abre a conversa no Chat (key + nonce p/ re-disparar).
  const [chatFocus, setChatFocus] = useState<{ key: string; nonce: number }>({ key: '', nonce: 0 });
  // Fase 3b-1: layout abas OU split (Chat|Mapa lado a lado, divisor arrastável).
  const [layout, setLayout] = useState<'tabs' | 'split'>('tabs');
  const [chatWidth, setChatWidth] = useState(400);
  const splitRootRef = useRef<HTMLDivElement>(null);
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;
  const draggingSplit = useRef(false);

  // Histórico cru. As rotas são DERIVADAS (com o gap configurável).
  const [rawPositions, setRawPositions] = useState<LatestPosition[]>([]);
  // Trilha AO VIVO por agente: cresce a cada posição do MQTT durante o deslocamento
  // (semeada com o histórico recente na carga). `[lng,lat][]` — um traço por agente.
  const [liveTrails, setLiveTrails] = useState<
    Record<string, { lng: number; lat: number; capturedAt: string }[]>
  >({});
  const [showLiveTrail, setShowLiveTrail] = useState(true);
  // Efeito "Sentido das trilhas" (setas no mapa) — controlado pelo menu de efeitos.
  const [showTrailDirection, setShowTrailDirection] = useState(false);
  // Ligar/desligar a trilha ao vivo. Ao DESLIGAR, também desliga o "Sentido das
  // trilhas" (sem trilha não há sentido a indicar → as setas somem, não ficam órfãs).
  const setLiveTrail = useCallback((v: boolean) => {
    setShowLiveTrail(v);
    if (!v) setShowTrailDirection(false);
  }, []);
  // Sentido efetivo: só vale com a trilha ao vivo ligada (defesa contra estado órfão).
  const trailDirectionOn = showLiveTrail && showTrailDirection;
  // Exibir fotos (pins de mídia geolocalizada) no mapa — menu de efeitos.
  const [showMedia, setShowMedia] = useState(true);
  const seededTrailRef = useRef(false);
  // Seleção inicial das rotas: marca todos os agentes por padrão na 1ª carga (uma vez).
  const seededSelectionRef = useRef(false);
  // Cor por agente: token auto-atribuído + override escolhido pelo admin (localStorage).
  const [agentColorTokens, setAgentColorTokens] = useState<Record<string, string>>({});
  const [agentColorOverrides, setAgentColorOverrides] = useState<Record<string, string>>({});
  // Sinal para o mapa enquadrar (fitBounds) todas as rotas plotadas.
  const [fitNonce, setFitNonce] = useState(0);
  const [firstTs, setFirstTs] = useState<number | null>(null);
  // "Agora" — teto do período; avança para acompanhar o horário atual. Inicia em 0
  // (estável no SSR) e recebe o Date.now() real no mount (evita mismatch de hidratação:
  // Date.now() no init difere entre servidor e cliente).
  const [nowTs, setNowTs] = useState(0);
  // Ponta direita "ao vivo": segue o "agora" até o operador arrastá-la para trás.
  const [liveEnd, setLiveEnd] = useState(true);
  const liveEndRef = useRef(true);
  liveEndRef.current = liveEnd;
  const windowInitRef = useRef(false); // só define o período padrão UMA vez
  // Período ajustável (início/fim em ms). Padrão: últimas 24 h ATÉ agora.
  const [windowStartMs, setWindowStartMs] = useState(0);
  const [windowEndMs, setWindowEndMs] = useState(0);
  // "Agora" avança a cada 15s (teto do período acompanha o horário atual); se a ponta
  // direita está "ao vivo", ela segue junto — assim posições recém-chegadas entram no
  // período e o card do agente fica selecionável sem precisar recarregar.
  useEffect(() => {
    setNowTs(Date.now()); // valor real só no cliente (SSR fica com 0)
    const id = setInterval(() => {
      const now = Date.now();
      setNowTs(now);
      if (liveEndRef.current) setWindowEndMs(now);
    }, 15_000);
    return () => clearInterval(id);
  }, []);
  // Rotas selecionadas para plotagem (id da rota) e agente com a lista expandida.
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<string>>(new Set());
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  // Configurações do sistema (padrões enquanto não carrega) + modal.
  const [settings, setSettings] = useState<Settings>({
    minRoutePoints: 5,
    connectRoutes: false,
    maxGapMinutes: 5,
    sidebarMessageCount: 5,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Persiste alterações de Configurações feitas pelo menu de efeitos. Aplica local
  // na hora (o mapa reage) e faz o PATCH com debounce+acúmulo (evita 1 request por
  // tecla nos campos numéricos). Mesmos campos do SettingsModal — os dois coexistem.
  const settingsPatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettingsPatch = useRef<Partial<Settings>>({});
  const updateSetting = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    pendingSettingsPatch.current = { ...pendingSettingsPatch.current, ...patch };
    if (settingsPatchTimer.current) clearTimeout(settingsPatchTimer.current);
    settingsPatchTimer.current = setTimeout(() => {
      const body = pendingSettingsPatch.current;
      pendingSettingsPatch.current = {};
      api
        .patchSettings(body)
        .then((saved) => setSettings((s) => ({ ...s, ...saved })))
        .catch(() => {
          // Sem permissão / falha — recarrega o estado real do servidor.
          api.settings().then(setSettings).catch(() => {});
        });
    }, 500);
  }, []);
  // Nome de exibição por id (agente/usuário) para o card de mensagens.
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});

  // Barra de período: aparece ao passar o cursor no topo do mapa; "pin" fixa.
  const [barHover, setBarHover] = useState(false);
  const [barPinned, setBarPinned] = useState(false);

  // Composer de broadcast (central → agentes).
  const [broadcastText, setBroadcastText] = useState('');
  const [sending, setSending] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState<string | null>(null);

  // Mídia (fotos) enviadas pelos agentes — com metadata E2EE já decifrada.
  const [mediaMsgs, setMediaMsgs] = useState<DecryptedMedia[]>([]);
  const [docMsgs, setDocMsgs] = useState<DecryptedDoc[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Fase 6b — estatísticas de mídia (views + favoritos) + dedupe de views na sessão.
  const [mediaStats, setMediaStats] = useState<Record<string, MediaStatInfo>>({});
  const viewedRef = useRef<Set<string>>(new Set());
  const docFileRef = useRef<HTMLInputElement>(null); // Fase 6d — upload de documento
  const [docBusy, setDocBusy] = useState(false);

  // Histórico de texto/broadcast (E2EE) decifrado localmente para exibição.
  const [chatMsgs, setChatMsgs] = useState<DecryptedMessage[]>([]);
  // Fase 5c — diretório de chaves (autentica o remetente ao decifrar). Ref para o
  // `refreshMessages` ler sem virar dependência (evita recriação/re-subscribe).
  const [keyDirectory, setKeyDirectory] = useState<KeyDirectoryEntry[]>([]);
  const keyDirectoryRef = useRef<KeyDirectoryEntry[]>([]);
  keyDirectoryRef.current = keyDirectory;

  // Geofencing.
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [alerts, setAlerts] = useState<GeofenceAlert[]>([]);
  const [placing, setPlacing] = useState(false);
  const [pendingCenter, setPendingCenter] = useState<{ lng: number; lat: number } | null>(null);
  const [gfName, setGfName] = useState('');
  const [gfRadius, setGfRadius] = useState('200');
  const [gfColor, setGfColor] = useState('green');
  // Fase 4: forma da nova zona + dimensões do retângulo.
  const [gfShape, setGfShape] = useState<'circle' | 'rectangle'>('circle');
  const [gfWidth, setGfWidth] = useState('300');
  const [gfHeight, setGfHeight] = useState('200');
  const [gfRotation, setGfRotation] = useState('0');
  // Fase 5b — equipes da operação (seletor de zona por equipe) + regras avançadas da nova zona.
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const ADV_DEFAULT: AdvancedZoneValue = {
    teamId: '',
    windowStart: '',
    windowEnd: '',
    trigger: 'both',
    severity: 'medium',
  };
  const [gfAdv, setGfAdv] = useState<AdvancedZoneValue>(ADV_DEFAULT);
  const [editGeo, setEditGeo] = useState<{
    id: string;
    lng: number;
    lat: number;
    radiusMeters: number;
    color: string;
    shape?: string;
    widthMeters?: number;
    heightMeters?: number;
    rotationDeg?: number;
    vertices?: [number, number][];
    adv: AdvancedZoneValue;
  } | null>(null);
  const [alertFocus, setAlertFocus] = useState<AlertFocus | null>(null);
  const [showZones, setShowZones] = useState(true);
  const [recomputing, setRecomputing] = useState(false);

  // Preferências lidas do localStorage (só no cliente — evita mismatch de SSR):
  // pin da barra + cores escolhidas por agente para esta operação.
  useEffect(() => {
    setBarPinned(localStorage.getItem('cerberus_period_pinned') === '1');
    try {
      const raw = localStorage.getItem(colorsKey);
      if (raw) setAgentColorOverrides(JSON.parse(raw) as Record<string, string>);
    } catch {
      /* preferência corrompida — ignora */
    }
  }, [colorsKey]);

  // Layout (abas/split) + largura do chat no split: carrega a preferência e liga o
  // arraste do divisor (mesmo padrão do ResizableSidebar).
  useEffect(() => {
    if (localStorage.getItem('cerberus_live_layout') === 'split') setLayout('split');
    const w = Number(localStorage.getItem('cerberus_live_chatmap_w'));
    if (Number.isFinite(w) && w >= 280 && w <= 900) setChatWidth(w);

    const onMove = (e: MouseEvent) => {
      if (!draggingSplit.current || !splitRootRef.current) return;
      const rect = splitRootRef.current.getBoundingClientRect();
      setChatWidth(Math.min(900, Math.max(280, rect.right - e.clientX)));
    };
    const onUp = () => {
      if (!draggingSplit.current) return;
      draggingSplit.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('cerberus_live_chatmap_w', String(chatWidthRef.current));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Busca o histórico e decifra texto/broadcast localmente (E2EE). A mídia sai do
  // mesmo fetch. Reusado pelo polling e logo após enviar um broadcast.
  const refreshMessages = useCallback(() => {
    api
      .messages(operationId)
      .then((msgs) => {
        const user = getUser();
        const secretKey = user ? getSecretKey(user.id) : null;
        const myId = user?.id ?? '';
        // Decodifica toda a mídia e separa IMAGENS (galeria) de DOCUMENTOS (aba Docs).
        // Documento = envelope com `filename` OU mime não-imagem.
        const mediaDecoded = msgs
          .filter((m) => m.type === 'media' && !!m.mediaRef)
          .map((m) => {
            const sdir = keyDirectoryRef.current.find((e) => e.id === m.senderId);
            const senderKeys = sdir ? [sdir.publicKey, ...(sdir.keyHistory ?? [])] : undefined;
            const meta =
              m.ciphertext && secretKey
                ? parseMediaMeta(openForMe(myId, m.ciphertext, myId, senderKeys))
                : null;
            const mime = meta?.mime ?? 'image/jpeg';
            const crypto = meta?.k && meta?.n ? { k: meta.k, n: meta.n } : null;
            const isDoc = !!meta?.filename || !mime.startsWith('image/');
            return { m, meta, mime, crypto, isDoc };
          });
        setMediaMsgs(
          mediaDecoded
            .filter((d) => !d.isDoc)
            .map(({ m, meta, mime, crypto }) => ({
              id: m.id,
              senderId: m.senderId,
              mediaRef: m.mediaRef as string,
              caption: meta?.caption ?? null,
              lat: meta?.lat,
              lng: meta?.lng,
              mime,
              crypto,
              capturedAt: m.capturedAt,
              teamId: m.teamId,
              recipientId: m.recipientId,
            })),
        );
        setDocMsgs(
          mediaDecoded
            .filter((d) => d.isDoc)
            .map(({ m, meta, mime, crypto }) => ({
              id: m.id,
              senderId: m.senderId,
              mediaRef: m.mediaRef as string,
              filename: meta?.filename ?? `documento-${m.id.slice(-6)}`,
              mime,
              crypto,
              capturedAt: m.capturedAt,
            })),
        );
        setChatMsgs(
          msgs
            .filter((m) => m.type === 'text' || m.type === 'broadcast')
            .map((m) => {
              const sdir = keyDirectoryRef.current.find((e) => e.id === m.senderId);
              const senderKeys = sdir ? [sdir.publicKey, ...(sdir.keyHistory ?? [])] : undefined;
              return {
                id: m.id,
                senderId: m.senderId,
                type: m.type,
                // Envelope E2EE → decifra com a chave local; senão cai no texto legado.
                text:
                  m.ciphertext && secretKey
                    ? openForMe(myId, m.ciphertext, myId, senderKeys)
                    : (m.text ?? null),
                capturedAt: m.capturedAt,
                teamId: m.teamId,
                recipientId: m.recipientId,
              };
            }),
        );
      })
      .catch(() => {});
  }, [operationId]);

  // Fase 5e-1 — ao DESBLOQUEAR a chave, re-decifra o histórico (antes, o painel
  // decifrava com a chave ainda travada e mostrava "não foi possível decifrar").
  useEffect(() => {
    const rerun = () => refreshMessages();
    window.addEventListener(E2EE_UNLOCK_EVENT, rerun);
    return () => window.removeEventListener(E2EE_UNLOCK_EVENT, rerun);
  }, [refreshMessages]);

  // Snapshot inicial (última posição conhecida) via REST + stream ao vivo via MQTT.
  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }

    api
      .settings()
      .then(setSettings)
      .catch(() => {
        /* mantém os padrões */
      });

    api
      .latestPositions(operationId)
      .then((positions: LatestPosition[]) => {
        setAgents((prev) => {
          const next = { ...prev };
          for (const p of positions) {
            next[p.agentId] = {
              agentId: p.agentId,
              lat: p.lat,
              lng: p.lng,
              heading: p.heading,
              battery: p.battery,
              activity: p.activity,
            };
          }
          return next;
        });
      })
      .catch(() => {
        /* sem histórico ainda */
      });

    // Monta as rotas por agente a partir do histórico (segmentadas nos gaps de
    // transmissão) para a lista/seleção de rotas. Re-buscado no polling — assim as
    // posições que um agente transmite AO VIVO viram rotas selecionáveis sem recarregar.
    const loadHistory = () => {
      api
        .positionHistory(operationId, HISTORY_LIMIT)
        .then((positions: LatestPosition[]) => {
          const agentIds = new Set<string>();
          let earliest = Infinity;
          for (const p of positions) {
            if (p.lat == null || p.lng == null) continue;
            agentIds.add(p.agentId);
            const cap = +new Date(p.capturedAt);
            if (cap < earliest) earliest = cap;
          }
          setRawPositions(positions);
          setAgentColorTokens(assignAgentColors([...agentIds]));
          if (Number.isFinite(earliest)) setFirstTs(earliest);
          // Período padrão (definido UMA vez): últimas 24 h ATÉ agora. A ponta direita
          // fica "ao vivo" e o tick acima a mantém no horário atual.
          if (!windowInitRef.current) {
            windowInitRef.current = true;
            const now = Date.now();
            setWindowEndMs(now);
            setWindowStartMs(
              Math.max(Number.isFinite(earliest) ? earliest : -Infinity, now - 24 * HOUR_MS),
            );
          }
        })
        .catch(() => {
          /* sem histórico ainda */
        });
    };

    // Overlays (mensagens/mídia + geofences + alertas + histórico): polling a cada 15s
    // (o painel não assina o canal de broadcast). `refreshMessages` decifra o histórico.
    const loadOverlays = () => {
      refreshMessages();
      loadHistory();
      api
        .geofences(operationId)
        .then(setGeofences)
        .catch(() => {});
      api
        .alerts(operationId)
        .then(setAlerts)
        .catch(() => {});
    };
    void loadOverlays();
    // Equipes da operação (seletor de "zona por equipe") — mudam pouco, busca uma vez.
    api
      .operationTeams(operationId)
      .then(setTeams)
      .catch(() => {});
    // Nomes de exibição (agente/usuário) para o card de mensagens.
    api
      .operationMembers(operationId)
      .then((ms) => {
        const map: Record<string, string> = {};
        for (const m of ms) {
          if (m.agentId) map[m.agentId] = m.name;
          map[m.id] = m.name;
        }
        setMemberNames(map);
      })
      .catch(() => {});
    // Fase 6b — estatísticas de mídia (views + favoritos).
    api
      .mediaStats(operationId)
      .then((list) => {
        const map: Record<string, MediaStatInfo> = {};
        for (const s of list) map[s.mediaId] = s;
        setMediaStats(map);
      })
      .catch(() => {});
    // Fase 5c — diretório de chaves para autenticar remetentes ao decifrar.
    api
      .operationKeys(operationId)
      .then((dir) => {
        setKeyDirectory(dir);
        refreshMessages(); // re-decifra já com verificação de remetente
      })
      .catch(() => {});
    const overlayTimer = setInterval(loadOverlays, 15000);

    const unsubscribe = subscribeToOperation(
      operationId,
      (pos: LivePosition) => {
        setAgents((prev) => ({
          ...prev,
          [pos.agentId]: {
            agentId: pos.agentId,
            lat: pos.lat,
            lng: pos.lng,
            heading: pos.heading,
            battery: pos.battery,
            activity: pos.activity,
          },
        }));
        // Estende a trilha ao vivo do agente (limita o comprimento). Guarda o
        // `capturedAt` para segmentar nos gaps (não ligar por reta o "pulo").
        setLiveTrails((prev) => {
          const cur = prev[pos.agentId] ?? [];
          const next = [...cur, { lng: pos.lng, lat: pos.lat, capturedAt: pos.capturedAt }];
          return {
            ...prev,
            [pos.agentId]: next.length > MAX_LIVE_TRAIL ? next.slice(-MAX_LIVE_TRAIL) : next,
          };
        });
      },
      getToken() ?? undefined,
      setConnected,
      (m: IncomingMessage) => setIncomingChat((prev) => [...prev, m].slice(-300)),
    );

    return () => {
      clearInterval(overlayTimer);
      unsubscribe();
    };
  }, [operationId, router, refreshMessages]);

  // Lista do sidebar: agentes com posição + agentes designados (diretório de chaves)
  // que ainda não transmitiram (aparecem como "aguardando sinal", não selecionáveis).
  const agentList = useMemo<AgentCard[]>(() => {
    const byId = new Map<string, AgentCard>();
    for (const a of Object.values(agents)) byId.set(a.agentId, { ...a, hasSignal: true });
    for (const e of keyDirectory) {
      if (e.role === 'agente' && e.agentId && !byId.has(e.agentId)) {
        byId.set(e.agentId, { agentId: e.agentId, hasSignal: false });
      }
    }
    return [...byId.values()];
  }, [agents, keyDirectory]);

  // Cor efetiva (hex) por agente: override do admin quando houver, senão o token
  // auto-atribuído — resolvida para hex (usada no marcador, na rota e no card).
  const agentColors = useMemo(() => {
    const out: Record<string, string> = {};
    const ids = new Set([...Object.keys(agentColorTokens), ...Object.keys(agentColorOverrides)]);
    for (const id of ids) out[id] = resolveColor(agentColorOverrides[id] ?? agentColorTokens[id]);
    return out;
  }, [agentColorTokens, agentColorOverrides]);

  // Semeia a trilha ao vivo com o histórico recente (uma vez, quando ele carrega):
  // ao abrir a página o caminho recente já aparece e passa a crescer ao vivo.
  useEffect(() => {
    if (seededTrailRef.current || rawPositions.length === 0) return;
    const asc = [...rawPositions].sort((a, b) => +new Date(a.capturedAt) - +new Date(b.capturedAt));
    const byAgent: Record<string, { lng: number; lat: number; capturedAt: string }[]> = {};
    for (const p of asc) {
      if (p.lng == null || p.lat == null) continue;
      (byAgent[p.agentId] ??= []).push({ lng: p.lng, lat: p.lat, capturedAt: p.capturedAt });
    }
    seededTrailRef.current = true;
    setLiveTrails((prev) => {
      const next = { ...prev };
      for (const [id, pts] of Object.entries(byAgent)) {
        const seed = pts.length > MAX_LIVE_TRAIL ? pts.slice(-MAX_LIVE_TRAIL) : pts;
        // História primeiro; preserva o que já chegou ao vivo antes do seed.
        next[id] = [...seed, ...(prev[id] ?? [])];
      }
      return next;
    });
  }, [rawPositions]);

  // Formato do mapa (AgentTrails = LISTA DE SEGMENTOS por agente): a trilha ao vivo
  // é quebrada nos gaps de transmissão (mesmo limiar das rotas) para NÃO ligar por
  // uma reta dois pontos separados por um "pulo" que não aconteceu de verdade.
  const liveTrailsForMap = useMemo<AgentTrails>(() => {
    const gapMs = settings.maxGapMinutes * 60_000;
    const out: AgentTrails = {};
    for (const [id, pts] of Object.entries(liveTrails)) out[id] = splitSegments(pts, gapMs);
    return out;
  }, [liveTrails, settings.maxGapMinutes]);

  // Define a cor (token de família) de um agente e persiste por operação.
  function setAgentColor(agentId: string, token: string) {
    setAgentColorOverrides((prev) => {
      const next = { ...prev, [agentId]: token };
      try {
        localStorage.setItem(colorsKey, JSON.stringify(next));
      } catch {
        /* storage cheio/indisponível — mantém em memória */
      }
      return next;
    });
  }

  // Limites do período ajustável: da 1ª plotagem até "agora".
  const rangeMin = firstTs ?? nowTs - 24 * HOUR_MS;
  const rangeMax = nowTs;
  // Rota dentro do período se SOBREPÕE o intervalo [início, fim].
  const inWindow = (r: Route) => r.end >= windowStartMs && r.start <= windowEndMs;

  // Alertas dentro do Período (mesma janela das rotas). Sem isto, apareciam alertas
  // de cruzamentos fora do período exibido — sem rota correspondente no mapa.
  const periodAlerts = useMemo(
    () =>
      alerts
        .filter((a) => {
          const t = +new Date(a.capturedAt);
          return t >= windowStartMs && t <= windowEndMs;
        })
        // Fase 5b — mais severos primeiro; empate = mais recente primeiro.
        .sort((x, y) => {
          const r =
            (GEOFENCE_SEVERITY_RANK[x.severity ?? 'medium'] ?? 2) -
            (GEOFENCE_SEVERITY_RANK[y.severity ?? 'medium'] ?? 2);
          return r !== 0 ? r : +new Date(y.capturedAt) - +new Date(x.capturedAt);
        }),
    [alerts, windowStartMs, windowEndMs],
  );

  // Rotas por agente, segmentadas nos gaps (limiar configurável em Configurações).
  const routes = useMemo(
    () => buildRoutes(rawPositions, settings.maxGapMinutes * 60_000),
    [rawPositions, settings.maxGapMinutes],
  );

  // Rotas exibíveis: descarta as com menos de `minRoutePoints` pontos (trechos
  // insignificantes que só poluem a lista). É a base para cards, lista e plotagem.
  const visibleRoutes = useMemo(() => {
    const out: Record<string, Route[]> = {};
    for (const [agentId, rs] of Object.entries(routes)) {
      out[agentId] = rs.filter((r) => r.points.length >= settings.minRoutePoints);
    }
    return out;
  }, [routes, settings.minRoutePoints]);

  // Marca os agentes por padrão: seleciona TODAS as rotas visíveis na primeira carga
  // (uma vez). A partir daí, respeita as escolhas do operador (marcar/desmarcar).
  useEffect(() => {
    if (seededSelectionRef.current) return;
    const allIds = Object.values(visibleRoutes).flatMap((rs) => rs.map((r) => r.id));
    if (allIds.length === 0) return;
    seededSelectionRef.current = true;
    setSelectedRouteIds(new Set(allIds));
  }, [visibleRoutes]);

  // Rotas efetivamente plotadas: selecionadas E dentro do período. Com a opção
  // "ligar rotas", adiciona conectores tracejados entre rotas consecutivas.
  const plottedRoutes = useMemo<PlottedRoute[]>(() => {
    const out: PlottedRoute[] = [];
    for (const [agentId, rs] of Object.entries(visibleRoutes)) {
      const color = agentColors[agentId] ?? '#c1121f';
      const shown = rs
        .filter(
          (r) => selectedRouteIds.has(r.id) && r.end >= windowStartMs && r.start <= windowEndMs,
        )
        .sort((a, b) => a.start - b.start);
      for (const r of shown) out.push({ id: r.id, points: r.points, color });
      if (settings.connectRoutes) {
        for (let i = 0; i + 1 < shown.length; i++) {
          const from = shown[i].points[shown[i].points.length - 1];
          const to = shown[i + 1].points[0];
          if (from && to) {
            out.push({
              id: `${shown[i].id}~${shown[i + 1].id}`,
              points: [from, to],
              color,
              dashed: true,
            });
          }
        }
      }
    }
    return out;
  }, [
    visibleRoutes,
    agentColors,
    selectedRouteIds,
    windowStartMs,
    windowEndMs,
    settings.connectRoutes,
  ]);

  function toggleRoute(id: string) {
    setSelectedRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Seleciona/limpa todas as rotas do agente que caem no período atual.
  function toggleAgentRoutes(agentId: string) {
    const routesInWindow = (visibleRoutes[agentId] ?? []).filter(inWindow);
    const allSel =
      routesInWindow.length > 0 && routesInWindow.every((r) => selectedRouteIds.has(r.id));
    setSelectedRouteIds((prev) => {
      const next = new Set(prev);
      for (const r of routesInWindow) {
        if (allSel) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  }

  const mediaMarkers = useMemo(
    () =>
      mediaMsgs
        .filter((m) => m.lat != null && m.lng != null)
        .map((m) => ({
          id: m.id,
          lat: m.lat as number,
          lng: m.lng as number,
          senderId: m.senderId,
          caption: m.caption ?? undefined,
        })),
    [mediaMsgs],
  );

  // Zonas exibidas no mapa: cor resolvida (familia->hex), valores ao vivo da zona
  // em edicao e preview da nova zona (com a cor escolhida).
  const displayGeofences = useMemo<GeofenceCircle[]>(() => {
    const base: GeofenceCircle[] = geofences.map((g) => {
      const e = editGeo?.id === g.id ? editGeo : null;
      return {
        id: g.id,
        name: g.name,
        shape: e ? (e.shape ?? g.shape) : g.shape,
        lng: e ? e.lng : g.lng,
        lat: e ? e.lat : g.lat,
        radiusMeters: e ? e.radiusMeters : g.radiusMeters,
        widthMeters: e ? e.widthMeters : g.widthMeters,
        heightMeters: e ? e.heightMeters : g.heightMeters,
        rotationDeg: e ? e.rotationDeg : g.rotationDeg,
        vertices: e ? e.vertices : g.vertices,
        color: resolveColor(e ? e.color : g.color),
      };
    });
    if (!pendingCenter) return base;
    // Preview da nova zona (com a forma/cor escolhidas).
    const num = (s: string, fallback: number) => {
      const v = Number(s);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const preview: GeofenceCircle =
      gfShape === 'rectangle'
        ? {
            id: '__preview__',
            name: '(nova zona)',
            shape: 'rectangle',
            lng: pendingCenter.lng,
            lat: pendingCenter.lat,
            widthMeters: num(gfWidth, 300),
            heightMeters: num(gfHeight, 200),
            rotationDeg: Number(gfRotation) || 0,
            color: resolveColor(gfColor),
          }
        : {
            id: '__preview__',
            name: '(nova zona)',
            shape: 'circle',
            lng: pendingCenter.lng,
            lat: pendingCenter.lat,
            radiusMeters: num(gfRadius, 100),
            color: resolveColor(gfColor),
          };
    return [...base, preview];
  }, [geofences, pendingCenter, gfShape, gfRadius, gfWidth, gfHeight, gfRotation, gfColor, editGeo]);

  async function sendBroadcast() {
    const text = broadcastText.trim();
    if (!text) return;
    setSending(true);
    setBroadcastMsg(null);
    try {
      // E2EE: cifra o broadcast localmente (envelope por destinatário) usando o
      // diretório de chaves da operação. O servidor só recebe o ciphertext.
      const user = getUser();
      const secretKey = user ? getSecretKey(user.id) : null;
      if (!user || !secretKey) {
        setBroadcastMsg('Chave E2EE ausente — refaça o login para provisioná-la.');
        return;
      }
      const directory = await api.operationKeys(operationId);
      if (!directory.some((e) => e.role === 'agente')) {
        setBroadcastMsg('Nenhum agente com chave E2EE registrada ainda.');
        return;
      }
      const recipients = directory
        .filter((e) => !e.revoked) // Fase 5e-2 — não selar para chaves revogadas
        .map((e) => ({ id: e.id, publicKey: e.publicKey }));
      const ciphertext = sealMessage(text, secretKey, recipients);
      await api.broadcast(operationId, ciphertext);
      setBroadcastText('');
      setBroadcastMsg('Broadcast cifrado enviado ✓');
      refreshMessages(); // reflete no histórico imediatamente (sem esperar o poll)
    } catch (e) {
      setBroadcastMsg(e instanceof Error ? e.message : 'Falha ao enviar');
    } finally {
      setSending(false);
    }
  }

  // Fase 5b — converte os controles avançados (hora local → minuto UTC) p/ o corpo da API.
  function advToInput(adv: AdvancedZoneValue): Partial<GeofenceInput> {
    return {
      teamId: adv.teamId || null,
      windowStartMin: localTimeToUtcMin(adv.windowStart),
      windowEndMin: localTimeToUtcMin(adv.windowEnd),
      triggerOn: adv.trigger,
      severity: adv.severity,
    };
  }

  async function handleCreateGeofence() {
    if (!pendingCenter || !gfName.trim()) return;
    const commonBase = {
      name: gfName.trim(),
      lng: pendingCenter.lng,
      lat: pendingCenter.lat,
      color: gfColor,
      ...advToInput(gfAdv),
    };
    let data;
    if (gfShape === 'rectangle') {
      const w = Number(gfWidth);
      const h = Number(gfHeight);
      if (!Number.isFinite(w) || w < 1 || !Number.isFinite(h) || h < 1) return;
      data = { ...commonBase, shape: 'rectangle' as const, widthMeters: w, heightMeters: h, rotationDeg: Number(gfRotation) || 0 };
    } else {
      const radius = Number(gfRadius);
      if (!Number.isFinite(radius) || radius < 1) return;
      data = { ...commonBase, shape: 'circle' as const, radiusMeters: radius };
    }
    try {
      await api.createGeofence(operationId, data);
      setPendingCenter(null);
      setPlacing(false);
      setGfName('');
      setGfAdv(ADV_DEFAULT);
      setGeofences(await api.geofences(operationId));
    } catch {
      /* criação falhou (ex.: sem permissão) */
    }
  }

  async function handleDeleteGeofence(gid: string) {
    try {
      await api.deleteGeofence(operationId, gid);
      setGeofences((prev) => prev.filter((g) => g.id !== gid));
      if (editGeo?.id === gid) setEditGeo(null);
    } catch {
      /* remoção falhou */
    }
  }

  function startEdit(g: Geofence) {
    setPlacing(false);
    setPendingCenter(null);
    setEditGeo({
      id: g.id,
      lng: g.lng ?? 0,
      lat: g.lat ?? 0,
      radiusMeters: g.radiusMeters ?? 0,
      color: g.color,
      shape: g.shape,
      widthMeters: g.widthMeters,
      heightMeters: g.heightMeters,
      rotationDeg: g.rotationDeg,
      vertices: g.vertices,
      adv: {
        teamId: g.teamId ?? '',
        windowStart: utcMinToLocalTime(g.windowStartMin),
        windowEnd: utcMinToLocalTime(g.windowEndMin),
        trigger: g.triggerOn ?? 'both',
        severity: g.severity ?? 'medium',
      },
    });
  }

  async function saveEdit() {
    if (!editGeo) return;
    try {
      // `shape` SEMPRE explícito: converter círculo→polígono muda a forma, e sem
      // mandar `shape` o PATCH grava os vértices mas mantém o shape antigo (a zona
      // volta a renderizar como círculo).
      const geoData: GeofenceInput =
        editGeo.shape === 'rectangle'
          ? {
              shape: 'rectangle',
              lng: editGeo.lng,
              lat: editGeo.lat,
              widthMeters: editGeo.widthMeters,
              heightMeters: editGeo.heightMeters,
              rotationDeg: editGeo.rotationDeg,
              color: editGeo.color,
            }
          : editGeo.shape === 'polygon'
            ? { shape: 'polygon', vertices: editGeo.vertices, color: editGeo.color }
            : {
                shape: 'circle',
                lng: editGeo.lng,
                lat: editGeo.lat,
                radiusMeters: editGeo.radiusMeters,
                color: editGeo.color,
              };
      // Fase 5b — regras avançadas junto (equipe/agendamento/gatilho/severidade).
      await api.patchGeofence(operationId, editGeo.id, { ...geoData, ...advToInput(editGeo.adv) });
      setGeofences(await api.geofences(operationId));
    } catch {
      /* edição falhou */
    }
    setEditGeo(null);
  }

  /**
   * Converte a zona em edição (círculo/retângulo) em POLÍGONO livre, semeando os
   * vértices a partir da forma atual (círculo → 16 pontos do anel; retângulo → 4
   * cantos). A partir daí os vértices ficam arrastáveis no mapa (handles do LiveMap).
   */
  function convertToPolygon() {
    setEditGeo((g) => {
      if (!g || g.shape === 'polygon') return g;
      const closed =
        g.shape === 'rectangle'
          ? rectangleRing(g.lng, g.lat, g.widthMeters ?? 100, g.heightMeters ?? 100, g.rotationDeg ?? 0)
          : circleRing(g.lng, g.lat, g.radiusMeters || 100, 16);
      // Anel fechado (último = primeiro) → vértices abertos.
      const vertices = closed.slice(0, -1).map((p): [number, number] => [p[0] ?? 0, p[1] ?? 0]);
      return { ...g, shape: 'polygon', vertices };
    });
  }

  // Clique numa mensagem do card → abre a conversa correspondente no Chat.
  function openInChat(m: { senderId: string; teamId?: string; recipientId?: string }) {
    const me = getUser()?.id;
    const key = m.teamId
      ? `team:${m.teamId}`
      : m.recipientId
        ? `dm:${m.recipientId}`
        : m.senderId && m.senderId !== me
          ? `dm:${m.senderId}`
          : null;
    if (!key) return;
    setMainTab('chat');
    setChatFocus((prev) => ({ key, nonce: prev.nonce + 1 }));
  }

  // Nome de exibição do remetente (broadcast = Central; senão nome do membro / id).
  const nameFor = (senderId: string, type?: string): string =>
    type === 'broadcast' ? 'Central' : (memberNames[senderId] ?? senderId);

  // Ícone por tipo de documento (Fase 6d) — Lucide colorido por família de arquivo.
  const docIcon = (mime: string): ReactElement => {
    const s = 22;
    if (mime.includes('pdf')) return <FileText size={s} color="#e5534b" aria-hidden />;
    if (mime.includes('word') || mime.includes('document'))
      return <FileText size={s} color="#539bf5" aria-hidden />;
    if (mime.includes('sheet') || mime.includes('excel') || mime.includes('csv'))
      return <FileSpreadsheet size={s} color="#3fb950" aria-hidden />;
    if (mime.includes('zip') || mime.includes('compress'))
      return <FileArchive size={s} color="#c9a227" aria-hidden />;
    return <FileIcon size={s} color="var(--muted)" aria-hidden />;
  };

  // Fase 6b — conta a visualização (uma vez por mídia na sessão) e atualiza o total.
  async function handleViewMedia(item: { id: string }) {
    if (viewedRef.current.has(item.id)) return;
    viewedRef.current.add(item.id);
    try {
      const { views } = await api.viewMedia(operationId, item.id);
      setMediaStats((s) => ({
        ...s,
        [item.id]: {
          mediaId: item.id,
          views,
          favorites: s[item.id]?.favorites ?? 0,
          favorited: s[item.id]?.favorited ?? false,
        },
      }));
    } catch {
      /* ignora */
    }
  }

  // Fase 6d — envia um DOCUMENTO (qualquer arquivo) E2EE, selado a todos os membros.
  async function uploadDoc(file: File) {
    const u = getUser();
    const secretKey = u ? getSecretKey(u.id) : null;
    if (!secretKey) return;
    const recipients = keyDirectory
      .filter((e) => !e.revoked) // Fase 5e-2 — não selar para chaves revogadas
      .map((e) => ({ id: e.id, publicKey: e.publicKey }));
    if (recipients.length === 0) return;
    setDocBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { cipher, key, nonce } = encryptBytes(bytes);
      const envelope = sealMessage(
        JSON.stringify({
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          k: key,
          n: nonce,
        }),
        secretKey,
        recipients,
      );
      const blobBuf = cipher.buffer.slice(
        cipher.byteOffset,
        cipher.byteOffset + cipher.byteLength,
      ) as ArrayBuffer;
      const form = new FormData();
      form.append('ciphertext', envelope);
      form.append('file', new Blob([blobBuf], { type: 'application/octet-stream' }), 'doc.bin');
      const resp = await api.uploadMedia(operationId, form);
      if (resp.mediaRef) void putCachedCiphertext(api.mediaPath(operationId, resp.mediaRef), cipher);
      refreshMessages();
    } catch {
      /* upload falhou */
    } finally {
      setDocBusy(false);
    }
  }

  // Fase 6d — baixa e decifra um documento, salvando com o nome original.
  async function downloadDoc(doc: DecryptedDoc) {
    if (!doc.crypto) return;
    try {
      const bytes = await loadDecryptedBytes(
        api.mediaPath(operationId, doc.mediaRef),
        doc.crypto.k,
        doc.crypto.n,
      );
      const url = bytesToObjectUrl(bytes, doc.mime);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      /* download falhou */
    }
  }

  // Fase 6b — alterna o favorito da mídia.
  async function handleToggleFav(item: { id: string }) {
    try {
      const { favorited, favorites } = await api.toggleFavoriteMedia(operationId, item.id);
      setMediaStats((s) => ({
        ...s,
        [item.id]: { mediaId: item.id, views: s[item.id]?.views ?? 0, favorites, favorited },
      }));
    } catch {
      /* ignora */
    }
  }

  // Feed unificado do card: texto/broadcast + fotos, mais recentes primeiro.
  const cardMsgs = useMemo<CardMsg[]>(() => {
    const texts: CardMsg[] = chatMsgs.map((m) => ({ ...m }));
    const media: CardMsg[] = mediaMsgs.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      type: 'media',
      text: m.caption ?? null,
      capturedAt: m.capturedAt,
      teamId: m.teamId,
      recipientId: m.recipientId,
      mediaRef: m.mediaRef,
      mime: m.mime,
      crypto: m.crypto,
      caption: m.caption,
    }));
    return [...texts, ...media].sort(
      (a, b) => +new Date(b.capturedAt) - +new Date(a.capturedAt),
    );
  }, [chatMsgs, mediaMsgs]);

  // Feed da central de notificações: avatar do remetente + título na COR DA TRILHA do
  // agente + prévia, agrupado por Equipe (mensagens sem equipe → "Direto").
  const notifItems = useMemo<NotifItem[]>(
    () =>
      cardMsgs.map((m) => {
        const isBroadcast = m.type === 'broadcast';
        const teamName = m.teamId ? teams.find((t) => t.id === m.teamId)?.name : undefined;
        return {
          id: m.id,
          senderName: isBroadcast ? 'Central' : (memberNames[m.senderId] ?? m.senderId),
          // Cor da trilha do agente; Central/broadcast (sem trilha) usa o vermelho institucional.
          color: isBroadcast ? 'var(--accent)' : (agentColors[m.senderId] ?? 'var(--accent)'),
          isMedia: m.type === 'media',
          preview: m.type === 'media' ? (m.caption || 'Foto') : (m.text ?? 'cifrada'),
          capturedAt: m.capturedAt,
          group: teamName ? `Equipe ${teamName}` : 'Direto',
        };
      }),
    [cardMsgs, teams, agentColors, memberNames],
  );

  async function handleRecompute() {
    setRecomputing(true);
    try {
      await api.recomputeAlerts(operationId);
      setAlerts(await api.alerts(operationId));
    } catch {
      /* recálculo falhou */
    }
    setRecomputing(false);
  }

  // Só admin edita as Configurações do sistema (o backend também impõe 403); os
  // controles de exibição (camadas) valem para qualquer operador.
  const isAdmin = getUser()?.role === 'admin';

  const gfInputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg, #0b0f14)',
    color: 'var(--text, #e6edf3)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link href="/operations" className="badge">
            ← Operações
          </Link>
          <div className="brand">
            <span className="brand-dot" />
            Monitoramento ao vivo
          </div>
          <Link href={`/operations/${operationId}/replay`} className="badge">
            Replay ↺
          </Link>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="badge"
            title="Configurações do sistema"
            style={{
              cursor: 'pointer',
              border: '1px solid var(--border)',
              background: 'transparent',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <SettingsIcon size={15} aria-hidden /> Configurações
            </span>
          </button>
          <span className="badge" style={{ color: connected ? 'var(--ok)' : 'var(--muted)' }}>
            {connected ? '● barramento conectado' : '○ aguardando telemetria'}
          </span>
          <NotificationCenter
            items={notifItems}
            storageKey={`cerberus_notif_seen:${operationId}`}
            onOpen={(id) => {
              const m = cardMsgs.find((x) => x.id === id);
              if (m) openInChat(m);
            }}
          />
          <UserMenu onSettings={() => setSettingsOpen(true)} />
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ResizableSidebar storageKey="cerberus_live_sidebar_w" defaultWidth={260}>
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <strong style={{ fontSize: 14 }}>Broadcast à operação</strong>
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
              Diretiva da central para todos os agentes.
            </p>
            <textarea
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              placeholder="Ex.: Recolher ao ponto de encontro."
              rows={3}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void sendBroadcast();
              }}
              style={{
                width: '100%',
                resize: 'vertical',
                background: 'var(--bg, #0b0f14)',
                color: 'var(--text, #e6edf3)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 8,
                fontSize: 13,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <button
              type="button"
              onClick={() => void sendBroadcast()}
              disabled={sending || !broadcastText.trim()}
              style={{
                marginTop: 8,
                width: '100%',
                padding: '8px 0',
                borderRadius: 8,
                border: 'none',
                background: '#c1121f',
                color: '#fff',
                fontWeight: 700,
                cursor: sending || !broadcastText.trim() ? 'not-allowed' : 'pointer',
                opacity: sending || !broadcastText.trim() ? 0.5 : 1,
              }}
            >
              {sending ? 'Enviando…' : 'Enviar broadcast'}
            </button>
            {broadcastMsg && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {broadcastMsg}
              </div>
            )}
          </div>

          {mediaMsgs.length > 0 && (
            <div className="card" style={{ padding: 12, marginBottom: 16 }}>
              <strong style={{ fontSize: 14 }}>Mídias da operação ({mediaMsgs.length})</strong>
              {/* Masonry (colunas CSS): as fotos mantêm o aspecto natural e não
                  deformam. `column-width: 32px` mantém as miniaturas bem pequenas
                  (o nº de colunas se adapta à largura do sidebar). */}
              <div style={{ columns: '32px', columnGap: 4, marginTop: 8 }}>
                {mediaMsgs.map((m, i) => (
                  <div key={m.id} style={{ breakInside: 'avoid', marginBottom: 4 }}>
                    <AuthImage
                      path={api.mediaPath(operationId, m.mediaRef)}
                      mediaKey={m.crypto}
                      mime={m.mime}
                      alt={`Mídia de ${nameFor(m.senderId)}`}
                      onClick={() => setLightboxIndex(i)}
                      style={{
                        width: '100%',
                        height: 'auto',
                        display: 'block',
                        borderRadius: 3,
                        background: 'var(--border)',
                        cursor: 'pointer',
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <strong style={{ fontSize: 14 }}>Zonas ({geofences.length})</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => {
                    setPlacing((p) => !p);
                    setPendingCenter(null);
                  }}
                  className="badge"
                  style={{
                    cursor: 'pointer',
                    border: '1px solid var(--border)',
                    background: placing ? '#3fb950' : 'transparent',
                    color: placing ? '#0b0f14' : 'var(--muted)',
                  }}
                >
                  {placing ? 'clique no mapa…' : '+ Nova'}
                </button>
              </div>
            </div>
            {pendingCenter && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  value={gfName}
                  onChange={(e) => setGfName(e.target.value)}
                  placeholder="Nome da zona"
                  style={gfInputStyle}
                />
                {/* Seletor de forma (Fase 4). */}
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['circle', 'rectangle'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setGfShape(s)}
                      className="badge"
                      style={{
                        flex: 1,
                        cursor: 'pointer',
                        border: '1px solid var(--border)',
                        color: 'var(--text)',
                        background: gfShape === s ? 'var(--panel-2)' : 'transparent',
                        borderColor: gfShape === s ? 'var(--accent)' : 'var(--border)',
                      }}
                    >
                      {s === 'circle' ? '● Círculo' : '▭ Retângulo'}
                    </button>
                  ))}
                </div>
                {gfShape === 'circle' ? (
                  <input
                    type="number"
                    value={gfRadius}
                    onChange={(e) => setGfRadius(e.target.value)}
                    placeholder="Raio (m)"
                    style={gfInputStyle}
                  />
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      value={gfWidth}
                      onChange={(e) => setGfWidth(e.target.value)}
                      placeholder="Largura (m)"
                      style={gfInputStyle}
                    />
                    <input
                      type="number"
                      value={gfHeight}
                      onChange={(e) => setGfHeight(e.target.value)}
                      placeholder="Altura (m)"
                      style={gfInputStyle}
                    />
                    <input
                      type="number"
                      value={gfRotation}
                      onChange={(e) => setGfRotation(e.target.value)}
                      placeholder="Rot (°)"
                      style={{ ...gfInputStyle, maxWidth: 72 }}
                    />
                  </div>
                )}
                <ColorPalettePicker value={gfColor} onChange={setGfColor} />
                <AdvancedZoneFields teams={teams} value={gfAdv} onChange={setGfAdv} />
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={handleCreateGeofence}
                    disabled={!gfName.trim()}
                    title={!gfName.trim() ? 'Informe um nome para a zona' : 'Criar zona'}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 6,
                      border: 'none',
                      background: '#3fb950',
                      color: '#0b0f14',
                      fontWeight: 700,
                      cursor: gfName.trim() ? 'pointer' : 'not-allowed',
                      opacity: gfName.trim() ? 1 : 0.5,
                    }}
                  >
                    Criar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingCenter(null);
                      setPlacing(false);
                    }}
                    className="badge"
                    style={{
                      cursor: 'pointer',
                      border: '1px solid var(--border)',
                      background: 'transparent',
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
            {geofences.map((g) => (
              <div
                key={g.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 8,
                  fontSize: 13,
                }}
              >
                <span style={{ color: editGeo?.id === g.id ? 'var(--ok)' : undefined }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: resolveColor(editGeo?.id === g.id ? editGeo.color : g.color),
                      marginRight: 6,
                      verticalAlign: 'middle',
                    }}
                  />
                  {g.name} ·{' '}
                  {g.shape === 'rectangle'
                    ? `▭ ${g.widthMeters ?? '—'}×${g.heightMeters ?? '—'} m`
                    : g.shape === 'polygon'
                      ? `⬡ ${g.vertices?.length ?? 0} vértices`
                      : `● ${editGeo?.id === g.id ? editGeo.radiusMeters : g.radiusMeters} m`}
                </span>
                <span style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => startEdit(g)}
                    title="Editar (mover/redimensionar)"
                    style={{
                      cursor: 'pointer',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--muted)',
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteGeofence(g.id)}
                    title="Remover"
                    style={{
                      cursor: 'pointer',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--muted)',
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
            {editGeo && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                {editGeo.shape === 'rectangle' ? (
                  <>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Arraste o <strong>centro</strong> para mover. Ajuste largura/altura/rotação:
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <input
                        type="number"
                        value={editGeo.widthMeters ?? ''}
                        onChange={(e) =>
                          setEditGeo((g) => (g ? { ...g, widthMeters: Number(e.target.value) } : g))
                        }
                        placeholder="Largura (m)"
                        style={gfInputStyle}
                      />
                      <input
                        type="number"
                        value={editGeo.heightMeters ?? ''}
                        onChange={(e) =>
                          setEditGeo((g) => (g ? { ...g, heightMeters: Number(e.target.value) } : g))
                        }
                        placeholder="Altura (m)"
                        style={gfInputStyle}
                      />
                      <input
                        type="number"
                        value={editGeo.rotationDeg ?? 0}
                        onChange={(e) =>
                          setEditGeo((g) => (g ? { ...g, rotationDeg: Number(e.target.value) } : g))
                        }
                        placeholder="Rot (°)"
                        style={{ ...gfInputStyle, maxWidth: 72 }}
                      />
                    </div>
                  </>
                ) : editGeo.shape === 'polygon' ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    Arraste os <strong>vértices</strong> ({editGeo.vertices?.length ?? 0}). Clique num
                    ponto <strong>+</strong> na aresta para adicionar; <strong>duplo-clique</strong>{' '}
                    num vértice para remover (mín. 3).
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12 }}>
                    Arraste o <strong>centro</strong> (mover) ou a <strong>borda</strong>{' '}
                    (redimensionar). Raio: {editGeo.radiusMeters} m
                  </div>
                )}
                {editGeo.shape !== 'polygon' && (
                  <button
                    type="button"
                    onClick={convertToPolygon}
                    className="badge"
                    title="Transforma esta zona num polígono de vértices arrastáveis"
                    style={{
                      marginTop: 8,
                      width: '100%',
                      cursor: 'pointer',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      background: 'transparent',
                    }}
                  >
                    ⬡ Converter em polígono livre
                  </button>
                )}
                <div style={{ marginTop: 8 }}>
                  <ColorPalettePicker
                    value={editGeo.color}
                    onChange={(c) => setEditGeo((e) => (e ? { ...e, color: c } : e))}
                  />
                </div>
                <AdvancedZoneFields
                  teams={teams}
                  value={editGeo.adv}
                  onChange={(adv) => setEditGeo((e) => (e ? { ...e, adv } : e))}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={saveEdit}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 6,
                      border: 'none',
                      background: '#3fb950',
                      color: '#0b0f14',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Salvar
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditGeo(null)}
                    className="badge"
                    style={{
                      cursor: 'pointer',
                      border: '1px solid var(--border)',
                      background: 'transparent',
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={handleRecompute}
              disabled={recomputing}
              title="Reprocessa o histórico de posições e regenera os alertas de entrada/saída"
              className="badge"
              style={{
                marginTop: 10,
                width: '100%',
                cursor: recomputing ? 'wait' : 'pointer',
                border: '1px solid var(--border)',
                background: 'transparent',
              }}
            >
              {recomputing ? 'Recalculando…' : '↻ Recalcular alertas do histórico'}
            </button>
          </div>

          {periodAlerts.length > 0 && (
            <div className="card" style={{ padding: 12, marginBottom: 16 }}>
              <strong style={{ fontSize: 14 }}>Alertas ({periodAlerts.length})</strong>
              <div
                className="thinscroll"
                style={{ maxHeight: 220, overflowY: 'auto', marginTop: 4 }}
              >
                {periodAlerts.map((a) => {
                  const hasLoc = a.lng != null && a.lat != null;
                  return (
                    <div
                      key={a.id}
                      className="muted"
                      onClick={() => {
                        if (a.lng == null || a.lat == null) return;
                        const zone = geofences.find((g) => g.id === a.geofenceId);
                        // Direção da seta = sentido do deslocamento na rota no cruzamento
                        // (não o raio da zona). Fallback: radial, se a rota não for achada.
                        const travel = routeBearingAt(
                          (routes[a.agentId] ?? []).map((r) => r.points),
                          [a.lng, a.lat],
                        );
                        if (
                          zone &&
                          zone.lng != null &&
                          zone.lat != null &&
                          zone.radiusMeters != null
                        ) {
                          // Foco na borda: só círculo (usa raio). Outras formas caem no ponto.
                          const f = alertBorderFocus(
                            [a.lng, a.lat],
                            [zone.lng, zone.lat],
                            zone.radiusMeters,
                            a.type,
                          );
                          setAlertFocus(travel != null ? { ...f, bearing: travel } : f);
                        } else {
                          setAlertFocus({
                            lng: a.lng,
                            lat: a.lat,
                            bearing: travel ?? 0,
                            type: a.type,
                          });
                        }
                      }}
                      title={hasLoc ? 'Ver no mapa' : undefined}
                      style={{
                        fontSize: 13,
                        marginTop: 6,
                        cursor: hasLoc ? 'pointer' : 'default',
                      }}
                    >
                      <span style={{ color: a.type === 'enter' ? 'var(--ok)' : '#e3b341' }}>
                        {a.type === 'enter' ? '⊕' : '⊖'}
                      </span>{' '}
                      {a.agentId} {a.type === 'enter' ? 'entrou em' : 'saiu de'}{' '}
                      <strong>{a.geofenceName}</strong>
                      <span
                        title={`Severidade: ${SEVERITY_LABEL[a.severity ?? 'medium'] ?? a.severity}`}
                        style={{
                          display: 'inline-block',
                          marginLeft: 6,
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          verticalAlign: 'middle',
                          background: SEVERITY_COLOR[a.severity ?? 'medium'] ?? '#8b9aa8',
                          boxShadow: a.severity === 'critical' ? '0 0 6px #c1121f' : 'none',
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              marginTop: 0,
            }}
          >
            <h3 style={{ margin: 0 }}>Agentes ({agentList.length})</h3>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '8px 0' }}>
            A <strong>trilha ao vivo</strong> (cor do agente) cresce em tempo real durante o
            deslocamento. As <strong>rotas</strong> abaixo são o histórico — selecione-as e ajuste o
            período na barra do topo do mapa.
          </p>
          {agentList.length === 0 && (
            <p className="muted" style={{ fontSize: 14 }}>
              Nenhuma posição recebida. Simule com o publish-fake-position.
            </p>
          )}
          {agentList.map((a) => {
            const color = agentColors[a.agentId] ?? '#c1121f';
            const agentRoutes = visibleRoutes[a.agentId] ?? [];
            const routesInWindow = agentRoutes.filter(inWindow);
            const selCount = routesInWindow.filter((r) => selectedRouteIds.has(r.id)).length;
            const allSel = routesInWindow.length > 0 && selCount === routesInWindow.length;
            const anySel = selCount > 0;
            const expanded = expandedAgent === a.agentId;
            return (
              <div key={a.agentId}>
                <div
                  className="card"
                  style={{
                    padding: 12,
                    marginBottom: expanded ? 0 : 10,
                    borderLeft: `3px solid ${color}`,
                    boxShadow: anySel ? `0 0 0 1px ${color}` : undefined,
                    opacity: a.hasSignal ? 1 : 0.6, // designado mas sem sinal ainda
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => toggleAgentRoutes(a.agentId)}
                      disabled={routesInWindow.length === 0}
                      title={
                        routesInWindow.length === 0
                          ? 'Sem rotas no período atual'
                          : allSel
                            ? 'Ocultar as rotas deste agente'
                            : 'Plotar as rotas deste agente'
                      }
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        border: `2px solid ${color}`,
                        background: allSel ? color : anySel ? `${color}80` : 'transparent',
                        cursor: routesInWindow.length === 0 ? 'not-allowed' : 'pointer',
                        flexShrink: 0,
                        padding: 0,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setExpandedAgent(expanded ? null : a.agentId)}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        background: 'transparent',
                        border: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                        padding: 0,
                        textAlign: 'left',
                        font: 'inherit',
                      }}
                    >
                      <strong>{a.agentId}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {agentRoutes.length} rota{agentRoutes.length === 1 ? '' : 's'}
                      </span>
                      <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                        {expanded ? '▾' : '▸'}
                      </span>
                    </button>
                  </div>
                  {a.hasSignal ? (
                    <>
                      <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                        {a.lat.toFixed(5)}, {a.lng.toFixed(5)}
                      </div>
                      <div className="muted" style={{ fontSize: 13 }}>
                        bateria: {a.battery != null ? Math.round(a.battery * 100) + '%' : '—'} ·{' '}
                        {a.activity ?? '—'}
                      </div>
                    </>
                  ) : (
                    <div
                      className="muted"
                      style={{ fontSize: 13, marginTop: 6, fontStyle: 'italic' }}
                    >
                      aguardando sinal…
                    </div>
                  )}
                </div>
                {expanded && (
                  <div
                    className="card"
                    style={{
                      padding: 10,
                      margin: '0 0 10px',
                      borderLeft: `3px solid ${color}`,
                      background: 'var(--bg)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 10,
                        paddingBottom: 10,
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Cor do agente</span>
                      <ColorPalettePicker
                        value={
                          agentColorOverrides[a.agentId] ?? agentColorTokens[a.agentId] ?? 'blue'
                        }
                        onChange={(token) => setAgentColor(a.agentId, token)}
                      />
                    </div>
                    {agentRoutes.length === 0 && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        Nenhuma rota registrada para este agente.
                      </div>
                    )}
                    {agentRoutes.map((r, i) => {
                      const outWin = !inWindow(r);
                      const sel = selectedRouteIds.has(r.id);
                      return (
                        <label
                          key={r.id}
                          title={
                            outWin ? 'Fora do período atual' : 'Exibir/ocultar esta rota no mapa'
                          }
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 12,
                            padding: '4px 0',
                            opacity: outWin ? 0.45 : 1,
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={sel}
                            onChange={() => toggleRoute(r.id)}
                            style={{ accentColor: color, flexShrink: 0 }}
                          />
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {fmtDateTime(r.start)} → {fmtDateTime(r.end)}
                          </span>
                          <span className="muted" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                            #{i + 1} · {r.points.length}p
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </ResizableSidebar>

        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Abas Mapa | Chat (Fase 3a). O mapa fica montado (display:none) para não
              perder estado/marcadores ao alternar. */}
          <div
            style={{
              display: 'flex',
              gap: 6,
              padding: '6px 8px',
              borderBottom: '1px solid var(--border)',
              alignItems: 'center',
            }}
          >
            {layout === 'tabs' &&
              (['map', 'chat', 'gallery', 'docs'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setMainTab(tab)}
                  className="badge"
                  style={{
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    background: mainTab === tab ? 'var(--panel-2)' : 'transparent',
                    borderColor: mainTab === tab ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  {tab === 'map' ? (
                    <>
                      <MapIcon size={15} aria-hidden /> Mapa
                    </>
                  ) : tab === 'chat' ? (
                    <>
                      <MessageSquare size={15} aria-hidden /> Chat
                    </>
                  ) : tab === 'gallery' ? (
                    <>
                      <Images size={15} aria-hidden /> Galeria
                    </>
                  ) : (
                    <>
                      <FileText size={15} aria-hidden /> Docs
                    </>
                  )}
                </button>
              ))}
            {/* Alternador de layout: abas ↔ split (Chat e Mapa lado a lado). */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {(['tabs', 'split'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setLayout(mode);
                    localStorage.setItem('cerberus_live_layout', mode);
                  }}
                  className="badge"
                  title={mode === 'tabs' ? 'Abas Mapa/Chat' : 'Mapa e Chat lado a lado'}
                  style={{
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    background: layout === mode ? 'var(--panel-2)' : 'transparent',
                    borderColor: layout === mode ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  {mode === 'tabs' ? (
                    <>
                      <PanelTop size={15} aria-hidden /> Abas
                    </>
                  ) : (
                    <>
                      {/* split é em COLUNAS → ícone de duas colunas */}
                      <Columns2 size={15} aria-hidden /> Split
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div ref={splitRootRef} style={{ flex: 1, minHeight: 0, display: 'flex', minWidth: 0 }}>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                position: 'relative',
                display: layout === 'tabs' && mainTab !== 'map' ? 'none' : 'block',
              }}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setBarHover(e.clientY - rect.top < 72);
              }}
              onMouseLeave={() => setBarHover(false)}
            >
          {/* Barra de período (topo do mapa): DOIS controles (início e fim) definem o
              intervalo das rotas plotadas. Fica OCULTA e DESCE do topo quando o cursor
              passa na faixa superior; o "pin" a mantém fixa. O wrapper com overflow
              hidden faz a barra deslizar de cima para baixo. Padrão: últimas 24 h. */}
          {firstTs != null && (
            <>
              {/* Alça sutil quando oculta — indica a área para revelar. */}
              <div
                style={{
                  position: 'absolute',
                  top: 6,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 5,
                  width: 56,
                  height: 5,
                  borderRadius: 3,
                  background: 'rgba(255,255,255,0.28)',
                  pointerEvents: 'none',
                  opacity: barPinned || barHover ? 0 : 1,
                  transition: 'opacity 0.2s ease',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  zIndex: 5,
                  // Recorta só o topo (para a barra deslizar de cima); o espaço
                  // extra embaixo evita cortar a SOMBRA da barra na base.
                  overflow: 'hidden',
                  paddingTop: 10,
                  paddingBottom: 44,
                  pointerEvents: 'none',
                }}
              >
                <div
                  style={{
                    margin: '0 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: 'rgba(20,27,36,0.92)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '8px 14px',
                    boxShadow: '0 6px 16px rgba(0,0,0,.45)',
                    transform: barPinned || barHover ? 'translateY(0)' : 'translateY(-180%)',
                    opacity: barPinned || barHover ? 1 : 0,
                    // "Bounce down": desce com leve overshoot (easing back) e mais devagar.
                    transition:
                      'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.28s ease',
                    pointerEvents: barPinned || barHover ? 'auto' : 'none',
                  }}
                >
                  <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    Período
                  </span>
                  <EdgeStamp ms={rangeMin} title="Início da faixa disponível" align="right" />
                  <PeriodRange
                    min={rangeMin}
                    max={rangeMax}
                    start={windowStartMs}
                    end={windowEndMs}
                    format={fmtDateTime}
                    onChange={(s, e) => {
                      setWindowStartMs(s);
                      setWindowEndMs(e);
                      // Ponta direita colada no extremo (≈agora) ⇒ volta a seguir o "agora".
                      setLiveEnd(e >= nowTs - 60_000);
                    }}
                  />
                  <EdgeStamp ms={rangeMax} title="Fim da faixa (agora)" align="left" />
                  <button
                    type="button"
                    className="pinbtn"
                    onClick={() => {
                      const v = !barPinned;
                      setBarPinned(v);
                      localStorage.setItem('cerberus_period_pinned', v ? '1' : '0');
                    }}
                    title={barPinned ? 'Desafixar a barra de período' : 'Fixar a barra de período'}
                    aria-pressed={barPinned}
                    style={{ flexShrink: 0, cursor: 'pointer', display: 'grid', placeItems: 'center' }}
                  >
                    📌
                  </button>
                </div>
              </div>
            </>
          )}
          {/* Botão: enquadra o mapa em TODAS as rotas plotadas (fit bounds). O
              rótulo só aparece no hover (em repouso mostra só o ícone). */}
          <button
            type="button"
            className="maplabelbtn"
            onClick={() => setFitNonce((n) => n + 1)}
            disabled={plottedRoutes.length === 0}
            title={
              plottedRoutes.length === 0
                ? 'Selecione rotas para enquadrar'
                : 'Enquadrar todas as rotas visíveis'
            }
            style={{
              position: 'absolute',
              bottom: 12,
              left: 12,
              zIndex: 5,
              display: 'flex',
              alignItems: 'center',
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'rgba(20,27,36,0.92)',
              color: 'var(--text)',
              boxShadow: '0 2px 12px rgba(0,0,0,.4)',
              cursor: plottedRoutes.length === 0 ? 'not-allowed' : 'pointer',
              opacity: plottedRoutes.length === 0 ? 0.5 : 1,
              fontSize: 13,
            }}
          >
            <span>⤢</span>
            <span className="maplabel">Enquadrar rotas</span>
          </button>
          <LiveMap
            agents={agents}
            routes={plottedRoutes}
            trails={liveTrailsForMap}
            showTrails={showLiveTrail}
            showTrailDirection={trailDirectionOn}
            agentColors={agentColors}
            fitNonce={fitNonce}
            mediaMarkers={showMedia ? mediaMarkers : []}
            onMediaClick={(id) => {
              const i = mediaMsgs.findIndex((m) => m.id === id);
              if (i >= 0) setLightboxIndex(i);
            }}
            geofences={displayGeofences}
            showGeofences={showZones}
            onMapClick={(lng, lat) => {
              if (placing) setPendingCenter({ lng, lat });
            }}
            editGeofence={editGeo}
            onGeofenceMove={(lng, lat) => setEditGeo((e) => (e ? { ...e, lng, lat } : e))}
            onGeofenceResize={(radiusMeters) => setEditGeo((e) => (e ? { ...e, radiusMeters } : e))}
            onGeofenceReshape={(vertices) => setEditGeo((e) => (e ? { ...e, vertices } : e))}
            focus={alertFocus}
          />
          <MapEffectsMenu
            controls={[
              { kind: 'section', id: 'sec-layers', label: 'Camadas' },
              {
                kind: 'toggle',
                id: 'live-trail',
                label: 'Trilha ao vivo',
                title: 'Desenha o caminho do agente ao vivo, conforme ele se desloca',
                checked: showLiveTrail,
                onChange: setLiveTrail,
              },
              {
                kind: 'toggle',
                id: 'trail-direction',
                label: 'Sentido das trilhas',
                title: showLiveTrail
                  ? 'Setas ao longo das trilhas e rotas indicando a direção do deslocamento'
                  : 'Ative a "Trilha ao vivo" para usar o sentido das trilhas',
                checked: trailDirectionOn,
                // Sem trilha ao vivo não há trilha para indicar sentido — desabilita.
                disabled: !showLiveTrail,
                onChange: setShowTrailDirection,
              },
              {
                kind: 'toggle',
                id: 'zones',
                label: 'Exibir zonas',
                title: 'Exibir/ocultar as zonas (geofences) no mapa',
                checked: showZones,
                onChange: setShowZones,
              },
              {
                kind: 'toggle',
                id: 'media',
                label: 'Exibir fotos',
                title: 'Exibir/ocultar os pins de fotos geolocalizadas no mapa',
                checked: showMedia,
                onChange: setShowMedia,
              },
              { kind: 'section', id: 'sec-routes', label: 'Rotas' },
              {
                kind: 'toggle',
                id: 'connect-routes',
                label: 'Ligar rotas',
                title: isAdmin
                  ? 'Liga o fim de uma rota ao início da próxima (linha tracejada)'
                  : 'Apenas administradores alteram as configurações',
                checked: settings.connectRoutes,
                disabled: !isAdmin,
                onChange: (v) => updateSetting({ connectRoutes: v }),
              },
              {
                kind: 'number',
                id: 'min-route-points',
                label: 'Pontos mínimos por rota',
                title: isAdmin
                  ? 'Rotas com menos pontos que isso são ocultadas (trechos insignificantes)'
                  : 'Apenas administradores alteram as configurações',
                value: settings.minRoutePoints,
                min: 1,
                max: 1000,
                disabled: !isAdmin,
                onChange: (v) =>
                  updateSetting({ minRoutePoints: Math.min(1000, Math.max(1, Math.round(v))) }),
              },
              {
                kind: 'number',
                id: 'max-gap-minutes',
                label: 'Intervalo que quebra a rota (min)',
                title: isAdmin
                  ? 'Sem transmissão por mais que isso, o trajeto é quebrado (evita o “pulo”)'
                  : 'Apenas administradores alteram as configurações',
                value: settings.maxGapMinutes,
                min: 1,
                max: 1440,
                disabled: !isAdmin,
                onChange: (v) =>
                  updateSetting({ maxGapMinutes: Math.min(1440, Math.max(1, Math.round(v))) }),
              },
            ]}
          />
          </div>
            {layout === 'split' && (
              <div
                onMouseDown={() => {
                  draggingSplit.current = true;
                  document.body.style.cursor = 'col-resize';
                  document.body.style.userSelect = 'none';
                }}
                title="Arraste para ajustar a divisão"
                style={{
                  width: 6,
                  flexShrink: 0,
                  cursor: 'col-resize',
                  background: 'var(--border)',
                }}
              />
            )}
            {(layout === 'split' || mainTab === 'chat') && (
              <div
                style={
                  layout === 'split'
                    ? { width: chatWidth, flexShrink: 0, minWidth: 0, minHeight: 0 }
                    : { flex: 1, minWidth: 0, minHeight: 0 }
                }
              >
                <ChatPanel
                  operationId={operationId}
                  incoming={incomingChat}
                  focusKey={chatFocus.key || null}
                  focusNonce={chatFocus.nonce}
                />
              </div>
            )}
            {layout === 'tabs' && mainTab === 'gallery' && (
              <div
                className="thinscroll"
                style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: 12 }}
              >
                <strong style={{ fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Images size={16} aria-hidden /> Galeria ({mediaMsgs.length})
                </strong>
                {mediaMsgs.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13, textAlign: 'center', marginTop: 40 }}>
                    Nenhuma mídia na operação ainda.
                  </div>
                ) : (
                  <div
                    style={{
                      marginTop: 10,
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                      gap: 8,
                    }}
                  >
                    {mediaMsgs.map((m, i) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setLightboxIndex(i)}
                        title={`${nameFor(m.senderId)} · abrir`}
                        style={{
                          position: 'relative',
                          padding: 0,
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          overflow: 'hidden',
                          cursor: 'pointer',
                          background: 'var(--panel-2)',
                        }}
                      >
                        <AuthImage
                          path={api.mediaPath(operationId, m.mediaRef)}
                          mediaKey={m.crypto}
                          mime={m.mime}
                          alt={`Mídia de ${nameFor(m.senderId)}`}
                          style={{
                            width: '100%',
                            aspectRatio: '1',
                            objectFit: 'cover',
                            display: 'block',
                            background: 'var(--border)',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '3px 6px',
                            fontSize: 11,
                            color: '#fff',
                            background: 'linear-gradient(transparent, rgba(0,0,0,.7))',
                          }}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <Eye size={12} aria-hidden /> {mediaStats[m.id]?.views ?? 0}
                          </span>
                          {mediaStats[m.id]?.favorited && (
                            <Star size={12} color="#e3b341" fill="#e3b341" aria-hidden />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {layout === 'tabs' && mainTab === 'docs' && (
              <div
                className="thinscroll"
                style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: 12 }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                >
                  <strong style={{ fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FileText size={16} aria-hidden /> Documentos ({docMsgs.length})
                </strong>
                  <input
                    ref={docFileRef}
                    type="file"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadDoc(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => docFileRef.current?.click()}
                    disabled={docBusy}
                    className="badge"
                    style={{
                      cursor: docBusy ? 'not-allowed' : 'pointer',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      background: 'transparent',
                      opacity: docBusy ? 0.5 : 1,
                    }}
                  >
                    {docBusy ? 'Enviando…' : '⤒ Enviar documento'}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
                  Arquivos cifrados (E2EE) — o servidor nunca vê o conteúdo.
                </p>
                {docMsgs.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13, textAlign: 'center', marginTop: 30 }}>
                    Nenhum documento ainda.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 6 }}>
                    {docMsgs.map((d) => (
                      <div
                        key={d.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 10px',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          background: 'var(--panel-2)',
                        }}
                      >
                        <span style={{ display: 'flex', flexShrink: 0 }}>{docIcon(d.mime)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 13,
                              color: 'var(--text)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {d.filename}
                          </div>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {nameFor(d.senderId)} ·{' '}
                            {new Date(d.capturedAt).toLocaleString('pt-BR', {
                              day: '2-digit',
                              month: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                        {d.crypto ? (
                          <button
                            type="button"
                            onClick={() => void downloadDoc(d)}
                            title="Baixar (decifrado)"
                            className="badge"
                            style={{
                              cursor: 'pointer',
                              border: '1px solid var(--border)',
                              color: 'var(--text)',
                              background: 'transparent',
                            }}
                          >
                            ⤓ Baixar
                          </button>
                        ) : (
                          <span className="muted" style={{ display: 'inline-flex' }} title="Indecifrável">
                            <Lock size={14} aria-hidden />
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {settingsOpen && (
        <SettingsModal
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
        />
      )}

      {lightboxIndex != null && mediaMsgs[lightboxIndex] && (
        <MediaViewer
          items={mediaMsgs}
          index={lightboxIndex}
          onIndex={(i) => setLightboxIndex(i)}
          onClose={() => setLightboxIndex(null)}
          operationId={operationId}
          nameOf={(id) => nameFor(id)}
          onView={(it) => void handleViewMedia(it)}
          actions={(it) => (
            <button
              type="button"
              onClick={() => void handleToggleFav(it)}
              title={mediaStats[it.id]?.favorited ? 'Desfavoritar' : 'Favoritar'}
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,.25)',
                background: 'rgba(0,0,0,.4)',
                color: mediaStats[it.id]?.favorited ? '#e3b341' : '#fff',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Star
                size={18}
                aria-hidden
                fill={mediaStats[it.id]?.favorited ? '#e3b341' : 'none'}
              />
            </button>
          )}
          extraInfo={(it) => (
            <div
              style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}
            >
              <span className="muted">Visualizações · Favoritos</span>
              <span
                style={{ color: 'var(--text)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Eye size={13} aria-hidden /> {mediaStats[it.id]?.views ?? 0} ·{' '}
                <Star size={13} aria-hidden /> {mediaStats[it.id]?.favorites ?? 0}
              </span>
            </div>
          )}
        />
      )}
    </div>
  );
}
