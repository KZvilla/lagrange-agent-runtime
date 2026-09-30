/**
 * SEC-018 — Marco de sondas de aislamiento, común a todo motor.
 *
 * Un perfil "sondeado" (hoy, `sin-tools` de agy) solo se usa si hay un
 * resultado **vigente**: el último juego de sondas pasó con la misma huella que
 * la instalación actual (versión del CLI, versión de Lagrange y, en agy, el
 * roster MCP). Sin eso, fail-closed: el `preflight` rechaza y dispara las
 * sondas en segundo plano. Las sondas nunca corren dentro de un turno.
 *
 * Lo propio de cada motor (qué sondas, cómo se calcula su huella) vive en su
 * módulo (`sondas-antigravity.js`); acá está lo que no depende del CLI: el
 * archivo de resultados, la comparación de huellas, el testigo entre procesos y
 * la regla de reintento de una sonda inconclusa.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { leerJson, guardarJson } = require('../agents/almacen.js');
const { conLock } = require('../almas/archivos.js');

/** `no-aplica` cuenta como aprobada (p. ej. A3 sin servidores MCP: la vía no existe). */
const APROBADOS = new Set(['pasa', 'no-aplica']);
/** Techo de un juego completo; un testigo más viejo quedó abandonado. */
const TESTIGO_VENCE_MS = 10 * 60 * 1000;
/** BE-071 — versiones de Lagrange que se recuerdan por motor en el auxiliar. */
const VERSIONES_POR_MOTOR = 3;
/** BE-071 — cuánto se conserva una falla de una versión que ya salió del tope (después, la versión no se reinstala). */
const VIDA_FALLA_MS = 90 * 24 * 60 * 60 * 1000;
/** BE-071 — margen para relojes que no coinciden: una fecha más adelantada que esto no es una verificación. */
const FUTURO_TOLERADO_MS = 5 * 60 * 1000;
/** BE-071 — espera y vencimiento del lock del archivo de siempre (los mismos que `almas/archivos.js`). */
const LOCK_ESPERA_MS = 2000;
const LOCK_OBSOLETO_MS = 5000;

function rutaResultados(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'antigravity-sondas-motor.json');
}

/**
 * BE-071 — Resultados por versión de Lagrange: un archivo por motor, versión y perfil
 * (`<carpeta>/<motor>/<versionLagrange>/<perfil>.json`, la misma entrada que el archivo de siempre).
 * Lo escriben solo las versiones que conocen BE-071; una anterior reescribe el archivo de
 * arriba entero y no lo toca. Un archivo por entrada evita que la escritura de un motor o
 * perfil se lleve por delante, con una copia vieja, la de otro (una falla, sobre todo).
 */
function rutaResultadosPorVersion(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'antigravity-sondas-motor.versiones');
}

/**
 * Un segmento de ruta seguro: codificado y sin `.` ni `..`. Uno largo se corta y lleva el hash del
 * valor completo, para que dos claves distintas nunca compartan carpeta o archivo.
 */
function seg(texto) {
  const completo = encodeURIComponent(String(texto));
  if (completo.length > 100) {
    return `${completo.slice(0, 80)}-${crypto.createHash('sha256').update(String(texto)).digest('hex').slice(0, 16)}`;
  }
  return /^\.*$/.test(completo) ? completo.replace(/\./g, '%2E') || '%00' : completo;
}

function rutaEntradaPorVersion(motor, versionLagrange, perfil, homeDir = os.homedir()) {
  return path.join(rutaResultadosPorVersion(homeDir), seg(motor), seg(versionLagrange), `${seg(perfil)}.json`);
}

function rutaTestigo(motor, homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', `antigravity-sondas-motor.${motor}.corriendo`);
}

function leerResultados(homeDir = os.homedir()) {
  const { datos } = leerJson(rutaResultados(homeDir));
  return datos && typeof datos === 'object' ? datos : {};
}

function versionDe(entrada) {
  const v = entrada && entrada.huella && entrada.huella.versionLagrange;
  return typeof v === 'string' && v ? v : null;
}

/** Una entrada del auxiliar solo cuenta si tiene la forma que escribe `correrJuego` (con una fecha que se entienda). */
function entradaValida(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (!e.huella || typeof e.huella !== 'object' || Array.isArray(e.huella)) return false;
  return typeof e.resultado === 'string' && typeof e.fecha === 'string' && Number.isFinite(Date.parse(e.fecha));
}

/**
 * ¿La fecha está más adelantada que el margen para relojes desfasados? Un reloj adelantado o un archivo
 * editado no pueden dejar un pase "más nuevo que todo" que tape una falla real, ni valer como verificación.
 * Una FALLA con fecha futura sigue valiendo (falla cerrada); lo que se ignora es su lugar en el orden.
 */
function fechaFutura(e, ahora = Date.now()) {
  const t = Date.parse(e && e.fecha);
  return Number.isFinite(t) && t > ahora + FUTURO_TOLERADO_MS;
}

/** Cuándo empezó la corrida que produjo la entrada (la más temprana de `inicio` y `fecha`); `NaN` si no se sabe. */
function ordenDe(e) {
  const fin = Date.parse(e.fecha);
  const ini = typeof e.inicio === 'string' ? Date.parse(e.inicio) : NaN;
  return Number.isFinite(ini) ? Math.min(ini, fin) : fin;
}

/** Entrada de `versionLagrange` en el auxiliar, o `null`. Un archivo ausente, ilegible o de otra forma cuenta como ausente. */
function leerPorVersion(motor, versionLagrange, perfil, homeDir = os.homedir()) {
  const { datos } = leerJson(rutaEntradaPorVersion(motor, versionLagrange, perfil, homeDir));
  return entradaValida(datos) ? datos : null;
}

/** Antigüedad de una versión del auxiliar: la `fecha` más reciente de sus perfiles; sin ninguna, la de la carpeta. */
function frescuraDe(dirVersion) {
  let max = 0;
  try {
    for (const n of fs.readdirSync(dirVersion)) {
      const { datos } = leerJson(path.join(dirVersion, n));
      // Una fecha futura no es fiable: no vuelve "más fresca" a una versión.
      const t = entradaValida(datos) && !fechaFutura(datos) ? Date.parse(datos.fecha) : 0;
      if (t > max) max = t;
    }
    if (!max) max = fs.statSync(dirVersion).mtimeMs;
  } catch {}
  return max;
}

/**
 * Tope por motor: se conservan las más recientes por fecha (no por semver) y la recién escrita nunca
 * se descarta. De las versiones que sobran se borran los pases y las fallas de más de VIDA_FALLA_MS,
 * no una falla reciente: la poda corre sin coordinarse con quien esté escribiendo, y perder un pase es
 * un re-sondeo, perder una falla no.
 */
function podarVersiones(motor, versionLagrange, homeDir) {
  const dirMotor = path.join(rutaResultadosPorVersion(homeDir), seg(motor));
  let versiones = [];
  try { versiones = fs.readdirSync(dirMotor); } catch { return; }
  const otras = versiones
    .filter((v) => v !== seg(versionLagrange))
    .map((v) => ({ v, t: frescuraDe(path.join(dirMotor, v)) }))
    .sort((x, y) => y.t - x.t);
  for (const { v } of otras.slice(Math.max(0, VERSIONES_POR_MOTOR - 1))) {
    const dir = path.join(dirMotor, v);
    try {
      for (const n of fs.readdirSync(dir)) {
        const { datos } = leerJson(path.join(dir, n));
        // Una falla reciente se conserva; una de hace más de VIDA_FALLA_MS ya no protege nada y acota la carpeta.
        if (entradaValida(datos) && datos.resultado !== 'pasa' && Date.now() - Date.parse(datos.fecha) < VIDA_FALLA_MS) continue;
        try { fs.unlinkSync(path.join(dir, n)); } catch {}
      }
      fs.rmdirSync(dir);
    } catch {}
  }
}

/**
 * Escribe la entrada de su versión. `false` si es un `pasa` de una corrida que empezó antes que la que
 * escribió la entrada actual: el testigo vence a los 10 minutos y una corrida larga puede terminar
 * después de otra posterior, con un pase que ya no vale. Solo se descarta un `pasa`: una falla siempre
 * se escribe (perderla dejaría vigente un pase), y una entrada con fecha futura no cuenta para el orden
 * (su reloj no es fiable): un pase nuevo la reemplaza.
 */
function guardarPorVersion(motor, perfil, entrada, versionLagrange, homeDir) {
  const ruta = rutaEntradaPorVersion(motor, versionLagrange, perfil, homeDir);
  const { datos, ilegible } = leerJson(ruta);
  if (entrada.resultado === 'pasa' && entradaValida(datos) && !fechaFutura(datos) && ordenDe(datos) > ordenDe(entrada)) return false;
  guardarJson(ruta, entrada, { ilegible });
  podarVersiones(motor, versionLagrange, homeDir);
  return true;
}

function escribirPrincipal(motor, perfil, entrada, homeDir) {
  const ruta = rutaResultados(homeDir);
  const { datos, ilegible } = leerJson(ruta);
  const todo = datos && typeof datos === 'object' ? datos : {};
  todo[motor] = { ...(todo[motor] || {}), [perfil]: entrada };
  guardarJson(ruta, todo, { ilegible });
}

/**
 * Guarda el resultado de un perfil. `true` si quedó guardado, `false` si se descartó.
 *
 * BE-071 — El resultado de una versión va primero a su propio archivo (auxiliar) y después al
 * archivo de siempre, que leen las versiones anteriores. Con ese orden, un corte entre las dos
 * escrituras deja el resultado nuevo en el auxiliar, que `vigencia` consulta. Cada entrada del
 * auxiliar es un archivo propio: ninguna escritura de otro motor o perfil puede llevarse por
 * delante una falla ahí. Dos corridas de la misma entrada (el testigo vence a los 10 minutos) se
 * ordenan por cuándo empezaron: un `pasa` de una corrida que terminó tarde no reemplaza al de una
 * posterior. Una falla siempre se escribe. Queda una ventana de milisegundos entre leer y escribir.
 *
 * El archivo de siempre se reescribe entero, con un lock de mejor esfuerzo (la recuperación de un
 * lock huérfano no es exclusiva y una versión anterior no lo toma). Sin lock, un `pasa` no se
 * escribe ahí: para las versiones anteriores es un re-sondeo, el lado seguro. Un resultado que
 * no es `pasa` se escribe igual: a ellas no puede quedarles vigente un pase anterior.
 */
function guardarResultado(motor, perfil, entrada, homeDir = os.homedir()) {
  const version = versionDe(entrada);
  let persistido = false;
  if (version) {
    try {
      // Un pase superado por una corrida posterior no escribe nada, ni el auxiliar ni el archivo de siempre.
      if (guardarPorVersion(motor, perfil, entrada, version, homeDir) === false) return false;
      persistido = true;
    } catch {}
  }
  let dentro = false;
  try {
    conLock(rutaResultados(homeDir), () => {
      dentro = true;
      escribirPrincipal(motor, perfil, entrada, homeDir);
    }, { esperaMs: LOCK_ESPERA_MS, obsoletoMs: LOCK_OBSOLETO_MS });
    return true;
  } catch (err) {
    // Un error de la escritura misma sube, como antes; lo que se traga es no haber conseguido el lock.
    if (dentro) throw err;
  }
  if (entrada && entrada.resultado === 'pasa') return persistido;
  escribirPrincipal(motor, perfil, entrada, homeDir);
  return true;
}

/** Misma huella, campo por campo. Una huella `null` (no se pudo calcular) nunca coincide. */
function mismaHuella(a, b) {
  if (!a || !b) return false;
  const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of claves) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}

function describirHuella(h) {
  return Object.entries(h || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`).join(', ');
}

/**
 * `{ ok, motivo, entrada }`. `huellaActual` es la de la instalación de ahora (o
 * `null` si no se pudo calcular, que invalida).
 */
function vigencia(motor, perfil, huellaActual, homeDir = os.homedir()) {
  let entrada = (leerResultados(homeDir)[motor] || {})[perfil] || null;
  // BE-071 — Con dos instalaciones en versiones distintas, el archivo de siempre guarda solo la
  // última escritura. Si la versión de esta instalación tiene un resultado propio en el auxiliar,
  // se usa (mismo semver = mismo código). La comparación completa de la huella sigue más abajo.
  // Si las dos entradas coinciden con la huella y discrepan, gana la que no es `pasa`: el auxiliar
  // se escribe antes (un corte deja la falla nueva solo ahí), una escritura concurrente del archivo
  // de siempre puede devolverle un pase viejo y, si el auxiliar no se pudo escribir, el de siempre
  // es el más nuevo. En todos los casos lo seguro es no dar por buena una verificación.
  const versionActual = huellaActual && typeof huellaActual.versionLagrange === 'string' ? huellaActual.versionLagrange : null;
  if (versionActual) {
    const propia = leerPorVersion(motor, versionActual, perfil, homeDir);
    if (propia) {
      if (!entrada) {
        entrada = propia;
      } else if (mismaHuella(propia.huella, huellaActual)) {
        if (!mismaHuella(entrada.huella, huellaActual) || entrada.resultado === 'pasa') entrada = propia;
      }
    }
  }
  if (!huellaActual) {
    return { ok: false, entrada, motivo: `no se pudo leer la instalación de ${motor} para comprobar su aislamiento` };
  }
  if (!entrada) {
    return { ok: false, entrada, motivo: `el aislamiento de ${motor} (${perfil}) todavía no se verificó en esta instalación` };
  }
  if (!mismaHuella(entrada.huella, huellaActual)) {
    return { ok: false, entrada, motivo: `cambió la instalación de ${motor} (${describirHuella(huellaActual)}): hay que volver a verificar su aislamiento` };
  }
  // BE-073 — Sin cuota no se midió nada: decir «falló» sugería un aislamiento roto.
  if (entrada.resultado === 'inconclusa') {
    return { ok: false, entrada, motivo: `no se pudo verificar el aislamiento de ${motor} (${perfil}): ${entrada.motivo || 'sin detalle'}. Se vuelve a verificar solo cuando haga falta` };
  }
  if (entrada.resultado !== 'pasa') {
    return { ok: false, entrada, motivo: `la última verificación del aislamiento de ${motor} (${perfil}) falló: ${entrada.motivo || 'sin detalle'}` };
  }
  // BE-071 — Un pase con fecha del futuro (reloj adelantado, archivo editado) no es una verificación: en el
  // archivo de siempre tampoco. Con la fecha ya corregida, o con una corrida nueva, vuelve a valer.
  if (fechaFutura(entrada)) {
    return { ok: false, entrada, motivo: `la verificación del aislamiento de ${motor} (${perfil}) tiene fecha del futuro (¿reloj adelantado?): hay que volver a verificarlo` };
  }
  return { ok: true, entrada, motivo: null };
}

/**
 * Toma el testigo con creación exclusiva (`wx`, el patrón de `archivos.js`):
 * un solo juego de sondas a la vez, también entre el MCP y el bot. `true` si es
 * nuestro. Uno más viejo que `TESTIGO_VENCE_MS` se considera abandonado.
 */
function tomarTestigo(motor, { homeDir = os.homedir(), ahora = Date.now() } = {}) {
  const ruta = rutaTestigo(motor, homeDir);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  for (let intento = 0; intento < 2; intento++) {
    try {
      const fd = fs.openSync(ruta, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, desde: new Date(ahora).toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      let viejo = false;
      try { viejo = ahora - fs.statSync(ruta).mtimeMs > TESTIGO_VENCE_MS; } catch { continue; }
      if (!viejo) return false;
      try { fs.unlinkSync(ruta); } catch {}
    }
  }
  return false;
}

/**
 * BE-071 — Solo borra el testigo si es de este proceso: uno que venció y tomó otro no se
 * le quita. Es de mejor esfuerzo (comparar y borrar son dos operaciones, y una versión
 * anterior sigue soltando sin comprobar). Un testigo ilegible se borra, como antes.
 */
function soltarTestigo(motor, homeDir = os.homedir()) {
  const ruta = rutaTestigo(motor, homeDir);
  try {
    const dueno = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (dueno && typeof dueno.pid === 'number' && dueno.pid !== process.pid) return;
  } catch {}
  try { fs.unlinkSync(ruta); } catch {}
}

/**
 * FEAT-075 — ¿Hay un juego de sondas de `motor` corriendo, en este proceso o en
 * otro? Lee el testigo sin tomarlo; uno abandonado (más viejo que
 * `TESTIGO_VENCE_MS`) no cuenta, igual que en `tomarTestigo`.
 */
function corriendo(motor, { homeDir = os.homedir(), ahora = Date.now() } = {}) {
  try {
    return ahora - fs.statSync(rutaTestigo(motor, homeDir)).mtimeMs <= TESTIGO_VENCE_MS;
  } catch {
    return false;
  }
}

/**
 * Corre las sondas de un perfil, en orden. Una `inconclusa` se reintenta una
 * vez; si vuelve a serlo cuenta como `falla` (fail-closed). Una sonda que lanza
 * es `falla` con el mensaje: nunca éxito por defecto.
 *
 * `sondas`: `[{ id, correr(ctx, previos) -> { resultado, evidencia, motivo } }]`.
 * Devuelve la entrada que se guarda: `{ huella, resultado, motivo, sondas, fecha }`.
 */
async function correrJuego({ sondas, huella, ctx = {}, ahora = () => new Date() }) {
  // BE-071 — `inicio` ordena las corridas de una misma entrada: `fecha` es el final, y una corrida
  // larga puede terminar después de otra que arrancó más tarde (el testigo vence a los 10 minutos).
  const inicio = ahora().toISOString();
  const detalle = {};
  let resultado = 'pasa';
  let motivo = null;
  // BE-073 — Una sonda que no pudo correr por cuota no midió nada: no es una
  // falla del aislamiento. Tampoco se reintenta, y las que siguen no se corren
  // (gastarían la cuota que no hay). El juego queda `inconclusa`: nunca `pasa`,
  // así que el bloqueo se mantiene, pero dice por qué.
  let sinCuota = null;
  for (const sonda of sondas) {
    let r = null;
    if (sinCuota) {
      detalle[sonda.id] = { resultado: 'inconclusa', causa: 'cuota', motivo: `no se corrió: ${sinCuota}` };
      continue;
    }
    for (let intento = 0; intento < 2; intento++) {
      try {
        r = await sonda.correr(ctx, detalle);
      } catch (err) {
        r = { resultado: 'falla', motivo: `la sonda no pudo correr: ${err.message}` };
      }
      if (!r || r.resultado !== 'inconclusa' || r.causa === 'cuota') break;
    }
    if (r && r.resultado === 'inconclusa' && r.causa === 'cuota') {
      sinCuota = r.motivo || 'sin cuota';
      detalle[sonda.id] = r;
      if (resultado === 'pasa') {
        resultado = 'inconclusa';
        motivo = `${sonda.id}: ${sinCuota}`;
      }
      continue;
    }
    if (!r || r.resultado === 'inconclusa') {
      r = { ...(r || {}), resultado: 'falla', motivo: `inconclusa dos veces: ${(r && r.motivo) || 'sin intento observable'}` };
    }
    detalle[sonda.id] = r;
    if (!APROBADOS.has(r.resultado) && resultado === 'pasa') {
      resultado = 'falla';
      motivo = `${sonda.id}: ${r.motivo || r.resultado}`;
    }
  }
  if (!huella) {
    resultado = 'falla';
    motivo = motivo || 'no se pudo leer la instalación';
  }
  return { huella, resultado, motivo, sondas: detalle, fecha: ahora().toISOString(), inicio };
}

module.exports = {
  APROBADOS,
  TESTIGO_VENCE_MS,
  VERSIONES_POR_MOTOR,
  rutaResultados,
  rutaResultadosPorVersion,
  rutaEntradaPorVersion,
  rutaTestigo,
  leerResultados,
  guardarResultado,
  mismaHuella,
  vigencia,
  tomarTestigo,
  soltarTestigo,
  corriendo,
  correrJuego
};
