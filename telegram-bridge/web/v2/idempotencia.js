/**
 * FEAT-201 F0 S5 — La tabla de idempotencia de la API v2.
 *
 * Clave `(sujeto, idCliente)`. La fuente de verdad es el `Map` en memoria; el
 * archivo (`v2-idempotencia.json`) es solo su persistencia, con un único
 * escritor (este módulo) y escrituras encoladas: la última gana.
 *
 * `buscar` + `reservar` se llaman sin ningún `await` de por medio. Node corre en
 * un solo hilo, así que dos POST con la misma clave no pueden despachar dos
 * veces: el segundo encuentra la reserva del primero. El despacho que sigue a
 * `reservar` entrega el `tareaId` en forma sincrónica (`alEncolar`), antes de
 * ceder el control.
 *
 * La tabla no guarda el estado del turno: se lee del registro de tareas por
 * `tareaId`. Una entrada vence a las 24 h o cuando su tarea salió del registro
 * (que guarda hasta 200 cerradas).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { escribirAtomico } = require('../../../mcp-server/lib/fs-atomico.js');

export const ARCHIVO_IDEMPOTENCIA = 'v2-idempotencia.json';
export const VENTANA_MS = 24 * 60 * 60 * 1000;
export const RE_ID_CLIENTE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

const claveDe = (sujeto, idCliente) => `${sujeto}|${idCliente}`;

export function crearIdempotencia({ archivo = null, registro, ahora = Date.now, ventanaMs = VENTANA_MS, escribir = escribirAtomico, leer = fs } = {}) {
  const porClave = new Map();
  const porTid = new Map();
  const porTareaId = new Map();

  const indexar = (e) => {
    if (e.idCliente) porClave.set(claveDe(e.sujeto, e.idCliente), e);
    porTid.set(e.tid, e);
    if (e.tareaId) porTareaId.set(e.tareaId, e);
  };
  const quitar = (e) => {
    if (e.idCliente && porClave.get(claveDe(e.sujeto, e.idCliente)) === e) porClave.delete(claveDe(e.sujeto, e.idCliente));
    if (porTid.get(e.tid) === e) porTid.delete(e.tid);
    if (e.tareaId && porTareaId.get(e.tareaId) === e) porTareaId.delete(e.tareaId);
  };

  if (archivo) {
    try {
      const datos = JSON.parse(leer.readFileSync(archivo, 'utf8'));
      for (const e of Array.isArray(datos?.entradas) ? datos.entradas : []) {
        if (e && typeof e.tid === 'string' && typeof e.sujeto === 'string' && Number.isFinite(e.creado)) indexar(e);
      }
    } catch {}
  }

  let escribiendo = false;
  let pendiente = false;
  const persistir = () => {
    if (!archivo) return;
    if (escribiendo) { pendiente = true; return; }
    escribiendo = true;
    // Asincrónico respecto del pedido: nunca entre `buscar` y `reservar`.
    setImmediate(() => {
      try {
        escribir(archivo, JSON.stringify({ entradas: [...porTid.values()] }), { mode: 0o600 });
      } catch (err) {
        console.error(`[v2] No se pudo guardar la tabla de idempotencia: ${err.message}`);
      } finally {
        escribiendo = false;
        if (pendiente) { pendiente = false; persistir(); }
      }
    });
  };

  /** Vencida: más de 24 h, o su tarea ya no está en el registro. */
  function vencida(e) {
    if (ahora() - e.creado > ventanaMs) return true;
    return Boolean(e.tareaId) && !registro.obtener(e.tareaId);
  }

  function barrer() {
    let cambio = false;
    for (const e of [...porTid.values()]) if (vencida(e)) { quitar(e); cambio = true; }
    if (cambio) persistir();
  }

  return {
    buscar: (sujeto, idCliente) => porClave.get(claveDe(sujeto, idCliente)) || null,
    /** Por `tid` o, para los turnos que no se crearon por v2 (Telegram), `null`. */
    porId: (id) => porTid.get(id) || porTareaId.get(id) || null,
    vencida,
    reservar({ sujeto, idCliente = null, adjunto = false, reintentoDe = null }) {
      const e = { sujeto, idCliente, tid: crypto.randomUUID(), tareaId: null, creado: ahora(), adjunto: Boolean(adjunto), reintentoDe };
      indexar(e);
      persistir();
      return e;
    },
    asignarTareaId(e, tareaId) {
      e.tareaId = String(tareaId);
      porTareaId.set(e.tareaId, e);
      persistir();
    },
    deshacer(e) {
      quitar(e);
      persistir();
    },
    /** Lo que solo sabe v2 de un turno, para el productor de eventos y las lecturas. */
    extras(tareaId) {
      const e = porTareaId.get(String(tareaId));
      return e ? { tid: e.tid, idCliente: e.idCliente || null, reintentoDe: e.reintentoDe || null } : null;
    },
    barrer,
    tamano: () => porTid.size
  };
}
