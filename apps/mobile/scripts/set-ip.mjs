#!/usr/bin/env node
/**
 * Detecta o IP LOCAL ATIVO (o da rota padrão de internet — Wi-Fi/Ethernet, não o
 * adaptador virtual do WSL/Docker) e grava em `apps/mobile/.env` as URLs de API e
 * broker. Roda automaticamente no `npm start`, então trocar de rede não exige mais
 * editar o IP à mão. Preserva o resto do `.env` — e NÃO toca em endpoints explícitos
 * públicos (`https://`/`wss://`, ex.: deploy Render/HiveMQ): só atualiza valores de
 * LAN/localhost/vazios. Nunca falha o start (sai 0).
 *
 * O truque do socket UDP "conectado" a um IP público devolve o IP da interface que
 * o SO usaria para sair à internet — evita escolher o 172.x do WSL por engano.
 */
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

function activeIp() {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    let done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      try {
        s.close();
      } catch {
        /* já fechado */
      }
      resolve(ip);
    };
    s.once('error', () => finish(null));
    setTimeout(() => finish(null), 1500);
    try {
      s.connect(53, '8.8.8.8', () => finish(s.address().address));
    } catch {
      finish(null);
    }
  });
}

const ip = await activeIp();
if (!ip || ip.startsWith('127.')) {
  console.warn('[set-ip] IP local não detectado — mantendo o .env atual.');
  process.exit(0);
}

const api = `http://${ip}:3000`;
const mqtt = `ws://${ip}:9001`;
const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : [];

// Só sobrescreve valores de LAN/localhost/vazios. Um endpoint EXPLÍCITO público/
// seguro (`https://` ou `wss://` — ex.: deploy Render/HiveMQ) é PRESERVADO: o
// set-ip nunca estraga a config de produção ao trocar de rede.
function setVar(key, value) {
  const idx = lines.findIndex((l) => l.replace(/^#\s*/, '').startsWith(`${key}=`));
  if (idx >= 0) {
    const current = lines[idx].slice(lines[idx].indexOf('=') + 1).trim();
    if (/^(https|wss):\/\//i.test(current)) {
      console.log(`[set-ip] ${key} preservado (endpoint público): ${current}`);
      return;
    }
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
  console.log(`[set-ip] ${key} = ${value}`);
}

setVar('EXPO_PUBLIC_API_URL', api);
setVar('EXPO_PUBLIC_MQTT_WS_URL', mqtt);
writeFileSync(envPath, lines.join('\n'));
console.log(`[set-ip] host local detectado: ${ip}`);
