/**
 * FEAT-210 — La sección `imagenes` de la configuración: las imágenes de las almas.
 *
 * Solo global (`~/.claude/antigravity.json`): un repo clonado no puede encender
 * un proveedor remoto ni apuntar a un flujo de ComfyUI. `normalizar` es la
 * lectura tolerante (lo inválido cae a su valor por defecto, con aviso) y la usa
 * todo lo que decide en caliente (la consigna del alma, la cola, `capacidades`);
 * `aplicarImagenes` es la escritura estricta de Ajustes.
 *
 * FEAT-212 — Suma los perfiles propios, los flujos por perfil, los LoRAs y la
 * edición. `leerSeccion` es la única lectura: si el archivo trae claves de 2.18,
 * las traduce en memoria (`imagenes/migracion.js`) antes de normalizar.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const almasRutas = require('../almas/rutas.js');
const perfiles = require('../imagenes/perfiles.js');
const flujosLib = require('../imagenes/flujos.js');
const migracion = require('../imagenes/migracion.js');
const catalogos = require('../imagenes/catalogo.js');
const { esLoopback } = require('../imagenes/loopback.js');
const flagsComfyui = require('../imagenes/comfyui-flags.js');
// La hoja, no ajustes-general.js: config.js lee esta sección y ajustes-general.js lee config.js.
const { ErrorAjuste } = require('./error-ajuste.js');

const PROVEEDORES = Object.freeze(['comfyui', 'antigravity', 'openai', 'gemini']);
const REMOTOS = Object.freeze({ openai: 'openai_imagen', gemini: 'gemini_imagen' });
const BOOLEANOS = Object.freeze(['activas', 'refinar', 'alma_la_ve', 'otra_version', 'fotos_seguras', 'reconocer_propias', 'reconocer_telegram',
  // FEAT-213 — Partir de una imagen.
  'responder_usa_imagen', 'usar_ultima', 'foto_cuenta', 'fuerza_automatica',
  // FEAT-215 — El alma ve con la visión de su modelo.
  'vision_propia', 'variar', 'partir', 'varias_bases',
  // Imágenes en un hilo con contenido de afuera aunque el usuario no las pida en ese mensaje (apagada: una instrucción
  // escondida en una página podría guiar la imagen).
  'hilo_externo']);
/** FEAT-215 — Con varias versiones sin elegir. */
const VARIAS_VERSIONES = Object.freeze(['preguntar', 'ultima']);
const CAMPOS = Object.freeze([...BOOLEANOS, 'varias_versiones', 'tope_por_alma', 'orden', 'por_alma', 'comfyui', 'perfiles_propios', 'openai_imagen', 'gemini_imagen', 'taller']);
/**
 * FEAT-214 — El taller: los interruptores (prendidos) y qué pasa con lo que quedó en la tira al cerrarlo.
 * FEAT-217 — `disposicion_plugin`: acomodar las plantillas del plugin con la disposición que traen.
 */
const TALLER_BOOLEANOS = Object.freeze(['activo', 'abrir_en_taller', 'prepara_alma', 'mirar', 'disposicion_plugin']);
const AL_CERRAR = Object.freeze(['preguntar', 'descartar', 'quedar']);
const MASCARAS = Object.freeze(['florence2', 'sam2', 'no']);
const RETOQUES = Object.freeze(['crop-stitch', 'fill', 'no']);
const MAX_LORAS = 20;
const MAX_INVALIDOS = 40;
const URL_COMFYUI = 'http://127.0.0.1:8188';
const MAX_TEXTO = 200;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const RE_KEY_ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RE_NODO = /^[A-Za-z0-9_:.-]{1,40}$/;

// `pasos` y `tope_prompt` viven en el perfil desde FEAT-212: acá quedan por los campos viejos de Desktop v0.21.1.
const RANGOS = Object.freeze({
  pasos: { min: 1, max: 150 },
  tiempo_s: { min: 10, max: 3600, defecto: 300 },
  tope_prompt: { min: 100, max: 2000 },
  // FEAT-213 — 0 = sin tope, y 0 = nunca se apaga solo.
  tope_por_alma: { min: 0, max: 10000, defecto: 500 },
  apagar_min: { min: 0, max: 1440, defecto: 20 },
  espera_s: { min: 10, max: 600, defecto: 120 }
});
const NUMEROS = Object.freeze(['tiempo_s']);
const MODELO_POR_DEFECTO = 'sd_xl_base_1.0.safetensors';

function defectos() {
  return {
    activas: true,
    orden: ['comfyui', 'antigravity'],
    por_alma: {},
    refinar: true,
    alma_la_ve: true,
    otra_version: true,
    fotos_seguras: true,
    reconocer_propias: true,
    reconocer_telegram: true,
    responder_usa_imagen: true,
    usar_ultima: true,
    foto_cuenta: true,
    fuerza_automatica: true,
    vision_propia: true,
    variar: true,
    partir: true,
    varias_bases: true,
    hilo_externo: false,
    varias_versiones: 'preguntar',
    tope_por_alma: RANGOS.tope_por_alma.defecto,
    perfiles_propios: {},
    comfyui: {
      url: URL_COMFYUI, modelo: MODELO_POR_DEFECTO, modelo_edicion: null, modelo_retoque: null, perfil_de: {}, seguro_de: {}, flujos: {},
      // FEAT-218 — Elegir el modelo según el pedido (solo actúa con 2 o más candidatos) y la segunda pasada por perfil.
      modelo_automatico: true, candidatos: [], hires_de: {}, hires_modelo_de: {},
      mascara: 'florence2', retoque: 'crop-stitch', chequeo_zona: true, loras: [], loras_activos: true,
      tiempo_s: RANGOS.tiempo_s.defecto, liberar_gpu: true,
      arranque: { carpeta: null, automatico: true, apagar_min: RANGOS.apagar_min.defecto, espera_s: RANGOS.espera_s.defecto, flags: [] }
    },
    openai_imagen: { url: null, modelo: null, key_env: null },
    gemini_imagen: { url: null, modelo: null, key_env: null },
    taller: { activo: true, abrir_en_taller: true, prepara_alma: true, mirar: true, disposicion_plugin: true, al_cerrar: 'preguntar' }
  };
}

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function esHttps(url) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}

function texto(v) {
  return typeof v === 'string' && v.trim() && v.trim().length <= MAX_TEXTO && !CONTROLES.test(v) ? v.trim() : null;
}

const RE_CLAVE_LORA = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,29}$/u;
const reservada = (k) => perfiles.RESERVADAS.includes(k);
const conClave = (o, k, v) => Object.fromEntries([...Object.entries(esObjeto(o) ? o : {}).filter(([x]) => x !== k), [k, v]]);
const sinClave = (o, k) => Object.fromEntries(Object.entries(esObjeto(o) ? o : {}).filter(([x]) => x !== k));

/** FEAT-216 — Cuántos perfiles pueden tener el modo seguro elegido (los del plugin y los propios). */
const MAX_SEGURO_DE = 40;

/** El nombre de un modelo, como clave de `perfil_de`: `null` si vale, o el motivo. */
function formaDeClaveDeModelo(k) {
  if (reservada(k)) return 'no es un nombre de modelo';
  return perfiles.formaDeArchivo(k, MAX_TEXTO);
}

/** FEAT-218 — Hasta cuántos modelos puede nombrar una LoRA en `modelos`, y cuántos candidatos hay. */
const MAX_MODELOS_LORA = 10;
const MAX_CANDIDATOS = 4;
const MAX_PARA = 200;

/** FEAT-218 — Valida `comfyui.candidatos`. `{ ok, candidatos }` o `{ ok: false, campo, motivo }`. */
function validarCandidatos(v) {
  const mal = (campo, motivo) => ({ ok: false, campo: `candidatos${campo}`, motivo });
  if (!Array.isArray(v)) return mal('', 'tiene que ser una lista');
  if (v.length > MAX_CANDIDATOS) return mal('', `tiene hasta ${MAX_CANDIDATOS}`);
  const salida = [];
  for (const [i, c] of v.entries()) {
    if (!esObjeto(c)) return mal(`.${i}`, 'tiene que ser un objeto { archivo, para }');
    for (const k of Object.keys(c)) if (!['archivo', 'para'].includes(k)) return mal(`.${i}.${k}`, 'no está permitido');
    const m = formaDeClaveDeModelo(c.archivo);
    if (m) return mal(`.${i}.archivo`, m);
    const archivo = c.archivo.trim();
    if (salida.some((x) => perfiles.mismoArchivo(x.archivo, archivo))) return mal(`.${i}.archivo`, 'está repetido');
    const para = typeof c.para === 'string' ? c.para.trim() : '';
    if (!para || para.length > MAX_PARA || CONTROLES.test(para)) return mal(`.${i}.para`, `tiene que ser un texto de una línea de 1 a ${MAX_PARA} caracteres`);
    salida.push({ archivo, para });
  }
  return { ok: true, candidatos: salida };
}

/** Valida la lista de LoRAs. `{ ok, loras }` o `{ ok: false, campo, motivo }`. */
function validarLoras(v) {
  const mal = (campo, motivo) => ({ ok: false, campo: `loras${campo}`, motivo });
  if (!Array.isArray(v)) return mal('', 'tiene que ser una lista');
  if (v.length > MAX_LORAS) return mal('', `tiene hasta ${MAX_LORAS}`);
  const claves = new Set();
  const loras = [];
  for (const [i, l] of v.entries()) {
    if (!esObjeto(l)) return mal(`.${i}`, 'tiene que ser un objeto');
    for (const k of Object.keys(l)) if (!['archivo', 'clave', 'familias', 'fuerza', 'activo', 'modelos'].includes(k)) return mal(`.${i}.${k}`, 'no está permitido');
    const m = perfiles.formaDeArchivo(l.archivo);
    if (m) return mal(`.${i}.archivo`, m);
    const clave = typeof l.clave === 'string' ? l.clave.trim() : '';
    if (!RE_CLAVE_LORA.test(clave)) return mal(`.${i}.clave`, 'tiene que tener de 1 a 30 letras, números o espacios');
    if (claves.has(clave.toLowerCase())) return mal(`.${i}.clave`, 'está repetida');
    claves.add(clave.toLowerCase());
    if (!Array.isArray(l.familias) || !l.familias.length || !l.familias.every((f) => perfiles.FAMILIAS.includes(f)) || new Set(l.familias).size !== l.familias.length) return mal(`.${i}.familias`, `tiene que ser una lista de ${perfiles.FAMILIAS.join(', ')}`);
    if (!Number.isFinite(l.fuerza) || l.fuerza < 0 || l.fuerza > 2) return mal(`.${i}.fuerza`, 'tiene que ser un número de 0 a 2');
    if (typeof l.activo !== 'boolean') return mal(`.${i}.activo`, 'tiene que ser true o false');
    // FEAT-218 — Con qué modelos va (opcional: sin ella, con todos los de sus familias). `null` es «sin restricción».
    let modelos = null;
    if (l.modelos !== undefined && l.modelos !== null) {
      if (!Array.isArray(l.modelos) || !l.modelos.length || l.modelos.length > MAX_MODELOS_LORA) return mal(`.${i}.modelos`, `tiene que ser una lista de 1 a ${MAX_MODELOS_LORA} modelos, o null`);
      modelos = [];
      for (const [j, mod] of l.modelos.entries()) {
        const mm = perfiles.formaDeArchivo(mod);
        if (mm) return mal(`.${i}.modelos.${j}`, mm);
        if (modelos.some((x) => perfiles.mismoArchivo(x, mod))) return mal(`.${i}.modelos.${j}`, 'está repetido');
        modelos.push(mod.trim());
      }
    }
    loras.push({ archivo: l.archivo.trim(), clave, familias: [...l.familias], fuerza: l.fuerza, activo: l.activo, ...(modelos ? { modelos } : {}) });
  }
  return { ok: true, loras };
}

/** Una entrada de `flujos[<perfil>][<caso>]`, sin leer el archivo. `{ ok, entrada }` o `{ ok: false, campo, motivo }`. */
function validarEntradaDeFlujo(e, { denyPaths = [] } = {}) {
  if (!esObjeto(e)) return { ok: false, campo: '', motivo: 'tiene que ser un objeto { archivo, salida }' };
  for (const k of Object.keys(e)) if (!['archivo', 'salida'].includes(k)) return { ok: false, campo: `.${k}`, motivo: 'no está permitido' };
  const forma = flujosLib.formaDeFlujo(e.archivo, { denyPaths });
  if (!forma.ok) return { ok: false, campo: '.archivo', motivo: forma.motivo };
  const salida = e.salida === undefined || e.salida === null || e.salida === '' ? null : String(e.salida);
  if (salida !== null && !RE_NODO.test(salida)) return { ok: false, campo: '.salida', motivo: 'tiene que ser el id de un nodo del flujo' };
  return { ok: true, entrada: { archivo: forma.ruta, salida } };
}

/** FEAT-213 — La carpeta de ComfyUI: absoluta y local. `null` si vale, o el motivo. */
function formaDeCarpeta(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 260 || CONTROLES.test(v)) return 'no es una carpeta válida';
  const c = v.trim();
  if (/^[\\/]{2}/.test(c)) return 'tiene que ser local (sin carpetas de red)';
  if (!path.isAbsolute(c) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c))) return 'tiene que ser una ruta completa';
  return null;
}

/** FEAT-213 — `comfyui.arranque`, tolerante. */
function normalizarArranque(a, d, avisos) {
  if (a === undefined || a === null) return;
  if (!esObjeto(a)) { avisos.push('imagenes.comfyui.arranque tiene que ser un objeto; se ignora'); return; }
  if (a.carpeta) {
    const m = formaDeCarpeta(a.carpeta);
    if (m) avisos.push(`imagenes.comfyui.arranque.carpeta ${m}; se ignora`); else d.carpeta = a.carpeta.trim();
  }
  if (typeof a.automatico === 'boolean') d.automatico = a.automatico;
  else if (a.automatico !== undefined && a.automatico !== null) avisos.push('imagenes.comfyui.arranque.automatico tiene que ser true o false; se ignora');
  for (const k of ['apagar_min', 'espera_s']) {
    if (a[k] === undefined || a[k] === null) continue;
    d[k] = rangoTolerante(a[k], k);
    if (d[k] !== a[k]) avisos.push(`imagenes.comfyui.arranque.${k} tiene que ser un entero entre ${RANGOS[k].min} y ${RANGOS[k].max}; se usa ${RANGOS[k].defecto}`);
  }
  if (a.flags !== undefined && a.flags !== null) {
    const v = flagsComfyui.validarForma(a.flags);
    if (v.ok) d.flags = v.flags; else avisos.push(`imagenes.comfyui.arranque.flags${v.campo} ${v.motivo}; no se usa ninguna`);
  }
}

function rangoTolerante(v, campo) {
  const r = RANGOS[campo];
  return Number.isInteger(v) && v >= r.min && v <= r.max ? v : r.defecto;
}

/**
 * La lectura tolerante: cada campo inválido cae a su valor por defecto y se avisa. `{ imagenes, avisos }`.
 * `almas`, si viene, filtra `por_alma` a las que existen (con aviso).
 */
function normalizar(crudo, { almas = null, denyPaths = [] } = {}) {
  const d = defectos();
  d[flujosLib.DENY] = denyPaths;
  const avisos = [];
  const invalidos = [];
  const invalido = (donde, motivo) => {
    if (invalidos.length < MAX_INVALIDOS) invalidos.push({ donde: donde.slice(0, 200), motivo: String(motivo).slice(0, 120) });
    avisos.push(`imagenes.${donde} ${motivo}; se ignora`);
  };
  if (crudo === undefined || crudo === null) return { imagenes: d, avisos, invalidos };
  if (!esObjeto(crudo)) return { imagenes: d, avisos: ['imagenes tiene que ser un objeto; se usan los valores por defecto'], invalidos };
  if (crudo.perfiles_propios !== undefined && crudo.perfiles_propios !== null) {
    if (!esObjeto(crudo.perfiles_propios)) invalido('perfiles_propios', 'tiene que ser un objeto');
    else {
      const validos = [];
      for (const [id, p] of Object.entries(crudo.perfiles_propios)) {
        if (validos.length >= perfiles.MAX_PROPIOS) { invalido(`perfiles_propios.${id}`, `pasa los ${perfiles.MAX_PROPIOS} perfiles`); continue; }
        const v = perfiles.validarPerfil(id, esObjeto(p) ? { ...p, id: undefined } : p);
        if (v.ok) { const { id: _, ...resto } = v.perfil; validos.push([id, resto]); } else invalido(`perfiles_propios.${id}${v.campo ? `.${v.campo}` : ''}`, v.motivo);
      }
      d.perfiles_propios = Object.fromEntries(validos);
    }
  }
  for (const k of BOOLEANOS) {
    if (crudo[k] === undefined) continue;
    if (typeof crudo[k] === 'boolean') d[k] = crudo[k];
    else avisos.push(`imagenes.${k} tiene que ser true o false; se usa ${d[k]}`);
  }
  if (crudo.varias_versiones !== undefined && crudo.varias_versiones !== null) {
    if (VARIAS_VERSIONES.includes(crudo.varias_versiones)) d.varias_versiones = crudo.varias_versiones;
    else avisos.push(`imagenes.varias_versiones tiene que ser ${VARIAS_VERSIONES.join(' o ')}; se usa ${d.varias_versiones}`);
  }
  if (crudo.tope_por_alma !== undefined && crudo.tope_por_alma !== null) {
    d.tope_por_alma = rangoTolerante(crudo.tope_por_alma, 'tope_por_alma');
    if (d.tope_por_alma !== crudo.tope_por_alma) avisos.push(`imagenes.tope_por_alma tiene que ser un entero entre 0 y ${RANGOS.tope_por_alma.max}; se usa ${RANGOS.tope_por_alma.defecto}`);
  }
  if (crudo.orden !== undefined) {
    if (Array.isArray(crudo.orden) && crudo.orden.every((p) => PROVEEDORES.includes(p)) && new Set(crudo.orden).size === crudo.orden.length) d.orden = [...crudo.orden];
    else avisos.push(`imagenes.orden tiene que ser una lista sin repetidos de ${PROVEEDORES.join(', ')}; se usa ${d.orden.join(', ')}`);
  }
  if (crudo.por_alma !== undefined) {
    if (!esObjeto(crudo.por_alma)) avisos.push('imagenes.por_alma tiene que ser un objeto { alma: false }; se ignora');
    else {
      const existe = almas ? new Set(almas) : null;
      for (const [clave, v] of Object.entries(crudo.por_alma)) {
        if (!almasRutas.CLAVE_VALIDA.test(clave) || v !== false) { avisos.push(`imagenes.por_alma.${clave} no vale (solo false para un alma); se ignora`); continue; }
        if (existe && !existe.has(clave)) { avisos.push(`imagenes.por_alma: el alma "${clave}" no existe; su entrada no se usa ni se toca`); continue; }
        d.por_alma[clave] = false;
      }
    }
  }
  if (crudo.comfyui !== undefined) {
    const c = crudo.comfyui;
    if (!esObjeto(c)) avisos.push('imagenes.comfyui tiene que ser un objeto; se usan los valores por defecto');
    else {
      if (c.url !== undefined && c.url !== null) {
        if (esLoopback(c.url)) d.comfyui.url = String(c.url).replace(/\/+$/, '');
        else avisos.push('imagenes.comfyui.url tiene que ser de esta máquina (127.0.0.1, localhost o [::1]); se usa la de siempre');
      }
      for (const k of ['modelo', 'modelo_edicion', 'modelo_retoque']) {
        if (c[k] === undefined || c[k] === null || c[k] === '') continue;
        if (perfiles.formaDeArchivo(c[k], MAX_TEXTO) === null) d.comfyui[k] = c[k].trim();
        else avisos.push(`imagenes.comfyui.${k} no es un nombre de archivo válido; se usa el de siempre`);
      }
      if (c.perfil_de !== undefined && c.perfil_de !== null) {
        if (!esObjeto(c.perfil_de)) invalido('comfyui.perfil_de', 'tiene que ser un objeto { modelo: perfil }');
        else {
          const validos = [];
          for (const [k, v] of Object.entries(c.perfil_de)) {
            const m = formaDeClaveDeModelo(k);
            if (m) invalido(`comfyui.perfil_de.${k}`, m);
            else if (typeof v !== 'string' || !perfiles.RE_ID.test(v) || reservada(v)) invalido(`comfyui.perfil_de.${k}`, 'tiene que ser el id de un perfil');
            else if (validos.length >= migracion.MAX_PERFIL_DE) invalido(`comfyui.perfil_de.${k}`, `pasa las ${migracion.MAX_PERFIL_DE} entradas`);
            else validos.push([k, v]);
          }
          d.comfyui.perfil_de = Object.fromEntries(validos);
        }
      }
      // FEAT-216 — «Solo contenido seguro» por perfil: { <perfil>: false } lo apaga (sin entrada, prendido).
      if (c.seguro_de !== undefined && c.seguro_de !== null) {
        if (!esObjeto(c.seguro_de)) invalido('comfyui.seguro_de', 'tiene que ser un objeto { perfil: true|false }');
        else {
          const validos = [];
          for (const [k, v] of Object.entries(c.seguro_de)) {
            if (!perfiles.RE_ID.test(k) || reservada(k)) invalido(`comfyui.seguro_de.${k}`, 'tiene que ser el id de un perfil');
            else if (typeof v !== 'boolean') invalido(`comfyui.seguro_de.${k}`, 'tiene que ser true o false');
            else if (validos.length >= MAX_SEGURO_DE) invalido(`comfyui.seguro_de.${k}`, `pasa las ${MAX_SEGURO_DE} entradas`);
            else validos.push([k, v]);
          }
          d.comfyui.seguro_de = Object.fromEntries(validos);
        }
      }
      // FEAT-218 — La segunda pasada por perfil: { <perfil>: true } la prende (sin entrada, apagada).
      if (c.hires_de !== undefined && c.hires_de !== null) {
        if (!esObjeto(c.hires_de)) invalido('comfyui.hires_de', 'tiene que ser un objeto { perfil: true|false }');
        else {
          const validos = [];
          for (const [k, v] of Object.entries(c.hires_de)) {
            if (!perfiles.RE_ID.test(k) || reservada(k)) invalido(`comfyui.hires_de.${k}`, 'tiene que ser el id de un perfil');
            else if (typeof v !== 'boolean') invalido(`comfyui.hires_de.${k}`, 'tiene que ser true o false');
            else if (validos.length >= MAX_SEGURO_DE) invalido(`comfyui.hires_de.${k}`, `pasa las ${MAX_SEGURO_DE} entradas`);
            else validos.push([k, v]);
          }
          d.comfyui.hires_de = Object.fromEntries(validos);
        }
      }
      // FEAT-218 S1.1 — El modelo de reescalado de la segunda pasada por perfil (sin entrada, en el latente).
      if (c.hires_modelo_de !== undefined && c.hires_modelo_de !== null) {
        if (!esObjeto(c.hires_modelo_de)) invalido('comfyui.hires_modelo_de', 'tiene que ser un objeto { perfil: archivo }');
        else {
          const validos = [];
          for (const [k, v] of Object.entries(c.hires_modelo_de)) {
            if (!perfiles.RE_ID.test(k) || reservada(k)) invalido(`comfyui.hires_modelo_de.${k}`, 'tiene que ser el id de un perfil');
            else if (perfiles.formaDeArchivo(v, MAX_TEXTO) !== null) invalido(`comfyui.hires_modelo_de.${k}`, perfiles.formaDeArchivo(v, MAX_TEXTO));
            else if (validos.length >= MAX_SEGURO_DE) invalido(`comfyui.hires_modelo_de.${k}`, `pasa las ${MAX_SEGURO_DE} entradas`);
            else validos.push([k, v.trim()]);
          }
          d.comfyui.hires_modelo_de = Object.fromEntries(validos);
        }
      }
      // FEAT-218 — Los modelos entre los que elige el refinador.
      if (c.candidatos !== undefined && c.candidatos !== null) {
        const v = validarCandidatos(c.candidatos);
        if (v.ok) d.comfyui.candidatos = v.candidatos; else invalido(`comfyui.${v.campo}`, v.motivo);
      }
      if (c.flujos !== undefined && c.flujos !== null) {
        if (!esObjeto(c.flujos)) invalido('comfyui.flujos', 'tiene que ser un objeto');
        else {
          const porPerfil = [];
          for (const [id, casos] of Object.entries(c.flujos)) {
            if (!perfiles.perfil(d, id)) { invalido(`comfyui.flujos.${id}`, 'no es un perfil que exista'); continue; }
            if (!esObjeto(casos)) { invalido(`comfyui.flujos.${id}`, 'tiene que ser un objeto'); continue; }
            const validos = [];
            for (const [caso, e] of Object.entries(casos)) {
              if (!flujosLib.CASOS_PROPIOS.includes(caso)) { invalido(`comfyui.flujos.${id}.${caso}`, caso === 'retoque' ? 'el retoque con flujo propio llega en una rebanada posterior' : 'no es un caso'); continue; }
              const v = validarEntradaDeFlujo(e, { denyPaths });
              if (v.ok) validos.push([caso, v.entrada]); else invalido(`comfyui.flujos.${id}.${caso}${v.campo}`, v.motivo);
            }
            if (validos.length) porPerfil.push([id, Object.fromEntries(validos)]);
          }
          d.comfyui.flujos = Object.fromEntries(porPerfil);
        }
      }
      for (const [k, lista] of [['mascara', MASCARAS], ['retoque', RETOQUES]]) {
        if (c[k] === undefined || c[k] === null) continue;
        if (lista.includes(c[k])) d.comfyui[k] = c[k]; else avisos.push(`imagenes.comfyui.${k} tiene que ser ${lista.join(', ')}; se usa ${d.comfyui[k]}`);
      }
      for (const k of ['chequeo_zona', 'loras_activos', 'modelo_automatico']) {
        if (c[k] === undefined || c[k] === null) continue;
        if (typeof c[k] === 'boolean') d.comfyui[k] = c[k]; else avisos.push(`imagenes.comfyui.${k} tiene que ser true o false; se usa ${d.comfyui[k]}`);
      }
      if (c.loras !== undefined && c.loras !== null) {
        const v = validarLoras(c.loras);
        if (v.ok) d.comfyui.loras = v.loras; else avisos.push(`imagenes.comfyui.${v.campo} ${v.motivo}; se ignoran los LoRAs`);
      }
      for (const k of NUMEROS) {
        if (c[k] === undefined || c[k] === null) continue;
        d.comfyui[k] = rangoTolerante(c[k], k);
        if (d.comfyui[k] !== c[k]) avisos.push(`imagenes.comfyui.${k} tiene que ser un entero entre ${RANGOS[k].min} y ${RANGOS[k].max}; se usa ${RANGOS[k].defecto}`);
      }
      normalizarArranque(c.arranque, d.comfyui.arranque, avisos);
      if (typeof c.liberar_gpu === 'boolean') d.comfyui.liberar_gpu = c.liberar_gpu;
      else if (c.liberar_gpu !== undefined && c.liberar_gpu !== null) avisos.push('imagenes.comfyui.liberar_gpu tiene que ser true o false; se ignora');
    }
  }
  for (const campo of Object.values(REMOTOS)) {
    const r = crudo[campo];
    if (r === undefined || r === null) continue;
    if (!esObjeto(r)) { avisos.push(`imagenes.${campo} tiene que ser un objeto; se ignora`); continue; }
    if (r.url) { if (esHttps(r.url)) d[campo].url = String(r.url); else avisos.push(`imagenes.${campo}.url tiene que ser https; se ignora`); }
    if (r.modelo) { if (texto(r.modelo)) d[campo].modelo = texto(r.modelo); else avisos.push(`imagenes.${campo}.modelo no es un nombre válido; se ignora`); }
    if (r.key_env) { if (RE_KEY_ENV.test(String(r.key_env))) d[campo].key_env = String(r.key_env); else avisos.push(`imagenes.${campo}.key_env tiene que ser el nombre de una variable (MAYÚSCULAS_Y_GUIONES); se ignora`); }
  }
  if (crudo.taller !== undefined && crudo.taller !== null) {
    if (!esObjeto(crudo.taller)) avisos.push('imagenes.taller tiene que ser un objeto; se usan los valores por defecto');
    else {
      for (const k of TALLER_BOOLEANOS) {
        if (crudo.taller[k] === undefined) continue;
        if (typeof crudo.taller[k] === 'boolean') d.taller[k] = crudo.taller[k];
        else avisos.push(`imagenes.taller.${k} tiene que ser true o false; se usa ${d.taller[k]}`);
      }
      if (crudo.taller.al_cerrar !== undefined) {
        if (AL_CERRAR.includes(crudo.taller.al_cerrar)) d.taller.al_cerrar = crudo.taller.al_cerrar;
        else avisos.push(`imagenes.taller.al_cerrar tiene que ser ${AL_CERRAR.join(', ')}; se usa ${d.taller.al_cerrar}`);
      }
    }
  }
  return { imagenes: d, avisos, invalidos };
}

/** La política de lectura de la config (`permissions.deny_paths`), o la de siempre. */
function denyDe(datos) {
  const p = datos && esObjeto(datos.permissions) ? datos.permissions : null;
  return p && Array.isArray(p.deny_paths) ? p.deny_paths : ['.env*', '**/*.key', '**/*.pem'];
}

// La última migración en memoria: la clave es la sección cruda más el tamaño y la fecha de los dos flujos legados.
let migrada = null;
let avisosDeMigracion = [];

function huellaDe(crudo, denyPaths) {
  const h = crypto.createHash('sha256').update(JSON.stringify([crudo, denyPaths]));
  for (const k of ['flujo_txt2img', 'flujo_img2img']) {
    const r = crudo.comfyui[k];
    try { if (typeof r === 'string' && flujosLib.formaDeFlujo(r, { denyPaths }).ok) { const st = fs.statSync(r.trim()); h.update(`${k}:${st.size}:${st.mtimeMs}`); } } catch {}
  }
  return h.digest('hex');
}

/** La sección cruda, sin claves de 2.18: `{ crudo, avisos }`. Si las trae, las traduce en memoria (con caché). */
function migrarCrudo(crudo, { denyPaths = [] } = {}) {
  if (!migracion.tieneLegado(crudo)) return { crudo, avisos: [] };
  const clave = huellaDe(crudo, denyPaths);
  if (migrada && migrada.clave === clave) return { crudo: migrada.crudo, avisos: migrada.avisos };
  const legado = Object.fromEntries(migracion.LEGADAS.filter((k) => Object.hasOwn(crudo.comfyui, k)).map((k) => [k, crudo.comfyui[k]]));
  const r = migracion.traducirLegado(crudo, legado, { manda: 'nuevo', denyPaths, catalogo: catalogos.enCache(crudo.comfyui.url || URL_COMFYUI), normalizar, modeloPorDefecto: MODELO_POR_DEFECTO });
  migrada = { clave, crudo: r.imagenes, avisos: r.avisos };
  return { crudo: r.imagenes, avisos: r.avisos };
}

/** Los datos enteros con `imagenes` migrada. `{ datos, cambio, avisos }`. Deja los avisos para el GET de este proceso. */
function migrarDatos(datos) {
  if (!migracion.tieneLegado(datos.imagenes)) return { datos, cambio: false, avisos: [] };
  const r = migrarCrudo(datos.imagenes, { denyPaths: denyDe(datos) });
  avisosDeMigracion = r.avisos;
  return { datos: { ...datos, imagenes: r.crudo }, cambio: true, avisos: r.avisos };
}

/**
 * La lectura de la sección, la única: migra en memoria lo de 2.18 y normaliza. La usan la cola (`disponible`), el GET
 * de Ajustes y la config del MCP. `{ imagenes, avisos, invalidos }`.
 */
function leerSeccion(datos, { almas = null } = {}) {
  const d = esObjeto(datos) ? datos : {};
  const denyPaths = denyDe(d);
  const m = migrarCrudo(d.imagenes, { denyPaths });
  const r = normalizar(m.crudo, { almas, denyPaths });
  return { ...r, avisos: [...r.avisos, ...m.avisos] };
}

/** La vista de un caso, para la tarjeta de la pestaña. La ruta de una plantilla del plugin no viaja. */
function vistaDeFlujo(imagenes, caso, catalogo) {
  const casos = require('../imagenes/casos.js');
  const modelo = casos.modeloDeCaso(imagenes, caso);
  const p = perfiles.perfilDe(imagenes, modelo || imagenes.comfyui.modelo, catalogo);
  const f = flujosLib.resolverFlujo(imagenes, p.perfil, caso);
  let motivo = modelo ? f.motivo : 'falta el modelo';
  if (modelo && f.ok && flujosLib.inyectaModelo(f.flujo) && p.cargaDelModelo !== p.perfil.carga.tipo) motivo = 'la carga del modelo no coincide con el perfil';
  return {
    modelo, perfil: p.perfil.id, familia: p.perfil.plantillas, archivo: f.archivo, nombre: f.nombre, propio: f.propio, salida: f.salida, salidas: f.salidas,
    ok: motivo === null, motivo: motivo || p.aviso || null, marcadores: f.marcadores.filter((m) => !/^lora_/.test(m)), huecosLora: f.huecos.length, ficha: f.conFicha
  };
}

/**
 * La sección, para la pantalla: los valores normalizados, los campos viejos que lee Desktop v0.21.1 (con los valores
 * efectivos) y lo que solo se lee: `perfiles`, `vistaFlujos` e `invalidos`.
 */
function leerImagenes(datos, { almas = null } = {}) {
  const { imagenes, avisos, invalidos } = leerSeccion(datos, { almas });
  const catalogo = catalogos.enCache(imagenes.comfyui.url);
  const vistaFlujos = Object.fromEntries(perfiles.CASOS.map((c) => [c, vistaDeFlujo(imagenes, c, catalogo)]));
  for (const c of ['nueva', 'variacion']) if (vistaFlujos[c].propio && !vistaFlujos[c].ok) avisos.push(`El flujo de ${c} no sirve: ${vistaFlujos[c].motivo}`);
  const principal = perfiles.perfilDe(imagenes, imagenes.comfyui.modelo, catalogo).perfil;
  const propio = (c) => flujosLib.flujoPropio(imagenes, principal.id, c);
  const entradas = ['nueva', 'variacion'].map(propio).filter(Boolean);
  const salidas = [...new Set(entradas.map((e) => e.salida))];
  const compat = {
    pasos: principal.muestreo.pasos, tope_prompt: principal.prompt.tope,
    flujo_txt2img: propio('nueva') ? propio('nueva').archivo : null, flujo_img2img: propio('variacion') ? propio('variacion').archivo : null,
    nodo_salida: salidas.length === 1 ? salidas[0] : null
  };
  const vieja = (v) => (v.ok ? { ok: true, marcadores: v.marcadores, plantilla: !v.propio } : { ok: false, motivo: v.motivo });
  return {
    imagenes: { ...imagenes, comfyui: { ...imagenes.comfyui, ...compat } },
    avisos: [...avisos, ...avisosDeMigracion.filter((a) => !avisos.includes(a))],
    flujos: { txt2img: vieja(vistaFlujos.nueva), img2img: vieja(vistaFlujos.variacion) },
    perfiles: perfiles.perfilesEfectivos(imagenes), vistaFlujos, invalidos
  };
}

/** Lo crudo de la sección, para su versión. */
function crudoImagenes(datos) {
  return datos.imagenes ?? null;
}

/**
 * La escritura estricta de Ajustes: cada campo que viene se valida y se aplica sobre lo guardado (las claves que el
 * panel no conoce se conservan). Lanza `ErrorAjuste`. `almas` son las claves que existen; `denyPaths`, los de la config.
 */
function aplicarImagenes(datos, pedido, { almas = [], denyPaths = [] } = {}) {
  if (!esObjeto(pedido)) throw new ErrorAjuste(`imagenes tiene que ser un objeto { ${CAMPOS.join(', ')} }`, 'imagenes');
  for (const k of Object.keys(pedido)) if (!CAMPOS.includes(k)) throw new ErrorAjuste(`imagenes.${k} no está permitido`, `imagenes.${k}`);
  const previo = esObjeto(datos.imagenes) ? datos.imagenes : {};
  const nuevo = { ...previo };
  for (const k of BOOLEANOS) {
    if (pedido[k] === undefined) continue;
    if (pedido[k] === null || pedido[k] === '') { delete nuevo[k]; continue; }
    if (typeof pedido[k] !== 'boolean') throw new ErrorAjuste(`imagenes.${k} tiene que ser true o false`, `imagenes.${k}`);
    nuevo[k] = pedido[k];
  }
  if (pedido.varias_versiones !== undefined) {
    const v = pedido.varias_versiones;
    if (v === null || v === '') delete nuevo.varias_versiones;
    else if (!VARIAS_VERSIONES.includes(v)) throw new ErrorAjuste(`Con varias versiones: ${VARIAS_VERSIONES.join(' o ')}`, 'imagenes.varias_versiones');
    else nuevo.varias_versiones = v;
  }
  if (pedido.tope_por_alma !== undefined) {
    const v = pedido.tope_por_alma;
    const rg = RANGOS.tope_por_alma;
    if (v === null || v === '') delete nuevo.tope_por_alma;
    else if (!Number.isInteger(v) || v < rg.min || v > rg.max) throw new ErrorAjuste(`El tope por alma tiene que ser un entero de ${rg.min} a ${rg.max} (0 = sin tope)`, 'imagenes.tope_por_alma');
    else nuevo.tope_por_alma = v;
  }
  if (pedido.taller !== undefined) {
    // Campo por campo: lo que no viene queda como estaba.
    const tl = pedido.taller;
    if (tl === null) delete nuevo.taller;
    else {
      if (!esObjeto(tl)) throw new ErrorAjuste(`imagenes.taller tiene que ser un objeto { ${[...TALLER_BOOLEANOS, 'al_cerrar'].join(', ')} }`, 'imagenes.taller');
      const t2 = esObjeto(previo.taller) ? { ...previo.taller } : {};
      for (const k of Object.keys(tl)) if (![...TALLER_BOOLEANOS, 'al_cerrar'].includes(k)) throw new ErrorAjuste(`imagenes.taller.${k} no está permitido`, `imagenes.taller.${k}`);
      for (const k of TALLER_BOOLEANOS) {
        if (tl[k] === undefined) continue;
        if (tl[k] === null) { delete t2[k]; continue; }
        if (typeof tl[k] !== 'boolean') throw new ErrorAjuste(`imagenes.taller.${k} tiene que ser true o false`, `imagenes.taller.${k}`);
        t2[k] = tl[k];
      }
      if (tl.al_cerrar !== undefined) {
        if (tl.al_cerrar === null) delete t2.al_cerrar;
        else if (!AL_CERRAR.includes(tl.al_cerrar)) throw new ErrorAjuste(`Al cerrar el taller: ${AL_CERRAR.join(', ')}`, 'imagenes.taller.al_cerrar');
        else t2.al_cerrar = tl.al_cerrar;
      }
      if (Object.keys(t2).length) nuevo.taller = t2; else delete nuevo.taller;
    }
  }
  if (pedido.orden !== undefined) {
    const o = pedido.orden;
    if (!Array.isArray(o) || !o.every((p) => PROVEEDORES.includes(p)) || new Set(o).size !== o.length) {
      throw new ErrorAjuste(`El orden tiene que ser una lista sin repetidos de ${PROVEEDORES.join(', ')}`, 'imagenes.orden');
    }
    nuevo.orden = [...o];
  }
  if (pedido.por_alma !== undefined) {
    if (pedido.por_alma !== null && !esObjeto(pedido.por_alma)) throw new ErrorAjuste('imagenes.por_alma tiene que ser un objeto { alma: false }', 'imagenes.por_alma');
    const viejo = esObjeto(previo.por_alma) ? previo.por_alma : {};
    const existe = new Set(almas);
    const tabla = {};
    for (const [clave, v] of Object.entries(pedido.por_alma || {})) {
      if (v === null || v === true) continue; // prendida: sin entrada
      if (!almasRutas.CLAVE_VALIDA.test(clave) || v !== false) throw new ErrorAjuste(`imagenes.por_alma.${clave} tiene que ser false (o no estar)`, `imagenes.por_alma.${clave}`);
      if (viejo[clave] !== false && !existe.has(clave)) throw new ErrorAjuste(`"${clave}" no es un alma de esta máquina`, `imagenes.por_alma.${clave}`);
      tabla[clave] = false;
    }
    if (Object.keys(tabla).length) nuevo.por_alma = tabla; else delete nuevo.por_alma;
  }
  if (pedido.perfiles_propios !== undefined) {
    const p = pedido.perfiles_propios;
    if (p !== null && !esObjeto(p)) throw new ErrorAjuste('imagenes.perfiles_propios tiene que ser un objeto { id: perfil }', 'imagenes.perfiles_propios');
    let tabla = p === null ? {} : esObjeto(previo.perfiles_propios) ? previo.perfiles_propios : {};
    for (const [id, v0] of Object.entries(p || {})) {
      if (v0 === null) { tabla = sinClave(tabla, id); continue; }
      // FEAT-218 — `muestreo.hires`: sin la clave se conserva el que tenía (un Desktop que no la conoce no la borra); `null`
      // la saca, antes de validar (`validarPerfil` no tiene por qué aceptar `null`).
      let v = v0;
      if (esObjeto(v0) && esObjeto(v0.muestreo)) {
        const m = { ...v0.muestreo };
        const antes = esObjeto(tabla[id]) && esObjeto(tabla[id].muestreo) ? tabla[id].muestreo.hires : undefined;
        if (m.hires === null) delete m.hires;
        else if (m.hires === undefined && esObjeto(antes) && v0.plantillas === 'sdxl') m.hires = antes;
        else if (esObjeto(m.hires)) {
          // S1.1 — `metodo`: la misma regla dentro del objeto (un Desktop que manda los tres números sin él no lo borra).
          const h = { ...m.hires };
          if (h.metodo === null) delete h.metodo;
          else if (h.metodo === undefined && esObjeto(antes) && antes.metodo !== undefined) h.metodo = antes.metodo;
          m.hires = h;
        }
        v = { ...v0, muestreo: m };
      }
      const r = perfiles.validarPerfil(id, esObjeto(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id' && k !== 'origen')) : v);
      if (!r.ok) throw new ErrorAjuste(`El perfil ${id}: ${r.campo ? `${r.campo} ` : ''}${r.motivo}`, `imagenes.perfiles_propios.${id}${r.campo ? `.${r.campo}` : ''}`);
      const { id: _, ...resto } = r.perfil;
      tabla = conClave(tabla, id, resto);
    }
    if (Object.keys(tabla).length > perfiles.MAX_PROPIOS) throw new ErrorAjuste(`Hasta ${perfiles.MAX_PROPIOS} perfiles propios`, 'imagenes.perfiles_propios');
    if (Object.keys(tabla).length) nuevo.perfiles_propios = tabla; else delete nuevo.perfiles_propios;
  }
  if (pedido.comfyui !== undefined) {
    const c = pedido.comfyui;
    if (!esObjeto(c)) throw new ErrorAjuste('imagenes.comfyui tiene que ser un objeto', 'imagenes.comfyui');
    const permitidos = ['url', 'modelo', 'modelo_edicion', 'modelo_retoque', 'perfil_de', 'seguro_de', 'flujos', 'mascara', 'retoque', 'chequeo_zona', 'loras', 'loras_activos', 'tiempo_s', 'liberar_gpu', 'arranque',
      'modelo_automatico', 'candidatos', 'hires_de', 'hires_modelo_de', ...migracion.LEGADAS];
    for (const k of Object.keys(c)) if (!permitidos.includes(k)) throw new ErrorAjuste(`imagenes.comfyui.${k} no está permitido`, `imagenes.comfyui.${k}`);
    let sal = esObjeto(previo.comfyui) ? { ...previo.comfyui } : {};
    const quitar = (k) => { delete sal[k]; };
    const cerrar = () => { if (Object.keys(sal).length) nuevo.comfyui = sal; else delete nuevo.comfyui; };
    const efectiva = () => { cerrar(); return normalizar(nuevo, { denyPaths }).imagenes; };
    if (c.url !== undefined) {
      if (c.url === null || c.url === '') quitar('url');
      else if (!esLoopback(c.url)) throw new ErrorAjuste('La URL de ComfyUI tiene que ser de esta máquina (127.0.0.1, localhost o [::1])', 'imagenes.comfyui.url');
      else sal.url = String(c.url).trim().replace(/\/+$/, '');
    }
    for (const k of ['modelo', 'modelo_edicion', 'modelo_retoque']) {
      if (c[k] === undefined) continue;
      if (c[k] === null || c[k] === '') { quitar(k); continue; }
      const m = perfiles.formaDeArchivo(c[k], MAX_TEXTO);
      if (m) throw new ErrorAjuste(`El modelo ${m}`, `imagenes.comfyui.${k}`);
      sal[k] = c[k].trim();
    }
    for (const [k, lista] of [['mascara', MASCARAS], ['retoque', RETOQUES]]) {
      if (c[k] === undefined) continue;
      if (c[k] === null || c[k] === '') quitar(k);
      else if (!lista.includes(c[k])) throw new ErrorAjuste(`imagenes.comfyui.${k} tiene que ser ${lista.join(', ')}`, `imagenes.comfyui.${k}`);
      else sal[k] = c[k];
    }
    for (const k of ['chequeo_zona', 'loras_activos', 'liberar_gpu', 'modelo_automatico']) {
      if (c[k] === undefined) continue;
      if (c[k] === null || c[k] === '') { quitar(k); continue; }
      if (typeof c[k] !== 'boolean') throw new ErrorAjuste(`imagenes.comfyui.${k} tiene que ser true o false`, `imagenes.comfyui.${k}`);
      sal[k] = c[k];
    }
    if (c.loras !== undefined) {
      if (c.loras === null || c.loras === '') quitar('loras');
      else {
        const v = validarLoras(c.loras);
        if (!v.ok) throw new ErrorAjuste(`imagenes.comfyui.${v.campo} ${v.motivo}`, `imagenes.comfyui.${v.campo}`);
        // FEAT-218 — Una LoRA que viene sin la clave `modelos` (un Desktop que no la conoce) conserva la de antes, si es la
        // misma LoRA (mismo archivo y clave); `modelos: null` la saca.
        const antes = Array.isArray(sal.loras) ? sal.loras : [];
        const loras = v.loras.map((l, i) => {
          if (Array.isArray(c.loras) && esObjeto(c.loras[i]) && c.loras[i].modelos !== undefined) return l;
          const previa = antes.find((x) => esObjeto(x) && x.clave === l.clave && perfiles.mismoArchivo(x.archivo, l.archivo));
          return previa && Array.isArray(previa.modelos) && previa.modelos.length ? { ...l, modelos: [...previa.modelos] } : l;
        });
        if (loras.length) sal.loras = loras; else quitar('loras');
      }
    }
    // FEAT-218 — Los modelos entre los que elige el refinador.
    if (c.candidatos !== undefined) {
      if (c.candidatos === null || c.candidatos === '') quitar('candidatos');
      else {
        const v = validarCandidatos(c.candidatos);
        if (!v.ok) throw new ErrorAjuste(`imagenes.comfyui.${v.campo} ${v.motivo}`, `imagenes.comfyui.${v.campo}`);
        if (v.candidatos.length) sal.candidatos = v.candidatos; else quitar('candidatos');
      }
    }
    for (const k of NUMEROS) {
      const rg = RANGOS[k];
      if (c[k] === undefined) continue;
      if (c[k] === null || c[k] === '') { quitar(k); continue; }
      if (!Number.isInteger(c[k]) || c[k] < rg.min || c[k] > rg.max) throw new ErrorAjuste(`imagenes.comfyui.${k} tiene que ser un entero de ${rg.min} a ${rg.max}`, `imagenes.comfyui.${k}`);
      sal[k] = c[k];
    }
    // FEAT-213 — Se funde campo por campo; `flags` va entera. Que la carpeta tenga un ComfyUI y que la flag exista en su versión lo
    // mira la ruta v2, que puede esperar.
    if (c.arranque !== undefined) {
      const a = c.arranque;
      const campo = 'imagenes.comfyui.arranque';
      if (a === null) quitar('arranque');
      else {
        if (!esObjeto(a)) throw new ErrorAjuste('imagenes.comfyui.arranque tiene que ser un objeto', campo);
        for (const k of Object.keys(a)) if (!['carpeta', 'automatico', 'apagar_min', 'espera_s', 'flags'].includes(k)) throw new ErrorAjuste(`arranque.${k} no está permitido`, `${campo}.${k}`);
        const arr = esObjeto(sal.arranque) ? { ...sal.arranque } : {};
        if (a.carpeta !== undefined) {
          if (a.carpeta === null || a.carpeta === '') delete arr.carpeta;
          else {
            const m = formaDeCarpeta(a.carpeta);
            if (m) throw new ErrorAjuste(`La carpeta de ComfyUI ${m}`, `${campo}.carpeta`);
            arr.carpeta = a.carpeta.trim();
          }
        }
        if (a.automatico !== undefined) {
          if (a.automatico === null || a.automatico === '') delete arr.automatico;
          else if (typeof a.automatico !== 'boolean') throw new ErrorAjuste('arranque.automatico tiene que ser true o false', `${campo}.automatico`);
          else arr.automatico = a.automatico;
        }
        for (const k of ['apagar_min', 'espera_s']) {
          if (a[k] === undefined) continue;
          if (a[k] === null || a[k] === '') { delete arr[k]; continue; }
          if (!Number.isInteger(a[k]) || a[k] < RANGOS[k].min || a[k] > RANGOS[k].max) throw new ErrorAjuste(`arranque.${k} tiene que ser un entero de ${RANGOS[k].min} a ${RANGOS[k].max}`, `${campo}.${k}`);
          arr[k] = a[k];
        }
        if (a.flags !== undefined) {
          const v = flagsComfyui.validarForma(a.flags === null ? [] : a.flags);
          if (!v.ok) throw new ErrorAjuste(`Las flags de ComfyUI: ${v.motivo}`, `${campo}.flags${v.campo}`);
          if (v.flags.length) arr.flags = v.flags; else delete arr.flags;
        }
        if (Object.keys(arr).length) sal.arranque = arr; else quitar('arranque');
      }
    }
    if (c.perfil_de !== undefined) {
      if (c.perfil_de !== null && !esObjeto(c.perfil_de)) throw new ErrorAjuste('imagenes.comfyui.perfil_de tiene que ser un objeto { modelo: perfil }', 'imagenes.comfyui.perfil_de');
      const e = efectiva();
      let tabla = c.perfil_de === null ? {} : esObjeto(sal.perfil_de) ? sal.perfil_de : {};
      for (const [k, v] of Object.entries(c.perfil_de || {})) {
        const campo = `imagenes.comfyui.perfil_de.${k}`;
        if (v === null) { tabla = sinClave(tabla, k); continue; }
        const m = formaDeClaveDeModelo(k);
        if (m) throw new ErrorAjuste(`perfil_de: el modelo ${m}`, campo);
        if (typeof v !== 'string' || !perfiles.perfil(e, v)) throw new ErrorAjuste(`perfil_de: "${v}" no es un perfil que exista`, campo);
        tabla = conClave(tabla, k, v);
      }
      if (Object.keys(tabla).length > migracion.MAX_PERFIL_DE) throw new ErrorAjuste(`Hasta ${migracion.MAX_PERFIL_DE} modelos con perfil asignado`, 'imagenes.comfyui.perfil_de');
      if (Object.keys(tabla).length) sal.perfil_de = tabla; else quitar('perfil_de');
    }
    if (c.seguro_de !== undefined) {
      if (c.seguro_de !== null && !esObjeto(c.seguro_de)) throw new ErrorAjuste('imagenes.comfyui.seguro_de tiene que ser un objeto { perfil: true|false }', 'imagenes.comfyui.seguro_de');
      const e = efectiva();
      let tabla = c.seguro_de === null ? {} : esObjeto(sal.seguro_de) ? sal.seguro_de : {};
      for (const [k, v] of Object.entries(c.seguro_de || {})) {
        const campo = `imagenes.comfyui.seguro_de.${k}`;
        // Quitar vale siempre, también una clave que ya no vale (editada a mano).
        if (v === null) { tabla = sinClave(tabla, k); continue; }
        if (!perfiles.RE_ID.test(k) || reservada(k)) throw new ErrorAjuste(`seguro_de: "${k}" no es el id de un perfil`, campo);
        if (typeof v !== 'boolean') throw new ErrorAjuste('seguro_de: tiene que ser true o false', campo);
        if (!perfiles.perfil(e, k)) throw new ErrorAjuste(`seguro_de: "${k}" no es un perfil que exista`, campo);
        tabla = conClave(tabla, k, v);
      }
      if (Object.keys(tabla).length > MAX_SEGURO_DE) throw new ErrorAjuste(`Hasta ${MAX_SEGURO_DE} perfiles con el modo seguro elegido`, 'imagenes.comfyui.seguro_de');
      if (Object.keys(tabla).length) sal.seguro_de = tabla; else quitar('seguro_de');
    }
    // FEAT-218 — La segunda pasada por perfil, solo en la familia sdxl (la única con plantilla hires).
    if (c.hires_de !== undefined) {
      if (c.hires_de !== null && !esObjeto(c.hires_de)) throw new ErrorAjuste('imagenes.comfyui.hires_de tiene que ser un objeto { perfil: true|false }', 'imagenes.comfyui.hires_de');
      const e = efectiva();
      let tabla = c.hires_de === null ? {} : esObjeto(sal.hires_de) ? sal.hires_de : {};
      for (const [k, v] of Object.entries(c.hires_de || {})) {
        const campo = `imagenes.comfyui.hires_de.${k}`;
        if (v === null) { tabla = sinClave(tabla, k); continue; }
        if (!perfiles.RE_ID.test(k) || reservada(k)) throw new ErrorAjuste(`hires_de: "${k}" no es el id de un perfil`, campo);
        if (typeof v !== 'boolean') throw new ErrorAjuste('hires_de: tiene que ser true o false', campo);
        const p = perfiles.perfil(e, k);
        if (!p) throw new ErrorAjuste(`hires_de: "${k}" no es un perfil que exista`, campo);
        if (p.plantillas !== 'sdxl') throw new ErrorAjuste(`hires_de: la segunda pasada es solo para los perfiles de la familia sdxl, y "${k}" es de ${p.plantillas}`, campo);
        tabla = conClave(tabla, k, v);
      }
      if (Object.keys(tabla).length > MAX_SEGURO_DE) throw new ErrorAjuste(`Hasta ${MAX_SEGURO_DE} perfiles con la segunda pasada elegida`, 'imagenes.comfyui.hires_de');
      if (Object.keys(tabla).length) sal.hires_de = tabla; else quitar('hires_de');
    }
    // FEAT-218 S1.1 — El modelo de reescalado por perfil, solo en la familia sdxl; `null` saca la entrada (vuelve al latente).
    if (c.hires_modelo_de !== undefined) {
      if (c.hires_modelo_de !== null && !esObjeto(c.hires_modelo_de)) throw new ErrorAjuste('imagenes.comfyui.hires_modelo_de tiene que ser un objeto { perfil: archivo }', 'imagenes.comfyui.hires_modelo_de');
      const e = efectiva();
      let tabla = c.hires_modelo_de === null ? {} : esObjeto(sal.hires_modelo_de) ? sal.hires_modelo_de : {};
      for (const [k, v] of Object.entries(c.hires_modelo_de || {})) {
        const campo = `imagenes.comfyui.hires_modelo_de.${k}`;
        if (v === null) { tabla = sinClave(tabla, k); continue; }
        if (!perfiles.RE_ID.test(k) || reservada(k)) throw new ErrorAjuste(`hires_modelo_de: "${k}" no es el id de un perfil`, campo);
        const forma = perfiles.formaDeArchivo(v, MAX_TEXTO);
        if (forma !== null) throw new ErrorAjuste(`hires_modelo_de: ${forma}`, campo);
        const p = perfiles.perfil(e, k);
        if (!p) throw new ErrorAjuste(`hires_modelo_de: "${k}" no es un perfil que exista`, campo);
        if (p.plantillas !== 'sdxl') throw new ErrorAjuste(`hires_modelo_de: la segunda pasada es solo para los perfiles de la familia sdxl, y "${k}" es de ${p.plantillas}`, campo);
        tabla = conClave(tabla, k, v.trim());
      }
      if (Object.keys(tabla).length > MAX_SEGURO_DE) throw new ErrorAjuste(`Hasta ${MAX_SEGURO_DE} perfiles con modelo de reescalado`, 'imagenes.comfyui.hires_modelo_de');
      if (Object.keys(tabla).length) sal.hires_modelo_de = tabla; else quitar('hires_modelo_de');
    }
    // Los campos de Desktop v0.21.1: se traducen con la misma función que la migración.
    const legado = Object.fromEntries(migracion.LEGADAS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
    if (Object.keys(legado).length) {
      if (legado.nodo_salida !== undefined && legado.nodo_salida !== null && legado.nodo_salida !== '' && !RE_NODO.test(String(legado.nodo_salida))) throw new ErrorAjuste('El nodo de salida tiene que ser el id de un nodo del flujo', 'imagenes.comfyui.nodo_salida');
      cerrar();
      const r = migracion.traducirLegado(nuevo, legado, { manda: 'legado', denyPaths, catalogo: catalogos.enCache(sal.url || URL_COMFYUI), normalizar, modeloPorDefecto: MODELO_POR_DEFECTO });
      sal = esObjeto(r.imagenes.comfyui) ? r.imagenes.comfyui : {};
      if (esObjeto(r.imagenes.perfiles_propios) && Object.keys(r.imagenes.perfiles_propios).length) nuevo.perfiles_propios = r.imagenes.perfiles_propios;
    }
    if (c.flujos !== undefined) {
      if (c.flujos !== null && !esObjeto(c.flujos)) throw new ErrorAjuste('imagenes.comfyui.flujos tiene que ser un objeto { perfil: { caso: { archivo, salida } } }', 'imagenes.comfyui.flujos');
      const e = efectiva();
      let tabla = c.flujos === null ? {} : esObjeto(sal.flujos) ? sal.flujos : {};
      for (const [id, porCaso] of Object.entries(c.flujos || {})) {
        const base = `imagenes.comfyui.flujos.${id}`;
        if (porCaso === null) { tabla = sinClave(tabla, id); continue; }
        if (!esObjeto(porCaso)) throw new ErrorAjuste(`flujos.${id} tiene que ser un objeto`, base);
        let del = esObjeto(tabla[id]) && Object.hasOwn(tabla, id) ? tabla[id] : {};
        for (const [caso, v] of Object.entries(porCaso)) {
          const campo = `${base}.${caso}`;
          if (v === null) { del = sinClave(del, caso); continue; }
          if (caso === 'retoque') throw new ErrorAjuste('El retoque con flujo propio llega en una rebanada posterior', campo);
          if (!flujosLib.CASOS_PROPIOS.includes(caso)) throw new ErrorAjuste(`"${caso}" no es un caso con flujo propio`, campo);
          const perfil = perfiles.perfil(e, id);
          if (!perfil) throw new ErrorAjuste(`"${id}" no es un perfil que exista`, base);
          const r = validarEntradaDeFlujo(v, { denyPaths });
          if (!r.ok) throw new ErrorAjuste(`El flujo de ${caso}: ${r.motivo}`, `${campo}${r.campo}`);
          const antes = Object.hasOwn(del, caso) && esObjeto(del[caso]) ? del[caso] : null;
          // Lo que no cambia no se vuelve a validar: un archivo que se borró no traba el resto del guardado.
          if (antes && antes.archivo === r.entrada.archivo && (antes.salida ?? null) === r.entrada.salida) continue;
          const l = flujosLib.leerFlujo(r.entrada.archivo, { caso, denyPaths });
          if (!l.ok) throw new ErrorAjuste(`El flujo de ${caso}: ${l.motivo}`, `${campo}.archivo`);
          let salida = r.entrada.salida;
          if (salida && !l.salidas.includes(salida)) throw new ErrorAjuste('El nodo de salida tiene que ser un SaveImage del flujo', `${campo}.salida`);
          if (!salida && l.salidas.length > 1) throw new ErrorAjuste('El flujo tiene varios SaveImage: elegí el nodo de salida', `${campo}.salida`);
          if (!salida) salida = l.salidas[0];
          if (l.ficha.salida && l.ficha.salida !== salida) throw new ErrorAjuste('La salida no es la de la ficha del flujo', `${campo}.salida`);
          if (!flujosLib.cargaCoincide(l.flujo, perfil.carga.tipo)) throw new ErrorAjuste(`El flujo de ${caso}: la carga del flujo no coincide con el perfil ${id}`, `${campo}.archivo`);
          del = conClave(del, caso, { archivo: r.entrada.archivo, salida });
        }
        tabla = Object.keys(del).length ? conClave(tabla, id, del) : sinClave(tabla, id);
      }
      if (Object.keys(tabla).length) sal.flujos = tabla; else quitar('flujos');
    }
    cerrar();
    // El modelo principal tiene que saber hacer una imagen nueva. Solo si el pedido lo trae: lo demás nunca se frena por él.
    if (c.modelo !== undefined) {
      const e = efectiva();
      const p = perfiles.perfilDe(e, e.comfyui.modelo, catalogos.enCache(e.comfyui.url)).perfil;
      const f = flujosLib.resolverFlujo(e, p, 'nueva');
      if (!f.ok) throw new ErrorAjuste(`Ese modelo no puede ser el principal: con el perfil ${p.nombre}, ${f.motivo}`, 'imagenes.comfyui.modelo');
    }
  }
  for (const campo of Object.values(REMOTOS)) {
    if (pedido[campo] === undefined) continue;
    const r = pedido[campo];
    if (r === null) { delete nuevo[campo]; continue; }
    if (!esObjeto(r)) throw new ErrorAjuste(`imagenes.${campo} tiene que ser un objeto { url, modelo, key_env }`, `imagenes.${campo}`);
    for (const k of Object.keys(r)) if (!['url', 'modelo', 'key_env'].includes(k)) throw new ErrorAjuste(`imagenes.${campo}.${k} no está permitido`, `imagenes.${campo}.${k}`);
    const sal = esObjeto(previo[campo]) ? { ...previo[campo] } : {};
    if (r.url !== undefined) {
      if (r.url === null || r.url === '') delete sal.url;
      else if (!esHttps(r.url)) throw new ErrorAjuste('La URL tiene que ser https', `imagenes.${campo}.url`);
      else sal.url = String(r.url).trim();
    }
    if (r.modelo !== undefined) {
      if (r.modelo === null || r.modelo === '') delete sal.modelo;
      else if (!texto(r.modelo)) throw new ErrorAjuste(`El modelo tiene que ser un nombre (hasta ${MAX_TEXTO} caracteres)`, `imagenes.${campo}.modelo`);
      else sal.modelo = texto(r.modelo);
    }
    if (r.key_env !== undefined) {
      if (r.key_env === null || r.key_env === '') delete sal.key_env;
      else if (!RE_KEY_ENV.test(String(r.key_env))) throw new ErrorAjuste('key_env es el NOMBRE de la variable del .env (MAYÚSCULAS_Y_GUIONES), nunca la key', `imagenes.${campo}.key_env`);
      else sal.key_env = String(r.key_env);
    }
    if (Object.keys(sal).length) nuevo[campo] = sal; else delete nuevo[campo];
  }
  const salida = { ...datos };
  if (Object.keys(nuevo).length) salida.imagenes = nuevo; else delete salida.imagenes;
  return salida;
}

module.exports = {
  PROVEEDORES, REMOTOS, BOOLEANOS, CAMPOS, TALLER_BOOLEANOS, AL_CERRAR, RANGOS, MASCARAS, RETOQUES, MAX_LORAS, URL_COMFYUI, MODELO_POR_DEFECTO,
  defectos, esLoopback, esHttps, formaDeCarpeta, formaDeFlujo: flujosLib.formaDeFlujo, leerFlujo: flujosLib.leerFlujo, marcadoresDe: flujosLib.marcadoresDe, resolverFlujo: flujosLib.resolverFlujo,
  normalizar, denyDe, migrarDatos, leerSeccion, leerImagenes, crudoImagenes, aplicarImagenes,
  MAX_CANDIDATOS, MAX_MODELOS_LORA, MAX_PARA, validarCandidatos, validarLoras
};
