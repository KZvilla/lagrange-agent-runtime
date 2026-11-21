/**
 * FEAT-204 S3 — Los efectos de una voz de Voicebox (`effects_chain`), elegidos desde la terminal entre los presets.
 *
 * Voicebox 0.5.0 (tag v0.5.0):
 *   - `GET /effects/presets` → `[{ id, name, description, effects_chain, is_builtin, created_at }]`: los de fábrica
 *     (Robotic, Radio, Echo Chamber, Deep Voice) y los que el usuario creó en la app;
 *   - `PUT /profiles/{id}/effects` con `{ effects_chain: [..] | null }` valida la cadena (400), escribe solo
 *     `effects_chain` y `updated_at` y responde el perfil; 404 si no existe;
 *   - la lista (`GET /profiles`) y el detalle traen `effects_chain`;
 *   - `/generate` sin `effects_chain` propia usa la del perfil: lo guardado se oye cuando suena Voicebox.
 *
 * Lectura por perfil (`efectosDe`): `{ estado, preset, nombre, cantidad, huella }`, con `estado` `'ninguno'` (sin
 * cadena o `[]`), `'preset'` (igual a un preset), `'personalizado'` (otra cadena, aun toda apagada) o `'desconocido'`
 * (hay cadena y no hay lista de presets para compararla). `huella` es el SHA-256 de `JSON.stringify` de la cadena
 * completa tal como la devuelve Voicebox (`null` y `[]`, la de `null`): la base del 409. El daemon la calcula siempre
 * sobre su propia lectura, así que no hace falta un JSON canónico.
 *
 * Solo con la 0.5.x, como el carácter (`caracter-voz.js`). Nunca arranca Voicebox.
 */
'use strict';

const crypto = require('node:crypto');
const vb = require('../voicebox-server.js');
const caracter = require('./caracter-voz.js');
const { enCola } = require('./cola-voz.js');

const MAX_PRESETS = 200;
const MAX_ID_PRESET = 64;
const RE_HUELLA = /^[0-9a-f]{64}$/;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const QUE = 'los efectos se editan';

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const error = (codigo, mensaje, extra = {}) => ({ ok: false, codigo, error: mensaje, ...extra });

/** La cadena de un perfil o un preset: un array no vacío, o `null`. */
function cadenaDe(x) {
  const c = esObjeto(x) ? x.effects_chain : null;
  return Array.isArray(c) && c.length ? c : null;
}

/** El SHA-256 (hex) de la cadena completa, sin recortar ni reordenar; `null` y `[]` dan el mismo. */
function huellaDe(cadena) {
  const c = Array.isArray(cadena) && cadena.length ? cadena : null;
  return crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
}

// La comparación con un preset es semántica: `enabled` ausente es `true`, los números por valor y `params` sin
// importar el orden de sus claves.
function efectoNormal(e) {
  const o = esObjeto(e) ? e : {};
  const params = esObjeto(o.params) ? o.params : {};
  const ordenados = Object.keys(params).sort().map((k) => [k, typeof params[k] === 'number' ? Number(params[k]) : params[k]]);
  return JSON.stringify([String(o.type ?? ''), o.enabled !== false, ordenados]);
}

function mismaCadena(a, b) {
  return a.length === b.length && a.every((e, i) => efectoNormal(e) === efectoNormal(b[i]));
}
/** Dos cadenas (o `null`) que suenan igual: las dos vacías, o iguales efecto por efecto. */
const igualesEnEfecto = (a, b) => (!a || !b ? !a && !b : mismaCadena(a, b));

/** La lectura de los efectos de un perfil. `presets` es la lista de Voicebox, o `null` si no se pudo leer. */
function efectosDe(perfil, presets) {
  const cadena = cadenaDe(perfil);
  const huella = huellaDe(cadena);
  if (!cadena) return { estado: 'ninguno', preset: null, nombre: null, cantidad: 0, huella };
  const cantidad = cadena.filter((e) => !esObjeto(e) || e.enabled !== false).length;
  // Sin lista (o una vacía) no hay con qué comparar: «desconocido», nunca «personalizado».
  if (!Array.isArray(presets) || !presets.length) return { estado: 'desconocido', preset: null, nombre: null, cantidad, huella };
  const p = presets.find((x) => cadenaDe(x) && mismaCadena(cadenaDe(x), cadena));
  if (p) return { estado: 'preset', preset: p.id, nombre: p.name, cantidad, huella };
  return { estado: 'personalizado', preset: null, nombre: null, cantidad, huella };
}

/** `GET /effects/presets`, en el orden de Voicebox. Lanza si Voicebox no responde o la forma no es la esperada. */
async function leerPresets({ url = null, pedir = vb.pedir } = {}) {
  const base = url || caracter.urlPorDefecto();
  const r = await caracter.json(pedir, `${base}/effects/presets`, { timeout: 4000 });
  if (r.status < 200 || r.status >= 300 || !Array.isArray(r.cuerpo)) throw new Error(`Voicebox /effects/presets devolvió HTTP ${r.status}`);
  return r.cuerpo
    .filter((p) => esObjeto(p) && typeof p.id === 'string' && p.id && p.id.length <= MAX_ID_PRESET && typeof p.name === 'string' && p.name)
    .slice(0, MAX_PRESETS);
}

/** Lo que la terminal ve de cada preset (sin su cadena: el daemon la busca al guardar). */
function presetsPublicos(presets) {
  return (Array.isArray(presets) ? presets : []).map((p) => ({
    id: p.id,
    nombre: p.name.slice(0, 128),
    descripcion: typeof p.description === 'string' ? p.description.slice(0, 300) : null
  }));
}

function validarPedido(p) {
  if (!esObjeto(p)) return 'El pedido tiene que ser un objeto { nombre, preset, base }.';
  for (const k of Object.keys(p)) if (!['nombre', 'preset', 'base'].includes(k)) return `${k} no está permitido.`;
  if (typeof p.nombre !== 'string' || !p.nombre.trim() || p.nombre.length > caracter.MAX_NOMBRE || CONTROLES.test(p.nombre)) return 'Falta el nombre de la voz.';
  if (p.preset !== null && (typeof p.preset !== 'string' || !p.preset || p.preset.length > MAX_ID_PRESET || CONTROLES.test(p.preset))) {
    return 'preset es el id de un preset de Voicebox, o null para sacar los efectos.';
  }
  if (typeof p.base !== 'string' || !RE_HUELLA.test(p.base)) return 'Falta base: la huella de los efectos como se leyeron.';
  return null;
}

/** El perfil para la terminal: lo del carácter más la lectura de sus efectos. */
function proyectar(p, presets) {
  return { ...caracter.proyectar(p), efectos: efectosDe(p, presets) };
}

/**
 * Pone los efectos de la voz `nombre`: los del preset `preset`, o ninguno con `null`. Devuelve `{ ok: true, perfil,
 * sinCambios? }` o `{ ok: false, codigo, error, … }`: 400 (pedido o preset desconocido), 404 (no existe), 409 (cambió
 * en Voicebox, con `actuales`), 503 (apagado, otra versión o sin respuesta) o 502 (Voicebox rechazó el PUT o la
 * verificación no coincide, con `diferencias`).
 * `deps`: `{ url, pedir, guardarCache, log }`, inyectables en los tests.
 */
async function guardarEfectos(pedido, deps = {}) {
  const invalido = validarPedido(pedido);
  if (invalido) return error(400, invalido);
  return enCola(() => guardarEnCola(pedido, deps));
}

async function guardarEnCola(pedido, { url = null, pedir = vb.pedir, guardarCache = null, log = (l) => console.warn(l) } = {}) {
  const base = url || caracter.urlPorDefecto();
  const cache = guardarCache || ((perfiles) => require('../omnivoice.js').guardarCacheVoces({ perfiles }));
  const deVoicebox = async (fn) => {
    try { return await fn(); } catch (err) { return { caido: String(err?.message || err).slice(0, 200) }; }
  };

  const noEscribible = await caracter.exigirEscribible({ base, pedir, que: QUE });
  if (noEscribible) return noEscribible;

  const listar = async () => {
    const r = await caracter.json(pedir, `${base}/profiles`, { timeout: 4000 });
    if (r.status < 200 || r.status >= 300 || !Array.isArray(r.cuerpo)) throw new Error(`Voicebox /profiles devolvió HTTP ${r.status}`);
    return r.cuerpo;
  };
  // El detalle devuelve el status: un 404 (la voz se borró entre la lista y el detalle) no es un fallo de red.
  const leer = async (id) => {
    const r = await caracter.json(pedir, `${base}/profiles/${encodeURIComponent(id)}`, { timeout: 4000 });
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300 || !esObjeto(r.cuerpo)) throw new Error(`Voicebox /profiles/{id} devolvió HTTP ${r.status}`);
    return r.cuerpo;
  };

  // Los presets aparte: Voicebox ya respondió como 0.5.x, así que una falla acá no es «apagado».
  let presets;
  try {
    presets = await leerPresets({ url: base, pedir });
  } catch (err) {
    return error(503, `No se pudo leer la lista de presets de Voicebox: ${String(err?.message || err).slice(0, 200)}`, { motivo: 'presets' });
  }
  const clave = pedido.nombre.trim().toLowerCase();
  const foto = await deVoicebox(async () => {
    const fila = (await listar()).find((p) => esObjeto(p) && typeof p.name === 'string' && p.name.trim().toLowerCase() === clave);
    if (!fila) return { falta: true };
    const detalle = await leer(fila.id);
    return detalle ? { id: fila.id, detalle } : { falta: true };
  });
  if (foto.caido) return error(503, `Voicebox no respondió: ${foto.caido}`, { motivo: 'apagado' });
  if (foto.falta) return error(404, `No existe la voz "${pedido.nombre.trim()}" en Voicebox.`);
  const { id, detalle: antes } = foto;

  const huellaAntes = huellaDe(cadenaDe(antes));
  if (huellaAntes !== pedido.base) {
    return error(409, 'Los efectos de esta voz cambiaron en Voicebox desde que los leíste.', { actuales: efectosDe(antes, presets) });
  }

  let destino = null;
  if (pedido.preset !== null) {
    const p = presets.find((x) => x.id === pedido.preset);
    if (!p) return error(400, `El preset "${pedido.preset}" ya no está en Voicebox: releé la lista.`);
    destino = cadenaDe(p);
  }
  // Sin cambios si ya suena igual (comparación semántica: Voicebox puede devolver la cadena con sus valores por defecto).
  if (igualesEnEfecto(cadenaDe(antes), destino)) return { ok: true, perfil: proyectar(antes, presets), sinCambios: true };

  const puesto = await deVoicebox(async () => {
    const r = await caracter.json(pedir, `${base}/profiles/${encodeURIComponent(id)}/effects`, { method: 'PUT', body: { effects_chain: destino }, timeout: 8000 });
    if (r.status < 200 || r.status >= 300) {
      const detalle = esObjeto(r.cuerpo) && typeof r.cuerpo.detail === 'string' ? r.cuerpo.detail.slice(0, 200) : `HTTP ${r.status}`;
      return { rechazo: `Voicebox rechazó los efectos: ${detalle}` };
    }
    return {};
  });
  if (puesto.caido || puesto.rechazo) return error(502, puesto.caido || puesto.rechazo, { diferencias: [] });

  const despues = await deVoicebox(async () => ({ detalle: await leer(id), lista: await listar() }));
  if (despues.caido || !despues.detalle) {
    const motivo = despues.caido || 'la voz ya no está';
    log(`[efectos-voz] ${pedido.nombre}: no se pudo verificar (${motivo})`);
    return error(502, `Se guardó, pero no se pudo verificar: ${motivo}`, { diferencias: [] });
  }
  // La verificación es semántica por lo mismo: `EffectConfig` completa `enabled` y `params` al guardar.
  if (!igualesEnEfecto(cadenaDe(despues.detalle), destino)) {
    log(`[efectos-voz] ${pedido.nombre}: la cadena verificada no es la mandada`);
    return error(502, 'Voicebox no quedó con los efectos mandados: otro los cambió en el medio.', { diferencias: [{ campo: 'effects_chain' }] });
  }
  // El PUT de efectos no escribe el carácter: un cambio ahí lo hizo otro (la app de Voicebox). Solo se anota.
  const ajenos = caracter.diferencias(caracter.baseDe(antes), caracter.baseDe(despues.detalle), []);
  if (ajenos.length) log(`[efectos-voz] ${pedido.nombre}: el carácter cambió en el medio (${ajenos.map((d) => d.campo).join(', ')})`);
  try { cache(despues.lista); } catch { /* la caché se rehace en la próxima lectura */ }
  return { ok: true, perfil: proyectar(despues.detalle, presets) };
}

module.exports = { huellaDe, efectosDe, leerPresets, presetsPublicos, validarPedido, guardarEfectos, QUE };
