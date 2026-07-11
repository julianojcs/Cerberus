import { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { login, type Session } from '../services/auth';
import { config } from '../config';

export function LoginScreen({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('agente01');
  const [password, setPassword] = useState('cerberus123');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      const session = await login(username.trim(), password);
      onLogin(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>CERBERUS</Text>
      <Text style={styles.subtitle}>Aplicação de Campo — Agente</Text>

      <TextInput
        style={styles.input}
        placeholder="Usuário"
        placeholderTextColor="#7c8b99"
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        style={styles.input}
        placeholder="Senha"
        placeholderTextColor="#7c8b99"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity style={styles.button} onPress={handleLogin} disabled={loading}>
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Entrar</Text>
        )}
      </TouchableOpacity>

      {/* Endereço do servidor em uso — ajuda a diagnosticar conexão (IP do Metro).
          Se aparecer um IP virtual (172.x/10.x) e o login falhar por "Network
          request failed", force o IP da WiFi (REACT_NATIVE_PACKAGER_HOSTNAME) ou
          defina EXPO_PUBLIC_API_URL. Ver docs/mobile-dev-wifi.md. */}
      <Text style={styles.server}>Servidor: {config.apiUrl}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f14', justifyContent: 'center', padding: 24 },
  brand: { color: '#fff', fontSize: 32, fontWeight: '800', letterSpacing: 2, textAlign: 'center' },
  subtitle: { color: '#8b9aa8', textAlign: 'center', marginBottom: 32 },
  input: {
    backgroundColor: '#1c2733',
    borderColor: '#263543',
    borderWidth: 1,
    borderRadius: 8,
    color: '#e6edf3',
    padding: 14,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#c1121f',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  error: { color: '#ff6b6b', marginBottom: 8 },
  server: { color: '#5b6b7a', fontSize: 12, textAlign: 'center', marginTop: 20 },
});
