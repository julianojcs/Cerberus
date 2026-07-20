import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Session } from '../services/auth';
import { getSecretKey } from '../services/keys';
import { fetchMessageHistory, sendTeamMessage, sendText } from '../services/messages';
import { fetchMyTeams, type MyTeam } from '../services/teams';
import { fetchOperationName } from '../services/operations';
import {
  connectMqtt,
  disconnectMqtt,
  isConnected,
  setBroadcastIdentity,
  subscribeBroadcast,
  subscribeInbox,
  subscribeTeam,
  type BroadcastMessage,
} from '../services/mqtt';
import {
  getCurrentPositionOnce,
  getLastSample,
  initTracking,
  setShareLocation,
  startSimulatedMovement,
  startTracking,
  stopSimulatedMovement,
  stopTracking,
  subscribePositions,
  subscribeSimulation,
} from '../services/geolocation';
import { outboxSize } from '../services/outbox';
import { pingSession } from '../services/heartbeat';
import { pickPhoto, uploadPhoto, type PickedPhoto } from '../services/media';
import {
  AgentMap,
  type DestinationPin,
  type PlannedRoute,
  type TrackPoint,
} from '../components/AgentMap';
import { DestinationSearch } from '../components/DestinationSearch';
import { NavigationBar } from '../components/NavigationBar';
import {
  cancelActiveRoute,
  requestRouteToDestination,
  reverseGeocode,
  startNavigation,
  subscribeNavigation,
  type NavigationState,
} from '../services/navigation';
import { isMuted, setMuted } from '../services/speech';
import { toLatLngPath } from '../shared/geo';
import { formatClock, formatDistance, formatDuration } from '../shared/format';
import type { GeocodeResult, PositionSample } from '../shared/contracts';

/** Máximo de pontos mantidos na trilha em memória. */
const MAX_TRACK = 500;

/**
 * Tela operacional do agente: liga/desliga o reporte de posição, mostra o status
 * do barramento/buffer, as coordenadas em tempo real e o próprio percurso no mapa.
 */
export function OperationScreen({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const operationId = session.operationIds[0];
  const agentId = session.agentId ?? session.userId;

  const [tracking, setTracking] = useState(false);
  const [share, setShare] = useState(true);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(0);
  const [pos, setPos] = useState<PositionSample | null>(getLastSample());
  const [track, setTrack] = useState<TrackPoint[]>([]);
  const [showTrack, setShowTrack] = useState(true);
  const [centering, setCentering] = useState(false);
  // Centralizar o mapa no agente sob demanda (nonce muda a cada toque).
  const [focus, setFocus] = useState<{ lat: number; lng: number; nonce: number } | null>(null);
  // Enquanto o dedo está sobre o mapa, travamos o scroll da tela para o Leaflet
  // receber os gestos de pinça/arraste (senão o ScrollView "rouba" o multitoque).
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [broadcasts, setBroadcasts] = useState<BroadcastMessage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [headingUp, setHeadingUp] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<PickedPhoto | null>(null);
  const [caption, setCaption] = useState('');
  const [messageText, setMessageText] = useState('');
  const [sendingText, setSendingText] = useState(false);
  const [myTeams, setMyTeams] = useState<MyTeam[]>([]);
  // Destino do composer: `null` = operação (central); MyTeam = a equipe escolhida.
  const [composeTeam, setComposeTeam] = useState<MyTeam | null>(null);
  // Nome da operação (cabeçalho) — o token só traz o id; buscamos o nome.
  const [operationName, setOperationName] = useState<string | null>(null);
  // --- Navegação por rota (issue #131) ---
  const [nav, setNav] = useState<NavigationState | null>(null);
  /** Simulação de deslocamento — só existe em build de desenvolvimento (`__DEV__`). */
  const [simulating, setSimulating] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
  // Escolha do destino pelo próprio agente (Fase 6b): enquanto ligado, o toque no
  // mapa vira destino em vez de gesto solto.
  const [picking, setPicking] = useState(false);
  const [creatingRoute, setCreatingRoute] = useState(false);
  // Destino candidato (toque no mapa ou acerto da busca), à espera de confirmação.
  const [pin, setPin] = useState<DestinationPin | null>(null);
  // Geocodificação reversa em curso — o diálogo do toque espera o endereço.
  const [resolvingAddress, setResolvingAddress] = useState(false);
  // A chegada é anunciada UMA vez — o estado `arrived` continua verdadeiro depois.
  const arrivalAlerted = useRef(false);

  useEffect(() => {
    connectMqtt(session.token, operationId, agentId);
    const interval = setInterval(async () => {
      setConnected(isConnected());
      setPending(await outboxSize());
    }, 2000);
    return () => clearInterval(interval);
  }, [session.token, operationId, agentId]);

  // Heartbeat de sessão (~30s + ao voltar ao primeiro plano): se a central derrubou/
  // bloqueou, o /auth/session responde 401 e o handler global desloga (ver App.tsx).
  useEffect(() => {
    const ping = () => void pingSession(session.token);
    ping();
    const interval = setInterval(ping, 30_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') ping();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [session.token]);

  // Espelha na tela cada amostra publicada (mesma fonte enviada ao painel).
  useEffect(
    () =>
      subscribePositions((sample) => {
        setPos(sample);
        setTrack((t) => [...t.slice(-(MAX_TRACK - 1)), { lat: sample.lat, lng: sample.lng }]);
      }),
    [],
  );

  // Navegação por rota: assina os comandos `route_assign`/`route_cancel`, o fluxo de
  // posições e recupera do servidor a rota despachada enquanto o app estava fora.
  useEffect(() => {
    if (!operationId) return;
    const stop = startNavigation({ token: session.token, operationId, agentId });
    const unsubscribe = subscribeNavigation(setNav);
    return () => {
      unsubscribe();
      stop();
    };
  }, [session.token, operationId, agentId]);

  /**
   * Simulação de deslocamento (desenvolvimento): reflete o estado e, ao sair da tela,
   * ENCERRA. Deixá-la viva fora daqui seguiria publicando posição sintética na central
   * sem ninguém à vista para desligar.
   */
  useEffect(() => {
    const unsubscribe = subscribeSimulation(setSimulating);
    return () => {
      unsubscribe();
      stopSimulatedMovement();
    };
  }, []);

  // Chegada ao destino: alerta uma única vez por rota (o `arrived` permanece ligado).
  useEffect(() => {
    if (!nav?.arrived) {
      arrivalAlerted.current = false;
      return;
    }
    if (arrivalAlerted.current) return;
    arrivalAlerted.current = true;
    Alert.alert(
      'Destino alcançado',
      nav.route?.destination.label
        ? `Você chegou a ${nav.route.destination.label}.`
        : 'Você chegou ao destino.',
    );
  }, [nav?.arrived, nav?.route?.destination.label]);

  // Nome da operação para o cabeçalho (o token só traz o id).
  useEffect(() => {
    if (!operationId) {
      setOperationName(null);
      return;
    }
    let cancelled = false;
    void fetchOperationName(session, operationId).then((n) => {
      if (!cancelled) setOperationName(n);
    });
    return () => {
      cancelled = true;
    };
  }, [operationId, session]);

  // Descobre as equipes do agente (para assinar os tópicos de equipe + enviar a elas).
  useEffect(() => {
    if (!operationId) return;
    let cancelled = false;
    void fetchMyTeams(session, operationId)
      .then((teams) => {
        if (!cancelled) setMyTeams(teams);
      })
      .catch(() => {
        /* sem equipes / falha de rede — segue só com a operação */
      });
    return () => {
      cancelled = true;
    };
  }, [operationId, session]);

  // Recebe mensagens: broadcast da operação + inbox (DM) + cada equipe do agente.
  // Carrega a chave secreta local (SecureStore) para decifrar o envelope E2EE — o
  // `myId` deve casar com o `rid` usado pela central (agentId ?? userId). Menor
  // privilégio: assina só esses tópicos, nunca wildcard.
  useEffect(() => {
    if (!operationId) return;
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    const dkey = (m: BroadcastMessage) => `${m.capturedAt}:${m.senderId}:${m.text}`;
    void (async () => {
      const secretKey = await getSecretKey(session.userId);
      if (cancelled) return;
      setBroadcastIdentity({ myId: agentId, secretKey });
      // Semeia o card com o HISTÓRICO (REST) antes de assinar o ao vivo.
      const history = await fetchMessageHistory(session, operationId, agentId, secretKey);
      if (cancelled) return;
      setBroadcasts(history.slice(0, 30));
      const onMessage = (message: BroadcastMessage) =>
        setBroadcasts((prev) =>
          prev.some((p) => dkey(p) === dkey(message)) ? prev : [message, ...prev].slice(0, 30),
        );
      unsubs.push(subscribeBroadcast(operationId, onMessage));
      unsubs.push(subscribeInbox(operationId, agentId, onMessage));
      for (const team of myTeams) unsubs.push(subscribeTeam(operationId, team.id, onMessage));
    })();
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [operationId, agentId, session.userId, myTeams]);

  async function toggleTracking(value: boolean) {
    if (!operationId) return;
    if (value) {
      await initTracking({ operationId, agentId });
      await startTracking();
    } else {
      await stopTracking();
    }
    setTracking(value);
  }

  // Compartilhar ou não com a central. Desligado, o GPS continua alimentando o mapa
  // do app, mas nada é publicado no barramento (rastreamento local/privado).
  function toggleShare(value: boolean) {
    setShareLocation(value);
    setShare(value);
  }

  // Centraliza o mapa na localização do agente, mesmo que não esteja transmitindo:
  // usa a última posição conhecida ou busca um fix sob demanda.
  async function handleCenter() {
    if (!operationId || centering) return;
    setCentering(true);
    try {
      const target = pos ?? (await getCurrentPositionOnce({ operationId, agentId }));
      if (target) {
        setPos((p) => p ?? target);
        setFocus({ lat: target.lat, lng: target.lng, nonce: Date.now() });
      } else {
        Alert.alert(
          'Sem posição',
          'Não foi possível obter a localização. Verifique o GPS e as permissões.',
        );
      }
    } finally {
      setCentering(false);
    }
  }

  // Traçado planejado no formato do mapa. A transposição GeoJSON `[lng, lat]` →
  // `{lat, lng}` acontece só aqui (via `toLatLngPath`) — ver as regras de coordenadas.
  const plannedRoute = useMemo<PlannedRoute | null>(() => {
    const route = nav?.route;
    if (!route) return null;
    return {
      id: route.id,
      path: toLatLngPath(route.geometry),
      destination: {
        lat: route.destination.lat,
        lng: route.destination.lng,
        label: route.destination.label,
      },
      fallback: route.fallback,
    };
  }, [nav?.route]);

  function handleToggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  /**
   * Confirmação ÚNICA dos dois caminhos de escolha de destino — o toque no mapa e o
   * acerto da busca por endereço terminam aqui. O servidor traça a partir da ÚLTIMA
   * POSIÇÃO CONHECIDA do agente: se ele nunca publicou (compartilhamento desligado
   * desde o início), a API responde 409 e a mensagem dela é repassada como está.
   *
   * `label` vem da geocodificação; sem ela sobra a coordenada — o fluxo de rota nunca
   * depende do geocodificador estar de pé.
   */
  function confirmDestination(point: TrackPoint, label?: string) {
    const description = label ?? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    Alert.alert(
      'Definir destino',
      `Traçar rota até ${description}?`,
      [
        { text: 'Cancelar', style: 'cancel', onPress: () => setPin(null) },
        {
          text: 'Traçar rota',
          onPress: () => {
            setCreatingRoute(true);
            void requestRouteToDestination(point, label ?? 'Destino escolhido no app')
              .then(() => {
                setPicking(false);
                // A partir daqui quem marca o ponto é o destino da rota (🏁).
                setPin(null);
              })
              .catch((e: unknown) =>
                Alert.alert(
                  'Falha',
                  e instanceof Error ? e.message : 'Não foi possível traçar a rota.',
                ),
              )
              .finally(() => setCreatingRoute(false));
          },
        },
      ],
      // Android: sem isto o toque fora do diálogo o fecha SEM callback e o marcador
      // ficaria órfão no mapa, sugerindo um destino que ninguém confirmou.
      { cancelable: false },
    );
  }

  // Fase 6b: o agente toca no mapa. O ponto é marcado na hora e o endereço é buscado
  // por geocodificação reversa para o diálogo dizer "Rua X, 100" em vez de um par de
  // números. `reverseGeocode` NUNCA lança — sem endereço, cai na coordenada.
  function handleMapTap(point: TrackPoint) {
    if (!picking || creatingRoute || resolvingAddress || !operationId) return;
    setPin(point);
    setResolvingAddress(true);
    void reverseGeocode(point)
      .then((address) => {
        if (address) setPin({ ...point, label: address.label });
        confirmDestination(point, address?.label);
      })
      .finally(() => setResolvingAddress(false));
  }

  /**
   * Acerto escolhido na busca por endereço. Já vem com rótulo e coordenada do provedor,
   * então não há reversa a fazer: marca (enquadrando, porque o ponto pode estar fora da
   * tela) e cai direto na confirmação.
   */
  function handleSearchSelect(result: GeocodeResult) {
    if (creatingRoute || !operationId) return;
    const point: TrackPoint = { lat: result.lat, lng: result.lng };
    setPin({ ...point, label: result.label, center: true });
    confirmDestination(point, result.label);
  }

  function handleCancelRoute() {
    Alert.alert('Cancelar rota', 'Encerrar a navegação até o destino atual?', [
      { text: 'Manter', style: 'cancel' },
      {
        text: 'Cancelar rota',
        style: 'destructive',
        onPress: () => {
          void cancelActiveRoute().catch(() => {
            /* já limpa localmente; a central verá o cancelamento no próximo sync */
          });
        },
      },
    ]);
  }

  function handleLogout() {
    // "Sair" é a ÚNICA forma de encerrar o app — confirma para evitar saída acidental.
    Alert.alert('Sair do Cerberus', 'Encerrar a sessão e fechar o aplicativo?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Sair',
        style: 'destructive',
        onPress: () => {
          void stopTracking();
          // Anuncia `offline` antes de encerrar (o broker descarta o testamento).
          disconnectMqtt(operationId, agentId);
          onLogout();
        },
      },
    ]);
  }

  async function handleSendText() {
    const text = messageText.trim();
    if (!text || !operationId || sendingText) return;
    setSendingText(true);
    try {
      if (composeTeam) {
        await sendTeamMessage(session, operationId, composeTeam, text);
      } else {
        await sendText(session, operationId, text);
      }
      setMessageText('');
    } catch (e) {
      Alert.alert('Falha', e instanceof Error ? e.message : 'Não foi possível enviar a mensagem.');
    } finally {
      setSendingText(false);
    }
  }

  async function handleTakePhoto() {
    if (!operationId || uploading) return;
    try {
      const photo = await pickPhoto();
      if (photo) {
        setCaption('');
        setPendingPhoto(photo); // abre o modal de composição
      }
    } catch (e) {
      Alert.alert('Falha', e instanceof Error ? e.message : 'Não foi possível abrir a câmera.');
    }
  }

  async function handleConfirmUpload() {
    if (!operationId || !pendingPhoto || uploading) return;
    setUploading(true);
    try {
      await uploadPhoto(operationId, session, pendingPhoto, {
        caption,
        lat: pos?.lat ?? null, // geotag = posição atual do agente (se disponível)
        lng: pos?.lng ?? null,
      });
      setPendingPhoto(null);
      setCaption('');
      Alert.alert('Mídia enviada', 'Foto enviada à central.');
    } catch (e) {
      Alert.alert('Falha', e instanceof Error ? e.message : 'Não foi possível enviar a foto.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        scrollEnabled={scrollEnabled}
      >
        <Text style={styles.brand}>CERBERUS</Text>
        <Text style={styles.agent}>{session.name}</Text>
        <Text style={styles.meta}>Agente: {agentId}</Text>
        <Text style={styles.meta}>
          Operação: {operationName ?? operationId ?? 'nenhuma atribuída'}
        </Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Rastreamento (GPS)</Text>
            <Switch value={tracking} onValueChange={toggleTracking} disabled={!operationId} />
          </View>
          <View style={[styles.row, { marginTop: 12 }]}>
            <Text style={styles.compassLabel}>Compartilhar com a central</Text>
            <Switch value={share} onValueChange={toggleShare} />
          </View>
          <Text style={styles.status}>
            Barramento:{' '}
            <Text style={{ color: connected ? '#3fb950' : '#8b9aa8' }}>
              {connected ? 'conectado' : 'desconectado'}
            </Text>
          </Text>
          <Text style={styles.status}>
            Buffer offline:{' '}
            <Text style={{ color: pending > 0 ? '#e3b341' : '#8b9aa8' }}>{pending}</Text>{' '}
            posição(ões)
          </Text>
          <Text style={styles.hint}>
            {share
              ? 'Parado, o GPS hiberna (ping a cada 5 min). Em deslocamento, a taxa de amostragem sobe automaticamente.'
              : 'Compartilhamento desligado: sua posição fica só neste app (mapa e percurso) — nada é enviado à central.'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Sua localização</Text>
          {pos ? (
            <>
              <Text style={styles.coord}>
                {pos.lat.toFixed(6)}, {pos.lng.toFixed(6)}
              </Text>
              <View style={styles.metricsRow}>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Precisão</Text>
                  <Text style={styles.metricValue}>
                    {pos.accuracy != null ? `±${Math.round(pos.accuracy)} m` : '—'}
                  </Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Velocidade</Text>
                  <Text style={styles.metricValue}>
                    {pos.speed != null && pos.speed >= 0
                      ? `${(pos.speed * 3.6).toFixed(1)} km/h`
                      : '—'}
                  </Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Atividade</Text>
                  <Text style={styles.metricValue}>{pos.activity ?? '—'}</Text>
                </View>
              </View>
              <Text style={styles.status}>
                Atualizado às{' '}
                <Text style={{ color: '#e6edf3' }}>{formatClock(pos.capturedAt)}</Text> ·{' '}
                {track.length} ponto(s) na sessão
              </Text>
            </>
          ) : (
            <Text style={styles.hint}>
              {tracking
                ? 'Aguardando o primeiro fix do GPS… (ao ar livre é mais rápido)'
                : 'Ligue o reporte de posição para ver suas coordenadas em tempo real.'}
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={[styles.photoBtn, (uploading || !operationId) && styles.photoBtnDisabled]}
          onPress={handleTakePhoto}
          disabled={uploading || !operationId}
        >
          <Text style={styles.photoBtnText}>📷 Enviar foto à central</Text>
        </TouchableOpacity>

        <View style={styles.card}>
          <Text style={styles.label}>Mensagens</Text>
          {broadcasts.length === 0 ? (
            <Text style={styles.hint}>Nenhuma mensagem recebida ainda.</Text>
          ) : (
            broadcasts.map((m, i) => {
              const badge =
                m.scope === 'central'
                  ? 'CENTRAL'
                  : m.scope === 'dm'
                    ? 'DM'
                    : `EQUIPE ${myTeams.find((t) => t.id === m.teamId)?.name ?? ''}`.trim();
              const badgeColor =
                m.scope === 'central' ? '#f0a0a0' : m.scope === 'dm' ? '#d0a0f0' : '#a0c0f0';
              return (
                <View key={`${m.capturedAt}-${i}`} style={styles.broadcastItem}>
                  <Text style={[styles.scopeBadge, { color: badgeColor }]}>{badge}</Text>
                  <Text style={styles.broadcastText}>{m.text}</Text>
                  <Text style={styles.broadcastMeta}>
                    {m.senderId} · {formatClock(m.capturedAt)}
                  </Text>
                </View>
              );
            })
          )}

          {/* Destino do envio: operação (central) ou uma das equipes do agente. */}
          {myTeams.length > 0 && (
            <View style={styles.scopeRow}>
              <TouchableOpacity
                style={[styles.scopeChip, !composeTeam && styles.scopeChipActive]}
                onPress={() => setComposeTeam(null)}
              >
                <Text style={[styles.scopeChipText, !composeTeam && styles.scopeChipTextActive]}>
                  Operação
                </Text>
              </TouchableOpacity>
              {myTeams.map((t) => {
                const active = composeTeam?.id === t.id;
                return (
                  <TouchableOpacity
                    key={t.id}
                    style={[styles.scopeChip, active && styles.scopeChipActive]}
                    onPress={() => setComposeTeam(t)}
                  >
                    <Text style={[styles.scopeChipText, active && styles.scopeChipTextActive]}>
                      {t.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Compositor E2EE (cifrado no aparelho) — envia à operação ou à equipe. */}
          <View style={styles.replyRow}>
            <TextInput
              style={styles.replyInput}
              value={messageText}
              onChangeText={setMessageText}
              placeholder={
                composeTeam ? `Mensagem à equipe ${composeTeam.name}…` : 'Reportar à central…'
              }
              placeholderTextColor="#8b9aa8"
              multiline
              editable={!sendingText}
            />
            <TouchableOpacity
              style={[
                styles.replySend,
                (sendingText || !messageText.trim()) && styles.replySendDisabled,
              ]}
              onPress={handleSendText}
              disabled={sendingText || !messageText.trim()}
            >
              <Text style={styles.replySendText}>{sendingText ? '…' : 'Enviar'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Seu percurso</Text>
            <View style={styles.percursoActions}>
              <TouchableOpacity onPress={() => setFullscreen(true)} hitSlop={8}>
                <Text style={styles.expandIcon}>⛶</Text>
              </TouchableOpacity>
              <Switch value={showTrack} onValueChange={setShowTrack} />
            </View>
          </View>

          {/* Barra turn-by-turn: fica ACIMA do mapa para ser lida sem procurar. */}
          {nav && (
            <NavigationBar
              state={nav}
              muted={muted}
              onToggleMute={handleToggleMute}
              onCancel={handleCancelRoute}
            />
          )}

          <View
            style={styles.mapWrap}
            onTouchStart={() => setScrollEnabled(false)}
            onTouchEnd={() => setScrollEnabled(true)}
            onTouchCancel={() => setScrollEnabled(true)}
          >
            <AgentMap
              track={track}
              showTrack={showTrack}
              headingUp={headingUp}
              heading={pos?.heading ?? null}
              focus={focus}
              route={plannedRoute}
              pin={pin}
              pickMode={picking}
              onMapTap={handleMapTap}
            />
            <TouchableOpacity
              style={styles.centerBtn}
              onPress={handleCenter}
              disabled={centering}
              hitSlop={8}
            >
              <Text style={styles.centerBtnText}>{centering ? '…' : '◎'}</Text>
            </TouchableOpacity>
          </View>

          {/* Destino escolhido pelo próprio agente (Fase 6b). */}
          <TouchableOpacity
            style={[styles.destBtn, picking && styles.destBtnActive]}
            onPress={() => setPicking((p) => !p)}
            disabled={creatingRoute || resolvingAddress || !operationId}
          >
            <Text style={styles.destBtnText}>
              {creatingRoute
                ? 'Traçando rota…'
                : resolvingAddress
                  ? 'Identificando o endereço…'
                  : picking
                    ? 'Toque no mapa para escolher o destino (toque aqui para desistir)'
                    : '📍 Definir destino no mapa'}
            </Text>
          </TouchableOpacity>

          {/* Segundo caminho para o mesmo destino: buscar por endereço em vez de mirar
              no mapa. O toque continua valendo — quem sabe o nome da rua digita, quem
              conhece o ponto de referência aponta. */}
          <DestinationSearch
            near={pos ? { lat: pos.lat, lng: pos.lng } : null}
            onSelect={handleSearchSelect}
            disabled={creatingRoute || resolvingAddress || !operationId}
          />

          <View style={[styles.row, { marginTop: 12 }]}>
            <Text style={styles.compassLabel}>Girar com o movimento (bússola)</Text>
            <Switch value={headingUp} onValueChange={setHeadingUp} />
          </View>

          {/* Simulação de deslocamento — SÓ em build de desenvolvimento. Percorre a rota
              ativa gerando posições, para exercitar o turn-by-turn (avanço de passo,
              locução, chegada) sem sair andando. O GPS real fica suspenso enquanto roda. */}
          {__DEV__ && (
            <>
              <View style={[styles.row, { marginTop: 12 }]}>
                <Text style={styles.compassLabel}>Simular deslocamento (dev)</Text>
                <Switch
                  value={simulating}
                  disabled={!nav?.route}
                  onValueChange={(on) => {
                    if (!on) {
                      stopSimulatedMovement();
                      return;
                    }
                    const geometry = nav?.route?.geometry;
                    if (geometry) {
                      startSimulatedMovement({ operationId, agentId }, geometry, { speedKmh: 40 });
                    }
                  }}
                />
              </View>
              <Text style={styles.hint}>
                {!nav?.route
                  ? 'Defina um destino para poder simular o percurso.'
                  : simulating
                    ? 'Percorrendo a rota a 40 km/h. O GPS real está suspenso; a central recebe estas posições.'
                    : 'Percorre a rota ativa gerando posições, sem precisar se deslocar.'}
              </Text>
            </>
          )}
          <Text style={styles.hint}>
            {nav?.route
              ? `Rota ${nav.route.source === 'central' ? 'despachada pela central' : 'definida por você'} · ${formatDistance(nav.route.distanceMeters)} · ${formatDuration(nav.route.durationSec)} previstos. O traçado já está no aparelho e continua valendo sem rede.`
              : track.length > 0
                ? `${track.length} ponto(s) na sessão${showTrack ? '' : ' · rastro oculto'}.`
                : 'Dois dedos giram o mapa; a bússola (canto) volta ao norte. O trajeto aparece conforme você se desloca (requer rede).'}
          </Text>
        </View>

        <TouchableOpacity style={styles.logout} onPress={handleLogout}>
          <Text style={styles.logoutText}>Sair</Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal visible={fullscreen} animationType="slide" onRequestClose={() => setFullscreen(false)}>
        <View style={styles.modalContainer}>
          <View style={styles.modalBar}>
            <Text style={styles.modalTitle}>Seu percurso</Text>
            <View style={styles.percursoActions}>
              <View style={styles.modalToggle}>
                <Text style={styles.modalToggleLabel}>Rastro</Text>
                <Switch value={showTrack} onValueChange={setShowTrack} />
              </View>
              <View style={styles.modalToggle}>
                <Text style={styles.modalToggleLabel}>Bússola</Text>
                <Switch value={headingUp} onValueChange={setHeadingUp} />
              </View>
              <TouchableOpacity onPress={() => setFullscreen(false)} hitSlop={8}>
                <Text style={styles.modalClose}>Fechar ✕</Text>
              </TouchableOpacity>
            </View>
          </View>
          {/* Tela cheia é o modo de uso ao volante: a barra vem antes do mapa. */}
          {nav?.route && (
            <View style={styles.modalNav}>
              <NavigationBar
                state={nav}
                muted={muted}
                onToggleMute={handleToggleMute}
                onCancel={handleCancelRoute}
              />
            </View>
          )}
          <View style={styles.modalMap}>
            {fullscreen ? (
              <>
                <AgentMap
                  track={track}
                  showTrack={showTrack}
                  headingUp={headingUp}
                  heading={pos?.heading ?? null}
                  focus={focus}
                  route={plannedRoute}
                  pin={pin}
                  pickMode={picking}
                  onMapTap={handleMapTap}
                />
                <TouchableOpacity
                  style={styles.centerBtn}
                  onPress={handleCenter}
                  disabled={centering}
                  hitSlop={8}
                >
                  <Text style={styles.centerBtnText}>{centering ? '…' : '◎'}</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={pendingPhoto !== null}
        animationType="slide"
        transparent
        onRequestClose={() => !uploading && setPendingPhoto(null)}
      >
        <View style={styles.composeBackdrop}>
          <View style={styles.composeCard}>
            <Text style={styles.label}>Enviar foto à central</Text>
            {pendingPhoto && (
              <Image source={{ uri: pendingPhoto.uri }} style={styles.composePreview} />
            )}
            <TextInput
              style={styles.captionInput}
              placeholder="Legenda (opcional)…"
              placeholderTextColor="#8b9aa8"
              value={caption}
              onChangeText={setCaption}
              multiline
              maxLength={500}
              editable={!uploading}
            />
            <Text style={styles.geotagHint}>
              {pos
                ? `📍 Geotag: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`
                : '📍 Sem posição — ligue o reporte para geotag'}
            </Text>
            <View style={styles.composeActions}>
              <TouchableOpacity
                onPress={() => setPendingPhoto(null)}
                disabled={uploading}
                style={styles.composeCancel}
              >
                <Text style={styles.composeCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleConfirmUpload}
                disabled={uploading}
                style={[styles.composeSend, uploading && styles.photoBtnDisabled]}
              >
                <Text style={styles.photoBtnText}>{uploading ? 'Enviando…' : 'Enviar'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f14' },
  content: { padding: 24, paddingTop: 72, paddingBottom: 40 },
  brand: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: 2 },
  agent: { color: '#e6edf3', fontSize: 18, marginTop: 16, fontWeight: '600' },
  meta: { color: '#8b9aa8', marginTop: 4 },
  card: {
    backgroundColor: '#141b24',
    borderColor: '#263543',
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
    marginTop: 24,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: '#e6edf3', fontSize: 16, fontWeight: '600' },
  status: { color: '#e6edf3', marginTop: 12 },
  hint: { color: '#8b9aa8', fontSize: 13, marginTop: 16, lineHeight: 18 },
  coord: {
    color: '#3fb950',
    fontSize: 20,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginTop: 12,
    letterSpacing: 0.5,
  },
  metricsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  metric: { flex: 1 },
  metricLabel: { color: '#8b9aa8', fontSize: 12 },
  metricValue: { color: '#e6edf3', fontSize: 15, fontWeight: '600', marginTop: 2 },
  mapWrap: {
    height: 280,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 12,
    backgroundColor: '#0b0f14',
  },
  broadcastItem: {
    marginTop: 12,
    paddingLeft: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#c1121f',
  },
  broadcastText: { color: '#e6edf3', fontSize: 15, lineHeight: 20 },
  broadcastMeta: { color: '#8b9aa8', fontSize: 12, marginTop: 2 },
  scopeBadge: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, marginBottom: 2 },
  scopeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  scopeChip: {
    borderWidth: 1,
    borderColor: '#263543',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  scopeChipActive: { backgroundColor: '#1c2733', borderColor: '#c1121f' },
  scopeChipText: { color: '#8b9aa8', fontSize: 12 },
  scopeChipTextActive: { color: '#e6edf3', fontWeight: '600' },
  replyRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 16 },
  replyInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 96,
    backgroundColor: '#0b0f14',
    borderColor: '#263543',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: '#e6edf3',
    fontSize: 14,
  },
  replySend: {
    backgroundColor: '#c1121f',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  replySendDisabled: { opacity: 0.5 },
  replySendText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  photoBtn: {
    marginTop: 24,
    backgroundColor: '#c1121f',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  photoBtnDisabled: { opacity: 0.5 },
  photoBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  composeBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  composeCard: {
    backgroundColor: '#141b24',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 32,
  },
  composePreview: {
    width: '100%',
    height: 220,
    borderRadius: 8,
    marginTop: 12,
    backgroundColor: '#0b0f14',
  },
  captionInput: {
    marginTop: 12,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: '#0b0f14',
    borderColor: '#263543',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    color: '#e6edf3',
    fontSize: 15,
  },
  geotagHint: { color: '#8b9aa8', fontSize: 13, marginTop: 10 },
  composeActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  composeCancel: { flex: 1, alignItems: 'center', padding: 14 },
  composeCancelText: { color: '#8b9aa8', fontWeight: '700', fontSize: 16 },
  composeSend: {
    flex: 2,
    alignItems: 'center',
    padding: 14,
    backgroundColor: '#c1121f',
    borderRadius: 12,
  },
  percursoActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  expandIcon: { color: '#8b9aa8', fontSize: 22, fontWeight: '700' },
  centerBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(20,27,36,0.92)',
    borderColor: '#263543',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerBtnText: { color: '#2f81f7', fontSize: 22, fontWeight: '700', lineHeight: 26 },
  modalContainer: { flex: 1, backgroundColor: '#0b0f14', paddingTop: 44 },
  modalBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: '#263543',
    borderBottomWidth: 1,
  },
  modalTitle: { color: '#e6edf3', fontSize: 18, fontWeight: '700' },
  modalClose: { color: '#c1121f', fontWeight: '700', fontSize: 15 },
  modalMap: { flex: 1 },
  modalNav: { paddingHorizontal: 12 },
  destBtn: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#263543',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  destBtnActive: { borderColor: '#2f81f7', backgroundColor: '#1c2733' },
  // Cor explícita: sem ela o texto herdaria a cor de sistema e sumiria no escuro.
  destBtnText: { color: '#e6edf3', fontSize: 14, fontWeight: '600' },
  modalToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  modalToggleLabel: { color: '#8b9aa8', fontSize: 12 },
  compassLabel: { color: '#e6edf3', fontSize: 14 },
  logout: { marginTop: 24, alignItems: 'center', padding: 16 },
  logoutText: { color: '#c1121f', fontWeight: '700' },
});
