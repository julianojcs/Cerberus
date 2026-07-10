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
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Entrar</Text>}
      </TouchableOpacity>
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
});
