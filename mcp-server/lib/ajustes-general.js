/**
 * FEAT-159 — La sección `general` de Ajustes: los valores por defecto de agy
 * (`model`, `effort`, `timeout_minutes`), dónde corren plan/review/audit
 * (`readonly_isolation`), los avisos de fondo del mod (`background_toasts`) y
 * el freno de cuota de cada motor (`motores.<motor>.freno_cuota_5h`).
 *
 * Una sola validación para el panel y para `set_config` (BE-117). `effort` se
 * valida solo: `esfuerzoParaCli` ya descarta en ejecución el que el modelo no
 * admite, y `set_config` recibe parches parciales (un `effort` sin `model`).
 */
'use strict';

const { tiposAvisosFondo, TIPOS_AVISOS_FONDO, timeoutValido, TIMEOUT_MAX } = require('./config.js');
const configMotores = require('../motores/config-motores.js');

const AISLAMIENTOS = ['auto', 'container', 'host'];
const ESFUERZOS = ['low', 'medium', 'high'];
const MOTORES_CON_FRENO = ['claude', 'antigravity'];
const CLAVES = ['model', 'effort', 'timeout_minutes', 'readonly_isolation', 'background_toasts', 'frenos'];
const MAX_MODELO = 128;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

class ErrorAjuste extends Error {
  constructor(mensaje, campo = null) {
    super(mensaje);
    this.campo = campo;
  }
}

const frenoDe = (datos, motor) => (esObjeto(datos.motores) && esObjeto(datos.motores[motor]) ? datos.motores[motor].freno_cuota_5h : undefined);

/** Lo crudo de la sección, para su versión: cambia si cambia el archivo. */
function crudoGeneral(datos) {
  return {
    model: datos.model ?? null,
    effort: datos.effort ?? null,
    timeout_minutes: datos.timeout_minutes ?? null,
    readonly_isolation: datos.readonly_isolation ?? null,
    background_toasts: datos.background_toasts ?? null,
    frenos: Object.fromEntries(MOTORES_CON_FRENO.map((m) => [m, frenoDe(datos, m) ?? null]))
  };
}

/**
 * Para la pantalla: `null` es «no está en el archivo» (rige el valor por
 * defecto). Lo que no valida se devuelve como `null` con un aviso.
 */
function leerGeneral(datos) {
  const avisos = [];
  const c = crudoGeneral(datos);
  const general = { model: null, effort: null, timeout_minutes: null, readonly_isolation: null, background_toasts: null, frenos: {} };
  try { general.model = validarModelo(c.model); } catch (e) { avisos.push(`model no valida (${e.message}); se ignora`); }
  if (ESFUERZOS.includes(c.effort) || c.effort === null) general.effort = c.effort;
  else avisos.push(`effort = ${JSON.stringify(c.effort)} no es low, medium ni high`);
  if (c.timeout_minutes === null || timeoutValido(c.timeout_minutes)) general.timeout_minutes = c.timeout_minutes;
  else avisos.push(`timeout_minutes = ${JSON.stringify(c.timeout_minutes)} se ignora: tiene que ser un entero de 1 a ${TIMEOUT_MAX}`);
  if (c.readonly_isolation === null || AISLAMIENTOS.includes(c.readonly_isolation)) general.readonly_isolation = c.readonly_isolation;
  else avisos.push(`readonly_isolation = ${JSON.stringify(c.readonly_isolation)} se ignora (rige auto)`);
  if (c.background_toasts !== null) {
    const t = tiposAvisosFondo(c.background_toasts);
    if (t) general.background_toasts = t;
    else avisos.push(`background_toasts = ${JSON.stringify(c.background_toasts)} se ignora (rigen todos)`);
  }
  for (const m of MOTORES_CON_FRENO) {
    const f = c.frenos[m];
    general.frenos[m] = Number.isFinite(f) && f >= 0 && f <= 1 ? f : null;
    if (f !== null && general.frenos[m] === null) avisos.push(`motores.${m}.freno_cuota_5h = ${JSON.stringify(f)} se ignora (va de 0 a 1)`);
  }
  return { general, avisos };
}

function validarModelo(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || !v.trim() || v.trim().length > MAX_MODELO || CONTROLES.test(v)) {
    throw new ErrorAjuste(`El modelo tiene que ser un nombre de hasta ${MAX_MODELO} caracteres, o ninguno (decide agy)`, 'general.model');
  }
  return v.trim();
}

/**
 * Los valores por defecto de agy que trae el pedido (las claves ausentes no se
 * miran). Devuelve los normalizados; lanza `ErrorAjuste`. Lo usa `set_config`.
 */
function validarDefectosAgy(pedido) {
  const salida = {};
  if (pedido.model !== undefined) salida.model = validarModelo(pedido.model);
  if (pedido.effort !== undefined) {
    if (pedido.effort !== null && !ESFUERZOS.includes(pedido.effort)) throw new ErrorAjuste(`El esfuerzo tiene que ser ${ESFUERZOS.join(', ')} o ninguno`, 'general.effort');
    salida.effort = pedido.effort;
  }
  if (pedido.timeout_minutes !== undefined) {
    if (pedido.timeout_minutes !== null && !timeoutValido(pedido.timeout_minutes)) throw new ErrorAjuste(`El timeout tiene que ser un entero de 1 a ${TIMEOUT_MAX} minutos`, 'general.timeout_minutes');
    salida.timeout_minutes = pedido.timeout_minutes;
  }
  return salida;
}

/** `background_toasts` en su forma canónica: `undefined` (todos, se borra la clave), `'none'` o la lista en orden. */
function toastsCanonicos(v) {
  const tipos = Array.isArray(v) && v.length === 0 ? [] : tiposAvisosFondo(v);
  if (!tipos) throw new ErrorAjuste(`Avisos de fondo: "all", "none" o una lista de ${TIPOS_AVISOS_FONDO.join(', ')}`, 'general.background_toasts');
  if (tipos.length === TIPOS_AVISOS_FONDO.length) return undefined;
  if (!tipos.length) return 'none';
  return TIPOS_AVISOS_FONDO.filter((t) => tipos.includes(t));
}

/** Aplica el pedido (solo las claves que trae) sobre `datos`. Lanza `ErrorAjuste`. */
function aplicarGeneral(datos, pedido) {
  if (!esObjeto(pedido)) throw new ErrorAjuste('general tiene que ser un objeto', 'general');
  for (const k of Object.keys(pedido)) {
    if (!CLAVES.includes(k)) throw new ErrorAjuste(`general.${k} no está permitido`, `general.${k}`);
  }
  const salida = { ...datos };
  const poner = (k, v) => { if (v === null || v === undefined) delete salida[k]; else salida[k] = v; };
  for (const [k, v] of Object.entries(validarDefectosAgy(pedido))) poner(k, v);
  if (pedido.readonly_isolation !== undefined) {
    if (pedido.readonly_isolation !== null && !AISLAMIENTOS.includes(pedido.readonly_isolation)) throw new ErrorAjuste(`El aislamiento tiene que ser ${AISLAMIENTOS.join(', ')}`, 'general.readonly_isolation');
    poner('readonly_isolation', pedido.readonly_isolation);
  }
  if (pedido.background_toasts !== undefined) poner('background_toasts', pedido.background_toasts === null ? undefined : toastsCanonicos(pedido.background_toasts));
  if (pedido.frenos !== undefined) {
    if (!esObjeto(pedido.frenos)) throw new ErrorAjuste('frenos tiene que ser un objeto { claude, antigravity }', 'general.frenos');
    const cambios = {};
    for (const [m, f] of Object.entries(pedido.frenos)) {
      if (!MOTORES_CON_FRENO.includes(m)) throw new ErrorAjuste(`general.frenos.${m} no está permitido`, `general.frenos.${m}`);
      if (f !== null && !(Number.isFinite(f) && f >= 0 && f <= 1)) throw new ErrorAjuste('El freno va de 0 a 1 (0 % a 100 %), o ninguno', `general.frenos.${m}`);
      // Quitar un freno que no está es un no-op: no crea `motores.<m>` vacío.
      if (f === null && frenoDe(salida, m) === undefined) continue;
      cambios[m] = { freno_cuota_5h: f };
    }
    if (Object.keys(cambios).length) {
      try {
        salida.motores = configMotores.fusionarMotores(salida.motores, cambios);
      } catch (e) {
        throw new ErrorAjuste(e.message, 'general.frenos');
      }
    }
  }
  return salida;
}

module.exports = {
  ErrorAjuste, AISLAMIENTOS, ESFUERZOS, MOTORES_CON_FRENO, crudoGeneral, leerGeneral, validarDefectosAgy, aplicarGeneral
};
