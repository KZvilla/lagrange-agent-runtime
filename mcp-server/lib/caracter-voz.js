/**
 * FEAT-204 — El carácter de una voz de Voicebox (`description` y `personality`), editable desde la terminal sin romper
 * cómo lo lee Voicebox.
 *
 * Voicebox 0.5.0 (`backend/services/profiles.py:356-411`, tag v0.5.0): `PUT /profiles/{id}` recibe el cuerpo entero y
 * escribe cinco columnas, `name`, `description`, `language`, `personality` y `default_engine` (esta, solo si no viene
 * `null`; `""` la borra). Si falta `language` queda `"en"`; si falta `description` o `personality`, `null`. Por eso:
 *   - el PUT lleva exactamente esos cinco campos, copiados del GET, con los dos textos nuevos;
 *   - `base` (los cinco, como los vio el usuario) da 409 si Voicebox ya no coincide: Voicebox no tiene versión;
 *   - después se comparan el detalle (`GET /profiles/{id}`) y los conteos de la lista (`GET /profiles`; el detalle los
 *     trae en 0). Una diferencia fuera de los dos textos y `updated_at` da 502: si está en los cinco campos se restaura
 *     con un segundo PUT, y si no, no se puede deshacer con el PUT y se dice «no restaurable».
 * Solo con la 0.5.x, que es la que se probó (`GET /` informa la versión). Nunca arranca Voicebox.
 *
 * Probado contra la 0.5.0 instalada el 2026-11-20 (plan de FEAT-204, «Prueba real»).
 */
'use strict';

const vb = require('../voicebox-server.js');
const { enCola } = require('./cola-voz.js');

const MAX_DESCRIPCION = 500;
const MAX_PERSONALIDAD = 2000;
const MAX_NOMBRE = 100;
const ESCRITOS = Object.freeze(['name', 'description', 'language', 'personality', 'default_engine']);
// FEAT-204 S3 — `effects_chain` la escribe otro PUT (`efectos-voz.js`): un guardado de efectos en el medio no es un
// cambio de este guardado. El PUT del carácter no la toca (`backend/services/profiles.py`, tag v0.5.0).
const IGNORADOS = Object.freeze(['description', 'personality', 'updated_at', 'effects_chain']);
// Los textos admiten saltos de línea y tabuladores; el resto de los controles, no.
const CONTROLES_TEXTO = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const VERSION_ESCRIBIBLE = /^0\.5\.\d+$/;

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const igual = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const error = (codigo, mensaje, extra = {}) => ({ ok: false, codigo, error: mensaje, ...extra });

/** Los cinco campos que escribe el PUT, crudos, de un perfil de Voicebox. */
function baseDe(p) {
  const o = esObjeto(p) ? p : {};
  return Object.fromEntries(ESCRITOS.map((k) => [k, o[k] === undefined ? null : o[k]]));
}

function urlPorDefecto() {
  const cfg = require('./config.js').loadConfig();
  return vb.resolverUrlVoicebox({}, cfg);
}

async function json(pedir, url, opciones) {
  const r = await pedir(url, opciones);
  let cuerpo = null;
  try { cuerpo = r.body ? JSON.parse(r.body) : null; } catch { cuerpo = undefined; }
  return { status: r.status, cuerpo };
}

/**
 * La versión de Voicebox por `GET /` (`{ message, version }`), con 3 s de espera. `null` si falla, no es JSON o no
 * trae `version`. `cfg` es la config, para la URL; `url` la pisa.
 */
async function versionVoicebox(cfg = null, { url = null, pedir = vb.pedir } = {}) {
  try {
    const base = url || vb.resolverUrlVoicebox({}, cfg || require('./config.js').loadConfig());
    const r = await json(pedir, `${base}/`, { timeout: 3000 });
    if (r.status < 200 || r.status >= 300 || !esObjeto(r.cuerpo)) return null;
    return typeof r.cuerpo.version === 'string' && r.cuerpo.version.length <= 32 ? r.cuerpo.version : null;
  } catch {
    return null;
  }
}

/** ¿Se puede escribir `que` con esa versión? `null` si sí; si no, el motivo para la pantalla. */
function motivoSoloLectura(version, que = 'el carácter se edita') {
  if (!version) return 'No se pudo saber la versión de Voicebox';
  if (!VERSION_ESCRIBIBLE.test(version)) return `Voicebox ${version}: ${que} con la 0.5`;
  return null;
}

/**
 * FEAT-204 S3 — Voicebox 0.5.x encendido, o el 503 para la pantalla (`motivo: 'apagado' | 'version'`). `que` nombra lo
 * que se edita, con su verbo («el carácter se edita», «los efectos se editan»). Compartido por el carácter y los efectos.
 */
async function exigirEscribible({ base, pedir, que = 'el carácter se edita' }) {
  const version = await versionVoicebox(null, { url: base, pedir });
  if (!version) {
    let s;
    try { s = await json(pedir, `${base}/health`, { timeout: 3000 }); } catch { s = null; }
    if (!s || s.status < 200 || s.status >= 300) return error(503, `Voicebox está apagado: ${que} con Voicebox encendido.`, { motivo: 'apagado' });
  }
  const soloLectura = motivoSoloLectura(version, que);
  if (soloLectura) return error(503, `${soloLectura}.`, { motivo: 'version', version });
  return null;
}

function validarPedido(p) {
  if (!esObjeto(p)) return 'El pedido tiene que ser un objeto { nombre, description, personality, base }.';
  for (const k of Object.keys(p)) {
    if (!['nombre', 'description', 'personality', 'base'].includes(k)) return `${k} no está permitido.`;
  }
  if (typeof p.nombre !== 'string' || !p.nombre.trim() || p.nombre.length > MAX_NOMBRE || CONTROLES.test(p.nombre)) return 'Falta el nombre de la voz.';
  for (const [k, tope] of [['description', MAX_DESCRIPCION], ['personality', MAX_PERSONALIDAD]]) {
    if (typeof p[k] !== 'string') return `${k} tiene que ser un texto (vacío para borrarlo).`;
    if (p[k].length > tope) return `${k} tiene hasta ${tope} caracteres.`;
    if (CONTROLES_TEXTO.test(p[k])) return `${k} tiene caracteres de control.`;
  }
  if (!esObjeto(p.base)) return 'Falta base: los cinco campos del perfil como se leyeron.';
  for (const k of Object.keys(p.base)) if (!ESCRITOS.includes(k)) return `base.${k} no está permitido.`;
  return null;
}

/** Las diferencias entre dos fotos de un perfil, fuera de `ignorar`: `[{ campo, antes, despues }]`. */
function diferencias(antes, despues, ignorar) {
  const a = esObjeto(antes) ? antes : {};
  const d = esObjeto(despues) ? despues : {};
  return [...new Set([...Object.keys(a), ...Object.keys(d)])]
    .filter((k) => !ignorar.includes(k) && !igual(a[k], d[k]))
    .map((campo) => ({ campo, antes: a[campo] === undefined ? null : a[campo], despues: d[campo] === undefined ? null : d[campo] }));
}

/** Lo que tiene que cambiar y lo que no: el detalle entero y los conteos de la lista. */
function verificar({ detalleAntes, filaAntes, detalleDespues, filaDespues, pedido }) {
  const difs = diferencias(detalleAntes, detalleDespues, IGNORADOS);
  for (const k of ['description', 'personality']) {
    if (!esObjeto(detalleDespues) || (detalleDespues[k] ?? '') !== pedido[k]) difs.push({ campo: k, antes: pedido[k], despues: esObjeto(detalleDespues) ? detalleDespues[k] ?? null : null });
  }
  if (!filaDespues) difs.push({ campo: 'perfil', antes: 'en la lista', despues: 'no está en la lista' });
  else {
    if (!igual(filaAntes.sample_count, filaDespues.sample_count)) difs.push({ campo: 'sample_count', antes: filaAntes.sample_count ?? null, despues: filaDespues.sample_count ?? null });
    // `generation_count` puede subir si alguien genera mientras tanto; bajar, no.
    if (Number(filaDespues.generation_count) < Number(filaAntes.generation_count)) difs.push({ campo: 'generation_count', antes: filaAntes.generation_count, despues: filaDespues.generation_count });
  }
  return difs;
}

/** El cuerpo del PUT: los cinco campos. Un `default_engine` que tiene que volver a `null` va como `""`. */
function cuerpoPut(base, cambios = {}, { borrarMotor = false } = {}) {
  const c = { ...baseDe(base), ...cambios };
  if (c.default_engine === null && borrarMotor) c.default_engine = '';
  return c;
}

/** Lo que la terminal ve de un perfil (la misma lista blanca que `perfilesAjustes`, más el carácter). */
function proyectar(p) {
  return {
    nombre: p.name,
    idioma: typeof p.language === 'string' ? p.language.slice(0, 2).toLowerCase() : null,
    tipo: p.voice_type || null,
    motor: p.default_engine || null,
    description: typeof p.description === 'string' ? p.description.slice(0, MAX_DESCRIPCION) : null,
    personality: typeof p.personality === 'string' ? p.personality.slice(0, MAX_PERSONALIDAD) : null,
    base: baseDe(p)
  };
}

/**
 * Guarda el carácter de la voz `nombre`. Devuelve `{ ok: true, perfil, sinCambios? }` o `{ ok: false, codigo, error,
 * … }`: 400 (pedido), 404 (no existe), 409 (cambió en Voicebox, con `actuales`), 503 (apagado, otra versión o sin
 * respuesta) o 502 (la verificación encontró otro cambio, con `diferencias` y `restauracion`).
 * `deps`: `{ url, pedir, guardarCache, log }`, inyectables en los tests.
 */
async function guardarCaracter(pedido, deps = {}) {
  const invalido = validarPedido(pedido);
  if (invalido) return error(400, invalido);
  // FEAT-204 S3 — En la cola del daemon que comparte con los efectos: dos guardados no leen la misma foto.
  return enCola(() => guardarCaracterEnCola(pedido, deps));
}

async function guardarCaracterEnCola(pedido, { url = null, pedir = vb.pedir, guardarCache = null, log = (l) => console.warn(l) } = {}) {
  const base = url || urlPorDefecto();
  const cache = guardarCache || ((perfiles) => require('../omnivoice.js').guardarCacheVoces({ perfiles }));
  const deVoicebox = async (fn) => {
    try { return await fn(); } catch (err) { return { caido: String(err?.message || err).slice(0, 200) }; }
  };

  const noEscribible = await exigirEscribible({ base, pedir, que: 'el carácter se edita' });
  if (noEscribible) return noEscribible;

  const listar = async () => {
    const r = await json(pedir, `${base}/profiles`, { timeout: 4000 });
    if (r.status < 200 || r.status >= 300 || !Array.isArray(r.cuerpo)) throw new Error(`Voicebox /profiles devolvió HTTP ${r.status}`);
    return r.cuerpo;
  };
  const leer = async (id) => {
    const r = await json(pedir, `${base}/profiles/${encodeURIComponent(id)}`, { timeout: 4000 });
    if (r.status < 200 || r.status >= 300 || !esObjeto(r.cuerpo)) throw new Error(`Voicebox /profiles/{id} devolvió HTTP ${r.status}`);
    return r.cuerpo;
  };
  const poner = async (id, cuerpo) => {
    const r = await json(pedir, `${base}/profiles/${encodeURIComponent(id)}`, { method: 'PUT', body: cuerpo, timeout: 8000 });
    if (r.status < 200 || r.status >= 300) {
      const detalle = esObjeto(r.cuerpo) && typeof r.cuerpo.detail === 'string' ? r.cuerpo.detail.slice(0, 200) : `HTTP ${r.status}`;
      throw new Error(`Voicebox rechazó el cambio: ${detalle}`);
    }
  };

  const clave = pedido.nombre.trim().toLowerCase();
  const fotoAntes = await deVoicebox(async () => {
    const lista = await listar();
    const fila = lista.find((p) => esObjeto(p) && typeof p.name === 'string' && p.name.trim().toLowerCase() === clave);
    if (!fila) return { falta: true };
    return { fila, detalle: await leer(fila.id) };
  });
  if (fotoAntes.caido) return error(503, `Voicebox no respondió: ${fotoAntes.caido}`, { motivo: 'apagado' });
  if (fotoAntes.falta) return error(404, `No existe la voz "${pedido.nombre.trim()}" en Voicebox.`);
  const { fila: filaAntes, detalle: detalleAntes } = fotoAntes;

  const actuales = baseDe(detalleAntes);
  const conflictos = ESCRITOS.filter((k) => !igual(pedido.base[k], actuales[k]));
  if (conflictos.length) return error(409, 'La voz cambió en Voicebox desde que la leíste. Recargá para ver lo nuevo.', { conflictos, actuales });

  if (actuales.description === pedido.description && actuales.personality === pedido.personality) {
    return { ok: true, perfil: proyectar(detalleAntes), sinCambios: true };
  }

  const id = filaAntes.id;
  const puesto = await deVoicebox(() => poner(id, cuerpoPut(detalleAntes, { description: pedido.description, personality: pedido.personality })));
  if (puesto && puesto.caido) return error(502, puesto.caido, { restauracion: 'sin cambios' });

  const fotoDespues = async () => {
    const lista = await listar();
    return { lista, fila: lista.find((p) => esObjeto(p) && p.id === id) || null, detalle: await leer(id) };
  };
  const despues = await deVoicebox(fotoDespues);
  if (despues.caido) {
    log(`[caracter-voz] ${pedido.nombre}: no se pudo verificar (${despues.caido}); antes: ${JSON.stringify(detalleAntes)}`);
    return error(502, `Se guardó, pero no se pudo verificar: ${despues.caido}`, { restauracion: 'no verificado' });
  }
  const difs = verificar({ detalleAntes, filaAntes, detalleDespues: despues.detalle, filaDespues: despues.fila, pedido });
  if (!difs.length) {
    try { cache(despues.lista); } catch { /* la caché se rehace en la próxima lectura */ }
    return { ok: true, perfil: proyectar(despues.detalle) };
  }

  // Algo más cambió. Solo lo que escribe el PUT se puede deshacer con el PUT.
  const fuera = difs.filter((d) => !ESCRITOS.includes(d.campo));
  let restauracion;
  if (fuera.length) restauracion = 'no restaurable';
  else {
    const borrarMotor = detalleAntes.default_engine == null && despues.detalle.default_engine != null;
    const r = await deVoicebox(async () => {
      await poner(id, cuerpoPut(detalleAntes, {}, { borrarMotor }));
      const otra = await fotoDespues();
      return diferencias(detalleAntes, otra.detalle, ['updated_at', 'effects_chain']).length ? null : otra;
    });
    restauracion = r && !r.caido ? 'restaurado' : 'no restaurado';
    if (restauracion === 'restaurado') { try { cache(r.lista); } catch { /* idem */ } }
  }
  if (restauracion !== 'restaurado') log(`[caracter-voz] ${pedido.nombre}: ${restauracion}; antes: ${JSON.stringify(detalleAntes)}`);
  return error(502, `Voicebox cambió más de lo pedido (${difs.map((d) => d.campo).join(', ')}): ${restauracion}.`, { diferencias: difs.slice(0, 20), restauracion });
}

module.exports = {
  MAX_DESCRIPCION, MAX_PERSONALIDAD, MAX_NOMBRE, ESCRITOS, baseDe, versionVoicebox, motivoSoloLectura, guardarCaracter,
  proyectar, diferencias, exigirEscribible, json, urlPorDefecto
};
