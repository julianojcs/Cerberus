import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import naclUtil from 'tweetnacl-util';
import { config } from '../config';
import { encryptBytes, sealMessage } from '../shared/e2ee';
import { fetchRecipients, getSecretKey } from './keys';
import type { Session } from './auth';

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
 * Envia a foto à operação com **E2EE**: cifra os bytes da imagem (secretbox) e
 * embrulha a legenda + geotag + a chave da imagem num envelope por destinatário
 * (diretório da operação). Sobe o blob OPACO ao GridFS + o envelope; o servidor
 * nunca vê a imagem nem a legenda. O binário cifrado passa por um arquivo temporário
 * (o multipart do RN envia arquivo por `uri`).
 */
export async function uploadPhoto(
  operationId: string,
  session: Session,
  photo: PickedPhoto,
  opts: { caption?: string; lat?: number | null; lng?: number | null } = {},
): Promise<void> {
  const secretKey = await getSecretKey(session.userId);
  if (!secretKey) throw new Error('Chave E2EE ausente — refaça o login.');

  // Lê a imagem, cifra os bytes com uma chave nova.
  const imgB64 = await FileSystem.readAsStringAsync(photo.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const { cipher, key, nonce } = encryptBytes(naclUtil.decodeBase64(imgB64));

  // Envelope: legenda + geotag + chave/nonce da imagem + mime, cifrado por destinatário.
  const recipients = await fetchRecipients(session, operationId);
  if (recipients.length === 0) throw new Error('Nenhum destinatário com chave registrada.');
  const metadata = JSON.stringify({
    caption: opts.caption?.trim() || undefined,
    lat: opts.lat ?? undefined,
    lng: opts.lng ?? undefined,
    mime: photo.type,
    k: key,
    n: nonce,
  });
  const ciphertext = sealMessage(metadata, secretKey, recipients);

  // O blob cifrado vai por arquivo temporário (o multipart do RN envia por `uri`).
  const tempUri = `${FileSystem.cacheDirectory}enc_${Date.now()}.bin`;
  await FileSystem.writeAsStringAsync(tempUri, naclUtil.encodeBase64(cipher), {
    encoding: FileSystem.EncodingType.Base64,
  });
  try {
    const form = new FormData();
    form.append('ciphertext', ciphertext); // ANTES do arquivo (para file.fields)
    form.append('file', {
      uri: tempUri,
      name: 'media.bin',
      type: 'application/octet-stream',
    } as unknown as Blob);

    const res = await fetch(`${config.apiUrl}/operations/${operationId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Falha no upload (${res.status}).`);
  } finally {
    await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
  }
}
