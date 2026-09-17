/**
 * FEAT-065 — Adjuntos entrantes de Telegram.
 *
 * Hasta acá el bot contestaba «todavía no proceso archivos entrantes, pega el
 * contenido como texto, o dime la ruta del archivo en tu equipo». Este módulo
 * cumple esa promesa desde el otro lado: guarda el archivo en el directorio de
 * datos del bridge y devuelve **la ruta**, que es exactamente el contrato que
 * ese mensaje ya ofrecía. No hay extracción, ni OCR, ni visión: eso es otra
 * feature y no hace falta para que sirva.
 *
 * La regla que ordena todo lo demás: **un adjunto es material, nunca una
 * instrucción**. La ruta viaja al pedido de una tarjeta; el contenido no se
 * inyecta en ningún prompt. Quien decida leerlo es un agente, con sus propios
 * permisos, y recién cuando el usuario lance la tarjeta.
 *
 * Lo que entra viene de afuera, así que:
 *
 * - **El nombre se construye acá, nunca se confía.** `file_name` lo controla
 *   quien manda el mensaje: puede traer `..`, separadores, dos puntos de una
 *   unidad de Windows, un nombre reservado (`CON`, `NUL`, `LPT1`) o 4 KB de
 *   basura. Del original solo se conserva un slug de caracteres seguros, y
 *   siempre con un prefijo único: dos archivos con el mismo nombre no se pisan.
 * - **Lista blanca de extensiones, no lista negra.** Una lista negra siempre
 *   olvida una (`.cmd`, `.scr`, `.msi`, `.lnk`, `.jar`…). Solo pasan imágenes y
 *   texto plano; nada ejecutable, nada de scripts, nada de archivos
 *   comprimidos, que esconden su contenido hasta que alguien los abre.
 * - **Dos topes.** Uno por archivo y uno para el directorio entero, porque esto
 *   escribe en disco a pedido de un mensaje. Al llenarse se rechaza con un
 *   motivo claro: no se borra nada por las suyas (limpiar es otra cosa, y es
 *   del usuario). El del directorio es un tope **blando**: se mide antes de
 *   escribir, así que dos adjuntos a la vez podrían pasarlo por lo que ocupe
 *   uno (10 MB como mucho) antes de que el siguiente se rechace. No se pone un
 *   lock por eso: el daemon atiende un update por vez, el exceso es acotado y
 *   conocido, y un lock acá compraría muy poco a cambio de otra pieza que
 *   puede quedarse trabada.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bridgeDataDirPath } from './paths.js';

/** Telegram no deja bajar más de 20 MB; esto es nuestro techo, más bajo. */
export const TOPE_ARCHIVO_BYTES = 10 * 1024 * 1024;
/** Techo del directorio entero. Al pasarse, se rechaza y se avisa. */
export const TOPE_TOTAL_BYTES = 200 * 1024 * 1024;
export const TOPE_SLUG = 40;

/**
 * Lo único que se acepta. Imágenes (la foto del error) y texto plano (el log,
 * el stack trace, el csv). Nada que un doble clic pueda ejecutar.
 */
export const EXTENSIONES_PERMITIDAS = Object.freeze([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
  'txt', 'log', 'md', 'json', 'yaml', 'yml', 'csv', 'tsv', 'xml', 'diff', 'patch', 'ini', 'toml'
]);

export function dirAdjuntos(base = bridgeDataDirPath()) {
  return path.join(base, 'adjuntos');
}

/**
 * Extensión en minúsculas y sin punto, solo si está en la lista blanca.
 * Se mira el ÚLTIMO segmento: `informe.txt.exe` es un `.exe`.
 */
export function extensionPermitida(nombre) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(nombre || '').trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return EXTENSIONES_PERMITIDAS.includes(ext) ? ext : null;
}

/**
 * Slug del nombre original, solo para que el archivo sea reconocible a ojo.
 * No es identidad: la unicidad la da el prefijo de `nombreSeguro`.
 */
export function slugDeNombre(nombre) {
  const base = String(nombre || '')
    .trim()                     // igual que `extensionPermitida`: si no, un
                                // nombre con espacios al final conserva su
                                // extensión dentro del slug («…-md.md»)
    .replace(/\\/g, '/')        // un separador de Windows no parte el basename
    .split('/').pop()           // cualquier ruta que venga en el nombre se descarta
    .replace(/\.[A-Za-z0-9]{1,10}$/, '');
  const limpio = base
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TOPE_SLUG)
    .replace(/-+$/, '');
  return limpio || 'adjunto';
}

/**
 * El nombre con el que se guarda. Siempre `<fecha>-<azar>-<slug>.<ext>`: nunca
 * contiene nada del original que no haya pasado por el slug, así que no puede
 * escaparse del directorio ni chocar con un nombre reservado de Windows.
 */
export function nombreSeguro(nombreOriginal, { ahora = () => new Date(), azar = () => crypto.randomBytes(3).toString('hex') } = {}) {
  const ext = extensionPermitida(nombreOriginal);
  if (!ext) return { ok: false, motivo: 'extension' };
  const d = ahora();
  const sello = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0')
  ].join('');
  return { ok: true, nombre: `${sello}-${azar()}-${slugDeNombre(nombreOriginal)}.${ext}`, ext };
}

/** Bytes ocupados por el directorio. Un archivo ilegible se cuenta como 0. */
export function espacioUsado(dir) {
  let total = 0;
  let entradas;
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entradas) {
    if (!e.isFile()) continue;
    try { total += fs.statSync(path.join(dir, e.name)).size; } catch {}
  }
  return total;
}

const MOTIVOS = Object.freeze({
  extension: (nombre) => `No guardo «${nombre}»: solo acepto imágenes y texto plano (${EXTENSIONES_PERMITIDAS.join(', ')}). Nada ejecutable.`,
  vacio: () => 'El archivo llegó vacío.',
  grande: () => `El archivo pasa de ${Math.round(TOPE_ARCHIVO_BYTES / (1024 * 1024))} MB.`,
  lleno: (_, dir) => `La carpeta de adjuntos llegó a su tope de ${Math.round(TOPE_TOTAL_BYTES / (1024 * 1024))} MB. Hacé lugar en ${dir}.`,
  escritura: () => 'No se pudo escribir el archivo (mirá daemon.log).'
});

export function explicarMotivo(motivo, nombre, dir) {
  return (MOTIVOS[motivo] || (() => 'No se pudo guardar el adjunto.'))(nombre, dir);
}

/**
 * Guarda los bytes ya descargados. Separado de la descarga a propósito: todo
 * lo que decide (nombre, extensión, topes) se prueba sin red.
 *
 * @returns {{ ok: true, ruta: string, nombre: string, bytes: number } | { ok: false, motivo: string }}
 */
export function guardarAdjunto({ dir = dirAdjuntos(), nombreOriginal, contenido } = {}) {
  if (!Buffer.isBuffer(contenido) || contenido.length === 0) return { ok: false, motivo: 'vacio' };
  if (contenido.length > TOPE_ARCHIVO_BYTES) return { ok: false, motivo: 'grande' };

  const seguro = nombreSeguro(nombreOriginal);
  if (!seguro.ok) return { ok: false, motivo: seguro.motivo };

  // El tope del directorio se mira con el archivo nuevo incluido.
  if (espacioUsado(dir) + contenido.length > TOPE_TOTAL_BYTES) return { ok: false, motivo: 'lleno' };

  const ruta = path.join(dir, seguro.nombre);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // `wx`: nunca pisar. Con el prefijo único no debería chocar; si choca, es
    // preferible fallar a sobrescribir algo que el usuario todavía no usó.
    fs.writeFileSync(ruta, contenido, { flag: 'wx' });
  } catch (err) {
    console.error(`[adjuntos] No se pudo guardar ${ruta}: ${err.message}`);
    return { ok: false, motivo: 'escritura' };
  }
  return { ok: true, ruta, nombre: seguro.nombre, bytes: contenido.length };
}

/**
 * De qué archivo habla un mensaje, sin decidir nada todavía. Devuelve el
 * `file_id` y el nombre que el usuario cree que tiene.
 *
 * Una foto llega sin nombre y en varios tamaños: se toma el último, que es el
 * más grande, y se le pone un `.jpg` (Telegram las recodifica a JPEG).
 */
export function adjuntoDelMensaje(mensaje = {}) {
  if (mensaje.document) {
    return { fileId: mensaje.document.file_id, nombreOriginal: mensaje.document.file_name || 'documento', clase: 'documento' };
  }
  if (Array.isArray(mensaje.photo) && mensaje.photo.length) {
    const grande = mensaje.photo[mensaje.photo.length - 1];
    return { fileId: grande.file_id, nombreOriginal: 'foto.jpg', clase: 'foto' };
  }
  return null;
}
