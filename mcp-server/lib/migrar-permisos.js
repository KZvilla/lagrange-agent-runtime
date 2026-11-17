'use strict';

/**
 * FEAT-197 — Los permisos que el usuario guardó con los nombres viejos de las tools (`allow`/`deny`/`ask` de cada
 * `settings.json` de Claude, y las entradas `lagrange_<tool>` del `opencode.json(c)`). Sin alias, una entrada vieja
 * deja de valer: el migrador la reescribe y `telegram_bridge_status` avisa si quedó alguna.
 *
 * Trabaja sobre el texto y solo reemplaza cadenas JSON exactas (`"mcp__lagrange__agy_audit"`), así conserva el
 * formato y los comentarios de un `.jsonc`, y una segunda pasada no cambia nada.
 */

const { NOMBRES } = require('./nombres-tools.js');

const SERVIDORES = ['plugin_lagrange_lagrange', 'lagrange', 'lagrange-dev'];

/** Los pares viejo → nuevo, tal como aparecen entre comillas en cada formato. */
function pares() {
  const salida = [];
  for (const [viejo, nuevo] of Object.entries(NOMBRES)) {
    for (const s of SERVIDORES) salida.push([`mcp__${s}__${viejo}`, `mcp__${s}__${nuevo}`]);
    salida.push([`lagrange_${viejo}`, `lagrange_${nuevo}`]);
  }
  return salida;
}

const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `{ texto, cambios }`: el texto con cada nombre viejo entre comillas reemplazado, y qué se cambió. */
function migrarTexto(texto) {
  let salida = String(texto);
  const cambios = [];
  for (const [viejo, nuevo] of pares()) {
    const re = new RegExp(`"${escapar(viejo)}"`, 'g');
    const n = (salida.match(re) || []).length;
    if (n) {
      salida = salida.replace(re, `"${nuevo}"`);
      cambios.push({ viejo, nuevo, veces: n });
    }
  }
  return { texto: salida, cambios };
}

// 5d6f80 F3 — Un comodín con el prefijo viejo (`"lagrange_agy_*"`, `"mcp__lagrange__agy_*"`) no tiene un reemplazo
// único: no se reescribe, pero se avisa para que el usuario lo cambie a mano.
const RE_COMODIN = new RegExp(`"((?:mcp__(?:${SERVIDORES.map(escapar).join('|')})__|lagrange_)agy_[^"]*\\*[^"]*)"`, 'g');

/** Los comodines con el prefijo viejo que aparecen en `texto`. */
function comodinesViejos(texto) {
  return [...String(texto).matchAll(RE_COMODIN)].map((m) => m[1]);
}

/** Los nombres viejos (y comodines viejos) que todavía aparecen entre comillas en `texto`, para avisar sin tocar nada. */
function nombresViejos(texto) {
  return [...migrarTexto(texto).cambios.map((c) => c.viejo), ...comodinesViejos(texto)];
}

module.exports = { SERVIDORES, migrarTexto, nombresViejos, comodinesViejos };
