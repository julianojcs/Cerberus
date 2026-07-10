import * as ImagePicker from 'expo-image-picker';
import { config } from '../config';

/**
 * Captura uma foto pela câmera e faz upload para a operação (multipart → GridFS
 * na API). Retorna `true` no sucesso, `false` se o agente cancelou. Lança em caso
 * de permissão negada ou falha de rede/servidor.
 */
export async function captureAndUploadPhoto(operationId: string, token: string): Promise<boolean> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Permissão de câmera negada.');

  const result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
  if (result.canceled || result.assets.length === 0) return false;

  const asset = result.assets[0];
  const form = new FormData();
  // No React Native o arquivo do multipart é { uri, name, type } (não um Blob).
  form.append('file', {
    uri: asset.uri,
    name: asset.fileName ?? 'foto.jpg',
    type: asset.mimeType ?? 'image/jpeg',
  } as unknown as Blob);

  const res = await fetch(`${config.apiUrl}/operations/${operationId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Falha no upload (${res.status}).`);
  return true;
}
