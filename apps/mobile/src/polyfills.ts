// Polyfills de globais exigidos pelo mqtt.js (e readable-stream) no React Native.
// DEVE ser importado ANTES de qualquer código que use `mqtt` — por isso é o
// primeiro import do index.ts.
import 'react-native-url-polyfill/auto';
import { Buffer } from 'buffer';

const g = global as unknown as { Buffer?: unknown };
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}
