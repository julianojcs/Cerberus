import { describe, expect, it } from 'vitest';
import {
  decryptBytes,
  encryptBytes,
  generateKeyPair,
  openMessage,
  publicFromSecret,
  sealMessage,
} from './e2ee.js';

describe('e2ee', () => {
  it('deriva a chave pública correta a partir da secreta', () => {
    const kp = generateKeyPair();
    expect(publicFromSecret(kp.secretKey)).toBe(kp.publicKey);
  });

  it('faz round-trip do broadcast 1→N (cada destinatário decifra o seu)', () => {
    const central = generateKeyPair();
    const ag1 = generateKeyPair();
    const ag2 = generateKeyPair();
    const recipients = [
      { id: 'AG-001', publicKey: ag1.publicKey },
      { id: 'AG-002', publicKey: ag2.publicKey },
    ];

    const envelope = sealMessage('Avançar para o ponto Bravo', central.secretKey, recipients);

    expect(openMessage(envelope, 'AG-001', ag1.secretKey)).toBe('Avançar para o ponto Bravo');
    expect(openMessage(envelope, 'AG-002', ag2.secretKey)).toBe('Avançar para o ponto Bravo');
  });

  it('não vaza conteúdo: o envelope não contém o texto em claro', () => {
    const central = generateKeyPair();
    const ag1 = generateKeyPair();
    const envelope = sealMessage('senha-secreta-123', central.secretKey, [
      { id: 'AG-001', publicKey: ag1.publicKey },
    ]);
    expect(envelope).not.toContain('senha-secreta-123');
  });

  it('devolve null para quem não é destinatário', () => {
    const central = generateKeyPair();
    const ag1 = generateKeyPair();
    const intruso = generateKeyPair();
    const envelope = sealMessage('confidencial', central.secretKey, [
      { id: 'AG-001', publicKey: ag1.publicKey },
    ]);
    // id não presente no envelope
    expect(openMessage(envelope, 'AG-999', intruso.secretKey)).toBeNull();
    // id presente, mas chave secreta errada
    expect(openMessage(envelope, 'AG-001', intruso.secretKey)).toBeNull();
  });

  it('devolve null (sem lançar) para uma mensagem de sistema em claro', () => {
    // simula um alerta de geofence publicado em claro no mesmo canal
    expect(openMessage('Entrada na zona Alfa', 'AG-001', generateKeyPair().secretKey)).toBeNull();
  });

  it('autenticação do remetente (5c): rejeita spk que não bate com o diretório', () => {
    const central = generateKeyPair();
    const ag1 = generateKeyPair();
    const recipients = [{ id: 'AG-001', publicKey: ag1.publicKey }];
    const envelope = sealMessage('ordem legítima', central.secretKey, recipients);

    // spk esperado correto (do diretório) → decifra normalmente.
    expect(openMessage(envelope, 'AG-001', ag1.secretKey, central.publicKey)).toBe('ordem legítima');
    // spk esperado de OUTRO remetente → rejeita (possível spoofing).
    const impostor = generateKeyPair();
    expect(openMessage(envelope, 'AG-001', ag1.secretKey, impostor.publicKey)).toBeNull();
    // sem expectedSenderKey → mantém o comportamento antigo (decifra).
    expect(openMessage(envelope, 'AG-001', ag1.secretKey)).toBe('ordem legítima');
  });

  it('autenticação aceita um CONJUNTO de chaves do remetente (rotação — Fase 5e-2)', () => {
    const central = generateKeyPair();
    const ag1 = generateKeyPair();
    const envelope = sealMessage('ordem', central.secretKey, [
      { id: 'AG-001', publicKey: ag1.publicKey },
    ]);
    const chaveAntiga = generateKeyPair().publicKey;
    // spk (central) ∈ {antiga, central} → decifra.
    expect(openMessage(envelope, 'AG-001', ag1.secretKey, [chaveAntiga, central.publicKey])).toBe(
      'ordem',
    );
    // spk fora do conjunto → null.
    expect(
      openMessage(envelope, 'AG-001', ag1.secretKey, [chaveAntiga, generateKeyPair().publicKey]),
    ).toBeNull();
    // conjunto vazio → sem verificação.
    expect(openMessage(envelope, 'AG-001', ag1.secretKey, [])).toBe('ordem');
  });

  it('anti-spoofing: envelope forjado com identidade trocada é barrado pelo diretório', () => {
    // O impostor cifra com a PRÓPRIA chave, mas afirma ser a central.
    const impostor = generateKeyPair();
    const central = generateKeyPair();
    const ag1 = generateKeyPair();
    const forged = sealMessage('ordem falsa', impostor.secretKey, [
      { id: 'AG-001', publicKey: ag1.publicKey },
    ]);
    // Sem verificação, decifraria; COM a chave da central (do diretório) → null.
    expect(openMessage(forged, 'AG-001', ag1.secretKey, central.publicKey)).toBeNull();
  });

  it('cifra/decifra bytes (mídia) e não vaza o conteúdo no cipher', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 128, 0, 42]);
    const { cipher, key, nonce } = encryptBytes(bytes);
    expect(Array.from(cipher)).not.toEqual(Array.from(bytes)); // cifrado ≠ claro
    const back = decryptBytes(cipher, key, nonce);
    expect(back && Array.from(back)).toEqual(Array.from(bytes));
    // chave errada → null
    expect(decryptBytes(cipher, generateKeyPair().secretKey, nonce)).toBeNull();
  });
});
