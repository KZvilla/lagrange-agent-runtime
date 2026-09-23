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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { leerJson, guardarJson } = require('../agents/almacen.js');

/** `no-aplica` cuenta como aprobada (p. ej. A3 sin servidores MCP: la vía no existe). */
const APROBADOS = new Set(['pasa', 'no-aplica']);
/** Techo de un juego completo; un testigo más viejo quedó abandonado. */
const TESTIGO_VENCE_MS = 10 * 60 * 1000;

function rutaResultados(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'antigravity-sondas-motor.json');
}

function rutaTestigo(motor, homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', `antigravity-sondas-motor.${motor}.corriendo`);
}

function leerResultados(homeDir = os.homedir()) {
  const { datos } = leerJson(rutaResultados(homeDir));
  return datos && typeof datos === 'object' ? datos : {};
}

function guardarResultado(motor, perfil, entrada, homeDir = os.homedir()) {
  const ruta = rutaResultados(homeDir);
  const { datos, ilegible } = leerJson(ruta);
  const todo = datos && typeof datos === 'object' ? datos : {};
  todo[motor] = { ...(todo[motor] || {}), [perfil]: entrada };
  guardarJson(ruta, todo, { ilegible });
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
  const entrada = (leerResultados(homeDir)[motor] || {})[perfil] || null;
  if (!huellaActual) {
    return { ok: false, entrada, motivo: `no se pudo leer la instalación de ${motor} para comprobar su aislamiento` };
  }
  if (!entrada) {
    return { ok: false, entrada, motivo: `el aislamiento de ${motor} (${perfil}) todavía no se verificó en esta instalación` };
  }
  if (!mismaHuella(entrada.huella, huellaActual)) {
    return { ok: false, entrada, motivo: `cambió la instalación de ${motor} (${describirHuella(huellaActual)}): hay que volver a verificar su aislamiento` };
  }
  if (entrada.resultado !== 'pasa') {
    return { ok: false, entrada, motivo: `la última verificación del aislamiento de ${motor} (${perfil}) falló: ${entrada.motivo || 'sin detalle'}` };
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

function soltarTestigo(motor, homeDir = os.homedir()) {
  try { fs.unlinkSync(rutaTestigo(motor, homeDir)); } catch {}
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
  const detalle = {};
  let resultado = 'pasa';
  let motivo = null;
  for (const sonda of sondas) {
    let r = null;
    for (let intento = 0; intento < 2; intento++) {
      try {
        r = await sonda.correr(ctx, detalle);
      } catch (err) {
        r = { resultado: 'falla', motivo: `la sonda no pudo correr: ${err.message}` };
      }
      if (!r || r.resultado !== 'inconclusa') break;
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
  return { huella, resultado, motivo, sondas: detalle, fecha: ahora().toISOString() };
}

module.exports = {
  APROBADOS,
  TESTIGO_VENCE_MS,
  rutaResultados,
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
