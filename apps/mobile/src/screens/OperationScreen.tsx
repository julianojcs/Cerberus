import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import type { Session } from '../services/auth';
import { connectMqtt, disconnectMqtt, isConnected } from '../services/mqtt';
import { initTracking, startTracking, stopTracking } from '../services/geolocation';
import { outboxSize } from '../services/outbox';

/**
 * Tela operacional do agente: liga/desliga o reporte de posição e mostra o
 * status do barramento e do buffer offline.
 */
export function OperationScreen({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const operationId = session.operationIds[0];
  const agentId = session.agentId ?? session.userId;

  const [tracking, setTracking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    connectMqtt(session.token, agentId);
    const interval = setInterval(async () => {
      setConnected(isConnected());
      setPending(await outboxSize());
    }, 2000);
    return () => clearInterval(interval);
  }, [session.token, agentId]);

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
    <View style={styles.container}>
      <Text style={styles.brand}>CERBERUS</Text>
      <Text style={styles.agent}>{session.name}</Text>
      <Text style={styles.meta}>Agente: {agentId}</Text>
      <Text style={styles.meta}>
        Operação: {operationId ?? 'nenhuma atribuída'}
      </Text>

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
          Buffer offline: <Text style={{ color: pending > 0 ? '#e3b341' : '#8b9aa8' }}>{pending}</Text>{' '}
          posição(ões)
        </Text>
        <Text style={styles.hint}>
          Parado, o GPS hiberna (ping a cada 5 min). Em deslocamento, a taxa de amostragem sobe
          automaticamente.
        </Text>
      </View>

      <TouchableOpacity style={styles.logout} onPress={handleLogout}>
        <Text style={styles.logoutText}>Sair</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f14', padding: 24, paddingTop: 72 },
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
  logout: { marginTop: 'auto', alignItems: 'center', padding: 16 },
  logoutText: { color: '#c1121f', fontWeight: '700' },
});
