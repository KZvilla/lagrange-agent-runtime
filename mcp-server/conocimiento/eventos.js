/**
 * FEAT-129 §2 — Eventos del proyecto, append-only, con las reglas de
 * `lib/historia.js`: solo `appendFileSync` (sin lock, temporal ni rename),
 * nunca lanza y tolera duplicados. Cada línea queda por debajo de 1 KB, así el
 * append de dos procesos no se intercala.
 *
 * Lo que ya tiene registro no se repite acá: commits y merges salen de
 * `git log`, las sesiones de sus handoffs (§3).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mesDe } = require('../lib/historia.js');
const { redactarSecretos } = require('../almas/escaneo.js');
const { resolverCuenta } = require('../lib/identidad-sesion.js');
const { homeDir } = require('../almas/rutas.js');
const rutas = require('./rutas.js');

const DIR_EVENTOS = 'eventos';
const MAX_TEXTO = 300;
const MAX_LINEA = 1000;
const ACTOR_MCP = 'process:lagrange-mcp';

// Quien arma las vistas se entera de cada escritura propia (§4 b).
const oyentes = new Set();
function alEscribir(fn) { oyentes.add(fn); return () => oyentes.delete(fn); }
function avisar(dirProy) {
  for (const fn of oyentes) { try { fn(dirProy); } catch {} }
}

/**
 * OKF §7 — `claude-code/<clave de cuenta>`: `principal` o la clave de
 * `motores.cuentas`, nunca el nombre visible (Spica/Epikouros), que puede
 * cambiar. Sin cuenta conocida, el proceso del MCP.
 */
function actorDe({ env = process.env, cuentas = {} } = {}) {
  try {
    const cuenta = resolverCuenta({ configDir: env.CLAUDE_CONFIG_DIR, home: homeDir(env), cuentas });
    return cuenta ? `claude-code/${cuenta}` : ACTOR_MCP;
  } catch {
    return ACTOR_MCP;
  }
}

/** Una línea, redactada y con tope. */
function textoSeguro(texto, max = MAX_TEXTO) {
  const plano = String(texto ?? '').replace(/\s+/g, ' ').trim();
  const { texto: limpio } = redactarSecretos(plano);
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio;
}

function archivoDelMes(dirProy, mes) {
  return path.join(dirProy, DIR_EVENTOS, `${mes}.jsonl`);
}

/**
 * Anexa un evento. `{ tipo, texto, ...campos }`; el resto lo pone el módulo.
 * Devuelve `{ ok, motivo? }` y nunca lanza.
 */
function anotar(evento, { env = process.env, cwd = process.cwd(), cuentas = {}, actor = null, ahora = new Date() } = {}) {
  try {
    if (!evento || typeof evento.tipo !== 'string' || !evento.tipo) return { ok: false, motivo: 'evento sin tipo' };
    const { tipo, texto, ...campos } = evento;
    const fila = { ts: ahora.toISOString(), actor: actor || actorDe({ env, cuentas }), tipo, texto: textoSeguro(texto), ...campos };
    let linea = JSON.stringify(fila);
    if (Buffer.byteLength(linea, 'utf8') > MAX_LINEA) {
      // El texto es lo único largo: se recorta hasta que entre.
      fila.texto = textoSeguro(fila.texto, 120);
      linea = JSON.stringify(fila);
      if (Buffer.byteLength(linea, 'utf8') > MAX_LINEA) return { ok: false, motivo: 'evento demasiado largo' };
    }
    const raiz = rutas.raizCacheada(cwd);
    const dirProy = rutas.dirProyecto(rutas.slugDeProyecto(raiz), env);
    const ruta = archivoDelMes(dirProy, mesDe(fila.ts));
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.appendFileSync(ruta, linea + '\n', 'utf8');
    avisar(dirProy);
    return { ok: true };
  } catch (err) {
    process.stderr.write(`[conocimiento] No se pudo anotar el evento: ${err && err.message}\n`);
    return { ok: false, motivo: err && err.message };
  }
}

/** Los eventos de un mes; una línea rota se saltea. */
function leerMes(dirProy, mes) {
  let texto;
  try {
    texto = fs.readFileSync(archivoDelMes(dirProy, mes), 'utf8');
  } catch {
    return [];
  }
  const salida = [];
  for (const linea of texto.split(/\r?\n/)) {
    if (!linea.trim()) continue;
    try {
      const obj = JSON.parse(linea);
      if (obj && typeof obj === 'object' && typeof obj.ts === 'string') salida.push(obj);
    } catch {}
  }
  return salida;
}

/** `YYYY-MM` del mes de `ahora` y del anterior. */
function mesesRecientes(ahora = new Date()) {
  const actual = mesDe(ahora.toISOString());
  const previo = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - 1, 1));
  return [mesDe(previo.toISOString()), actual];
}

module.exports = { DIR_EVENTOS, ACTOR_MCP, anotar, actorDe, textoSeguro, leerMes, mesesRecientes, alEscribir };
