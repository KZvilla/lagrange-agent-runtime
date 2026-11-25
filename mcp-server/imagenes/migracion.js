'use strict';

/**
 * FEAT-212 §1.1 — De los campos de 2.18 (`pasos`, `tope_prompt`, `flujo_txt2img`, `flujo_img2img`, `nodo_salida`) a los
 * perfiles y a `flujos[<perfil>]`.
 *
 * `traducirLegado` es una sola función para los dos caminos: la migración del archivo (`manda: 'nuevo'`, tolerante) y el
 * POST de Desktop v0.21.1 (`manda: 'legado'`, estricto: lanza `ErrorAjuste`). Así no pueden decidir distinto.
 */

const { ErrorAjuste } = require('../lib/error-ajuste.js');
const perfiles = require('./perfiles.js');
const flujos = require('./flujos.js');

const LEGADAS = Object.freeze(['pasos', 'tope_prompt', 'flujo_txt2img', 'flujo_img2img', 'nodo_salida']);
const CASO_DE = Object.freeze({ flujo_txt2img: 'nueva', flujo_img2img: 'variacion' });
const NUMEROS = Object.freeze({ pasos: { min: 1, max: 150 }, tope_prompt: { min: 100, max: 2000 } });
const MAX_PERFIL_DE = 50;
const SALIDA_DE_PLANTILLA = '9';

const esObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const copia = (o) => JSON.parse(JSON.stringify(o));
const conClave = (o, k, v) => Object.fromEntries([...Object.entries(esObjeto(o) ? o : {}).filter(([x]) => x !== k), [k, v]]);
const sinClave = (o, k) => Object.fromEntries(Object.entries(esObjeto(o) ? o : {}).filter(([x]) => x !== k));

/** ¿Trae la sección cruda alguna clave de 2.18? */
const tieneLegado = (crudo) => esObjeto(crudo) && esObjeto(crudo.comfyui) && LEGADAS.some((k) => Object.hasOwn(crudo.comfyui, k));

/** El texto del campo, para un 400. */
const nombreDe = (k) => (k === 'flujo_txt2img' ? 'El flujo de txt2img' : 'El flujo de img2img');

/**
 * `crudo`: la sección `imagenes` cruda (sin las claves legadas, o con ellas: se borran). `legado`: los campos viejos que
 * hay que traducir. Devuelve `{ imagenes, avisos }`. `normalizar` es el de `ajustes-imagenes.js`.
 */
function traducirLegado(crudo, legado, { manda = 'nuevo', denyPaths = [], catalogo = null, normalizar, modeloPorDefecto }) {
  const estricto = manda === 'legado';
  const avisos = [];
  const raiz = esObjeto(crudo) ? copia(crudo) : {};
  let c = esObjeto(raiz.comfyui) ? { ...raiz.comfyui } : {};
  for (const k of LEGADAS) c = sinClave(c, k);
  const campo = (k) => `imagenes.comfyui.${k}`;
  const norm = () => normalizar({ ...raiz, comfyui: c }, { denyPaths }).imagenes;
  let n = norm();
  const modelo = n.comfyui.modelo || modeloPorDefecto;

  // 1. Los flujos legados que se van a guardar.
  const propios = [];
  const vaciar = [];
  for (const k of ['flujo_txt2img', 'flujo_img2img']) {
    if (!Object.hasOwn(legado, k) || legado[k] === undefined) continue;
    const v = legado[k];
    if (v === null || v === '') { vaciar.push(k); continue; }
    const forma = flujos.formaDeFlujo(v, { denyPaths });
    if (!forma.ok) {
      if (estricto) throw new ErrorAjuste(`${nombreDe(k)} ${forma.motivo}`, campo(k));
      if (!forma.plantilla) avisos.push(`imagenes.comfyui.${k} (de 2.18) ${forma.motivo === 'está en deny_paths' ? 'está en deny_paths' : 'no es una ruta absoluta a un .json'}; no se usa`);
      continue;
    }
    const l = flujos.leerFlujo(forma.ruta, { caso: CASO_DE[k], denyPaths });
    if (!l.ok && estricto) throw new ErrorAjuste(`${nombreDe(k)}: ${l.motivo}`, campo(k));
    propios.push({ k, caso: CASO_DE[k], ruta: forma.ruta, leido: l });
  }

  // 2. La carga que sugieren, y el perfil.
  let sugerida = null;
  for (const p of propios) {
    if (!p.leido.flujo) continue;
    const q = flujos.cargasDe(p.leido.flujo);
    if (q.checkpoint !== q.unet) { sugerida = q.checkpoint ? 'checkpoint' : 'unet'; break; }
  }
  if (!sugerida && catalogo) {
    const en = perfiles.cargasEnCatalogo(modelo, catalogo);
    if (en.checkpoint !== en.unet) sugerida = en.checkpoint ? 'checkpoint' : 'unet';
  }
  const d = perfiles.perfilDe(n, modelo, null, { cargaSugerida: sugerida });
  let perfil = d.perfil;
  let creado = null;
  if (d.fuente !== 'asignado') {
    if (propios.length && ['flux-kontext', 'flux-fill'].includes(perfil.id)) perfil = perfiles.perfil(n, sugerida === 'checkpoint' ? 'flux-fp8' : 'flux');
    if (propios.length && sugerida && perfil.carga.tipo !== sugerida) {
      let id = `${perfil.id}-${sugerida}`.slice(0, 40);
      const hay = perfiles.perfil(n, id);
      if (hay && hay.carga.tipo !== sugerida) id = `${id.slice(0, 38)}-2`;
      if (!perfiles.perfil(n, id)) {
        const { id: _, origen: __, ...resto } = copia(perfil);
        raiz.perfiles_propios = conClave(raiz.perfiles_propios, id, { ...resto, nombre: `${perfil.nombre} (${sugerida})`.slice(0, 40), carga: { tipo: sugerida } });
        n = norm();
        creado = id;
      }
      perfil = perfiles.perfil(n, id) || perfil;
    }
  }

  // 3. Las entradas de los flujos.
  const entradas = () => (esObjeto(c.flujos) && Object.hasOwn(c.flujos, perfil.id) && esObjeto(c.flujos[perfil.id]) ? c.flujos[perfil.id] : {});
  const poner = (caso, e) => { c.flujos = conClave(c.flujos, perfil.id, conClave(entradas(), caso, e)); };
  const sacar = (caso) => {
    const resto = sinClave(entradas(), caso);
    c.flujos = Object.keys(resto).length ? conClave(c.flujos, perfil.id, resto) : sinClave(c.flujos, perfil.id);
    if (!Object.keys(c.flujos).length) delete c.flujos;
  };
  const nodo = Object.hasOwn(legado, 'nodo_salida') && legado.nodo_salida !== undefined ? legado.nodo_salida : undefined;
  const pedido = nodo === undefined || nodo === null || nodo === '' ? null : String(nodo);
  const salidaPara = (salidas) => (pedido && salidas.includes(pedido) ? pedido : salidas[0] || null);
  let usado = false;
  for (const p of propios) {
    const salidas = p.leido.salidas || [];
    if (estricto && !flujos.cargaCoincide(p.leido.flujo, perfil.carga.tipo)) throw new ErrorAjuste(`${nombreDe(p.k)}: la carga del flujo no coincide con el perfil ${perfil.id}`, campo(p.k));
    if (!estricto && Object.hasOwn(entradas(), p.caso)) continue;
    if (pedido && salidas.includes(pedido)) usado = true;
    else if (pedido && !estricto) avisos.push(`El nodo de salida de 2.18 no es un SaveImage del flujo de ${p.caso}; se usa el primero`);
    poner(p.caso, { archivo: p.ruta, salida: salidaPara(salidas) });
  }
  for (const k of vaciar) if (estricto) sacar(CASO_DE[k]);
  if (estricto && nodo !== undefined) {
    // El nodo de salida solo, sobre los flujos propios que ya están guardados.
    let habia = propios.length > 0;
    for (const caso of ['nueva', 'variacion']) {
      const e = Object.hasOwn(entradas(), caso) && esObjeto(entradas()[caso]) ? entradas()[caso] : null;
      if (!e || propios.some((p) => p.caso === caso)) continue;
      habia = true;
      const l = flujos.leerFlujo(String(e.archivo), { caso, denyPaths });
      const salidas = l.salidas || [];
      if (!pedido) { if (salidas.length) poner(caso, { ...e, salida: salidas[0] }); } else if (salidas.includes(pedido)) { usado = true; poner(caso, { ...e, salida: pedido }); }
    }
    if (pedido && !usado && (habia || pedido !== SALIDA_DE_PLANTILLA)) throw new ErrorAjuste('El nodo de salida tiene que ser un SaveImage de alguno de los dos flujos', campo('nodo_salida'));
  }
  if (propios.length && d.fuente !== 'asignado') {
    const previas = esObjeto(c.perfil_de) ? c.perfil_de : {};
    if (!Object.hasOwn(previas, modelo) && Object.keys(previas).length >= MAX_PERFIL_DE) {
      if (estricto) throw new ErrorAjuste(`Hasta ${MAX_PERFIL_DE} modelos con perfil asignado`, 'imagenes.comfyui.perfil_de');
    } else c.perfil_de = conClave(previas, modelo, perfil.id);
  }

  // 4. Los números, en la copia propia del perfil (o de los dos posibles, si todavía no se sabe cuál es).
  const ambiguo = d.fuente === 'nombre' && !propios.length && perfil.id === 'flux';
  const ids = ambiguo ? ['flux', 'flux-fp8'] : [perfil.id];
  for (const id of ids) {
    const propio = esObjeto(raiz.perfiles_propios) && Object.hasOwn(raiz.perfiles_propios, id);
    // Manda lo nuevo: en la migración, una copia propia que ya estaba no se toca.
    if (!estricto && propio && id !== creado) continue;
    let nuevo = null;
    for (const [k, r] of Object.entries(NUMEROS)) {
      if (!Object.hasOwn(legado, k) || legado[k] === undefined) continue;
      const v = legado[k];
      const base = nuevo || copia(perfiles.perfil(n, id));
      if (v === null || v === '') {
        if (!estricto || !propio) continue;
        const partida = perfiles.perfilDePartida(base);
        if (k === 'pasos') base.muestreo.pasos = partida.muestreo.pasos; else base.prompt.tope = partida.prompt.tope;
        nuevo = base;
        continue;
      }
      if (!Number.isInteger(v) || v < r.min || v > r.max) {
        if (estricto) throw new ErrorAjuste(`imagenes.comfyui.${k} tiene que ser un entero de ${r.min} a ${r.max}`, campo(k));
        avisos.push(`imagenes.comfyui.${k} (de 2.18) no es un entero de ${r.min} a ${r.max}; se usa el del perfil`);
        continue;
      }
      if (k === 'pasos') base.muestreo.pasos = v; else base.prompt.tope = v;
      nuevo = base;
    }
    if (!nuevo) continue;
    if (!propio && Object.keys(esObjeto(raiz.perfiles_propios) ? raiz.perfiles_propios : {}).length >= perfiles.MAX_PROPIOS) {
      if (estricto) throw new ErrorAjuste(`Hasta ${perfiles.MAX_PROPIOS} perfiles propios`, 'imagenes.perfiles_propios');
      continue;
    }
    const { id: _, origen: __, ...resto } = nuevo;
    raiz.perfiles_propios = conClave(raiz.perfiles_propios, id, resto);
  }

  // 5. Un Kontext o un Fill principal sin flujos (solo al migrar): a su lugar, si está libre.
  if (!estricto && !propios.length && d.fuente !== 'asignado' && ['flux-kontext', 'flux-fill'].includes(d.perfil.id)) {
    const lugar = d.perfil.id === 'flux-kontext' ? 'modelo_edicion' : 'modelo_retoque';
    if (!c[lugar]) {
      c[lugar] = modelo;
      c = sinClave(c, 'modelo');
      avisos.push(`El modelo principal (${d.perfil.nombre}) no hace imágenes nuevas: pasó a ser el de ${lugar === 'modelo_edicion' ? 'edición' : 'retoque'}`);
    }
  }
  if (propios.length && !estricto) avisos.push(`Los flujos de 2.18 quedaron en el perfil ${perfil.nombre}`);

  if (Object.keys(c).length) raiz.comfyui = c; else delete raiz.comfyui;
  return { imagenes: raiz, avisos };
}

module.exports = { LEGADAS, MAX_PERFIL_DE, tieneLegado, traducirLegado };
