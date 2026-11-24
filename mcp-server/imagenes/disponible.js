'use strict';

/**
 * FEAT-210 — ¿Puede un alma hacer una imagen ahora?
 *
 * Una sola respuesta para los que la necesitan: la consigna del alma (§1), la
 * capacidad `imagenes` de la API v2 (§5) y el trabajo de la cola (§6). La config
 * se lee de la global en cada llamada (sin caché): apagar las imágenes desde
 * Ajustes o a mano vale para el turno siguiente.
 */

const configMotores = require('../motores/config-motores.js');
const { enModoManual } = require('../motores/antigravity/modo.js');
const ajustesImagenes = require('../lib/ajustes-imagenes.js');

/** Los proveedores que, por su forma, nunca generan: cableados pero no funcionales. */
const NO_IMPLEMENTADOS = Object.freeze(['openai', 'gemini']);
/** El tope del prompt de cada proveedor (§2): el refinador escribe para el primero que puede andar. */
const TOPE_AGY = 900;

/** La sección `imagenes` normalizada, leída de la config global ahora. Un archivo ilegible da los valores por defecto. */
function leerImagenes({ homeDir = configMotores.homeDeConfig() } = {}) {
  const leido = configMotores.leerParaModificar(configMotores.rutaConfigGlobal(homeDir));
  // Los flujos pasan por `deny_paths` también acá: el daemon lee lo que se editó a mano.
  return ajustesImagenes.normalizar(leido.ok ? leido.datos.imagenes : undefined, { denyPaths: ajustesImagenes.denyDe(leido.ok ? leido.datos : null) }).imagenes;
}

/** ¿Puede andar este proveedor, sin preguntarle? (no es de los no implementados, y agy no está en modo manual). */
function puedeAndar(proveedor, { manual = enModoManual } = {}) {
  if (NO_IMPLEMENTADOS.includes(proveedor)) return false;
  if (proveedor === 'antigravity' && manual()) return false;
  return ajustesImagenes.PROVEEDORES.includes(proveedor);
}

/** ¿Algún proveedor del orden puede andar? No hace falta que responda en este momento. */
function algunoPuedeAndar(imagenes, opciones = {}) {
  return (imagenes.orden || []).some((p) => puedeAndar(p, opciones));
}

/** El primero del orden que puede andar, o `null`. */
function primeroQuePuede(imagenes, opciones = {}) {
  return (imagenes.orden || []).find((p) => puedeAndar(p, opciones)) || null;
}

/** El tope del prompt para el refinador: el del primer proveedor que puede andar. */
function topeDelPrompt(imagenes, opciones = {}) {
  const p = primeroQuePuede(imagenes, opciones);
  if (p === 'antigravity') return TOPE_AGY;
  return imagenes.comfyui.tope_prompt;
}

/** ¿Las imágenes están habilitadas para esta alma? (activas, no apagada en `por_alma`, y algún proveedor puede andar). */
function habilitadaPara(imagenes, clave, opciones = {}) {
  if (!imagenes.activas) return false;
  if (clave && imagenes.por_alma && imagenes.por_alma[clave] === false) return false;
  return algunoPuedeAndar(imagenes, opciones);
}

module.exports = { NO_IMPLEMENTADOS, TOPE_AGY, leerImagenes, puedeAndar, algunoPuedeAndar, primeroQuePuede, topeDelPrompt, habilitadaPara };
