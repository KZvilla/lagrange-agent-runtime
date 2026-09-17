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
 *
 * FEAT-057 — Formato 2: tarjetas en Por hacer, notas, eventos y `madre`. La
 * migración completa cada tarea campo por campo en cada carga y nunca pisa lo
 * que ya está: un daemon anterior que reescriba el archivo como versión 1
 * conserva los campos nuevos, y al volver no se pierde nada. `version` solo
 * sirve para detectar un archivo de una versión MAYOR, que se lee sin escribir.
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
// FEAT-057 — Una tarjeta que espera a que el usuario la lance. No es abierta:
// `recuperarAlArrancar` no la toca y `actualizar` no la mueve.
export const POR_HACER = 'por_hacer';
export const VERSION = 2;
export const TOPE_POR_HACER = 100;
export const TOPE_TITULO = 120;
export const TOPE_NOTA = 1000;
export const TOPE_NOTAS = 30;
export const TOPE_EVENTOS = 30;
export const TOPE_BUSQUEDA = 200;
export const ESTADOS_DEVOLVIBLES = Object.freeze(['error', 'cancelada', 'interrumpida']);

const CAMPOS_ACTUALIZABLES = new Set(['estado', 'iniciada', 'terminada', 'resultado', 'error', 'memoria', 'proyecto']);
const RECORTE = '\n\n… [recortado]';

let cache = null;
let rutaCache = null;
const suscriptores = new Set();

const cerrada = (t) => !ESTADOS_ABIERTOS.includes(t.estado) && t.estado !== POR_HACER;
const nuevoId = (prefijo) => `${prefijo}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const fallo = (codigo, error) => ({ ok: false, codigo, error });

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

/** Lo que se puede reconstruir de una tarea anterior a los eventos. */
function eventosReconstruidos(t) {
  const eventos = [];
  if (t.creada) eventos.push({ t: t.creada, tipo: 'creada' });
  if (t.iniciada) eventos.push({ t: t.iniciada, tipo: 'en_curso' });
  if (t.terminada && cerrada(t)) eventos.push({ t: t.terminada, tipo: t.estado });
  return eventos;
}

/** Completa lo que falta, campo por campo. Nunca pisa un valor que ya está. */
function migrar(t) {
  t.titulo ??= null;
  t.creadaPor ??= 'cola';
  t.madre ??= null;
  // FEAT-058 — Una tarjeta que propuso un alma y el usuario todavía no aceptó.
  t.propuesta ??= false;
  t.notas ??= [];
  t.eventos ??= eventosReconstruidos(t);
  t.actualizada ??= t.terminada || t.iniciada || t.creada || null;
  return t;
}

function cargar() {
  const ruta = rutaTareas();
  if (cache && rutaCache === ruta) return cache;
  const { datos, ilegible } = leerJson(ruta);
  const tareas = datos && Array.isArray(datos.tareas)
    ? datos.tareas.filter((t) => t && typeof t.id === 'string').map(migrar)
    : [];
  const version = Number(datos?.version) || 1;
  const soloLectura = version > VERSION;
  if (soloLectura) {
    console.error(`[tareas] ${ruta} es de la versión ${version} y este daemon conoce hasta la ${VERSION}: se lee sin escribir.`);
  }
  cache = { tareas, ilegible, soloLectura };
  rutaCache = ruta;
  return cache;
}

function guardar() {
  const estado = cargar();
  // Un archivo de una versión futura no se pisa: los cambios quedan en memoria.
  if (estado.soloLectura) return;
  const cerradas = estado.tareas.filter(cerrada).length;
  if (cerradas > TOPE_TAREAS) {
    // Se descartan las cerradas más viejas. Nunca una abierta (su cierre
    // llegaría a un id que ya no existe) ni una de Por hacer (tiene su tope).
    let sobran = cerradas - TOPE_TAREAS;
    estado.tareas = estado.tareas.filter((t) => {
      if (sobran > 0 && cerrada(t)) { sobran--; return false; }
      return true;
    });
  }
  try {
    guardarJson(rutaCache, { version: VERSION, tareas: estado.tareas }, { ilegible: estado.ilegible });
    estado.ilegible = false;
  } catch (err) {
    // El registro es una vista: si el disco falla, la cola sigue igual.
    console.error(`[tareas] No se pudo guardar ${rutaCache}: ${redactSecrets(err.message)}`);
  }
}

/** Los eventos los escribe el módulo, nunca el llamador. */
function agregarEvento(tarea, tipo, detalle = null) {
  const ahora = new Date().toISOString();
  tarea.eventos.push(detalle ? { t: ahora, tipo, detalle } : { t: ahora, tipo });
  if (tarea.eventos.length > TOPE_EVENTOS) tarea.eventos.splice(0, tarea.eventos.length - TOPE_EVENTOS);
  tarea.actualizada = ahora;
}

/**
 * La tarea sin los textos largos: lo que viaja por SSE y lo que usa el
 * tablero. La actividad sí va (está acotada).
 */
export function resumen(tarea) {
  if (!tarea) return null;
  const { resultado, resultadoHtml, notas, eventos, ...resto } = tarea;
  const pedido = String(tarea.pedido || '');
  return {
    ...resto,
    pedido: pedido.length > TOPE_PEDIDO_RESUMEN ? `${pedido.slice(0, TOPE_PEDIDO_RESUMEN)}…` : pedido,
    tieneResultado: Boolean(resultado),
    // FEAT-057 — El tablero no carga las notas ni el historial.
    cantidadNotas: Array.isArray(notas) ? notas.length : 0,
    ultimoEvento: Array.isArray(eventos) ? eventos.at(-1) || null : null
  };
}

/** `info.borrada`: la tarjeta ya no está (FEAT-057). */
function avisar(tarea, info = {}) {
  for (const fn of suscriptores) {
    try {
      fn(tarea, info);
    } catch (err) {
      console.error(`[tareas] Un suscriptor falló: ${err.message}`);
    }
  }
}

export function suscribir(fn) {
  suscriptores.add(fn);
  return () => suscriptores.delete(fn);
}

export function crear({ carril, origen, sujeto, pedido, motivo = 'mensaje', proyecto = null, workspaceId = null, madre = null }) {
  const estado = cargar();
  const ahora = new Date().toISOString();
  const tarea = {
    id: nuevoId('t'),
    titulo: null,
    carril,
    origen,
    sujeto,
    pedido: recortar(pedido, carril === 'principal' ? TOPE_EXTRACTO_TRABAJO : TOPE_TEXTO),
    motivo,
    proyecto: proyecto ? String(proyecto) : null,
    // Id del proyecto (nunca la ruta): lo necesita reintentar un cast.
    workspaceId: workspaceId ? String(workspaceId) : null,
    estado: 'en_cola',
    creadaPor: 'cola',
    propuesta: false,
    // FEAT-059 — La tarjeta que parte una orquestación.
    madre: madre ? String(madre) : null,
    creada: ahora,
    actualizada: ahora,
    iniciada: null,
    terminada: null,
    resultado: null,
    resultadoHtml: null,
    error: null,
    memoria: null,
    actividad: [],
    notas: [],
    eventos: [{ t: ahora, tipo: 'creada' }]
  };
  estado.tareas.push(tarea);
  guardar();
  avisar(tarea);
  return tarea;
}

export function actualizar(id, cambios = {}) {
  const tarea = cargar().tareas.find((t) => t.id === id);
  // Una tarjeta sale de Por hacer solo con `lanzarTarjeta`.
  if (!tarea || tarea.estado === POR_HACER) return null;
  const estadoPrevio = tarea.estado;
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
  if (tarea.estado !== estadoPrevio) agregarEvento(tarea, tarea.estado);
  else tarea.actualizada = new Date().toISOString();
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

// ---------------------------------------------------------------- FEAT-057

const sinTildes = (texto) => String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Tareas cuyo título, pedido completo o notas contienen `q`, sin tildes ni
 * mayúsculas. El largo de la consulta lo valida quien llama.
 */
export function buscar(q) {
  const aguja = sinTildes(String(q ?? '').trim());
  const tareas = cargar().tareas;
  if (!aguja) return tareas.slice();
  return tareas.filter((t) => [t.titulo, t.pedido, ...(t.notas || []).map((n) => n.texto)]
    .some((x) => x && sinTildes(x).includes(aguja)));
}

// `{ valor }` (redactado) o `{ error }`.
function textoLimpio(valor, tope, { opcional = false } = {}) {
  if (valor === undefined || valor === null) return opcional ? { valor: null } : { error: 'vacio' };
  if (typeof valor !== 'string') return { error: 'tipo' };
  const limpio = valor.trim();
  if (!limpio) return opcional ? { valor: null } : { error: 'vacio' };
  if (limpio.length > tope) return { error: 'largo' };
  return { valor: redactSecrets(limpio) };
}

const campoTitulo = (valor) => {
  const r = textoLimpio(valor, TOPE_TITULO, { opcional: true });
  return r.error ? { error: `El título tiene que ser texto de hasta ${TOPE_TITULO} caracteres.` } : r;
};
const campoPedido = (valor) => {
  const r = textoLimpio(valor, TOPE_TEXTO);
  return r.error ? { error: `El pedido tiene que tener entre 1 y ${TOPE_TEXTO} caracteres.` } : r;
};

// Solo la forma: si el alma existe o el agente es castable lo decide bot.js.
function campoSujeto(sujeto) {
  if (sujeto === null || sujeto === undefined) return { valor: null };
  if (sujeto.tipo === 'alma' && typeof sujeto.clave === 'string' && sujeto.clave) {
    return { valor: { tipo: 'alma', clave: sujeto.clave, voz: typeof sujeto.voz === 'string' ? sujeto.voz : sujeto.clave } };
  }
  if (sujeto.tipo === 'agente' && typeof sujeto.nombre === 'string' && sujeto.nombre) {
    return { valor: { tipo: 'agente', nombre: sujeto.nombre } };
  }
  return { error: 'Una tarjeta se asigna a un alma o a un agente.' };
}

const soloLectura = () => fallo(503, 'El registro es de una versión más nueva del bridge: no se modifica.');
const cantidadPorHacer = () => cargar().tareas.filter((t) => t.estado === POR_HACER).length;
const porHacerLleno = () => fallo(409, `Por hacer ya tiene ${TOPE_POR_HACER} tarjetas: lanzá o borrá alguna.`);

function tarjetaNueva({ titulo, pedido, sujeto, proyecto, workspaceId, madre = null, creadaPor = 'usuario', propuesta = false, motivo = 'mensaje' }) {
  const ahora = new Date().toISOString();
  // Un alma no trabaja sobre un proyecto.
  const esAgente = sujeto?.tipo === 'agente';
  return {
    id: nuevoId('t'),
    titulo,
    carril: null,
    origen: 'web',
    sujeto,
    pedido,
    motivo,
    proyecto: esAgente && proyecto ? String(proyecto) : null,
    workspaceId: esAgente && workspaceId ? String(workspaceId) : null,
    estado: POR_HACER,
    creadaPor,
    propuesta,
    madre,
    creada: ahora,
    actualizada: ahora,
    iniciada: null,
    terminada: null,
    resultado: null,
    resultadoHtml: null,
    error: null,
    memoria: null,
    actividad: [],
    notas: [],
    eventos: [{ t: ahora, tipo: 'creada' }]
  };
}

// La tarjeta, si existe y sigue en Por hacer; si no, `{ error }`.
function tarjetaEditable(id) {
  const tarea = obtener(id);
  if (!tarea) return { error: fallo(404, 'No existe esa tarea.') };
  if (tarea.estado !== POR_HACER) return { error: fallo(409, 'La tarjeta ya no está en Por hacer.') };
  return { tarea };
}

/**
 * Una tarjeta nueva en Por hacer. El proyecto llega ya resuelto por id.
 * Devuelve `{ ok, tarea }` o `{ ok: false, codigo, error }`.
 */
export function crearTarjeta({ titulo, pedido, sujeto = null, proyecto = null, workspaceId = null } = {}) {
  const estado = cargar();
  if (estado.soloLectura) return soloLectura();
  const t = campoTitulo(titulo);
  const p = campoPedido(pedido);
  const s = campoSujeto(sujeto);
  const malo = t.error || p.error || s.error;
  if (malo) return fallo(400, malo);
  if (cantidadPorHacer() >= TOPE_POR_HACER) return porHacerLleno();
  const tarea = tarjetaNueva({ titulo: t.valor, pedido: p.valor, sujeto: s.valor, proyecto, workspaceId });
  estado.tareas.push(tarea);
  guardar();
  avisar(tarea);
  return { ok: true, tarea };
}

/** Solo en Por hacer: `titulo`, `pedido`, `sujeto`, `proyecto` y `workspaceId`. */
export function editarTarjeta(id, cambios = {}) {
  if (cargar().soloLectura) return soloLectura();
  const { tarea, error } = tarjetaEditable(id);
  if (error) return error;
  const t = 'titulo' in cambios ? campoTitulo(cambios.titulo) : { valor: tarea.titulo };
  const p = 'pedido' in cambios ? campoPedido(cambios.pedido) : { valor: tarea.pedido };
  const s = 'sujeto' in cambios ? campoSujeto(cambios.sujeto) : { valor: tarea.sujeto };
  const malo = t.error || p.error || s.error;
  if (malo) return fallo(400, malo);
  const esAgente = s.valor?.tipo === 'agente';
  const proyecto = 'proyecto' in cambios ? cambios.proyecto : tarea.proyecto;
  const workspaceId = 'workspaceId' in cambios ? cambios.workspaceId : tarea.workspaceId;
  Object.assign(tarea, {
    titulo: t.valor,
    pedido: p.valor,
    sujeto: s.valor,
    proyecto: esAgente && proyecto ? String(proyecto) : null,
    workspaceId: esAgente && workspaceId ? String(workspaceId) : null
  });
  agregarEvento(tarea, 'editada');
  guardar();
  avisar(tarea);
  return { ok: true, tarea };
}

/** Solo en Por hacer. La confirmación en dos pasos es de la interfaz. */
export function borrarTarjeta(id) {
  const estado = cargar();
  if (estado.soloLectura) return soloLectura();
  const { tarea, error } = tarjetaEditable(id);
  if (error) return error;
  estado.tareas = estado.tareas.filter((t) => t !== tarea);
  guardar();
  avisar(tarea, { borrada: true });
  return { ok: true };
}

/**
 * Por hacer → en cola, con el carril y el sujeto con los que se encola.
 * Devuelve la tarea, o `null` si ya no estaba en Por hacer (un segundo clic)
 * o si el sujeto no es el de la tarjeta. Con `null`, quien llama no encola.
 */
export function lanzarTarjeta(id, { carril, sujeto, proyecto = null, workspaceId = null } = {}) {
  const estado = cargar();
  if (estado.soloLectura) return null;
  const tarea = obtener(id);
  if (!tarea || tarea.estado !== POR_HACER) return null;
  if (!carril || carril === 'principal' || !tarea.sujeto || claveSujeto(tarea.sujeto) !== claveSujeto(sujeto)) return null;
  Object.assign(tarea, {
    carril,
    sujeto,
    proyecto: proyecto ? String(proyecto) : null,
    workspaceId: workspaceId ? String(workspaceId) : null,
    estado: 'en_cola'
  });
  // FEAT-058 — Lanzar una propuesta es aceptarla.
  if (tarea.propuesta) {
    tarea.propuesta = false;
    agregarEvento(tarea, 'aceptada');
  }
  agregarEvento(tarea, 'lanzada');
  guardar();
  avisar(tarea);
  return tarea;
}

// ---------------------------------------------------------------- FEAT-058

export const TOPE_PROPUESTAS_POR_ALMA = 5;
export const TOPE_PROPUESTAS_POR_AGENTE = 20;

/**
 * FEAT-059 — Se encoló el cast que parte esta tarjeta. Devuelve la tarjeta, o
 * `null` si no existe.
 */
export function registrarPartida(madre, tareaId) {
  const estado = cargar();
  const tarea = obtener(madre);
  if (!tarea || estado.soloLectura) return null;
  agregarEvento(tarea, 'partida', String(tareaId));
  guardar();
  avisar(tarea);
  return tarea;
}

/**
 * Una tarjeta que propone un alma: entra en Por hacer marcada como propuesta
 * y nunca corre sola. Los textos llegan ya validados por el bot
 * (`bloque-tablero.validarOperacion`); acá se vuelven a acotar igual.
 * `rechazo` es un motivo corto para el diario y el pie de la respuesta.
 */
export function proponerTarjeta({ clave = null, autor = null, madre = null, titulo, pedido, sujeto = null, proyecto = null, workspaceId = null } = {}) {
  const estado = cargar();
  if (estado.soloLectura) return { ...soloLectura(), rechazo: 'registro de solo lectura' };
  // FEAT-059 — Un agente orquestador también propone: `autor` es `agente:<nombre>`.
  const quien = autor || (typeof clave === 'string' && clave ? `alma:${clave}` : null);
  if (!/^(alma|agente):.+/.test(String(quien || ''))) return { ...fallo(400, 'Falta quién propone.'), rechazo: 'sin autor' };
  const t = campoTitulo(titulo);
  const p = campoPedido(pedido);
  const s = campoSujeto(sujeto);
  const malo = t.error || p.error || s.error;
  if (malo) return { ...fallo(400, malo), rechazo: 'formato' };
  let tarjetaMadre = null;
  if (madre) {
    tarjetaMadre = obtener(madre);
    // Una madre lanzada o borrada no recibe hijas (plan FEAT-059 §8).
    if (!tarjetaMadre || tarjetaMadre.estado !== POR_HACER) {
      return { ...fallo(409, 'La tarjeta madre ya no está en Por hacer.'), rechazo: 'la madre ya no está en Por hacer' };
    }
  }
  const tope = quien.startsWith('alma:') ? TOPE_PROPUESTAS_POR_ALMA : TOPE_PROPUESTAS_POR_AGENTE;
  const pendientes = estado.tareas.filter((x) => x.estado === POR_HACER && x.propuesta && x.creadaPor === quien).length;
  if (pendientes >= tope) {
    return { ...fallo(409, `Ya hay ${tope} propuestas pendientes de ${quien}.`), rechazo: 'tope de propuestas' };
  }
  if (cantidadPorHacer() >= TOPE_POR_HACER) return { ...porHacerLleno(), rechazo: 'Por hacer lleno' };
  const tarea = tarjetaNueva({
    titulo: t.valor, pedido: p.valor, sujeto: s.valor, proyecto, workspaceId,
    creadaPor: quien, propuesta: true,
    madre: tarjetaMadre ? tarjetaMadre.id : null,
    motivo: tarjetaMadre ? 'hija' : 'mensaje'
  });
  tarea.eventos = [{ t: tarea.creada, tipo: 'propuesta', detalle: quien }];
  estado.tareas.push(tarea);
  if (tarjetaMadre) agregarEvento(tarjetaMadre, 'hija', tarea.id);
  guardar();
  if (tarjetaMadre) avisar(tarjetaMadre);
  avisar(tarea);
  return { ok: true, tarea };
}

/** El usuario acepta una propuesta: pasa a ser una tarjeta común de Por hacer. */
export function aceptarPropuesta(id) {
  if (cargar().soloLectura) return soloLectura();
  const { tarea, error } = tarjetaEditable(id);
  if (error) return error;
  if (!tarea.propuesta) return fallo(409, 'La tarjeta no es una propuesta.');
  tarea.propuesta = false;
  agregarEvento(tarea, 'aceptada');
  guardar();
  avisar(tarea);
  return { ok: true, tarea };
}

/** Una nota, en cualquier estado. El autor es `usuario` o `alma:<clave>` (FEAT-058). */
export function agregarNota(id, texto, autor = 'usuario') {
  if (cargar().soloLectura) return soloLectura();
  const tarea = obtener(id);
  if (!tarea) return fallo(404, 'No existe esa tarea.');
  const n = textoLimpio(texto, TOPE_NOTA);
  if (n.error) return fallo(400, `La nota tiene que tener entre 1 y ${TOPE_NOTA} caracteres.`);
  const nota = { id: nuevoId('n'), t: new Date().toISOString(), autor: String(autor), texto: n.valor };
  tarea.notas.push(nota);
  if (tarea.notas.length > TOPE_NOTAS) tarea.notas.splice(0, tarea.notas.length - TOPE_NOTAS);
  agregarEvento(tarea, 'nota');
  guardar();
  avisar(tarea);
  return { ok: true, tarea, nota };
}

/**
 * "Volver a Por hacer": una tarjeta nueva con el pedido, el sujeto y el
 * proyecto de la original. La original solo suma su evento.
 */
export function devolver(id) {
  const estado = cargar();
  if (estado.soloLectura) return soloLectura();
  const original = obtener(id);
  if (!original) return fallo(404, 'No existe esa tarea.');
  if (!ESTADOS_DEVOLVIBLES.includes(original.estado)) return fallo(409, 'Solo vuelve a Por hacer lo que falló, se canceló o quedó interrumpido.');
  if (original.carril === 'principal' || !['alma', 'agente'].includes(original.sujeto?.tipo)) return fallo(400, 'El trabajo no vuelve a Por hacer.');
  if (original.motivo === 'reaccion') return fallo(400, 'Una reacción no vuelve a Por hacer.');
  if (original.motivo === 'orquestar') return fallo(400, 'Una orquestación no vuelve a Por hacer: se vuelve a partir desde la tarjeta.');
  if (!original.pedido) return fallo(400, 'La tarea no tiene un pedido que repetir.');
  if (cantidadPorHacer() >= TOPE_POR_HACER) return porHacerLleno();
  const tarjeta = tarjetaNueva({
    titulo: original.titulo,
    pedido: original.pedido,
    sujeto: campoSujeto(original.sujeto).valor,
    proyecto: original.proyecto,
    workspaceId: original.workspaceId,
    // FEAT-059 — Una hija sigue siendo hija de su madre; el linaje con la
    // original queda en los eventos `devuelta`.
    madre: original.motivo === 'hija' ? original.madre : original.id,
    motivo: original.motivo === 'hija' ? 'hija' : 'mensaje'
  });
  tarjeta.eventos.push({ t: tarjeta.creada, tipo: 'devuelta', detalle: original.id });
  const actualizada = original.actualizada;
  agregarEvento(original, 'devuelta', tarjeta.id);
  original.actualizada = actualizada;
  estado.tareas.push(tarjeta);
  guardar();
  avisar(original);
  avisar(tarjeta);
  return { ok: true, tarea: tarjeta };
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
    agregarEvento(t, 'interrumpida');
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
