/**
 * FEAT-053 — Registro de tareas del bridge.
 *
 * Cada charla, cast o trabajo que pasa por la cola deja una entrada con su
 * estado, sus tiempos y (para charlas y casts) el pedido y el resultado. La
 * cola vive en memoria y no sobrevive a un reinicio; este registro es lo que
 * la consola web usa para mostrar historia, estados y, más adelante, el
 * tablero.
 *
 * Un solo escritor: el daemon (es el único que encola). Por eso alcanza con
 * una copia en memoria y una escritura atómica síncrona en cada cambio. No se
 * agrupan escrituras: un `taskkill` no dispara `exit`, y lo último que pasó
 * sería justo lo que se pierde.
 *
 * Sensibilidad: `redactSecrets` solo quita tokens de Telegram. Este archivo es
 * tan sensible como las conversaciones que ya guarda agy: vive en el
 * directorio de datos del usuario y nunca sale de la máquina.
 *
 * Importarlo no toca el disco: la ruta se resuelve en el primer uso, junto a
 * `state.json` (así los tests, que apuntan el estado a un temporal, quedan
 * aislados sin más).
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getStateFilePath } from './state.js';
import { redactSecrets } from './policy.js';
import { markdownToTelegramHtml } from './formatter.js';

const require = createRequire(import.meta.url);
const { leerJson, guardarJson } = require('../mcp-server/agents/almacen.js');

export const TOPE_TAREAS = 200;
export const TOPE_TEXTO = 16 * 1024;
export const TOPE_EXTRACTO_TRABAJO = 80;
export const TOPE_ACTIVIDAD = 40;
export const TOPE_TEXTO_ACTIVIDAD = 120;
export const TOPE_PEDIDO_RESUMEN = 200;
export const ESTADOS = Object.freeze(['en_cola', 'en_curso', 'ok', 'error', 'cancelada', 'interrumpida']);
export const ESTADOS_ABIERTOS = Object.freeze(['en_cola', 'en_curso']);

const CAMPOS_ACTUALIZABLES = new Set(['estado', 'iniciada', 'terminada', 'resultado', 'error', 'memoria', 'proyecto']);
const RECORTE = '\n\n… [recortado]';

let cache = null;
let rutaCache = null;
const suscriptores = new Set();

export function rutaTareas() {
  return path.join(path.dirname(getStateFilePath()), 'tareas.json');
}

function recortar(texto, tope) {
  const limpio = redactSecrets(texto ?? '');
  return limpio.length > tope ? limpio.slice(0, tope) + RECORTE : limpio;
}

/**
 * El conversor de Telegram no conoce títulos ni listas. Para la web se pasan a
 * negrita y viñetas antes de convertir, sin tocar los bloques de código.
 */
export function prepararMarkdown(texto) {
  return String(texto ?? '').split(/(```[\s\S]*?(?:```|$))/).map((tramo, i) => (i % 2
    ? tramo
    : tramo
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '**$1**')
      .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• '))).join('');
}

export function claveSujeto(sujeto) {
  if (!sujeto) return null;
  if (sujeto.tipo === 'alma') return `alma:${sujeto.clave}`;
  if (sujeto.tipo === 'agente') return `agente:${sujeto.nombre}`;
  if (sujeto.tipo === 'trabajo') return 'trabajo';
  return null;
}

function cargar() {
  const ruta = rutaTareas();
  if (cache && rutaCache === ruta) return cache;
  const { datos, ilegible } = leerJson(ruta);
  const tareas = datos && Array.isArray(datos.tareas) ? datos.tareas.filter((t) => t && typeof t.id === 'string') : [];
  cache = { tareas, ilegible };
  rutaCache = ruta;
  return cache;
}

function guardar() {
  const estado = cargar();
  if (estado.tareas.length > TOPE_TAREAS) {
    // Se descartan las más viejas, pero nunca una abierta: su cierre llegaría
    // a un id que ya no existe y la tarea desaparecería de la vista.
    let sobran = estado.tareas.length - TOPE_TAREAS;
    estado.tareas = estado.tareas.filter((t) => {
      if (sobran > 0 && !ESTADOS_ABIERTOS.includes(t.estado)) { sobran--; return false; }
      return true;
    });
  }
  try {
    guardarJson(rutaCache, { version: 1, tareas: estado.tareas }, { ilegible: estado.ilegible });
    estado.ilegible = false;
  } catch (err) {
    // El registro es una vista: si el disco falla, la cola sigue igual.
    console.error(`[tareas] No se pudo guardar ${rutaCache}: ${redactSecrets(err.message)}`);
  }
}

/**
 * La tarea sin los textos largos: lo que viaja por SSE y lo que usa el
 * tablero. La actividad sí va (está acotada).
 */
export function resumen(tarea) {
  if (!tarea) return null;
  const { resultado, resultadoHtml, ...resto } = tarea;
  const pedido = String(tarea.pedido || '');
  return {
    ...resto,
    pedido: pedido.length > TOPE_PEDIDO_RESUMEN ? `${pedido.slice(0, TOPE_PEDIDO_RESUMEN)}…` : pedido,
    tieneResultado: Boolean(resultado)
  };
}

function avisar(tarea) {
  for (const fn of suscriptores) {
    try {
      fn(tarea);
    } catch (err) {
      console.error(`[tareas] Un suscriptor falló: ${err.message}`);
    }
  }
}

export function suscribir(fn) {
  suscriptores.add(fn);
  return () => suscriptores.delete(fn);
}

export function crear({ carril, origen, sujeto, pedido, motivo = 'mensaje', proyecto = null, workspaceId = null }) {
  const estado = cargar();
  const tarea = {
    id: `t_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    carril,
    origen,
    sujeto,
    pedido: recortar(pedido, carril === 'principal' ? TOPE_EXTRACTO_TRABAJO : TOPE_TEXTO),
    motivo,
    proyecto: proyecto ? String(proyecto) : null,
    // Id del proyecto (nunca la ruta): lo necesita reintentar un cast.
    workspaceId: workspaceId ? String(workspaceId) : null,
    estado: 'en_cola',
    creada: new Date().toISOString(),
    iniciada: null,
    terminada: null,
    resultado: null,
    resultadoHtml: null,
    error: null,
    memoria: null,
    actividad: []
  };
  estado.tareas.push(tarea);
  guardar();
  avisar(tarea);
  return tarea;
}

export function actualizar(id, cambios = {}) {
  const tarea = cargar().tareas.find((t) => t.id === id);
  if (!tarea) return null;
  for (const [campo, valor] of Object.entries(cambios)) {
    if (!CAMPOS_ACTUALIZABLES.has(campo)) continue;
    if (campo === 'estado' && !ESTADOS.includes(valor)) continue;
    if (campo === 'resultado') {
      tarea.resultado = valor ? recortar(valor, TOPE_TEXTO) : null;
      tarea.resultadoHtml = tarea.resultado ? markdownToTelegramHtml(prepararMarkdown(tarea.resultado)) : null;
    } else if (campo === 'error') {
      tarea.error = valor ? recortar(valor, TOPE_TEXTO) : null;
    } else {
      tarea[campo] = valor;
    }
  }
  // Un cierre sin fecha la recibe acá: los llamadores no tienen que acordarse.
  if (!ESTADOS_ABIERTOS.includes(tarea.estado) && !tarea.terminada) tarea.terminada = new Date().toISOString();
  if (tarea.estado === 'en_curso' && !tarea.iniciada) tarea.iniciada = new Date().toISOString();
  guardar();
  avisar(tarea);
  return tarea;
}

/**
 * FEAT-054 — Una herramienta que el agente acaba de abrir. Se guarda en
 * memoria y se avisa, pero NO se escribe a disco: un cast emite decenas de
 * estas y cada escritura reescribe el archivo entero. Queda persistida en la
 * próxima escritura (a más tardar, al cerrar la tarea).
 */
export function agregarActividad(id, texto) {
  const tarea = cargar().tareas.find((t) => t.id === id);
  if (!tarea || !ESTADOS_ABIERTOS.includes(tarea.estado)) return null;
  const limpio = redactSecrets(String(texto ?? '')).replace(/\s+/g, ' ').trim();
  if (!limpio) return null;
  const recortado = limpio.length > TOPE_TEXTO_ACTIVIDAD ? `${limpio.slice(0, TOPE_TEXTO_ACTIVIDAD - 1)}…` : limpio;
  if (!Array.isArray(tarea.actividad)) tarea.actividad = [];
  tarea.actividad.push({ t: new Date().toISOString(), texto: recortado });
  if (tarea.actividad.length > TOPE_ACTIVIDAD) tarea.actividad.splice(0, tarea.actividad.length - TOPE_ACTIVIDAD);
  avisar(tarea);
  return tarea;
}

export function obtener(id) {
  return cargar().tareas.find((t) => t.id === id) || null;
}

/** De la más vieja a la más nueva. `sujeto` es la clave (`alma:alya`) o nada. */
export function listar({ sujeto = null } = {}) {
  const tareas = cargar().tareas;
  return sujeto ? tareas.filter((t) => claveSujeto(t.sujeto) === sujeto) : tareas.slice();
}

/**
 * La cola no sobrevive a un reinicio: lo que quedó abierto no va a terminar.
 * Se llama una vez al arrancar el daemon.
 */
export function recuperarAlArrancar() {
  const estado = cargar();
  const ahora = new Date().toISOString();
  let n = 0;
  for (const t of estado.tareas) {
    if (!ESTADOS_ABIERTOS.includes(t.estado)) continue;
    t.estado = 'interrumpida';
    t.terminada = ahora;
    t.error = t.error || 'El daemon se reinició antes de que terminara.';
    n++;
  }
  if (n > 0) guardar();
  return n;
}

/** Solo para los tests: olvida la copia en memoria y los suscriptores. */
export function reiniciarParaTests() {
  cache = null;
  rutaCache = null;
  suscriptores.clear();
}
