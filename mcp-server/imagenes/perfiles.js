'use strict';

/**
 * FEAT-212 §1 — Los perfiles de modelo: cómo se usa una familia (prompting, muestreo, medidas, carga y casos).
 *
 * Los del plugin están en `perfiles/*.json`; los propios, enteros, en
 * `imagenes.perfiles_propios`. No hay fusión: lo que se guarda es lo que se usa.
 * `perfilDe` es la única que decide qué perfil usa un modelo.
 */

const fs = require('node:fs');
const path = require('node:path');

const FAMILIAS = Object.freeze(['sdxl', 'flux', 'flux-fp8', 'flux-fill', 'flux-kontext']);
/** La carga de las plantillas que trae el plugin, por familia. */
const CARGA_DE_FAMILIA = Object.freeze({ sdxl: 'checkpoint', 'flux-fp8': 'checkpoint', flux: 'unet', 'flux-fill': 'unet', 'flux-kontext': 'unet' });
const CASOS = Object.freeze(['nueva', 'variacion', 'retoque', 'edicion']);
const PROPORCIONES = Object.freeze(['1:1', '3:4', '4:3', '16:9', '9:16']);
const ESTILOS = Object.freeze(['etiquetas', 'natural', 'instruccion']);
const NEGATIVOS = Object.freeze(['si', 'no', 'opcional']);
const RESERVADAS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const RE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_PROPIOS = 20;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
// Las reglas llevan saltos de línea.
const CONTROLES_TEXTO = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const tiene = (o, k) => Object.hasOwn(o, k);

/** Un nombre de archivo de ComfyUI (un modelo, un LoRA, un CLIP): relativo, sin `..`. `null` si vale, o el motivo. */
function formaDeArchivo(v, max = 200) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max || CONTROLES.test(v)) return `tiene que ser un nombre de archivo (hasta ${max} caracteres)`;
  const r = v.trim();
  if (r.startsWith('\\') || r.startsWith('/') || /^[A-Za-z]:/.test(r)) return 'tiene que ser relativo a la carpeta de modelos de ComfyUI';
  if (r.split(/[\\/]/).includes('..')) return 'no puede tener ..';
  return null;
}

/** Valida un perfil entero. `{ ok, perfil }` (con las claves conocidas, en orden) o `{ ok: false, campo, motivo }`. */
function validarPerfil(id, p) {
  const mal = (campo, motivo) => ({ ok: false, campo, motivo });
  if (typeof id !== 'string' || !RE_ID.test(id) || RESERVADAS.includes(id)) return mal('id', 'el id va con minúsculas, números y guiones (hasta 40)');
  if (!esObjeto(p)) return mal('', 'tiene que ser un objeto');
  const raiz = ['id', 'nombre', 'plantillas', 'carga', 'prompt', 'muestreo', 'medidas', 'casos'];
  for (const k of Object.keys(p)) if (!raiz.includes(k)) return mal(k, 'no está permitido');
  if (typeof p.nombre !== 'string' || !p.nombre.trim() || p.nombre.trim().length > 40 || CONTROLES.test(p.nombre)) return mal('nombre', 'tiene que tener de 1 a 40 caracteres');
  if (!FAMILIAS.includes(p.plantillas)) return mal('plantillas', `tiene que ser ${FAMILIAS.join(', ')}`);
  const esFlux = p.plantillas.startsWith('flux');

  if (!esObjeto(p.carga)) return mal('carga', 'tiene que ser un objeto { tipo }');
  if (p.carga.tipo !== 'checkpoint' && p.carga.tipo !== 'unet') return mal('carga.tipo', 'tiene que ser checkpoint o unet');
  const permitidasCarga = p.carga.tipo === 'unet' ? ['tipo', 'clip1', 'clip2', 'vae'] : ['tipo'];
  for (const k of Object.keys(p.carga)) if (!permitidasCarga.includes(k)) return mal(`carga.${k}`, 'no está permitido en esta carga');
  const carga = { tipo: p.carga.tipo };
  for (const k of ['clip1', 'clip2', 'vae']) {
    if (p.carga[k] === undefined || p.carga[k] === null || p.carga[k] === '') continue;
    const m = formaDeArchivo(p.carga[k]);
    if (m) return mal(`carga.${k}`, m);
    carga[k] = p.carga[k].trim();
  }

  const q = p.prompt;
  if (!esObjeto(q)) return mal('prompt', 'tiene que ser un objeto');
  for (const k of Object.keys(q)) if (!['estilo', 'reglas', 'tope', 'negativo', 'negativoPorDefecto', 'pesos'].includes(k)) return mal(`prompt.${k}`, 'no está permitido');
  if (!ESTILOS.includes(q.estilo)) return mal('prompt.estilo', `tiene que ser ${ESTILOS.join(', ')}`);
  if (typeof q.reglas !== 'string' || q.reglas.length > 4000 || CONTROLES_TEXTO.test(q.reglas)) return mal('prompt.reglas', 'tiene que ser un texto de hasta 4000 caracteres');
  if (!Number.isInteger(q.tope) || q.tope < 100 || q.tope > 2000) return mal('prompt.tope', 'tiene que ser un entero de 100 a 2000');
  if (!NEGATIVOS.includes(q.negativo)) return mal('prompt.negativo', `tiene que ser ${NEGATIVOS.join(', ')}`);
  if (typeof q.negativoPorDefecto !== 'string' || q.negativoPorDefecto.length > 500 || CONTROLES_TEXTO.test(q.negativoPorDefecto)) return mal('prompt.negativoPorDefecto', 'tiene que ser un texto de hasta 500 caracteres');
  if (typeof q.pesos !== 'boolean') return mal('prompt.pesos', 'tiene que ser true o false');

  const s = p.muestreo;
  if (!esObjeto(s)) return mal('muestreo', 'tiene que ser un objeto');
  for (const k of Object.keys(s)) if (!['pasos', 'cfg', 'guia', 'sampler', 'scheduler', 'fuerza'].includes(k)) return mal(`muestreo.${k}`, 'no está permitido');
  if (!Number.isInteger(s.pasos) || s.pasos < 1 || s.pasos > 150) return mal('muestreo.pasos', 'tiene que ser un entero de 1 a 150');
  if (!Number.isFinite(s.cfg) || s.cfg < 0 || s.cfg > 30) return mal('muestreo.cfg', 'tiene que ser un número de 0 a 30');
  const guia = s.guia === undefined ? null : s.guia;
  if (guia !== null && (!Number.isFinite(guia) || guia < 0 || guia > 30)) return mal('muestreo.guia', 'tiene que ser un número de 0 a 30, o null');
  if (esFlux && guia === null) return mal('muestreo.guia', 'un perfil de Flux necesita la guía');
  for (const k of ['sampler', 'scheduler']) {
    if (typeof s[k] !== 'string' || !s[k].trim() || s[k].trim().length > 40 || CONTROLES.test(s[k])) return mal(`muestreo.${k}`, 'tiene que ser un nombre de hasta 40 caracteres');
  }
  if (!Number.isFinite(s.fuerza) || s.fuerza < 0 || s.fuerza > 1) return mal('muestreo.fuerza', 'tiene que ser un número de 0 a 1');

  if (!esObjeto(p.medidas)) return mal('medidas', 'tiene que ser un objeto');
  for (const k of Object.keys(p.medidas)) if (!PROPORCIONES.includes(k)) return mal(`medidas.${k}`, 'no es una proporción');
  const medidas = [];
  for (const k of PROPORCIONES) {
    const m = tiene(p.medidas, k) ? p.medidas[k] : undefined;
    if (!Array.isArray(m) || m.length !== 2) return mal(`medidas.${k}`, 'tiene que ser [ancho, alto]');
    if (!m.every((x) => Number.isInteger(x) && x >= 256 && x <= 2048 && x % 64 === 0)) return mal(`medidas.${k}`, 'cada lado va de 256 a 2048, en múltiplos de 64');
    if (m[0] * m[1] > 2_500_000) return mal(`medidas.${k}`, 'el área máxima es 2,5 megapíxeles');
    medidas.push([k, [m[0], m[1]]]);
  }

  if (!Array.isArray(p.casos) || !p.casos.length || !p.casos.every((c) => CASOS.includes(c)) || new Set(p.casos).size !== p.casos.length) return mal('casos', `tiene que ser una lista sin repetidos de ${CASOS.join(', ')}`);

  return {
    ok: true,
    perfil: {
      id, nombre: p.nombre.trim(), plantillas: p.plantillas, carga,
      prompt: { estilo: q.estilo, reglas: q.reglas, tope: q.tope, negativo: q.negativo, negativoPorDefecto: q.negativoPorDefecto, pesos: q.pesos },
      muestreo: { pasos: s.pasos, cfg: s.cfg, guia, sampler: s.sampler.trim(), scheduler: s.scheduler.trim(), fuerza: s.fuerza },
      medidas: Object.fromEntries(medidas), casos: CASOS.filter((c) => p.casos.includes(c))
    }
  };
}

const congelar = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') congelar(v); return Object.freeze(o); };

/** Los perfiles que trae el plugin, en el orden en que los ofrece la pestaña. */
const PERFILES = new Map(['sdxl', 'sdxl-rapido', 'flux', 'flux-fp8', 'flux-fill', 'flux-kontext'].map((id) => {
  const r = validarPerfil(id, JSON.parse(fs.readFileSync(path.join(__dirname, 'perfiles', `${id}.json`), 'utf8')));
  if (!r.ok) throw new Error(`El perfil ${id} del plugin no vale: ${r.campo} ${r.motivo}`);
  return [id, congelar(r.perfil)];
}));

const propiosDe = (imagenes) => (imagenes && esObjeto(imagenes.perfiles_propios) ? imagenes.perfiles_propios : {});

/** El perfil efectivo con ese id: el propio si existe; si no, el del plugin; si no, `null`. */
function perfil(imagenes, id) {
  const propios = propiosDe(imagenes);
  if (typeof id !== 'string' || !id) return null;
  if (tiene(propios, id)) return { ...propios[id], id };
  return PERFILES.get(id) || null;
}

/** Los perfiles efectivos con su origen: `plugin`, `propio` (id nuevo) o `copia` (uno propio con el id del plugin). */
function perfilesEfectivos(imagenes) {
  const propios = propiosDe(imagenes);
  const salida = [];
  for (const [id, p] of PERFILES) salida.push(tiene(propios, id) ? { ...propios[id], id, origen: 'copia' } : { ...p, origen: 'plugin' });
  for (const id of Object.keys(propios)) if (!PERFILES.has(id)) salida.push({ ...propios[id], id, origen: 'propio' });
  return salida;
}

/** El perfil del plugin que le da de partida a uno: el de su mismo id o, si el id es nuevo, el primero de su familia. */
function perfilDePartida(p) {
  if (PERFILES.has(p.id)) return PERFILES.get(p.id);
  return [...PERFILES.values()].find((x) => x.plantillas === p.plantillas) || PERFILES.get('sdxl');
}

/** El id que le toca a un modelo solo por su nombre, dada su carga. */
function idPorNombre(modelo, carga) {
  const m = String(modelo || '').toLowerCase();
  if (m.includes('kontext')) return 'flux-kontext';
  if (/(^|[^a-z])fill([^a-z]|$)/.test(m)) return 'flux-fill';
  if (m.includes('flux')) return carga === 'checkpoint' ? 'flux-fp8' : 'flux';
  if (/lightning|turbo|hyper/.test(m)) return 'sdxl-rapido';
  return 'sdxl';
}

/** En qué listas del catálogo está el archivo: `{ checkpoint, unet }`. */
function cargasEnCatalogo(modelo, catalogo) {
  const en = (lista) => Array.isArray(lista) && lista.some((a) => a.valor === modelo);
  return { checkpoint: Boolean(catalogo) && en(catalogo.checkpoints), unet: Boolean(catalogo) && en(catalogo.unets) };
}

/** Si el modelo tiene `flux`, `kontext` o `fill` en el nombre. */
const pareceUnet = (modelo) => /flux|kontext/i.test(String(modelo || '')) || /(^|[^a-z])fill([^a-z]|$)/i.test(String(modelo || ''));

/**
 * El perfil de un modelo. `catalogo` es el de `catalogo.js` o `null`. Devuelve `{ perfil, cargaDelModelo, aviso, fuente }`:
 * - `fuente`: `asignado` (hay `perfil_de`), `catalogo`, `sugerida` o `nombre`;
 * - `cargaDelModelo`: la carpeta del catálogo; sin eso, la del perfil asignado, la `cargaSugerida` o la del nombre.
 */
function perfilDe(imagenes, modelo, catalogo = null, { cargaSugerida = null } = {}) {
  const c = imagenes && esObjeto(imagenes.comfyui) ? imagenes.comfyui : {};
  const asignaciones = esObjeto(c.perfil_de) ? c.perfil_de : {};
  let aviso = null;
  let asignado = null;
  if (typeof modelo === 'string' && tiene(asignaciones, modelo)) {
    asignado = perfil(imagenes, asignaciones[modelo]);
    if (!asignado) aviso = `El perfil "${asignaciones[modelo]}" de este modelo no existe`;
  }
  const en = cargasEnCatalogo(modelo, catalogo);
  const delCatalogo = en.checkpoint && en.unet ? (asignado ? asignado.carga.tipo : 'checkpoint') : en.checkpoint ? 'checkpoint' : en.unet ? 'unet' : null;
  if (asignado) return { perfil: asignado, cargaDelModelo: delCatalogo || asignado.carga.tipo, aviso, fuente: 'asignado' };
  const carga = delCatalogo || cargaSugerida || (pareceUnet(modelo) ? 'unet' : 'checkpoint');
  const fuente = delCatalogo ? 'catalogo' : cargaSugerida ? 'sugerida' : 'nombre';
  return { perfil: perfil(imagenes, idPorNombre(modelo, carga)), cargaDelModelo: carga, aviso, fuente };
}

module.exports = {
  FAMILIAS, CARGA_DE_FAMILIA, CASOS, PROPORCIONES, ESTILOS, NEGATIVOS, RESERVADAS, RE_ID, MAX_PROPIOS, PERFILES,
  formaDeArchivo, validarPerfil, perfil, perfilesEfectivos, perfilDePartida, idPorNombre, cargasEnCatalogo, pareceUnet, perfilDe
};
