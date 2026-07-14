import { useEffect, useRef, useState } from 'react';
import { Alert, BackHandler } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LoginScreen } from './src/screens/LoginScreen';
import { OperationScreen } from './src/screens/OperationScreen';
import { getSession, logout, type Session } from './src/services/auth';
import { setUnauthorizedHandler } from './src/services/http';
import { clearSecretKey } from './src/services/keys';
import { stopTracking } from './src/services/geolocation';
import { disconnectMqtt } from './src/services/mqtt';
import {
  hideAppRunningNotification,
  showAppRunningNotification,
} from './src/services/appNotification';

/** Mensagem pt-BR do logout forçado, conforme o motivo (reason) do 401. */
function forcedLogoutMessage(reason?: string): string {
  switch (reason) {
    case 'device_blocked':
      return 'Este dispositivo foi bloqueado pela central.';
    case 'account_blocked':
      return 'Sua conta foi bloqueada pela central.';
    case 'kicked':
      return 'Sua sessão foi encerrada pela central.';
    default:
      return 'Sessão expirada. Faça login novamente.';
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    getSession()
      .then(setSession)
      .finally(() => setReady(true));
  }, []);

  // Logout FORÇADO quando a central derruba/bloqueia: o 401 do servidor dispara este
  // handler global (services/http). Para o rastreamento + MQTT, apaga a chave E2EE se
  // o dispositivo foi bloqueado, e volta ao LoginScreen (não fecha o app).
  useEffect(() => {
    setUnauthorizedHandler(async (reason) => {
      const s = sessionRef.current;
      try {
        await stopTracking();
      } catch {
        /* ignora */
      }
      disconnectMqtt();
      if (reason === 'device_blocked' && s) {
        await clearSecretKey(s.userId).catch(() => {});
      }
      await hideAppRunningNotification();
      await logout();
      setSession(null);
      Alert.alert('Sessão encerrada', forcedLogoutMessage(reason));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Enquanto o app está aberto, mantém a notificação persistente (Android).
  useEffect(() => {
    void showAppRunningNotification();
    return () => {
      void hideAppRunningNotification();
    };
  }, []);

  // Logado: o botão "voltar" NÃO fecha o app — ele segue em execução (na barra de
  // notificações). Para encerrar de fato, o usuário usa o botão "Sair".
  useEffect(() => {
    if (!session) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [session]);

  // Botão "Sair": encerra a sessão e FECHA o aplicativo (única forma de sair).
  async function handleExit() {
    await hideAppRunningNotification();
    await logout();
    BackHandler.exitApp();
  }

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {session ? (
        <OperationScreen session={session} onLogout={handleExit} />
      ) : (
        <LoginScreen onLogin={setSession} />
      )}
    </SafeAreaProvider>
  );
}
