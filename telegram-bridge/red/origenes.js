/**
 * FEAT-091 §6.4 — De qué nodo es cada mensaje que un nodo mandó por un bot del
 * servidor: `<bot>:<chat>:<messageId>` → id del nodo. Lo usan la regla 3 del
 * ruteo (una reacción o una respuesta vuelven a quien mandó el mensaje) y el
 * control de ediciones (un nodo solo edita lo suyo).
 *
 * Tope de 5000 entradas (sale la más vieja) y persistido en `origenes.json`
 * como mucho cada 5 s, así un reinicio del servidor no lo vacía.
 */

import path from 'node:path';
import { leerJson, escribirJson } from './almacen.js';

export const TOPE_ORIGENES = 5000;
const GUARDAR_CADA_MS = 5000;

export function crearOrigenes({ dataDir, tope = TOPE_ORIGENES, guardarCadaMs = GUARDAR_CADA_MS, ahora = () => Date.now() } = {}) {
  const archivo = dataDir ? path.join(dataDir, 'origenes.json') : null;
  // Un Map conserva el orden de inserción: la primera clave es la más vieja.
  const mapa = new Map();
  if (archivo) {
    const guardado = leerJson(archivo, { entradas: [] });
    for (const [k, v] of Array.isArray(guardado.entradas) ? guardado.entradas : []) {
      if (typeof k === 'string' && typeof v === 'string') mapa.set(k, v);
    }
  }
  let ultimoGuardado = 0;
  let pendiente = null;

  const clave = (bot, chat, messageId) => `${bot}:${chat}:${messageId}`;

  function guardar() {
    pendiente = null;
    ultimoGuardado = ahora();
    if (!archivo) return;
    try { escribirJson(archivo, { entradas: [...mapa] }); } catch {}
  }

  function programarGuardado() {
    if (!archivo || pendiente) return;
    const falta = ultimoGuardado + guardarCadaMs - ahora();
    if (falta <= 0) return guardar();
    pendiente = setTimeout(guardar, falta);
    pendiente.unref?.();
  }

  return {
    anotar(bot, chat, messageId, nodo) {
      if (messageId === undefined || messageId === null) return;
      const k = clave(bot, chat, messageId);
      mapa.delete(k);
      mapa.set(k, String(nodo));
      while (mapa.size > tope) mapa.delete(mapa.keys().next().value);
      programarGuardado();
    },
    de(bot, chat, messageId) {
      return mapa.get(clave(bot, chat, messageId)) || null;
    },
    tamano: () => mapa.size,
    guardarYa: guardar
  };
}
