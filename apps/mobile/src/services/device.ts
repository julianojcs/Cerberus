import * as Application from 'expo-application';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import nacl from 'tweetnacl';

const DEVICE_ID_KEY = 'cerberus_device_id';

function randomId(): string {
  return Array.from(nacl.randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Id ESTÁVEL do dispositivo. Usa o id de hardware (androidId / idForVendor do iOS)
 * quando disponível; senão gera um UUID e persiste no SecureStore. Capturado uma vez
 * e reusado. É um controle operacional (asserido pelo cliente), não fronteira de segurança.
 */
export async function getDeviceId(): Promise<string> {
  const cached = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (cached) return cached;
  let hw: string | null = null;
  try {
    if (Platform.OS === 'android') hw = Application.getAndroidId();
    else if (Platform.OS === 'ios') hw = await Application.getIosIdForVendorAsync();
  } catch {
    hw = null;
  }
  const deviceId = hw && hw.length > 0 ? hw : randomId();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export function getDeviceLabel(): string {
  return `${Application.applicationName ?? 'Cerberus'} (${Platform.OS})`;
}

export function getDevicePlatform(): 'android' | 'ios' | 'web' {
  if (Platform.OS === 'android') return 'android';
  if (Platform.OS === 'ios') return 'ios';
  return 'web';
}
