import { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Session } from '../services/auth';
import {
  connectMqtt,
  disconnectMqtt,
  isConnected,
  subscribeBroadcast,
  type BroadcastMessage,
} from '../services/mqtt';
import {
  getLastSample,
  initTracking,
  startTracking,
  stopTracking,
  subscribePositions,
} from '../services/geolocation';
import { outboxSize } from '../services/outbox';
import { captureAndUploadPhoto } from '../services/media';
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
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(0);
  const [pos, setPos] = useState<PositionSample | null>(getLastSample());
  const [track, setTrack] = useState<TrackPoint[]>([]);
  const [showRoute, setShowRoute] = useState(true);
  // Enquanto o dedo está sobre o mapa, travamos o scroll da tela para o Leaflet
  // receber os gestos de pinça/arraste (senão o ScrollView "rouba" o multitoque).
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [broadcasts, setBroadcasts] = useState<BroadcastMessage[]>([]);
  const [uploading, setUploading] = useState(false);

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

  // Recebe diretivas da central (canal broadcast da operação).
  useEffect(() => {
    if (!operationId) return;
    return subscribeBroadcast(operationId, (message) => {
      setBroadcasts((prev) => [message, ...prev].slice(0, 20));
    });
  }, [operationId]);

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

  function handleLogout() {
    void stopTracking();
    disconnectMqtt();
    onLogout();
  }

  async function handleSendPhoto() {
    if (!operationId || uploading) return;
    setUploading(true);
    try {
      const sent = await captureAndUploadPhoto(operationId, session.token);
      if (sent) Alert.alert('Mídia enviada', 'Foto enviada à central.');
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
            <Text style={styles.label}>Reporte de posição</Text>
            <Switch value={tracking} onValueChange={toggleTracking} disabled={!operationId} />
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
            Parado, o GPS hiberna (ping a cada 5 min). Em deslocamento, a taxa de amostragem sobe
            automaticamente.
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
          onPress={handleSendPhoto}
          disabled={uploading || !operationId}
        >
          <Text style={styles.photoBtnText}>
            {uploading ? 'Enviando foto…' : '📷 Enviar foto à central'}
          </Text>
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
            <AgentMap track={track} showRoute={showRoute} />
          </View>
          <Text style={styles.hint}>
            {track.length > 0
              ? `${track.length} ponto(s) na sessão${showRoute ? '' : ' · rota oculta'}.`
              : 'O trajeto aparece aqui conforme você se desloca (requer rede para os mapas).'}
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
              <Switch value={showRoute} onValueChange={setShowRoute} />
              <TouchableOpacity onPress={() => setFullscreen(false)} hitSlop={8}>
                <Text style={styles.modalClose}>Fechar ✕</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.modalMap}>
            {fullscreen ? <AgentMap track={track} showRoute={showRoute} /> : null}
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
  photoBtn: {
    marginTop: 24,
    backgroundColor: '#c1121f',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  photoBtnDisabled: { opacity: 0.5 },
  photoBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  percursoActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  expandIcon: { color: '#8b9aa8', fontSize: 22, fontWeight: '700' },
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
  logout: { marginTop: 24, alignItems: 'center', padding: 16 },
  logoutText: { color: '#c1121f', fontWeight: '700' },
});
