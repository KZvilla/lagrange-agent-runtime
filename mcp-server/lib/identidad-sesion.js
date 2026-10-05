/**
 * FEAT-123 — Qué cuenta de Claude es esta sesión y con qué nombre, emblema y
 * color se muestra (`identidad_sesion` del antigravity.json global).
 *
 * La misma regla está copiada en `hooks/identidad.ts`, que el mod no puede
 * importar de acá (CJS). Las dos corren la tabla `test/fixtures/identidad-casos.mjs`:
 * si cambia una, cambia la otra.
 *
 * Sin `CLAUDE_CONFIG_DIR` la cuenta es `principal`, como `claudeDataDir`
 * (session-source.js); no se mira `CLAUDECODE`, que los hijos no heredan.
 */
'use strict';

const PRINCIPAL = 'principal';
const MAX_NOMBRE = 24;
const MAX_EMBLEMA = 2;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** `~` inicial al home, barras normales, sin barra final, en minúsculas: solo para comparar. */
function normalizar(ruta, home) {
  let r = String(ruta).trim();
  if (r === '~' || /^~[\\/]/.test(r)) r = String(home) + r.slice(1);
  return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** `principal`, el nombre de una cuenta de `motores.cuentas`, o `null` si el dir no es de ninguna. */
function resolverCuenta({ configDir, home, cuentas }) {
  const dir = typeof configDir === 'string' ? configDir.trim() : '';
  if (!dir) return PRINCIPAL;
  const propio = normalizar(dir, home);
  if (propio === normalizar(`${home}/.claude`, home)) return PRINCIPAL;
  for (const [nombre, entrada] of Object.entries(esObjeto(cuentas) ? cuentas : {})) {
    if (nombre === PRINCIPAL || !esObjeto(entrada) || typeof entrada.configDir !== 'string' || !entrada.configDir.trim()) continue;
    if (normalizar(entrada.configDir, home) === propio) return nombre;
  }
  return null;
}

function grafemas(texto) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(texto)].length;
  }
  return [...texto].length;
}

/**
 * `{ nombre, emblema, color }` o `null`. Sin nombre válido no hay identidad;
 * un emblema inválido se descarta solo. El color queda crudo: lo valida quien
 * lo pinta (la statusline, con `secuencia`).
 */
function validarIdentidad(crudo) {
  if (!esObjeto(crudo) || typeof crudo.nombre !== 'string') return null;
  const nombre = crudo.nombre.trim();
  if (!nombre || nombre.length > MAX_NOMBRE || CONTROLES.test(nombre)) return null;
  let emblema = null;
  if (typeof crudo.emblema === 'string') {
    const e = crudo.emblema.trim();
    if (e && !CONTROLES.test(e) && grafemas(e) <= MAX_EMBLEMA) emblema = e;
  }
  const color = typeof crudo.color === 'string' || typeof crudo.color === 'number' ? crudo.color : null;
  return { nombre, emblema, color };
}

/** La identidad de esta sesión según la config global, o `null`. Nunca tira. */
function identidadDeConfig(config, { configDir, home }) {
  try {
    if (!esObjeto(config) || !esObjeto(config.identidad_sesion)) return null;
    const cuentas = esObjeto(config.motores) ? config.motores.cuentas : undefined;
    const cuenta = resolverCuenta({ configDir, home, cuentas });
    if (!cuenta || !Object.prototype.hasOwnProperty.call(config.identidad_sesion, cuenta)) return null;
    return validarIdentidad(config.identidad_sesion[cuenta]);
  } catch {
    return null;
  }
}

/** Lo que se muestra: `✦ Spica`, o solo el nombre. */
// Dos espacios: varios emblemas (☘) se dibujan anchos en la terminal y con uno solo quedan pegados al nombre.
function etiquetaDe(identidad) {
  return identidad.emblema ? `${identidad.emblema}  ${identidad.nombre}` : identidad.nombre;
}

module.exports = { PRINCIPAL, resolverCuenta, validarIdentidad, identidadDeConfig, etiquetaDe };
