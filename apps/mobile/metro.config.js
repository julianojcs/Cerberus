// Metro config do app de campo.
//
// O `mqtt` (mqtt.js) foi escrito para Node/browser. No React Native isso dá dois
// problemas:
//  1. Ele importa módulos core do Node (buffer, events, stream, process) — que o
//     RN não fornece. Mapeamos para polyfills abaixo + globais em src/polyfills.ts.
//  2. O entry principal (build/index.js) puxa TODOS os transportes (ws, tcp, socks),
//     e os de TCP/SOCKS importam `net`/`tls`/`dns` (inexistentes no RN). Nós só
//     usamos WebSocket, então apontamos `mqtt` para o bundle de browser pré-montado
//     (dist/mqtt.esm.js), que contém só o transporte WS e não toca nesses módulos.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Caminho direto (o campo `exports` do mqtt mapeia ./dist/* -> ./dist/*.js, o que
// atrapalha require.resolve com a extensão .js). O bundle existe neste caminho.
const mqttBrowser = path.resolve(__dirname, 'node_modules/mqtt/dist/mqtt.esm.js');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'mqtt') {
    return { type: 'sourceFile', filePath: mqttBrowser };
  }
  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('readable-stream'),
  buffer: require.resolve('buffer'),
  events: require.resolve('events'),
  process: require.resolve('process'),
  url: require.resolve('url'),
};

module.exports = config;
