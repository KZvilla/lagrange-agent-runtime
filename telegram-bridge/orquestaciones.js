/**
 * FEAT-162 — Registro de orquestaciones: lo que una sesión (Spica, Epikouros…)
 * hace con la consola a través de la herramienta MCP `consola`.
 *
 * Una orquestación tiene un plan (pasos que declara la sesión), las acciones
 * que la credencial del orquestador hizo por la API (solo método, ruta, nivel
 * y resultado: nunca cuerpos) y las aprobaciones pendientes del modo `pedir`.
 * Una aprobación sí guarda `metodo` y `args` completos (hasta 16 KB): es lo que
 * se ejecuta si el usuario aprueba. Se borran al resolverse o al vencer.
 *
 * F3 — La conversación (notas del usuario, respuestas y preguntas de la sesión)
 * y las aprobaciones `local`: las de una herramienta del MCP (agy_lote,
 * agy_fanout, cast_agent). Aprobarlas no ejecuta nada: guardan la `huella` de
 * los argumentos y la sesión la consume una vez al volver a pedirla.
 *
 * Mismo patrón que `tareas.js`: un solo escritor (el daemon), copia en memoria,
 * escritura atómica por cambio, `suscribir` para el SSE. Importarlo no toca el
 * disco: la ruta se resuelve en el primer uso, junto a `state.json`.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getStateFilePath } from './state.js';
import { redactSecrets } from './policy.js';

const require = createRequire(import.meta.url);
const { leerJson, guardarJson } = require('../mcp-server/agents/almacen.js');

export const VERSION = 1;
export const TOPE_ORQUESTACIONES = 20;
export const TOPE_PASOS = 50;
export const TOPE_ACCIONES = 500;
export const TOPE_TITULO = 120;
export const TOPE_TEXTO_PASO = 200;
export const TOPE_ARGS = 16 * 1024;
export const VENCE_APROBACION_MS = 30 * 60 * 1000;
export const TOPE_CONVERSACION = 200;
export const TOPE_TEXTO_NOTA = 4 * 1024;
export const TOPE_RESUMEN = 300;
export const RESULTADOS = Object.freeze(['ok', 'error']);
export const ESTADOS = Object.freeze(['activa', 'frenada', 'terminada']);
export const ESTADOS_PASO = Object.freeze(['pendiente', 'en_curso', 'hecho', 'fallo']);
export const RE_QUIEN = /^[\p{L}\p{N} _-]{1,32}$/u;

let cache = null;
let rutaCache = null;
let reloj = () => Date.now();
const suscriptores = new Set();

export function rutaOrquestaciones() {
  return path.join(path.dirname(getStateFilePath()), 'orquestaciones.json');
}

const ahoraIso = () => new Date(reloj()).toISOString();
const nuevoId = (prefijo) => `${prefijo}_${reloj().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const fallo = (codigo, error) => ({ ok: false, codigo, error });
const texto = (v, tope) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, tope);

function cargar() {
  const ruta = rutaOrquestaciones();
  if (cache && rutaCache === ruta) return cache;
  const { datos, ilegible } = leerJson(ruta);
  const lista = datos && Array.isArray(datos.orquestaciones) ? datos.orquestaciones.filter((o) => o && typeof o.id === 'string') : [];
  cache = { lista, ilegible, soloLectura: Number(datos?.version) > VERSION };
  rutaCache = ruta;
  return cache;
}

function guardar() {
  const estado = cargar();
  if (estado.soloLectura) return;
  // Las más viejas terminadas salen primero; una activa o una frenada nunca (la frenada sigue frenando a su sesión).
  while (estado.lista.length > TOPE_ORQUESTACIONES) {
    const i = estado.lista.findIndex((o) => o.estado === 'terminada');
    if (i === -1) break;
    estado.lista.splice(i, 1);
  }
  try {
    guardarJson(rutaCache, { version: VERSION, orquestaciones: estado.lista }, { ilegible: estado.ilegible });
    estado.ilegible = false;
  } catch (err) {
    console.error(`[orquestaciones] No se pudo guardar ${rutaCache}: ${redactSecrets(err.message)}`);
  }
}

function avisar(o) {
  for (const fn of suscriptores) {
    try { fn(resumen(o)); } catch (err) { console.error(`[orquestaciones] Un suscriptor falló: ${err.message}`); }
  }
}

export function suscribir(fn) {
  suscriptores.add(fn);
  return () => suscriptores.delete(fn);
}

/**
 * Lo que viaja a la consola y a la herramienta: las aprobaciones sin sus `args` ni su `huella`, y sin el id
 * de buzón de la sesión (`sesion`): solo si recibe notas (`entrega`).
 */
export function resumen(o) {
  if (!o) return null;
  const { sesion, ...resto } = o;
  return { ...resto, conversacion: o.conversacion || [], entrega: Boolean(sesion), aprobaciones: o.aprobaciones.map(({ args, huella, ...a }) => a) };
}

/** Vence las aprobaciones pendientes viejas. Devuelve si cambió algo. */
function vencer(o) {
  let cambio = false;
  for (const a of o.aprobaciones) {
    if (a.estado === 'pendiente' && reloj() >= Date.parse(a.vence)) {
      a.estado = 'vencida';
      delete a.args;
      cambio = true;
    }
    // F3 — Una local aprobada que la sesión no volvió a pedir en 30 min ya no vale.
    if (a.local && a.estado === 'aprobada' && !a.consumida && reloj() >= Date.parse(a.aprobadaEn) + VENCE_APROBACION_MS) {
      a.estado = 'vencida';
      cambio = true;
    }
  }
  return cambio;
}

function cambiar(o) {
  o.actualizada = ahoraIso();
  guardar();
  avisar(o);
}

export function listar() {
  const estado = cargar();
  let cambio = false;
  for (const o of estado.lista) cambio = vencer(o) || cambio;
  if (cambio) guardar();
  return estado.lista.map(resumen).reverse();
}

export function obtener(id) {
  return cargar().lista.find((o) => o.id === id) || null;
}

export function activaDe(quien) {
  return cargar().lista.find((o) => o.quien === quien && o.estado !== 'terminada') || null;
}

function pasosValidados(pasos, previos = []) {
  if (!Array.isArray(pasos) || pasos.length > TOPE_PASOS) return { error: `Los pasos son una lista de hasta ${TOPE_PASOS}.` };
  const porId = new Map(previos.map((p) => [p.id, p]));
  const salida = [];
  for (const [i, crudo] of pasos.entries()) {
    const p = typeof crudo === 'string' ? { texto: crudo } : crudo;
    if (!p || typeof p !== 'object') return { error: `Paso ${i + 1}: tiene que ser un texto o un objeto.` };
    const previo = p.id && porId.get(p.id);
    const t = texto(p.texto ?? previo?.texto, TOPE_TEXTO_PASO);
    if (!t) return { error: `Paso ${i + 1}: falta el texto.` };
    const estado = p.estado ?? previo?.estado ?? 'pendiente';
    if (!ESTADOS_PASO.includes(estado)) return { error: `Paso ${i + 1}: el estado es ${ESTADOS_PASO.join(', ')}.` };
    const enlaces = Array.isArray(p.enlaces) ? p.enlaces : previo?.enlaces || [];
    const validos = enlaces.filter((e) => e && ['tarjeta', 'lote'].includes(e.tipo) && typeof e.id === 'string' && e.id.length <= 80).slice(0, 10)
      .map((e) => ({ tipo: e.tipo, id: e.id }));
    salida.push({ id: previo ? previo.id : `p${i + 1}_${crypto.randomBytes(2).toString('hex')}`, texto: t, estado, enlaces: validos });
  }
  return { pasos: salida };
}

/** Abre la orquestación de `quien`. Una sola abierta por quien: la anterior hay que terminarla. */
export function abrir({ quien, titulo, pasos = [], modo, sesion = null }) {
  const estado = cargar();
  if (estado.soloLectura) return fallo(503, 'El registro de orquestaciones es de una versión más nueva.');
  if (!RE_QUIEN.test(String(quien || ''))) return fallo(400, 'Quién orquesta no es válido.');
  const abierta = activaDe(quien);
  if (abierta) return fallo(409, `${quien} ya tiene una orquestación ${abierta.estado} (${abierta.id}): terminala antes de abrir otra.`);
  const t = texto(titulo, TOPE_TITULO);
  if (!t) return fallo(400, 'Falta el título.');
  const v = pasosValidados(pasos);
  if (v.error) return fallo(400, v.error);
  const ahora = ahoraIso();
  const o = { id: nuevoId('o'), quien, titulo: t, modo, estado: 'activa', pasos: v.pasos, acciones: [], aprobaciones: [], conversacion: [], creada: ahora, actualizada: ahora };
  // F3 — El buzón de la sesión (el servidor ya verificó que el daemon la tiene registrada).
  if (typeof sesion === 'string' && sesion) o.sesion = sesion;
  estado.lista.push(o);
  cambiar(o);
  return { ok: true, orquestacion: resumen(o) };
}

function deQuien(id, quien) {
  const o = obtener(id);
  if (!o) return { error: fallo(404, 'No existe esa orquestación.') };
  if (quien !== undefined && o.quien !== quien) return { error: fallo(403, 'Esa orquestación es de otra sesión.') };
  return { o };
}

export function actualizarPasos(id, quien, pasos) {
  const { o, error } = deQuien(id, quien);
  if (error) return error;
  if (o.estado !== 'activa') return fallo(409, `La orquestación está ${o.estado}.`);
  const v = pasosValidados(pasos, o.pasos);
  if (v.error) return fallo(400, v.error);
  o.pasos = v.pasos;
  cambiar(o);
  return { ok: true, orquestacion: resumen(o) };
}

/** La termina la sesión (`quien`) o el usuario (sin `quien`): una huérfana o una frenada se cierran desde la vista. */
export function terminar(id, quien) {
  const { o, error } = deQuien(id, quien);
  if (error) return error;
  if (o.estado === 'terminada') return { ok: true, orquestacion: resumen(o) };
  o.estado = 'terminada';
  for (const a of o.aprobaciones) if (a.estado === 'pendiente') { a.estado = 'cancelada'; delete a.args; }
  cambiar(o);
  return { ok: true, orquestacion: resumen(o) };
}

/** El usuario la frena: la credencial ya no puede hacer nada en su nombre. */
export function frenar(id) {
  const { o, error } = deQuien(id);
  if (error) return error;
  if (o.estado !== 'activa') return fallo(409, `La orquestación está ${o.estado}.`);
  o.estado = 'frenada';
  for (const a of o.aprobaciones) if (a.estado === 'pendiente') { a.estado = 'cancelada'; delete a.args; }
  cambiar(o);
  return { ok: true, orquestacion: resumen(o) };
}

/** El enlace (tarjeta o lote) también va al paso en curso, o al primero pendiente. */
function enlazarAlPaso(o, enlace) {
  const paso = o.pasos.find((p) => p.estado === 'en_curso') || o.pasos.find((p) => p.estado === 'pendiente');
  if (paso && !paso.enlaces.some((e) => e.tipo === enlace.tipo && e.id === enlace.id) && paso.enlaces.length < 10) paso.enlaces.push(enlace);
}
const enlaceValido = (e) => (e && ['tarjeta', 'lote'].includes(e.tipo) && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 80 ? { tipo: e.tipo, id: e.id } : null);

/** Una acción hecha por la credencial. `enlace`, si creó una tarjeta o un lote: va también al paso en curso. */
export function registrarAccion(id, { metodo, ruta, nivel, resultado, enlace = null, accionId = null }) {
  const o = obtener(id);
  if (!o) return null;
  const accion = { t: ahoraIso(), metodo: String(metodo), ruta: texto(ruta, 200), nivel, resultado };
  // F3 — Las de una herramienta del MCP nacen `en_curso` con id, y `cerrarAccion` las termina.
  if (accionId) accion.id = accionId;
  if (enlace) {
    accion.enlace = enlace;
    enlazarAlPaso(o, enlace);
  }
  o.acciones.push(accion);
  if (o.acciones.length > TOPE_ACCIONES) o.acciones.splice(0, o.acciones.length - TOPE_ACCIONES);
  cambiar(o);
  return accion;
}

/** F3 — Una herramienta del MCP empieza a correr en nombre de la orquestación: devuelve el id de su acción. */
export function iniciarAccion(id, { metodo, nivel }) {
  const accionId = nuevoId('h');
  return registrarAccion(id, { metodo, ruta: '', nivel, resultado: 'en_curso', accionId }) ? accionId : null;
}

/** F3 — La cierra una sola vez (ok o error), con el lote que dejó, si dejó uno. Solo la sesión dueña. */
export function cerrarAccion(id, quien, accionId, { resultado, enlace = null } = {}) {
  const { o, error } = deQuien(id, quien);
  if (error) return error;
  if (!RESULTADOS.includes(resultado)) return fallo(400, `El resultado es ${RESULTADOS.join(' o ')}.`);
  const a = o.acciones.find((x) => x.id === accionId);
  if (!a) return fallo(404, 'No existe esa acción.');
  if (a.resultado !== 'en_curso') return fallo(409, `La acción ya está ${a.resultado}.`);
  a.resultado = resultado;
  a.cerrada = ahoraIso();
  const e = resultado === 'ok' ? enlaceValido(enlace) : null;
  if (e) { a.enlace = e; enlazarAlPaso(o, e); }
  cambiar(o);
  return { ok: true };
}

/** Modo `pedir`: guarda el pedido entero para ejecutarlo si el usuario aprueba. */
export function pedirAprobacion(id, { metodo, args, ruta, nivel, local = false, huella = null, resumen: detalle = null }) {
  const o = obtener(id);
  if (!o) return fallo(404, 'No existe esa orquestación.');
  let serial;
  try { serial = JSON.stringify(args ?? []); } catch { return fallo(400, 'El pedido no se puede guardar.'); }
  if (serial.length > TOPE_ARGS) return fallo(413, `El pedido pasa de ${TOPE_ARGS / 1024} KB: no se guarda para aprobar.`);
  const creada = ahoraIso();
  const a = { id: nuevoId('a'), metodo: String(metodo), ruta: texto(ruta, 200), nivel, estado: 'pendiente', creada,
    vence: new Date(reloj() + VENCE_APROBACION_MS).toISOString(), args: JSON.parse(serial) };
  // F3 — La de una herramienta del MCP: nada que ejecutar acá, solo la huella de lo que la sesión correrá.
  if (local) {
    if (typeof huella !== 'string' || !/^[0-9a-f]{64}$/.test(huella)) return fallo(400, 'Falta la huella de los argumentos.');
    a.local = true;
    a.huella = huella;
    a.args = [];
    const r = texto(detalle, TOPE_RESUMEN);
    if (r) a.resumen = redactSecrets(r);
  }
  o.aprobaciones.push(a);
  // Las resueltas viejas se van; las pendientes, nunca.
  while (o.aprobaciones.length > 50) {
    const i = o.aprobaciones.findIndex((x) => x.estado !== 'pendiente');
    if (i === -1) break;
    o.aprobaciones.splice(i, 1);
  }
  o.acciones.push({ t: creada, metodo: a.metodo, ruta: a.ruta, nivel, resultado: 'pendiente', aprobacion: a.id });
  cambiar(o);
  return { ok: true, aprobacion: a.id };
}

/**
 * El usuario decide. `{ ok, metodo, args }` si aprobó una vigente (quien llama la
 * ejecuta y anota el resultado con `resultadoAprobacion`); el rechazo no devuelve nada que ejecutar.
 */
export function resolverAprobacion(id, aid, aprobar) {
  const { o, error } = deQuien(id);
  if (error) return error;
  vencer(o);
  const a = o.aprobaciones.find((x) => x.id === aid);
  if (!a) return fallo(404, 'No existe esa aprobación.');
  if (a.estado !== 'pendiente') { cambiar(o); return fallo(409, `La aprobación ya está ${a.estado}.`); }
  if (o.estado !== 'activa') return fallo(409, `La orquestación está ${o.estado}.`);
  const { metodo, args } = a;
  a.estado = aprobar ? 'aprobada' : 'rechazada';
  a.resuelta = ahoraIso();
  delete a.args;
  // F3 — Aprobar una local no ejecuta nada: la sesión la consume al volver a pedirla (hasta 30 min).
  if (a.local) {
    if (aprobar) a.aprobadaEn = a.resuelta;
    else o.acciones.push({ t: a.resuelta, metodo, ruta: a.ruta, nivel: a.nivel, resultado: 'rechazada', aprobacion: a.id });
    cambiar(o);
    return { ok: true, local: true };
  }
  if (!aprobar) o.acciones.push({ t: a.resuelta, metodo, ruta: a.ruta, nivel: a.nivel, resultado: 'rechazada', aprobacion: a.id });
  cambiar(o);
  return aprobar ? { ok: true, metodo, args } : { ok: true };
}

export function resultadoAprobacion(id, aid, { resultado, enlace = null }) {
  const o = obtener(id);
  const a = o?.aprobaciones.find((x) => x.id === aid);
  if (!a) return;
  a.resultado = resultado;
  registrarAccion(id, { metodo: a.metodo, ruta: a.ruta, nivel: a.nivel, resultado, enlace });
}

/**
 * F3 — La sesión vuelve a pedir una herramienta con la aprobación del usuario: vale una sola vez, con la misma huella
 * y dentro de los 30 min de aprobada. `{ ok, accion }` con la acción ya iniciada.
 */
export function consumirAprobacion(id, quien, aid, huella) {
  const { o, error } = deQuien(id, quien);
  if (error) return error;
  if (vencer(o)) cambiar(o);
  const a = o.aprobaciones.find((x) => x.id === aid);
  if (!a || !a.local) return fallo(404, 'No existe esa aprobación de herramienta en esta orquestación.');
  if (a.consumida) return fallo(409, 'Esa aprobación ya se usó: pedí otra.');
  if (a.estado !== 'aprobada') return fallo(403, `La aprobación está ${a.estado}.`);
  if (a.huella !== huella) return fallo(403, 'Los argumentos no son los que el usuario aprobó: pedí otra aprobación.');
  a.consumida = ahoraIso();
  const accion = iniciarAccion(id, { metodo: a.metodo, nivel: a.nivel });
  return { ok: true, accion };
}

/** F3 — Una entrada de la conversación. Con `quien`, solo la sesión dueña; sin él, el usuario. */
export function anotarConversacion(id, { de, texto: crudo, pregunta = false, respuestaA = null }, quien) {
  const { o, error } = deQuien(id, quien);
  if (error) return error;
  if (o.estado === 'terminada') return fallo(409, 'La orquestación está terminada.');
  if (!['usuario', 'sesion'].includes(de)) return fallo(400, 'La nota es del usuario o de la sesión.');
  const limpio = redactSecrets(String(crudo ?? '')).trim();
  if (!limpio) return fallo(400, 'El texto está vacío.');
  if (Buffer.byteLength(limpio) > TOPE_TEXTO_NOTA) return fallo(413, `El texto pasa de ${TOPE_TEXTO_NOTA / 1024} KB.`);
  o.conversacion ||= [];
  if (respuestaA !== null && respuestaA !== undefined && !o.conversacion.some((n) => n.id === respuestaA)) return fallo(404, `No hay una nota ${respuestaA} en esta orquestación.`);
  const nota = { id: nuevoId('n'), t: ahoraIso(), de, texto: limpio };
  if (pregunta === true && de === 'sesion') nota.pregunta = true;
  if (respuestaA) nota.respuestaA = respuestaA;
  o.conversacion.push(nota);
  if (o.conversacion.length > TOPE_CONVERSACION) o.conversacion.splice(0, o.conversacion.length - TOPE_CONVERSACION);
  cambiar(o);
  return { ok: true, nota, orquestacion: o };
}

/** F3 — Las notas del usuario que la sesión todavía no vio (después de `vistoHasta`). */
export function notasSinVer(o) {
  const conv = o?.conversacion || [];
  const desde = o?.vistoHasta ? conv.findIndex((n) => n.id === o.vistoHasta) + 1 : 0;
  return conv.slice(desde).filter((n) => n.de === 'usuario');
}

/** F3 — La sesión ya mostró las notas hasta `hasta`: solo esto mueve el cursor (ningún GET cambia nada). */
export function marcarVisto(id, quien, hasta) {
  const { o, error } = deQuien(id, quien);
  if (error) return error;
  if (!(o.conversacion || []).some((n) => n.id === hasta)) return fallo(404, `No hay una nota ${hasta} en esta orquestación.`);
  o.vistoHasta = hasta;
  cambiar(o);
  return { ok: true };
}

/** Solo para los tests. */
export function reiniciarParaTests() {
  cache = null;
  rutaCache = null;
  suscriptores.clear();
  reloj = () => Date.now();
}
export function fijarRelojParaTests(fn) { reloj = fn; }
