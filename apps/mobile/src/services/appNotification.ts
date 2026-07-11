import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Notificação persistente de "app aberto". Enquanto o Cerberus está em execução, o
 * agente vê o app na barra de notificações (mesmo minimizado), podendo voltar a ele
 * com um toque. É uma notificação ONGOING (não descartável) num canal de baixa
 * prioridade (silencioso).
 *
 * Restrito ao Android: o iOS não permite notificações persistentes/ongoing.
 * Independe do rastreamento (que tem a própria notificação de foreground service).
 */
const CHANNEL_ID = 'cerberus-app';
const NOTIF_ID = 'cerberus-app-running';

let handlerSet = false;

function ensureHandler(): void {
  if (handlerSet) return;
  handlerSet = true;
  // Exibe a notificação mesmo com o app em primeiro plano.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export async function showAppRunningNotification(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    ensureHandler();
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) {
      const req = await Notifications.requestPermissionsAsync();
      if (!req.granted) return;
    }
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Cerberus em execução',
      importance: Notifications.AndroidImportance.LOW,
      showBadge: false,
    });
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIF_ID,
      content: {
        title: 'Cerberus Agente',
        body: 'Aplicativo aberto.',
        sticky: true, // ongoing (não descartável pelo usuário)
        autoDismiss: false,
        color: '#c1121f',
      },
      // Trigger apenas com channelId = apresentação IMEDIATA no canal informado.
      trigger: { channelId: CHANNEL_ID },
    });
  } catch {
    /* sem permissão/serviço de notificação — ignora */
  }
}

export async function hideAppRunningNotification(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.dismissNotificationAsync(NOTIF_ID);
  } catch {
    /* já removida */
  }
}
