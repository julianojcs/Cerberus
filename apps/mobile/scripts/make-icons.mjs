#!/usr/bin/env node
/**
 * Gera os ícones do app a partir da logo TRANSPARENTE (fonte de verdade da marca):
 *   fonte:  assets/brand/logo.png  (PNG com FUNDO TRANSPARENTE)
 *   saídas:
 *     - apps/mobile/assets/icon.png          → OPACO (logo sobre fundo claro). iOS
 *       exige ícone sem transparência; serve também de fallback legado no Android.
 *     - apps/mobile/assets/adaptive-icon.png → TRANSPARENTE, logo em ~66% (zona
 *       segura do adaptativo Android; o launcher recorta ~33% das bordas).
 *
 * Uso: troque `assets/brand/logo.png` pela nova logo (transparente) e rode
 * `npm run make-icons` (em apps/mobile). Depois `npm run android` reinstala.
 *
 * jimp é 100% JS (sem build nativo); é usado só aqui, em tempo de dev.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const Jimp = require('jimp');

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // apps/mobile
const SOURCE = join(root, '..', '..', 'assets', 'brand', 'logo.png');
const OUT_ICON = join(root, 'assets', 'icon.png');
const OUT_ADAPTIVE = join(root, 'assets', 'adaptive-icon.png');

const SIZE = 1024;
const BG = 0xffffffff; // branco OPACO (a logo é escura → fundo claro)
const ICON_SCALE = 0.8; // iOS/legado: preenche mais, pequena margem
const ADAPTIVE_SCALE = 0.66; // Android: zona segura do adaptativo

/** Recorta a moldura transparente ao redor da logo (bounding box do conteúdo). */
function trim(img) {
  const { width: w, height: h, data: d } = img.bitmap;
  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0,
    found = false;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > 16) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  return found ? img.clone().crop(minX, minY, maxX - minX + 1, maxY - minY + 1) : img;
}

/** Logo escalada para `scale` do canvas, centralizada sobre `background`. */
function centered(logo, scale, background) {
  const canvas = new Jimp(SIZE, SIZE, background);
  const fit = logo.clone().scaleToFit(Math.round(SIZE * scale), Math.round(SIZE * scale));
  const ox = Math.round((SIZE - fit.bitmap.width) / 2);
  const oy = Math.round((SIZE - fit.bitmap.height) / 2);
  return canvas.composite(fit, ox, oy);
}

const src = await Jimp.read(SOURCE);
const logo = trim(src);
await centered(logo, ICON_SCALE, BG).writeAsync(OUT_ICON);
await centered(logo, ADAPTIVE_SCALE, 0x00000000).writeAsync(OUT_ADAPTIVE);

console.log(`Ícones gerados de ${SOURCE}:`);
console.log(`  icon.png          (iOS/legado): logo em ${ICON_SCALE * 100}% sobre #ffffff (opaco)`);
console.log(`  adaptive-icon.png (Android)   : logo em ${ADAPTIVE_SCALE * 100}% (transparente)`);
