/**
 * FEAT-092 — Registro de sesiones de Claude Code y envío de mensajes entre
 * ellas, en el daemon del nodo. En este paso, dentro del mismo nodo (sirve en
 * `rol = solo`); entre nodos llega con FEAT-089.
 *
 * El registro vive en memoria. Cada MCP se da de alta al arrancar (y deja su
 * alta en `buzones/<sesion>.mcp`, así un daemon que se reinicia lo reconstruye)
 * y el daemon barre cada minuto las que tienen el MCP muerto: MCP y daemon están
 * en la misma máquina, no hace falta latido.
 *
 * `de` lo pone el daemon a partir del registro, no la sesión. Un proceso local
 * malicioso podría escribir un buzón a mano: dentro del mismo usuario no hay
 * frontera (FEAT-092 §6.1), y no se intenta impedir.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { redactSecrets } from './policy.js';

const require = createRequire(import.meta.url);
const buzones = require('../mcp-server/lib/buzones.js');

export const FORMA_NOMBRE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TOPE_TEXTO_BYTES = 8 * 1024;
export const TOPE_CADENA = 10;
export const TOPE_POR_HORA = 30;
const HORA_MS = 3600 * 1000;

/** `My Project` → `my-project`, `mi_repo` → `mi-repo`; si no queda nada, `sesion`. */
export function slugNombre(texto) {
  const s = String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return FORMA_NOMBRE.test(s) ? s : 'sesion';
}

export function crearRegistro({ dataDir, nodo = 'local', vivo = buzones.pidVivo, ahora = Date.now, log = () => {} } = {}) {
  const sesiones = new Map();
  const envios = new Map();

  const ocupado = (nombre, salvo) => [...sesiones.values()].some((s) => s.nombre === nombre && s.sesion !== salvo);
  const libre = (base, salvo) => {
    if (!ocupado(base, salvo)) return base;
    for (let i = 2; ; i++) {
      const sufijo = `-${i}`;
      const nombre = `${base.slice(0, 32 - sufijo.length).replace(/-+$/g, '')}${sufijo}`;
      if (!ocupado(nombre, salvo)) return nombre;
    }
  };
  const publica = (s) => ({
    nombre: s.nombre, nodo, host: s.host, proyecto: s.cwd ? path.basename(s.cwd) : null,
    desde: s.desde, entrega: s.entrega, silenciada: s.silenciada
  });

  function alta({ sesion, host = null, cwd = null, nombre = null, mcpPid, claudePid = null } = {}) {
    if (!buzones.sesionValida(sesion)) return { ok: false, codigo: 400, error: 'Sesión inválida.' };
    if (!Number.isInteger(mcpPid) || mcpPid <= 0) return { ok: false, codigo: 400, error: 'Falta el pid del MCP.' };
    const previa = sesiones.get(sesion);
    const pedido = typeof nombre === 'string' && FORMA_NOMBRE.test(nombre) ? nombre : null;
    const s = {
      sesion,
      host: typeof host === 'string' ? host.slice(0, 64) : null,
      cwd: typeof cwd === 'string' ? cwd : null,
      mcpPid,
      claudePid: Number.isInteger(claudePid) && claudePid > 0 ? claudePid : null,
      // Sin el proceso de Claude Code no hay cómo encontrar el buzón desde un hook.
      entrega: Number.isInteger(claudePid) && claudePid > 0 ? 'hooks' : 'manual',
      silenciada: previa?.silenciada ?? false,
      desde: previa?.desde ?? new Date(ahora()).toISOString(),
      nombre: previa?.nombre ?? libre(pedido || slugNombre(cwd ? path.basename(cwd) : ''), sesion)
    };
    sesiones.set(sesion, s);
    if (!previa) log(`[mensajes] alta ${nodo}/${s.nombre} (${s.entrega})`);
    return { ok: true, sesion: publica(s) };
  }

  function baja(sesion) {
    const s = sesiones.get(sesion);
    if (!s) return { ok: true };
    sesiones.delete(sesion);
    log(`[mensajes] baja ${nodo}/${s.nombre}`);
    return { ok: true };
  }

  /** Saca las sesiones cuyo MCP ya no existe. */
  function barrer() {
    let n = 0;
    for (const s of [...sesiones.values()]) {
      if (!vivo(s.mcpPid)) { baja(s.sesion); n++; }
    }
    return n;
  }

  function reconstruir() {
    for (const a of buzones.altasVivas(dataDir, { vivo })) alta(a);
    return sesiones.size;
  }

  function renombrar(sesion, nombre) {
    const s = sesiones.get(sesion);
    if (!s) return { ok: false, codigo: 404, error: 'Esta sesión no está registrada.' };
    if (typeof nombre !== 'string' || !FORMA_NOMBRE.test(nombre)) {
      return { ok: false, codigo: 400, error: 'Nombre inválido: minúsculas, dígitos y guiones, hasta 32.' };
    }
    if (ocupado(nombre, sesion)) return { ok: false, codigo: 409, error: `Ya hay una sesión llamada ${nombre}.` };
    s.nombre = nombre;
    return { ok: true, sesion: publica(s) };
  }

  function silenciar(sesion, si) {
    const s = sesiones.get(sesion);
    if (!s) return { ok: false, codigo: 404, error: 'Esta sesión no está registrada.' };
    s.silenciada = si === true;
    return { ok: true, sesion: publica(s) };
  }

  function lista() {
    return [...sesiones.values()].map(publica);
  }

  /**
   * Manda un mensaje a una sesión del mismo nodo. No hay cola: si no se puede
   * entregar ahora, se dice ahora (FEAT-092 §5.1).
   */
  function enviar({ de, para = null, texto, respuestaA = null } = {}) {
    const origen = sesiones.get(de);
    if (!origen) return { ok: false, codigo: 403, error: 'Esta sesión no está registrada en el daemon.' };
    const limpio = redactSecrets(String(texto ?? '')).trim();
    if (!limpio) return { ok: false, codigo: 400, error: 'El mensaje está vacío.' };
    if (Buffer.byteLength(limpio) > TOPE_TEXTO_BYTES) return { ok: false, codigo: 413, error: 'El mensaje pasa de 8 KB.' };

    // Una respuesta va a quien mandó el original, con la cadena +1.
    let cadena = 0;
    let destinoNombre = para;
    if (respuestaA) {
      const original = buzones.leerMensajes(dataDir, origen.sesion).find((m) => m.id === respuestaA);
      if (!original) return { ok: false, codigo: 404, error: `No tengo un mensaje ${respuestaA} en tu buzón.` };
      cadena = (Number(original.cadena) || 0) + 1;
      if (!destinoNombre) destinoNombre = original.de?.nodo === nodo ? original.de?.nombre : `${original.de?.nodo}/${original.de?.nombre}`;
    }
    if (cadena >= TOPE_CADENA) {
      log(`[mensajes] freno de cadena: ${nodo}/${origen.nombre} → ${destinoNombre}`);
      return { ok: false, codigo: 429, error: `Conversación de ${TOPE_CADENA} idas y vueltas entre agentes: pedile al usuario que decida si sigue.` };
    }

    const [nodoDestino, nombreDestino] = String(destinoNombre ?? '').includes('/')
      ? String(destinoNombre).split('/', 2)
      : [nodo, String(destinoNombre ?? '')];
    if (nodoDestino !== nodo) {
      return { ok: false, codigo: 501, error: `Los mensajes a otros nodos (${nodoDestino}) todavía no están disponibles: llegan con la red de nodos.` };
    }
    const destino = [...sesiones.values()].find((s) => s.nombre === nombreDestino);
    if (!destino) return { ok: false, codigo: 404, error: `No hay una sesión ${nodo}/${nombreDestino}. Mirá cuáles hay con accion: agentes.` };
    if (destino.sesion === origen.sesion) return { ok: false, codigo: 400, error: 'Esa es esta misma sesión.' };
    if (destino.silenciada) return { ok: false, codigo: 409, error: `${nodo}/${destino.nombre} no recibe mensajes.` };

    const t = ahora();
    const recientes = (envios.get(origen.sesion) || []).filter((x) => t - x < HORA_MS);
    if (recientes.length >= TOPE_POR_HORA) {
      log(`[mensajes] freno de ritmo: ${nodo}/${origen.nombre}`);
      return { ok: false, codigo: 429, error: `Ya mandaste ${TOPE_POR_HORA} mensajes en la última hora.` };
    }
    envios.set(origen.sesion, [...recientes, t]);

    const sobre = {
      id: `m_${crypto.randomBytes(5).toString('hex')}`,
      de: { nodo, sesion: origen.sesion, nombre: origen.nombre },
      para: `${nodo}/${destino.nombre}`,
      texto: limpio,
      respuestaA: respuestaA || null,
      cadena,
      creado: new Date(t).toISOString()
    };
    try {
      buzones.agregar(dataDir, destino.sesion, sobre, t);
    } catch (err) {
      log(`[mensajes] no se pudo escribir el buzón de ${nodo}/${destino.nombre}: ${redactSecrets(err.message)}`);
      return { ok: false, codigo: 500, error: 'No se pudo escribir el buzón.' };
    }
    // Sin el texto (§6.4).
    log(`[mensajes] ${sobre.id} ${nodo}/${origen.nombre} → ${sobre.para}${respuestaA ? ` (responde ${respuestaA})` : ''}`);
    const como = destino.entrega === 'hooks'
      ? 'al terminar su turno, o al despertarla si está ociosa'
      : 'cuando lea su buzón (mensaje, accion: leer)';
    return { ok: true, id: sobre.id, para: sobre.para, como };
  }

  const ids = () => new Set(sesiones.keys());

  return { alta, baja, barrer, reconstruir, renombrar, silenciar, lista, enviar, ids };
}
