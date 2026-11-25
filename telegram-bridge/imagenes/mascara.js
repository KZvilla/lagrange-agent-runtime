/**
 * FEAT-212 §5 — La máscara de un retoque: un lector PNG mínimo y el chequeo de la zona.
 *
 * El plugin no tiene dependencias de imágenes. La máscara llega achicada a
 * 256×256 por el flujo; se lee con `zlib` y los cinco filtros de PNG. Se admite
 * solo 8 bits, sin entrelazado, en gris, RGB o RGBA: cualquier otra cosa es «no
 * se puede leer», y el retoque sigue sin chequeo.
 */

import zlib from 'node:zlib';

const FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LADO_MAX = 1024;
const TOPE_INFLADO = 5 * 1024 * 1024;
const CANALES = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });

/** Con al menos esta parte de los píxeles marcada, la zona está; con más de la otra, la máscara cubre toda la foto. */
export const UMBRAL = 0.0005;
export const TECHO = 0.98;
export const TOPE_MASCARA = 256 * 1024;

/** Los píxeles de un PNG: `{ ancho, alto, canales, datos }`, o `null` si no se puede leer. */
export function leerPng(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(FIRMA)) return null;
    let ancho = 0;
    let alto = 0;
    let canales = 0;
    const idat = [];
    for (let p = 8; p + 8 <= bytes.length;) {
      const largo = bytes.readUInt32BE(p);
      const tipo = bytes.toString('latin1', p + 4, p + 8);
      if (p + 12 + largo > bytes.length) return null;
      const datos = bytes.subarray(p + 8, p + 8 + largo);
      if (tipo === 'IHDR') {
        ancho = datos.readUInt32BE(0);
        alto = datos.readUInt32BE(4);
        canales = CANALES[datos[9]] || 0;
        // Antes de descomprimir nada.
        if (!ancho || !alto || ancho > LADO_MAX || alto > LADO_MAX || datos[8] !== 8 || !canales || datos[9] === 4 || datos[12] !== 0) return null;
      } else if (tipo === 'IDAT') idat.push(datos);
      else if (tipo === 'IEND') break;
      p += 12 + largo;
    }
    if (!ancho || !idat.length) return null;
    const crudo = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: TOPE_INFLADO });
    const fila = ancho * canales;
    if (crudo.length < (fila + 1) * alto) return null;
    const salida = Buffer.alloc(fila * alto);
    for (let y = 0; y < alto; y++) {
      const filtro = crudo[y * (fila + 1)];
      if (filtro > 4) return null;
      for (let x = 0; x < fila; x++) {
        const v = crudo[y * (fila + 1) + 1 + x];
        const a = x >= canales ? salida[y * fila + x - canales] : 0;
        const b = y > 0 ? salida[(y - 1) * fila + x] : 0;
        const c = x >= canales && y > 0 ? salida[(y - 1) * fila + x - canales] : 0;
        let suma = 0;
        if (filtro === 1) suma = a;
        else if (filtro === 2) suma = b;
        else if (filtro === 3) suma = (a + b) >> 1;
        else if (filtro === 4) {
          const pr = a + b - c;
          const da = Math.abs(pr - a);
          const db = Math.abs(pr - b);
          const dc = Math.abs(pr - c);
          suma = da <= db && da <= dc ? a : db <= dc ? b : c;
        }
        salida[y * fila + x] = (v + suma) & 0xff;
      }
    }
    return { ancho, alto, canales, datos: salida };
  } catch {
    return null;
  }
}

/** Qué parte de la foto marca la máscara (0 a 1), o `null` si no se puede leer. Un píxel cuenta con luminancia de 128 o más. */
export function parteMarcada(bytes) {
  const png = leerPng(bytes);
  if (!png) return null;
  const { ancho, alto, canales, datos } = png;
  let marcados = 0;
  for (let i = 0; i < ancho * alto; i++) {
    const p = i * canales;
    const luz = canales === 1 ? datos[p] : (datos[p] + datos[p + 1] + datos[p + 2]) / 3;
    if (luz >= 128) marcados++;
  }
  return marcados / (ancho * alto);
}

/** `'ok'`, `'vacia'`, `'cubre'` o `'ilegible'`. */
export function chequearMascara(bytes) {
  const parte = parteMarcada(bytes);
  if (parte === null) return 'ilegible';
  if (parte < UMBRAL) return 'vacia';
  if (parte > TECHO) return 'cubre';
  return 'ok';
}
