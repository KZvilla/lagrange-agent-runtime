'use strict';

/**
 * FEAT-212 §2 y §3 — Los casos de una imagen: quién puede hacer cada uno ahora, la bajada y el ajuste al caso.
 *
 * `disponiblesDe` corre al empezar el trabajo y otra vez justo antes de generar.
 * `bajarCaso` es la única bajada; `ajustarAlCaso` corre después de cada una.
 */

const { limpiarSalida } = require('../almas/mediador.js');
const { enModoManual } = require('../motores/antigravity/modo.js');
const perfiles = require('./perfiles.js');
const flujos = require('./flujos.js');

const { CASOS, PROPORCIONES } = perfiles;
/** El orden de la bajada, de lo más específico a lo más general. */
const BAJADA = Object.freeze(['edicion', 'retoque', 'variacion', 'nueva']);
/** Los casos que declara cada proveedor. */
const DECLARA = Object.freeze({ comfyui: CASOS, antigravity: ['nueva'], openai: ['nueva'], gemini: ['nueva'] });
/** Los proveedores que, por su forma, nunca generan: cableados pero no funcionales. */
const NO_IMPLEMENTADOS = Object.freeze(['openai', 'gemini']);
const TOPE_AGY = 900;
const MAX_NEGATIVO = 500;
const MAX_ZONA = 120;
const MAX_INSTRUCCION = 2000;
// FEAT-213 — Cuánto cambia una variación, y lo que le suma a la fuerza del perfil.
const CAMBIOS = Object.freeze(['leve', 'medio', 'fuerte']);
const SUMA_FUERZA = Object.freeze({ leve: -0.15, medio: 0, fuerte: 0.2 });
const FUERZA_MIN = 0.1;
const FUERZA_MAX = 0.95;

/** FEAT-213 — La fuerza de una variación para ese cambio. `null`: la del perfil (una de 0 o 1 no se ajusta). */
function fuerzaDeCambio(cambio, fuerza) {
  if (!CAMBIOS.includes(cambio) || !Number.isFinite(fuerza) || fuerza < FUERZA_MIN || fuerza > FUERZA_MAX) return null;
  return Math.round(Math.min(FUERZA_MAX, Math.max(FUERZA_MIN, fuerza + SUMA_FUERZA[cambio])) * 100) / 100;
}

const declara = (proveedor, caso) => (DECLARA[proveedor] || []).includes(caso);

/** El modelo de ComfyUI de un caso, o `null`. */
function modeloDeCaso(imagenes, caso) {
  const c = imagenes.comfyui;
  if (caso === 'edicion') return c.modelo_edicion || null;
  if (caso === 'retoque' && c.retoque === 'fill') return c.modelo_retoque || null;
  return c.modelo || null;
}

/** Lo que el modelo y su perfil ponen en los marcadores de carga. */
function valoresDeCarga(modelo, perfil) {
  const v = { modelo };
  if (perfil.carga.tipo === 'unet') v.unet = modelo;
  if (perfil.carga.clip1) v.clip_1 = perfil.carga.clip1;
  if (perfil.carga.clip2) v.clip_2 = perfil.carga.clip2;
  if (perfil.carga.vae) v.vae = perfil.carga.vae;
  return v;
}

/** Los mismos valores, con el nombre exacto que lista ComfyUI (si el catálogo los tiene): es lo que su combo acepta. */
function comoLosLista(valores, catalogo) {
  if (!catalogo) return valores;
  const de = { modelo: [...(catalogo.checkpoints || []), ...(catalogo.unets || [])], unet: catalogo.unets, clip_1: catalogo.clips, clip_2: catalogo.clips, vae: catalogo.vaes };
  return Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, perfiles.enLista(de[k], v) || v]));
}

/** Los LoRAs activos de una familia de plantillas. */
function lorasDe(imagenes, familia) {
  const c = imagenes.comfyui;
  if (c.loras_activos === false || !Array.isArray(c.loras)) return [];
  return c.loras.filter((l) => l.activo && l.familias.includes(familia)).map((l) => ({ clave: l.clave, archivo: l.archivo, fuerza: l.fuerza }));
}

/** El tope del prompt de un caso: si el primero que puede es agy, como mucho 900. Nunca `null`. */
function topeDelPrompt(proveedores, perfil) {
  return proveedores[0] === 'antigravity' ? Math.min(TOPE_AGY, perfil.prompt.tope) : perfil.prompt.tope;
}

/**
 * Lo que ComfyUI puede con un caso, sin preguntarle: `{ puede, motivo, modelo, perfil, resuelto, faltan, faltanLoras, aviso }`.
 * Lo usan `disponiblesDe` y Probar.
 */
function estadoComfyui(imagenes, caso, catalogo = null) {
  const c = imagenes.comfyui;
  const modelo = modeloDeCaso(imagenes, caso);
  const base = perfiles.perfilDe(imagenes, modelo || c.modelo, catalogo);
  const salida = { puede: false, motivo: null, modelo, perfil: base.perfil, cargaDelModelo: base.cargaDelModelo, aviso: base.aviso, fuente: base.fuente, resuelto: null, faltan: { nodos: [], archivos: [] }, faltanLoras: [] };
  const no = (motivo) => ({ ...salida, motivo });
  if (caso === 'retoque' && (c.retoque === 'no' || c.mascara === 'no')) return no('el retoque está apagado');
  if (!modelo) return no('falta el modelo');
  salida.resuelto = flujos.resolverFlujo(imagenes, base.perfil, caso);
  if (!salida.resuelto.ok) return no(salida.resuelto.motivo);
  if (flujos.inyectaModelo(salida.resuelto.flujo) && base.cargaDelModelo !== base.perfil.carga.tipo) return no('la carga del modelo no coincide con el perfil');
  const f = flujos.faltantes(salida.resuelto, valoresDeCarga(modelo, base.perfil), catalogo, lorasDe(imagenes, base.perfil.plantillas).map((l) => l.archivo));
  salida.faltan = f.faltan;
  salida.faltanLoras = f.faltanLoras;
  if (f.faltan.archivos.length) return no(f.faltan.archivos.includes(modelo) ? 'falta el modelo' : 'falta un archivo del modelo');
  if (f.faltan.nodos.length) return no('faltan nodos de ComfyUI');
  return { ...salida, puede: true };
}

/**
 * Qué puede hacer cada caso ahora: `{ <caso>: { proveedores, afuera, modelo, perfil, huecos, loras, tope, motivo, resuelto } }`.
 * Un caso está disponible si `proveedores` no está vacía.
 */
function disponiblesDe(imagenes, { desdeFoto = false, catalogo = null, manual = enModoManual } = {}) {
  const salida = {};
  for (const caso of CASOS) {
    const e = estadoComfyui(imagenes, caso, catalogo);
    const proveedores = [];
    const afuera = [];
    let motivo = null;
    if (caso !== 'nueva' && !desdeFoto) motivo = 'falta la foto';
    else {
      for (const id of imagenes.orden || []) {
        if (!declara(id, caso)) continue;
        if (NO_IMPLEMENTADOS.includes(id)) afuera.push({ proveedor: id, codigo: 'no-implementado' });
        else if (id === 'antigravity') { if (manual()) afuera.push({ proveedor: id, codigo: 'manual' }); else proveedores.push(id); } else if (e.puede) proveedores.push(id);
        else { afuera.push({ proveedor: id, codigo: 'no-disponible' }); motivo = e.motivo; }
      }
      if (proveedores.length) motivo = null;
      else if (!motivo) motivo = 'ningún proveedor puede hacerlo';
    }
    const conComfy = proveedores.includes('comfyui');
    salida[caso] = {
      proveedores, afuera, modelo: e.modelo, perfil: e.perfil, huecos: conComfy ? e.resuelto.huecos.length : 0,
      loras: conComfy && e.resuelto.huecos.length ? lorasDe(imagenes, e.perfil.plantillas) : [],
      tope: topeDelPrompt(proveedores, e.perfil), motivo, resuelto: conComfy ? e.resuelto : null,
      // FEAT-216 — Con ComfyUI: lo que el sistema agrega al prompt (la consigna se lo dice al refinador). Sin ComfyUI
      // nadie lo agrega.
      seguro: conComfy && perfiles.seguroActivo(imagenes, e.perfil)
    };
  }
  return salida;
}

const estaDisponible = (disponibles, caso) => Boolean(disponibles[caso] && disponibles[caso].proveedores.length);

/**
 * La única bajada: desde el caso pedido hacia abajo, salta lo no disponible y lo que no tiene su campo. `null` si no queda nada.
 * FEAT-213 — Con `base` (la imagen tiene que partir de una foto) nunca da `nueva`: un `nueva` sube a `variacion`.
 */
function bajarCaso(caso, disponibles, { zona = '', instruccion = '', prompt = '' } = {}, { base = false } = {}) {
  if (base && caso === 'nueva') caso = 'variacion';
  const desde = BAJADA.indexOf(caso);
  if (desde < 0) return null;
  for (const c of BAJADA.slice(desde)) {
    if (!estaDisponible(disponibles, c) || (base && c === 'nueva')) continue;
    if (c === 'retoque' && !zona) continue;
    if (c === 'edicion' && !instruccion && !prompt) continue;
    return c;
  }
  return null;
}

/** Saca la sintaxis de pesos: `(red hat:1.2)` queda `red hat`. */
function sinPesos(texto) {
  let t = String(texto || '');
  for (let i = 0; i < 5; i++) {
    const n = t.replace(/\(([^()]+?):\s*\d+(?:\.\d+)?\)/g, '$1');
    if (n === t) break;
    t = n;
  }
  return t;
}

const limpio = (v, max) => limpiarSalida(typeof v === 'string' ? v : '', max).texto;

/** El refinado, limpio para el caso que quedó. `null` si se quedó sin prompt. */
function ajustarAlCaso(r, caso, d) {
  const { prompt: reglas } = d.perfil;
  const pesos = (t) => (reglas.pesos ? t : sinPesos(t));
  let instruccion = pesos(limpio(r.instruccion, MAX_INSTRUCCION));
  let prompt = pesos(limpio(r.prompt, 2000)) || instruccion;
  if (caso === 'edicion') instruccion = (instruccion || prompt).slice(0, MAX_INSTRUCCION);
  // FEAT-216 — Lo que el sistema agrega no cuenta para el tope: un prompt ya compuesto (el del taller) lo pierde acá y
  // `componerPrompt` lo vuelve a poner.
  prompt = perfiles.sinFijas(d.perfil, prompt, d.seguro).slice(0, d.tope);
  if (!prompt) return null;
  const propio = limpio(r.negativo, MAX_NEGATIVO);
  const negativo = reglas.negativo === 'no' ? '' : propio || reglas.negativoPorDefecto;
  const pedidas = (Array.isArray(r.loras) ? r.loras : []).map((l) => (typeof l === 'string' ? l : l && l.clave)).filter((l) => typeof l === 'string');
  const loras = [];
  for (const clave of pedidas) {
    const l = d.loras.find((x) => x.clave === clave);
    if (l && !loras.includes(l) && loras.length < Math.min(d.huecos, flujos.MAX_HUECOS)) loras.push(l);
  }
  // FEAT-213 — La fuerza de una variación, según cuánto cambia. Una que ya viene (se repite, o ya pasó por acá) se respeta.
  let fuerza = null;
  if (caso === 'variacion' && CAMBIOS.includes(r.cambio)) {
    fuerza = Number.isFinite(r.fuerza) && r.fuerza >= 0 && r.fuerza <= 1 ? r.fuerza : fuerzaDeCambio(r.cambio, d.perfil.muestreo.fuerza);
  }
  return {
    prompt, negativo, proporcion: PROPORCIONES.includes(r.proporcion) ? r.proporcion : '1:1',
    zona: caso === 'retoque' ? limpio(r.zona, MAX_ZONA) : '', instruccion: caso === 'edicion' ? instruccion : '', loras,
    cambio: fuerza === null ? null : r.cambio, fuerza
  };
}

/** El prompt para agy cuando es el respaldo: hasta 900, en el último límite de palabra. */
function recortarParaAgy(prompt) {
  const t = String(prompt || '');
  if (t.length <= TOPE_AGY) return t;
  const corte = t.slice(0, TOPE_AGY + 1).lastIndexOf(' ');
  return t.slice(0, corte > TOPE_AGY / 2 ? corte : TOPE_AGY);
}

module.exports = {
  CASOS, PROPORCIONES, CAMBIOS, fuerzaDeCambio, BAJADA, DECLARA, NO_IMPLEMENTADOS, TOPE_AGY, MAX_NEGATIVO, MAX_ZONA, MAX_INSTRUCCION,
  declara, modeloDeCaso, valoresDeCarga, comoLosLista, lorasDe, topeDelPrompt, estadoComfyui, disponiblesDe, estaDisponible, bajarCaso, sinPesos, ajustarAlCaso, recortarParaAgy
};
