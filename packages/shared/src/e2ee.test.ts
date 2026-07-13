import { describe, expect, it } from 'vitest';
import { generateKeyPair, openMessage, publicFromSecret, sealMessage } from './e2ee.js';

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
});
