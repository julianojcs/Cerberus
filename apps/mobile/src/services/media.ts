import * as ImagePicker from 'expo-image-picker';
import { config } from '../config';

export interface PickedPhoto {
  uri: string;
  name: string;
  type: string;
}

/** Abre a câmera e retorna a foto capturada (ou null se cancelado). */
export async function pickPhoto(): Promise<PickedPhoto | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Permissão de câmera negada.');

  const result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
  if (result.canceled || result.assets.length === 0) return null;

  const a = result.assets[0];
  return { uri: a.uri, name: a.fileName ?? 'foto.jpg', type: a.mimeType ?? 'image/jpeg' };
}

/**
 * Envia a foto para a operação (multipart → GridFS na API), com legenda e geotag
 * opcionais. Os campos de texto vão ANTES do arquivo para a API lê-los.
 */
export async function uploadPhoto(
  operationId: string,
  token: string,
  photo: PickedPhoto,
  opts: { caption?: string; lat?: number | null; lng?: number | null } = {},
): Promise<void> {
  const form = new FormData();
  if (opts.caption?.trim()) form.append('caption', opts.caption.trim());
  if (opts.lat != null && opts.lng != null) {
    form.append('lat', String(opts.lat));
    form.append('lng', String(opts.lng));
  }
  // No React Native o arquivo do multipart é { uri, name, type } (não um Blob).
  form.append('file', {
    uri: photo.uri,
    name: photo.name,
    type: photo.type,
  } as unknown as Blob);

  const res = await fetch(`${config.apiUrl}/operations/${operationId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Falha no upload (${res.status}).`);
}
