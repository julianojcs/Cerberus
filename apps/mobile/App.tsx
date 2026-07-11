import { useEffect, useState } from 'react';
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

  async function handleLogout() {
    await logout();
    setSession(null);
  }

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {session ? (
        <OperationScreen session={session} onLogout={handleLogout} />
      ) : (
        <LoginScreen onLogin={setSession} />
      )}
    </SafeAreaProvider>
  );
}
