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

// FEAT-133 — La voz de cada identidad. Solo la usa el MCP: el statusline y el
// mod siguen con `validarIdentidad`, que ignora el bloque `voz`.

/** El `clientInfo.name` que manda Claude Code en `initialize` (medido en 2.1.291, evidencia-feat-133). */
const CLIENTE_CLAUDE_CODE = 'claude-code';
const IDIOMAS = ['es', 'en'];
// El mismo tope que `audio.profile` en el esquema de `voice_setup`.
const MAX_PERFIL = 128;

function perfilValido(v) {
  if (typeof v !== 'string') return null;
  const p = v.trim();
  return p && p.length <= MAX_PERFIL && !CONTROLES.test(p) ? p : null;
}

/**
 * `{ es, en, idioma }` (cada perfil o `null`) o `null` si no hay ningún perfil
 * usable. Solo la forma: si el perfil existe en Voicebox se ve al usarlo.
 */
function vozDeIdentidad(crudo) {
  if (!esObjeto(crudo) || !esObjeto(crudo.voz)) return null;
  const es = perfilValido(crudo.voz.es);
  const en = perfilValido(crudo.voz.en);
  if (!es && !en) return null;
  const idioma = IDIOMAS.includes(crudo.voz.idioma) ? crudo.voz.idioma : null;
  return { es, en, idioma };
}

/**
 * La voz de la identidad de esta sesión, como si el usuario la hubiera pedido.
 * `null` (y los `args` quedan como vinieron) si el cliente no es Claude Code,
 * si la llamada ya pide una voz o un alma, o si la identidad no tiene voz para
 * el idioma. Si no, `{ args, identidad }`: `args` con `voice` y `language`
 * completos, que desde ahí siguen la ruta explícita de FEAT-049 (autoriza el
 * autostart y nunca sustituye la voz por otra), e `identidad` con el nombre
 * que se muestra. La identidad nunca sale de `args`: un modelo no puede hacerse
 * pasar por otra cuenta. Nunca tira.
 */
function vozDeLaSesion({ args = {}, config = {}, cliente = null, configDir = null, home = '' } = {}) {
  try {
    if (cliente !== CLIENTE_CLAUDE_CODE) return null;
    if (args.voice || args.profile || args.soul) return null;
    const tabla = config.identidadSesion;
    if (!esObjeto(tabla)) return null;
    const cuentas = esObjeto(config.motores) ? config.motores.cuentas : undefined;
    const cuenta = resolverCuenta({ configDir, home, cuentas });
    if (!cuenta || !Object.prototype.hasOwnProperty.call(tabla, cuenta)) return null;
    const identidad = validarIdentidad(tabla[cuenta]);
    const voz = vozDeIdentidad(tabla[cuenta]);
    if (!identidad || !voz) return null;
    const setup = config.voiceSetup;
    // Como `resolveVoice`: el default de `voice_setup` solo cuenta si está configurado.
    const deSetup = esObjeto(setup) && setup.status === 'configured' && IDIOMAS.includes(setup.default_language) ? setup.default_language : null;
    // Normalizado igual que `language()` de voice-resolution.js ("EN", "en-US" → "en").
    const pedido = typeof args.language === 'string' ? args.language.trim().toLowerCase().slice(0, 2) : null;
    const idioma = (IDIOMAS.includes(pedido) && pedido) || voz.idioma || deSetup || 'es';
    const perfil = voz[idioma];
    if (!perfil) return null;
    return { args: { ...args, voice: perfil, language: idioma }, identidad: { cuenta, nombre: identidad.nombre, perfil } };
  } catch {
    return null;
  }
}

/**
 * `identidad_sesion` con la voz de `pedido.cuenta` actualizada, para
 * `set_config identidad_voz`. Toca solo el bloque `voz`: `nombre`, `emblema` y
 * `color` quedan como estaban. `es`/`en`/`idioma` con string cambian el valor,
 * con `null` lo quitan y sin la clave lo dejan. Solo valida la forma (nunca
 * consulta Voicebox, como `voice_setup`). Lanza con el motivo si algo no sirve:
 * una voz para una cuenta sin `nombre` quedaría huérfana.
 */
function fusionarVozDeIdentidad(actual, pedido) {
  if (!esObjeto(pedido)) throw new Error('identidad_voz tiene que ser un objeto { cuenta, es, en, idioma }.');
  for (const k of Object.keys(pedido)) {
    if (!['cuenta', 'es', 'en', 'idioma'].includes(k)) throw new Error(`identidad_voz.${k} no está permitido.`);
  }
  const tabla = esObjeto(actual) ? actual : {};
  const cuenta = typeof pedido.cuenta === 'string' ? pedido.cuenta.trim() : '';
  if (!cuenta || !Object.prototype.hasOwnProperty.call(tabla, cuenta) || !validarIdentidad(tabla[cuenta])) {
    throw new Error(`identidad_voz.cuenta "${cuenta}" no tiene una identidad con nombre en identidad_sesion; definila primero.`);
  }
  const voz = esObjeto(tabla[cuenta].voz) ? { ...tabla[cuenta].voz } : {};
  for (const idioma of IDIOMAS) {
    if (pedido[idioma] === undefined) continue;
    if (pedido[idioma] === null) { delete voz[idioma]; continue; }
    const perfil = perfilValido(pedido[idioma]);
    if (!perfil) throw new Error(`identidad_voz.${idioma} tiene que ser el nombre de un perfil de voz (hasta ${MAX_PERFIL} caracteres, sin caracteres de control).`);
    voz[idioma] = perfil;
  }
  if (pedido.idioma !== undefined) {
    if (pedido.idioma === null) delete voz.idioma;
    else if (IDIOMAS.includes(pedido.idioma)) voz.idioma = pedido.idioma;
    else throw new Error('identidad_voz.idioma tiene que ser "es", "en" o null.');
  }
  const entrada = { ...tabla[cuenta] };
  if (Object.keys(voz).length) entrada.voz = voz;
  else delete entrada.voz;
  return { ...tabla, [cuenta]: entrada };
}

module.exports = {
  PRINCIPAL, resolverCuenta, validarIdentidad, identidadDeConfig, etiquetaDe,
  CLIENTE_CLAUDE_CODE, vozDeIdentidad, vozDeLaSesion, fusionarVozDeIdentidad
};
