/**
 * FEAT-060 — Programaciones: lo que el reloj dispara.
 *
 * Hasta acá nada empezaba solo. Todo camino vivo arrancaba en un gesto humano:
 * *Lanzar* una tarjeta, `/cast`, un mensaje, o un fan-out desde Claude Code. Una
 * programación es una tarjeta que se crea sola cada tanto.
 *
 * **Qué puede hacer, y por qué eso es todo.** Una programación dispara
 * exactamente lo mismo que una tarjeta del tablero: una charla con un alma o un
 * cast a un agente de solo lectura. Nada más. El carril principal (`/run`,
 * `/plan`) no se puede programar, igual que no se puede lanzar desde la web
 * (D4 de FEAT-057). Tampoco hay trabajos «sin agente» que corran un script, que
 * es lo que hace Hermes: sería capacidad de ejecución nueva, sin humano en el
 * lazo, y la auditoría del RFC fue explícita en que esta iteración toca **un
 * solo eje de autonomía** —el reloj— y ninguno de escritura.
 *
 * Así, lo peor que puede hacer una programación descontrolada es gastar cuota y
 * llenar el tablero. Para eso están los topes.
 *
 * **El modelo se congela al crear.** No es una comodidad, es contención de
 * gasto: `/model` de agy es global y reescribe su `settings.json`, así que un
 * trabajo que corre a las 3 de la mañana podría despertarse usando un modelo
 * caro que alguien eligió para otra cosa (ya pasó una vez, sin nadie mirando).
 * La programación guarda su modelo y lo pasa explícito en cada disparo.
 *
 * Un solo escritor: el daemon. Mismo patrón que `tareas.js` — copia en memoria
 * y escritura atómica en cada cambio.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getStateFilePath } from './state.js';
import { redactSecrets } from './policy.js';
import { parsearHorario, proximaDesde, saltados, describirHorario } from './horarios.js';

const require = createRequire(import.meta.url);
const { leerJson, guardarJson } = require('../mcp-server/agents/almacen.js');

export const VERSION = 1;
export const TOPE_PROGRAMACIONES = 50;
/** Disparos por día y por programación. Tope de gasto, no de utilidad. */
export const TOPE_DISPAROS_DIA = 48;
/** Tope de gasto de todo el reloj junto, por día. */
export const TOPE_DISPAROS_DIA_GLOBAL = 200;
export const TOPE_TITULO = 120;
export const TOPE_PEDIDO = 16 * 1024;
/** Fallos seguidos tras los cuales se pausa sola y se avisa. */
export const TOPE_FALLOS = 5;
/** Lo que espera una cita única a la que un tope le negó el turno. */
export const MINIMO_ESPERA_MS = 5 * 60_000;

let cache = null;
let rutaCache = null;
const suscriptores = new Set();

const nuevoId = () => `p_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const fallo = (codigo, error) => ({ ok: false, codigo, error });
const diaDe = (iso) => String(iso || '').slice(0, 10);

/**
 * FEAT-066 — Cada cambio que quedó guardado, para que la consola lo vea en vivo.
 * `info.borrada`: la programación ya no está. Un suscriptor que falla no
 * frena a los demás ni al registro.
 */
function avisar(p, info = {}) {
  for (const fn of suscriptores) {
    try {
      fn(p, info);
    } catch (err) {
      console.error(`[cron] Un suscriptor falló: ${redactSecrets(err.message)}`);
    }
  }
}

export function suscribir(fn) {
  suscriptores.add(fn);
  return () => suscriptores.delete(fn);
}

export function rutaProgramaciones() {
  return path.join(path.dirname(getStateFilePath()), 'programaciones.json');
}

function cargar() {
  const ruta = rutaProgramaciones();
  if (cache && rutaCache === ruta) return cache;
  const { datos, ilegible } = leerJson(ruta);
  const version = Number(datos?.version) || 1;
  const soloLectura = version > VERSION;
  if (soloLectura) {
    console.error(`[cron] ${ruta} es de la versión ${version} y este daemon conoce hasta la ${VERSION}: se lee sin escribir.`);
  }
  const lista = datos && Array.isArray(datos.programaciones)
    ? datos.programaciones.filter((p) => p && typeof p.id === 'string')
    : [];
  cache = { lista, ilegible, soloLectura };
  rutaCache = ruta;
  return cache;
}

function guardar() {
  const estado = cargar();
  if (estado.soloLectura) return;
  try {
    guardarJson(rutaCache, { version: VERSION, programaciones: estado.lista }, { ilegible: estado.ilegible });
    estado.ilegible = false;
  } catch (err) {
    console.error(`[cron] No se pudo guardar ${rutaCache}: ${redactSecrets(err.message)}`);
  }
}

const texto = (valor, tope) => {
  if (typeof valor !== 'string') return null;
  const limpio = redactSecrets(valor.trim());
  return limpio && limpio.length <= tope ? limpio : null;
};

/**
 * Alta. `sujeto` y `proyecto` ya vienen validados por quien llama (bot.js sabe
 * si el alma existe y si el agente es casteable); acá se valida la forma, el
 * horario y los topes.
 */
export function crear({
  titulo, pedido, sujeto = null, proyecto = null, workspaceId = null,
  horario: horarioTexto, modelo = null, esfuerzo = null,
  silencioso = false, origen = 'web', ahora = () => new Date()
} = {}) {
  const estado = cargar();
  if (estado.soloLectura) return fallo(503, 'El archivo de programaciones es de una versión más nueva: no se modifica.');
  if (estado.lista.length >= TOPE_PROGRAMACIONES) return fallo(409, `Ya hay ${TOPE_PROGRAMACIONES} programaciones: borrá alguna.`);

  const t = texto(titulo, TOPE_TITULO);
  const p = texto(pedido, TOPE_PEDIDO);
  if (!p) return fallo(400, `El pedido tiene que tener entre 1 y ${TOPE_PEDIDO} caracteres.`);
  if (titulo !== undefined && titulo !== null && !t) return fallo(400, `El título tiene que ser texto de hasta ${TOPE_TITULO} caracteres.`);

  if (!sujeto || (sujeto.tipo !== 'alma' && sujeto.tipo !== 'agente')) {
    return fallo(400, 'Una programación se asigna a un alma o a un agente. El carril de trabajo no se programa.');
  }

  const r = parsearHorario(horarioTexto);
  if (!r.ok) return fallo(400, r.error);

  const ahoraD = ahora();
  const proxima = proximaDesde(r.horario, ahoraD, ahoraD);
  if (!proxima) return fallo(400, 'Ese horario no tiene un próximo disparo.');

  const programacion = {
    id: nuevoId(),
    titulo: t || p.slice(0, 80),
    pedido: p,
    sujeto: sujeto.tipo === 'alma'
      ? { tipo: 'alma', clave: sujeto.clave, voz: sujeto.voz || sujeto.clave }
      : { tipo: 'agente', nombre: sujeto.nombre },
    proyecto: sujeto.tipo === 'agente' && proyecto ? String(proyecto) : null,
    workspaceId: sujeto.tipo === 'agente' && workspaceId ? String(workspaceId) : null,
    // El modelo congelado. `null` significa «el que haya», y se avisa al crear.
    modelo: typeof modelo === 'string' && modelo ? modelo : null,
    esfuerzo: typeof esfuerzo === 'string' && esfuerzo ? esfuerzo : null,
    horario: r.horario,
    // Desde cuándo se cuentan los intervalos. No se mueve con cada disparo: si
    // se moviera, un daemon que arranca tarde correría el horario para siempre.
    base: ahoraD.toISOString(),
    proxima: proxima.toISOString(),
    ultima: null,
    activa: true,
    silencioso: silencioso === true,
    origen: origen === 'telegram' ? 'telegram' : 'web',
    creada: ahoraD.toISOString(),
    disparos: 0,
    perdidos: 0,
    fallosSeguidos: 0,
    // Contador diario, para el tope de gasto.
    dia: null,
    disparosHoy: 0
  };

  estado.lista.push(programacion);
  guardar();
  avisar({ ...programacion });
  return { ok: true, programacion };
}

export function listar() {
  return cargar().lista.map((p) => ({ ...p }));
}

export function obtener(id) {
  const p = cargar().lista.find((x) => x.id === id);
  return p ? { ...p } : null;
}

export function borrar(id) {
  const estado = cargar();
  if (estado.soloLectura) return fallo(503, 'No se modifica.');
  const i = estado.lista.findIndex((p) => p.id === id);
  if (i < 0) return fallo(404, 'No existe esa programación.');
  const [fuera] = estado.lista.splice(i, 1);
  guardar();
  avisar({ id: fuera.id }, { borrada: true });
  return { ok: true, programacion: fuera };
}

/** Pausar o reanudar. Al reanudar se recalcula el próximo disparo desde ahora. */
export function activar(id, activa, { ahora = () => new Date() } = {}) {
  const estado = cargar();
  if (estado.soloLectura) return fallo(503, 'No se modifica.');
  const p = estado.lista.find((x) => x.id === id);
  if (!p) return fallo(404, 'No existe esa programación.');
  // BE-031 — La próxima se calcula ANTES de tocar nada: antes se marcaba activa
  // y después se fallaba sin guardar, y la copia en memoria quedaba activa
  // (sin próxima) hasta el siguiente reinicio.
  let proxima = null;
  if (activa !== false) {
    proxima = proximaDesde(p.horario, ahora(), new Date(p.base));
    if (!proxima) return fallo(400, 'Esa programación ya no tiene un próximo disparo.');
  }
  p.activa = activa !== false;
  p.fallosSeguidos = 0;
  if (proxima) p.proxima = proxima.toISOString();
  guardar();
  avisar({ ...p });
  return { ok: true, programacion: { ...p } };
}

/**
 * Las que ya tendrían que haber disparado. No las marca: el llamador decide si
 * puede con ellas (la cola puede estar ocupada) y después llama a `marcarDisparo`.
 */
export function vencidas(ahora = new Date()) {
  return cargar().lista.filter((p) => p.activa && p.proxima && new Date(p.proxima) <= ahora).map((p) => ({ ...p }));
}

/**
 * ¿Puede disparar, o algún tope lo frena? Se pregunta justo antes de disparar,
 * no al vencer: entre una cosa y la otra puede haberse llenado el cupo.
 */
export function puedeDisparar(id, ahora = new Date()) {
  const estado = cargar();
  const p = estado.lista.find((x) => x.id === id);
  if (!p) return { ok: false, motivo: 'no existe' };
  if (!p.activa) return { ok: false, motivo: 'pausada' };

  const hoy = diaDe(ahora.toISOString());
  if (p.dia === hoy && p.disparosHoy >= TOPE_DISPAROS_DIA) {
    return { ok: false, motivo: `llegó a ${TOPE_DISPAROS_DIA} disparos hoy` };
  }
  const globalHoy = estado.lista.reduce((n, x) => n + (x.dia === hoy ? x.disparosHoy : 0), 0);
  if (globalHoy >= TOPE_DISPAROS_DIA_GLOBAL) {
    return { ok: false, motivo: `el reloj llegó a ${TOPE_DISPAROS_DIA_GLOBAL} disparos hoy entre todas` };
  }
  return { ok: true };
}

/**
 * Registra que SALIÓ un disparo y calcula el próximo.
 *
 * Solo sabe que se despachó, no cómo terminó: el despacho encola y vuelve en
 * milisegundos, mucho antes de que `agy` arranque siquiera. Cómo terminó lo
 * dice `marcarResultado`, cuando la tarea se cierra de verdad.
 *
 * Los disparos que se perdieron mientras el daemon estaba apagado **se cuentan
 * y no se recuperan**: al prender la máquina después de ocho horas, un trabajo
 * cada dos horas corre una vez, no cuatro.
 *
 * Una programación de una sola vez se desactiva al disparar; no se borra, para
 * que el usuario vea que pasó.
 */
export function marcarDisparo(id, { ahora = () => new Date(), detalle = null } = {}) {
  const estado = cargar();
  if (estado.soloLectura) return null;
  const p = estado.lista.find((x) => x.id === id);
  if (!p) return null;

  const ahoraD = ahora();
  const prevista = p.proxima ? new Date(p.proxima) : ahoraD;
  const hoy = diaDe(ahoraD.toISOString());

  p.perdidos += saltados(p.horario, prevista, ahoraD);
  p.ultima = ahoraD.toISOString();
  p.disparos += 1;
  if (p.dia !== hoy) { p.dia = hoy; p.disparosHoy = 0; }
  p.disparosHoy += 1;
  p.ultimoDetalle = detalle ? String(detalle).slice(0, 300) : null;

  if (p.horario.tipo === 'una_vez') {
    p.activa = false;
    p.proxima = null;
  } else if (p.activa) {
    const proxima = proximaDesde(p.horario, ahoraD, new Date(p.base));
    p.proxima = proxima ? proxima.toISOString() : null;
    if (!p.proxima) p.activa = false;
  }

  guardar();
  avisar({ ...p });
  return { ...p };
}

/**
 * Cómo terminó el trabajo que se disparó. Llega cuando la cola cierra la tarea,
 * no cuando se encoló: es el único momento en que se sabe si `agy` corrió, si
 * el modelo contestó o si reventó.
 *
 * Es lo que hace real la autopausa: sin esto, una programación rota reintenta
 * para siempre, de madrugada, gastando cuota, porque despachar siempre sale
 * bien.
 */
export function marcarResultado(id, { ok = true, detalle = null } = {}) {
  const estado = cargar();
  if (estado.soloLectura) return null;
  const p = estado.lista.find((x) => x.id === id);
  if (!p) return null;

  if (ok) {
    p.fallosSeguidos = 0;
  } else {
    p.fallosSeguidos += 1;
    p.ultimoDetalle = detalle ? String(detalle).slice(0, 300) : p.ultimoDetalle;
    if (p.fallosSeguidos >= TOPE_FALLOS) {
      p.activa = false;
      p.proxima = null;
      p.ultimoDetalle = `Pausada tras ${TOPE_FALLOS} fallos seguidos. El último: ${detalle || 'sin detalle'}`;
    }
  }
  guardar();
  avisar({ ...p });
  return { ...p };
}

/**
 * La corrida de este minuto no va (un tope, o no hay a quién avisarle), pero la
 * programación sigue viva.
 *
 * NO es un disparo: no cuenta, no gasta cupo y —sobre todo— no mata una
 * programación de una sola vez, que si no se destruía sin haber corrido jamás.
 * Solo corre la próxima para no quedar reintentando el mismo minuto.
 */
export function posponer(id, { ahora = () => new Date(), motivo = null } = {}) {
  const estado = cargar();
  if (estado.soloLectura) return null;
  const p = estado.lista.find((x) => x.id === id);
  if (!p) return null;

  const ahoraD = ahora();
  p.ultimoDetalle = motivo ? `saltada: ${String(motivo).slice(0, 200)}` : p.ultimoDetalle;

  if (p.horario.tipo === 'una_vez') {
    // Una cita única no se pierde por un tope: espera al próximo paso del
    // reloj, cuando el cupo se haya liberado.
    p.proxima = new Date(ahoraD.getTime() + MINIMO_ESPERA_MS).toISOString();
  } else {
    const proxima = proximaDesde(p.horario, ahoraD, new Date(p.base));
    p.proxima = proxima ? proxima.toISOString() : null;
    if (!p.proxima) p.activa = false;
  }
  guardar();
  avisar({ ...p });
  return { ...p };
}

/** Una línea por programación, para `/cron` y para la consola. */
export function describir(p) {
  const cuando = p.activa && p.proxima
    ? `próxima ${new Date(p.proxima).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' })}`
    : (p.activa ? 'sin próxima' : 'pausada');
  const quien = p.sujeto?.tipo === 'alma' ? p.sujeto.clave : p.sujeto?.nombre;
  return `${p.titulo} — ${describirHorario(p.horario)}, ${quien}, ${cuando}`;
}

export function reiniciarParaTests() {
  cache = null;
  rutaCache = null;
  suscriptores.clear();
}
