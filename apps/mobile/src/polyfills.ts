// Polyfills de globais exigidos pelo mqtt.js (e readable-stream) no React Native.
// DEVE ser importado ANTES de qualquer código que use `mqtt` — por isso é o
// primeiro import do index.ts.
// `react-native-get-random-values` provê `crypto.getRandomValues`, exigido pelo
// tweetnacl (E2EE) para gerar chaves/nonces — precisa vir antes de qualquer import
// de cripto.
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import { Buffer } from 'buffer';

const g = global as unknown as { Buffer?: unknown };
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}
