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
const FUERZA_RETOQUE = 0.9;
const MAX_FIJO = 300;
const MAX_SEGURO = 200;
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
  for (const k of Object.keys(q)) if (!['estilo', 'reglas', 'tope', 'negativo', 'negativoPorDefecto', 'pesos', 'prefijo', 'negativoFijo', 'seguro'].includes(k)) return mal(`prompt.${k}`, 'no está permitido');
  if (!ESTILOS.includes(q.estilo)) return mal('prompt.estilo', `tiene que ser ${ESTILOS.join(', ')}`);
  if (typeof q.reglas !== 'string' || q.reglas.length > 4000 || CONTROLES_TEXTO.test(q.reglas)) return mal('prompt.reglas', 'tiene que ser un texto de hasta 4000 caracteres');
  if (!Number.isInteger(q.tope) || q.tope < 100 || q.tope > 2000) return mal('prompt.tope', 'tiene que ser un entero de 100 a 2000');
  if (!NEGATIVOS.includes(q.negativo)) return mal('prompt.negativo', `tiene que ser ${NEGATIVOS.join(', ')}`);
  if (typeof q.negativoPorDefecto !== 'string' || q.negativoPorDefecto.length > 500 || CONTROLES_TEXTO.test(q.negativoPorDefecto)) return mal('prompt.negativoPorDefecto', 'tiene que ser un texto de hasta 500 caracteres');
  if (typeof q.pesos !== 'boolean') return mal('prompt.pesos', 'tiene que ser true o false');
  // FEAT-216 — Lo que el sistema agrega siempre (no lo escribe el refinador ni cuenta para el tope).
  const fijo = (k) => {
    const v = q[k] === undefined || q[k] === null ? '' : q[k];
    if (typeof v !== 'string' || v.length > MAX_FIJO || CONTROLES.test(v)) return { mal: mal(`prompt.${k}`, `tiene que ser un texto de una línea de hasta ${MAX_FIJO} caracteres`) };
    return { v: v.trim() };
  };
  const prefijo = fijo('prefijo');
  if (prefijo.mal) return prefijo.mal;
  const negativoFijo = fijo('negativoFijo');
  if (negativoFijo.mal) return negativoFijo.mal;
  // FEAT-216 — «Solo contenido seguro»: qué agrega al prompt y al negativo, y qué etiquetas de rating saca de lo del refinador.
  let seguro = null;
  if (q.seguro !== undefined && q.seguro !== null) {
    if (!esObjeto(q.seguro)) return mal('prompt.seguro', 'tiene que ser un objeto { positivo, negativo, quitar } o null');
    for (const k of Object.keys(q.seguro)) if (!['positivo', 'negativo', 'quitar'].includes(k)) return mal(`prompt.seguro.${k}`, 'no está permitido');
    seguro = {};
    for (const k of ['positivo', 'negativo', 'quitar']) {
      const v = q.seguro[k] === undefined || q.seguro[k] === null ? '' : q.seguro[k];
      if (typeof v !== 'string' || v.length > MAX_SEGURO || CONTROLES.test(v)) return mal(`prompt.seguro.${k}`, `tiene que ser un texto de una línea de hasta ${MAX_SEGURO} caracteres`);
      seguro[k] = v.trim();
    }
    if (!seguro.positivo && !seguro.negativo && !seguro.quitar) return mal('prompt.seguro', 'tiene que tener al menos una etiqueta');
  }

  const s = p.muestreo;
  if (!esObjeto(s)) return mal('muestreo', 'tiene que ser un objeto');
  for (const k of Object.keys(s)) if (!['pasos', 'cfg', 'guia', 'sampler', 'scheduler', 'fuerza', 'fuerzaRetoque'].includes(k)) return mal(`muestreo.${k}`, 'no está permitido');
  if (!Number.isInteger(s.pasos) || s.pasos < 1 || s.pasos > 150) return mal('muestreo.pasos', 'tiene que ser un entero de 1 a 150');
  if (!Number.isFinite(s.cfg) || s.cfg < 0 || s.cfg > 30) return mal('muestreo.cfg', 'tiene que ser un número de 0 a 30');
  const guia = s.guia === undefined ? null : s.guia;
  if (guia !== null && (!Number.isFinite(guia) || guia < 0 || guia > 30)) return mal('muestreo.guia', 'tiene que ser un número de 0 a 30, o null');
  if (esFlux && guia === null) return mal('muestreo.guia', 'un perfil de Flux necesita la guía');
  for (const k of ['sampler', 'scheduler']) {
    if (typeof s[k] !== 'string' || !s[k].trim() || s[k].trim().length > 40 || CONTROLES.test(s[k])) return mal(`muestreo.${k}`, 'tiene que ser un nombre de hasta 40 caracteres');
  }
  if (!Number.isFinite(s.fuerza) || s.fuerza < 0 || s.fuerza > 1) return mal('muestreo.fuerza', 'tiene que ser un número de 0 a 1');
  // Repintar una zona pide más fuerza que variar la foto entera (con 0,6 casi no cambia).
  const fuerzaRetoque = s.fuerzaRetoque === undefined ? FUERZA_RETOQUE : s.fuerzaRetoque;
  if (!Number.isFinite(fuerzaRetoque) || fuerzaRetoque < 0 || fuerzaRetoque > 1) return mal('muestreo.fuerzaRetoque', 'tiene que ser un número de 0 a 1');

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
      prompt: { estilo: q.estilo, reglas: q.reglas, tope: q.tope, negativo: q.negativo, negativoPorDefecto: q.negativoPorDefecto, pesos: q.pesos, prefijo: prefijo.v, negativoFijo: negativoFijo.v, seguro },
      muestreo: { pasos: s.pasos, cfg: s.cfg, guia, sampler: s.sampler.trim(), scheduler: s.scheduler.trim(), fuerza: s.fuerza, fuerzaRetoque },
      medidas: Object.fromEntries(medidas), casos: CASOS.filter((c) => p.casos.includes(c))
    }
  };
}

const congelar = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') congelar(v); return Object.freeze(o); };

/** Los perfiles que trae el plugin, en el orden en que los ofrece la pestaña. */
const PERFILES = new Map(['sdxl', 'sdxl-rapido', 'sdxl-pony', 'sdxl-illustrious', 'sdxl-anything', 'flux', 'flux-fp8', 'flux-fill', 'flux-kontext'].map((id) => {
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
  // FEAT-216 — Las familias de anime: «pony» al principio de una palabra (ponyDiffusionV6XL, no ponytail), «illustrious»,
  // «noob» o la palabra «wai» (no waiting), y «anything».
  if (/(^|[^a-z])pony(?!tail)/.test(m)) return 'sdxl-pony';
  if (/illustrious|(^|[^a-z])noob|(^|[^a-z])wai([^a-z]|$)/.test(m)) return 'sdxl-illustrious';
  if (/(^|[^a-z])anything/.test(m)) return 'sdxl-anything';
  return 'sdxl';
}

// ---------------------------------------------------------------- FEAT-216: el prompt final

/** Un peso al final: `:1.2`, `: -0.5`, `:.8`, con espacios antes del cierre. */
const RE_PESO = /\s*:\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/;

/** La forma con que se compara una etiqueta: sin peso ni paréntesis, en minúsculas, con «_» como espacio. */
function claveEtiqueta(etiqueta) {
  let t = String(etiqueta || '').trim();
  for (let i = 0; i < 5; i++) {
    let n = t;
    if (/^\(.*\)$/s.test(n)) n = n.slice(1, -1);
    else if (/^\[.*\]$/s.test(n)) n = n.slice(1, -1);
    // El peso, envuelta o no: `nsfw:1.2` dentro de un grupo también es `nsfw`.
    n = n.replace(RE_PESO, '').trim();
    if (n === t) break;
    t = n;
  }
  return t.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
}

/** Las etiquetas de un texto separado por comas, sin vacías. Una coma dentro de paréntesis o corchetes no separa. */
function etiquetasDe(texto) {
  const salida = [];
  let prof = 0;
  let actual = '';
  for (const ch of String(texto || '')) {
    if (ch === '(' || ch === '[') prof++;
    else if ((ch === ')' || ch === ']') && prof > 0) prof--;
    if (ch === ',' && prof === 0) { salida.push(actual); actual = ''; } else actual += ch;
  }
  salida.push(actual);
  return salida.map((x) => x.trim()).filter(Boolean);
}

/**
 * Un grupo con peso, como `(masterpiece, best quality:1.2)`: sus etiquetas y cómo rearmarlo con las que queden. `null` si
 * la etiqueta no es un grupo (un solo paréntesis que la envuelve entera, con más de una etiqueta adentro).
 */
function grupoDe(e) {
  if (!/^\(.*\)$/s.test(e)) return null;
  let prof = 0;
  for (let i = 0; i < e.length - 1; i++) {
    if (e[i] === '(') prof++;
    else if (e[i] === ')') prof--;
    if (prof === 0) return null; // el primer paréntesis cierra antes del final: `(a) (b)`.
  }
  const adentro = e.slice(1, -1);
  const peso = (RE_PESO.exec(adentro) || [''])[0];
  const partes = etiquetasDe(peso ? adentro.slice(0, -peso.length) : adentro);
  if (partes.length < 2 && !(partes.length === 1 && grupoDe(partes[0]))) return null;
  // Si la que queda última ya trae su peso (`(nsfw:1.2, explicit:1.3)` sin `explicit`), el del grupo no se le suma.
  return { partes, armar: (quedan) => `(${quedan.join(', ')}${RE_PESO.test(quedan[quedan.length - 1]) ? '' : peso})` };
}

/** La etiqueta sin las partes que `fuera(clave)` descarta: un grupo se rearma con las que quedan. `''` si no queda nada. */
function filtrarEtiqueta(e, fuera) {
  const g = grupoDe(e);
  if (!g) return fuera(claveEtiqueta(e)) ? '' : e;
  const quedan = g.partes.map((x) => filtrarEtiqueta(x, fuera)).filter(Boolean);
  if (!quedan.length) return '';
  return quedan.length === g.partes.length && quedan.every((x, i) => x === g.partes[i]) ? e : g.armar(quedan);
}

/** Une textos de etiquetas en orden: una que ya está (por `claveEtiqueta`, también dentro de un grupo) no se repite. */
function unirEtiquetas(...partes) {
  const vistas = new Set();
  const fuera = (k) => {
    if (!k || vistas.has(k)) return true;
    vistas.add(k);
    return false;
  };
  const salida = [];
  for (const p of partes) for (const e of etiquetasDe(p)) {
    const f = filtrarEtiqueta(e, fuera);
    if (f) salida.push(f);
  }
  return salida.join(', ');
}

/** El texto sin las etiquetas de la lista `quitar` (también las de un grupo). */
function quitarEtiquetas(texto, quitar) {
  const lista = new Set(etiquetasDe(quitar).map(claveEtiqueta));
  if (!lista.size) return String(texto || '');
  return etiquetasDe(texto).map((e) => filtrarEtiqueta(e, (k) => lista.has(k))).filter(Boolean).join(', ');
}

/** ¿El modo seguro está prendido para este perfil? Si el perfil lo define, sí, salvo `comfyui.seguro_de[id] === false`. */
function seguroActivo(imagenes, p) {
  if (!p || !p.prompt || !p.prompt.seguro) return false;
  const c = imagenes && esObjeto(imagenes.comfyui) ? imagenes.comfyui : {};
  const tabla = esObjeto(c.seguro_de) ? c.seguro_de : {};
  return !(tiene(tabla, p.id) && tabla[p.id] === false);
}

/**
 * El prompt y el negativo que van a ComfyUI: el prefijo y el negativo fijo del perfil, y con el modo seguro sus etiquetas
 * (y sin las de rating que escribió el refinador), todo sin repetidos. Sin modo seguro no se agrega ni se saca nada de él.
 */
function componerPrompt(p, { prompt = '', negativo = '', seguro = false } = {}) {
  const q = p && p.prompt ? p.prompt : {};
  const s = seguro && q.seguro ? q.seguro : null;
  const positivo = s ? quitarEtiquetas(prompt, s.quitar) : prompt;
  // Del negativo del refinador también salen las de rating (y la segura: negar «general» sería pedir lo contrario); el
  // modo seguro pone las suyas.
  const neg = s ? quitarEtiquetas(negativo, unirEtiquetas(s.quitar, s.positivo)) : negativo;
  return {
    prompt: q.prefijo || s ? unirEtiquetas(q.prefijo, s ? s.positivo : '', positivo) : String(prompt || ''),
    negativo: q.negativo === 'no' ? '' : q.negativoFijo || s ? unirEtiquetas(q.negativoFijo, s ? s.negativo : '', neg) : String(negativo || '')
  };
}

/**
 * El prompt sin lo que el sistema agrega por su cuenta (el prefijo y, con el modo seguro, su etiqueta): un prompt que ya
 * pasó por `componerPrompt` (el del taller, al hacer «otra versión») vuelve a ocupar solo lo suyo dentro del tope.
 */
function sinFijas(p, prompt, seguro = false) {
  const q = p && p.prompt ? p.prompt : {};
  const fijas = unirEtiquetas(q.prefijo, seguro && q.seguro ? q.seguro.positivo : '');
  return fijas ? quitarEtiquetas(prompt, fijas) : String(prompt || '');
}

/**
 * El `valor` exacto con que ComfyUI lista un archivo, o `null`. En Windows lo lista con `\` (`SDXL\a.safetensors`) y la
 * pestaña lo muestra con `/`: las dos formas son el mismo archivo.
 */
function enLista(lista, nombre) {
  if (!Array.isArray(lista) || typeof nombre !== 'string' || !nombre) return null;
  const igual = (v) => v.replace(/\\/g, '/');
  const a = lista.find((x) => x.valor === nombre) || lista.find((x) => igual(x.valor) === igual(nombre));
  return a ? a.valor : null;
}

/** En qué listas del catálogo está el archivo: `{ checkpoint, unet }`. */
function cargasEnCatalogo(modelo, catalogo) {
  const en = (lista) => Boolean(enLista(lista, modelo));
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
  formaDeArchivo, validarPerfil, perfil, perfilesEfectivos, perfilDePartida, idPorNombre, enLista, cargasEnCatalogo, pareceUnet, perfilDe,
  MAX_FIJO, MAX_SEGURO, claveEtiqueta, etiquetasDe, unirEtiquetas, quitarEtiquetas, seguroActivo, componerPrompt, sinFijas
};
