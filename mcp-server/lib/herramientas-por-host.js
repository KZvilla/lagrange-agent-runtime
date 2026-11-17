'use strict';

/**
 * FEAT-196 — Qué tools de Lagrange ve cada host marcado (`LAGRANGE_HOST`), y quién llama cuando el host es agy.
 *
 * Puro: `mcp-server/index.js` arranca el bucle stdio al importarse, así que la lógica que se prueba vive acá.
 *
 * - agy: lista blanca (D1). Una tool nueva no entra a agy sin que alguien la sume acá. Fuera quedan las que lanzan agy
 *   (agy no se lanza a sí mismo), las que dependen de sesiones de Claude/Codex y las de Telegram y mensajes.
 * - Sin host marcado (Claude Code, Codex) u opencode: todas, como antes.
 */

// FEAT-197 — Nombres públicos: `tools/list` y `tools/call` los comparan después de traducir con nombres-tools.js.
const SOLO_EN_AGY = Object.freeze(['audit_queue', 'status', 'usage']);
const LISTAS = Object.freeze({ agy: new Set(SOLO_EN_AGY) });

/** ¿`nombre` está disponible en `host`? */
function permitida(host, nombre) {
  const lista = LISTAS[host];
  return lista ? lista.has(nombre) : true;
}

/** Las tools de `tools` (objetos con `name`) que ve `host`, en el mismo orden. */
function visibles(host, tools) {
  return tools.filter((t) => permitida(host, t && t.name));
}

/** El error que recibe agy si llama a una tool que no ve (por ejemplo, de memoria de otra sesión). */
function textoNoDisponible(host, nombre) {
  return `«${nombre}» no está disponible cuando Lagrange corre dentro de ${host} (FEAT-196: ${[...LISTAS[host]].join(', ')}).`;
}

const RE_SESION = /^[A-Za-z0-9._-]{1,128}$/;
const CLAVE_RAIZ = 'antigravity.google/root_conversation_id';
const CLAVE_CONVERSACION = 'antigravity.google/conversation_id';

/**
 * La conversación de agy que hace la llamada, desde `params._meta` (sonda S4): la raíz si está (un subagente comparte
 * la de su conversación principal), si no la propia. Solo cuentan las claves con el namespace `antigravity.google/`.
 * Las pone el cliente, no el modelo. Sin una válida, `null` (la cola la registra como `agy:anonimo`).
 */
function sesionDeAgy(meta) {
  if (!meta || typeof meta !== 'object') return null;
  for (const clave of [CLAVE_RAIZ, CLAVE_CONVERSACION]) {
    const v = typeof meta[clave] === 'string' ? meta[clave].trim() : '';
    if (RE_SESION.test(v)) return v;
  }
  return null;
}

module.exports = { SOLO_EN_AGY, permitida, visibles, textoNoDisponible, sesionDeAgy };
