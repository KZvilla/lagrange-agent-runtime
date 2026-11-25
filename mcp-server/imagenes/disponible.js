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
const casos = require('./casos.js');
const { enModoManual } = require('../motores/antigravity/modo.js');
const ajustesImagenes = require('../lib/ajustes-imagenes.js');

const { NO_IMPLEMENTADOS, TOPE_AGY } = casos;

/** La sección `imagenes` (migrada y normalizada), leída de la config global ahora. Un archivo ilegible da los valores por defecto. */
function leerImagenes({ homeDir = configMotores.homeDeConfig() } = {}) {
  const leido = configMotores.leerParaModificar(configMotores.rutaConfigGlobal(homeDir));
  // Los flujos pasan por `deny_paths` también acá: el daemon lee lo que se editó a mano.
  return ajustesImagenes.leerSeccion(leido.ok ? leido.datos : {}).imagenes;
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

/** ¿Las imágenes están habilitadas para esta alma? (activas, no apagada en `por_alma`, y algún proveedor puede andar). */
function habilitadaPara(imagenes, clave, opciones = {}) {
  if (!imagenes.activas) return false;
  if (clave && imagenes.por_alma && imagenes.por_alma[clave] === false) return false;
  return algunoPuedeAndar(imagenes, opciones);
}

module.exports = { NO_IMPLEMENTADOS, TOPE_AGY, leerImagenes, puedeAndar, algunoPuedeAndar, primeroQuePuede, topeDelPrompt: casos.topeDelPrompt, habilitadaPara };
