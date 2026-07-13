import { useEffect, useState } from 'react';
import {
  Alert,
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
import { sendText } from '../services/messages';
import {
  connectMqtt,
  disconnectMqtt,
  isConnected,
  subscribeBroadcast,
  type BroadcastMessage,
} from '../services/mqtt';
import {
  getCurrentPositionOnce,
  getLastSample,
  initTracking,
  setShareLocation,
  startTracking,
  stopTracking,
  subscribePositions,
} from '../services/geolocation';
import { outboxSize } from '../services/outbox';
import { pickPhoto, uploadPhoto, type PickedPhoto } from '../services/media';
import { AgentMap, type TrackPoint } from '../components/AgentMap';
import type { PositionSample } from '../shared/contracts';

/** Máximo de pontos mantidos na trilha em memória. */
const MAX_TRACK = 500;

/** Exibe o instante de captura (UTC) no fuso do operador para leitura em campo. */
function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(iso));
  } catch {
    // Fallback caso o build do Hermes não traga ICU/fuso: hora local do device.
    return new Date(iso).toTimeString().slice(0, 8);
  }
}

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
  const [showRoute, setShowRoute] = useState(true);
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

  useEffect(() => {
    connectMqtt(session.token, agentId);
    const interval = setInterval(async () => {
      setConnected(isConnected());
      setPending(await outboxSize());
    }, 2000);
    return () => clearInterval(interval);
  }, [session.token, agentId]);

  // Espelha na tela cada amostra publicada (mesma fonte enviada ao painel).
  useEffect(
    () =>
      subscribePositions((sample) => {
        setPos(sample);
        setTrack((t) => [...t.slice(-(MAX_TRACK - 1)), { lat: sample.lat, lng: sample.lng }]);
      }),
    [],
  );

  // Recebe diretivas da central (canal broadcast da operação). Carrega a chave
  // secreta local (SecureStore, assíncrono) para decifrar o envelope E2EE — o id
  // do agente deve casar com o `rid` que a central usou (agentId ?? userId).
  useEffect(() => {
    if (!operationId) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const secretKey = await getSecretKey(session.userId);
      if (cancelled) return;
      unsubscribe = subscribeBroadcast(operationId, { myId: agentId, secretKey }, (message) => {
        setBroadcasts((prev) => [message, ...prev].slice(0, 20));
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [operationId, agentId, session.userId]);

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

  function handleLogout() {
    // "Sair" é a ÚNICA forma de encerrar o app — confirma para evitar saída acidental.
    Alert.alert('Sair do Cerberus', 'Encerrar a sessão e fechar o aplicativo?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Sair',
        style: 'destructive',
        onPress: () => {
          void stopTracking();
          disconnectMqtt();
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
      await sendText(session, operationId, text);
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
        <Text style={styles.meta}>Operação: {operationId ?? 'nenhuma atribuída'}</Text>

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
                Atualizado às <Text style={{ color: '#e6edf3' }}>{formatTime(pos.capturedAt)}</Text>{' '}
                · {track.length} ponto(s) na sessão
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
          <Text style={styles.label}>Mensagens da central</Text>
          {broadcasts.length === 0 ? (
            <Text style={styles.hint}>Nenhuma diretiva recebida ainda.</Text>
          ) : (
            broadcasts.map((m, i) => (
              <View key={`${m.capturedAt}-${i}`} style={styles.broadcastItem}>
                <Text style={styles.broadcastText}>{m.text}</Text>
                <Text style={styles.broadcastMeta}>
                  {m.senderId} · {formatTime(m.capturedAt)}
                </Text>
              </View>
            ))
          )}

          {/* Compositor: o agente responde à central (E2EE — cifrado no aparelho). */}
          <View style={styles.replyRow}>
            <TextInput
              style={styles.replyInput}
              value={messageText}
              onChangeText={setMessageText}
              placeholder="Reportar à central…"
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
              <Switch value={showRoute} onValueChange={setShowRoute} />
            </View>
          </View>
          <View
            style={styles.mapWrap}
            onTouchStart={() => setScrollEnabled(false)}
            onTouchEnd={() => setScrollEnabled(true)}
            onTouchCancel={() => setScrollEnabled(true)}
          >
            <AgentMap
              track={track}
              showRoute={showRoute}
              headingUp={headingUp}
              heading={pos?.heading ?? null}
              focus={focus}
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
          <View style={[styles.row, { marginTop: 12 }]}>
            <Text style={styles.compassLabel}>Girar com o movimento (bússola)</Text>
            <Switch value={headingUp} onValueChange={setHeadingUp} />
          </View>
          <Text style={styles.hint}>
            {track.length > 0
              ? `${track.length} ponto(s) na sessão${showRoute ? '' : ' · rota oculta'}.`
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
                <Text style={styles.modalToggleLabel}>Rota</Text>
                <Switch value={showRoute} onValueChange={setShowRoute} />
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
          <View style={styles.modalMap}>
            {fullscreen ? (
              <>
                <AgentMap
                  track={track}
                  showRoute={showRoute}
                  headingUp={headingUp}
                  heading={pos?.heading ?? null}
                  focus={focus}
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
  modalToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  modalToggleLabel: { color: '#8b9aa8', fontSize: 12 },
  compassLabel: { color: '#e6edf3', fontSize: 14 },
  logout: { marginTop: 24, alignItems: 'center', padding: 16 },
  logoutText: { color: '#c1121f', fontWeight: '700' },
});
