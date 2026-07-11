import { useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LoginScreen } from './src/screens/LoginScreen';
import { OperationScreen } from './src/screens/OperationScreen';
import { getSession, logout, type Session } from './src/services/auth';
import {
  hideAppRunningNotification,
  showAppRunningNotification,
} from './src/services/appNotification';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getSession()
      .then(setSession)
      .finally(() => setReady(true));
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
