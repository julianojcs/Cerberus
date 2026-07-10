import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import type { Session } from '../services/auth';
import { connectMqtt, disconnectMqtt, isConnected } from '../services/mqtt';
import {
  getLastSample,
  initTracking,
  startTracking,
  stopTracking,
  subscribePositions,
} from '../services/geolocation';
import { outboxSize } from '../services/outbox';
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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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
          <Text style={{ color: pending > 0 ? '#e3b341' : '#8b9aa8' }}>{pending}</Text> posição(ões)
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
              Atualizado às <Text style={{ color: '#e6edf3' }}>{formatTime(pos.capturedAt)}</Text> ·{' '}
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

      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>Seu percurso</Text>
          <Switch value={showRoute} onValueChange={setShowRoute} />
        </View>
        <View style={styles.mapWrap}>
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
  logout: { marginTop: 24, alignItems: 'center', padding: 16 },
  logoutText: { color: '#c1121f', fontWeight: '700' },
});
