'use strict';

/**
 * FEAT-198 — Referencias a KeePassXC en el `.env` unificado.
 *
 * Un secreto puede ser literal, como siempre, o una referencia
 * `keepassxc:<entrada>` (D1). La referencia no es un secreto: puede quedar en
 * `process.env` tal cual. El valor se pide a KeePassXC (`lagrange://<entrada>`,
 * `keepassxc.js`) cuando hace falta:
 * - los tokens de Telegram y `LAGRANGE_MEMORY_TOKEN`, al arrancar el daemon
 *   (`resolverArranque`), una vez;
 * - las keys de motores, en cada pedido, con un caché en memoria de 5 minutos por
 *   secreto (P1). Un fallo no se cachea: el pedido siguiente vuelve a preguntar.
 *
 * Nunca hay caída silenciosa a otra fuente, y nada se escribe a disco ni a los
 * logs: los motivos nombran la variable y la entrada, nunca el valor.
 */

const keepassxc = require('./keepassxc.js');
const { esSecretoDeLagrange } = require('./secretos-lagrange.js');

const PREFIJO = 'keepassxc:';
const CACHE_MS = 5 * 60 * 1000;
// Las keys de motores no se resuelven al arrancar: el daemon las borra de su entorno
// y los motores las leen del `.env` en cada pedido (FEAT-166).
const KEYS_DE_MOTORES = Object.freeze(['DEEPSEEK_API_KEY', 'OPENCODE_GO_API_KEY']);
// IDs, no credenciales (audit F8): siempre literales.
const NO_CREDENCIALES = Object.freeze(['ALLOWED_USER_IDS', 'TELEGRAM_NOTIFY_CHAT_ID']);

const cache = new Map(); // entrada → { valor, hasta }
const ultimo = new Map(); // VARIABLE → { estado: 'ok'|'fallo', motivo, codigo, en }
let alEsperarGlobal = null;

function esReferencia(valor) {
  return typeof valor === 'string' && valor.trim().toLowerCase().startsWith(PREFIJO);
}

/** La entrada de una referencia, o `null` si `valor` no es una. No valida el nombre. */
function entradaDe(valor) {
  return esReferencia(valor) ? valor.trim().slice(PREFIJO.length).trim() : null;
}

/** ¿`nombre` es una credencial de Lagrange que puede ir en KeePassXC? */
function esCredencial(nombre) {
  const n = String(nombre).toUpperCase();
  return esSecretoDeLagrange(n) && !NO_CREDENCIALES.includes(n);
}

/**
 * Lo que hace el proceso cuando KeePassXC tarda (un diálogo que el usuario no vio):
 * el daemon avisa por Telegram. `fn({ variable, entrada })`; `null` lo apaga.
 */
function configurarAviso(fn) {
  alEsperarGlobal = typeof fn === 'function' ? fn : null;
}

function anotar(variable, estado) {
  if (variable) ultimo.set(String(variable).toUpperCase(), { ...estado, en: Date.now() });
}

/**
 * `valor` (lo que dice el `.env`) → `{ valor, motivo, codigo }`. Literal: tal cual.
 * Referencia: el valor de KeePassXC, o `valor: null` con el motivo.
 * `cliente` se inyecta en los tests (`{ leerSecreto }`).
 */
// FEAT-201 F0 S3 — Quien quiera tapar en su salida los valores que este proceso resolvió (el almacén de eventos v2).
// Se avisa el valor, nunca se guarda acá.
const observadoresResueltos = new Set();
function alResolver(fn) {
  observadoresResueltos.add(fn);
  return () => observadoresResueltos.delete(fn);
}
function avisarResuelto(valor) {
  if (typeof valor !== 'string' || !valor) return;
  for (const fn of observadoresResueltos) { try { fn(valor); } catch {} }
}

async function resolver(valor, {
  variable = null, cliente = keepassxc, usarCache = true, ahora = Date.now, alEsperar = alEsperarGlobal, env = process.env,
  timeoutMs
} = {}) {
  if (!esReferencia(valor)) {
    const v = typeof valor === 'string' ? valor.trim() : '';
    if (v && variable) avisarResuelto(v);
    return v ? { valor: v, motivo: null, codigo: null } : { valor: null, motivo: null, codigo: 'falta' };
  }
  const entrada = entradaDe(valor);
  if (!keepassxc.RE_ENTRADA.test(entrada)) {
    const r = { valor: null, codigo: 'entrada-invalida', motivo: `${variable || 'la referencia'}: ${keepassxc.MOTIVOS['entrada-invalida']}` };
    anotar(variable, { estado: 'fallo', motivo: r.motivo, codigo: r.codigo });
    return r;
  }
  const guardado = usarCache ? cache.get(entrada) : null;
  if (guardado && guardado.hasta > ahora()) {
    avisarResuelto(guardado.valor);
    return { valor: guardado.valor, motivo: null, codigo: null };
  }
  try {
    const opciones = { env, alEsperar: typeof alEsperar === 'function' ? () => alEsperar({ variable, entrada }) : null };
    if (timeoutMs) opciones.timeoutMs = timeoutMs;
    const v = await cliente.leerSecreto(entrada, opciones);
    if (usarCache) cache.set(entrada, { valor: v, hasta: ahora() + CACHE_MS });
    anotar(variable, { estado: 'ok', motivo: null, codigo: null });
    avisarResuelto(v);
    return { valor: v, motivo: null, codigo: null };
  } catch (err) {
    cache.delete(entrada);
    const codigo = err && err.codigo ? err.codigo : 'error';
    // Solo el mensaje de ErrorKeepassxc, que no lleva valores ni payloads.
    const base = err instanceof keepassxc.ErrorKeepassxc ? err.message : `error al leer KeePassXC (entrada ${entrada})`;
    const motivo = `${base}`;
    anotar(variable, { estado: 'fallo', motivo, codigo });
    return { valor: null, motivo, codigo };
  }
}

/**
 * D6 — Al empezar `main()` del daemon: reemplaza en `env` las referencias de los
 * tokens de Telegram y de `LAGRANGE_MEMORY_TOKEN`. No toca las keys de motores.
 * `omitir(nombre)` deja afuera variables (en un nodo, los tokens de Telegram).
 * Devuelve `{ resueltas: [variable], fallidas: [{ variable, motivo, codigo }] }`.
 */
async function resolverArranque(env = process.env, { cliente = keepassxc, omitir = () => false } = {}) {
  const resueltas = [];
  const fallidas = [];
  for (const [nombre, valor] of Object.entries(env)) {
    if (!esReferencia(valor) || !esCredencial(nombre)) continue;
    if (KEYS_DE_MOTORES.includes(nombre.toUpperCase()) || omitir(nombre)) continue;
    const r = await resolver(valor, { variable: nombre, cliente, usarCache: false, env });
    if (r.valor) { env[nombre] = r.valor; resueltas.push(nombre); }
    else fallidas.push({ variable: nombre, motivo: r.motivo, codigo: r.codigo });
  }
  return { resueltas, fallidas };
}

// D7 — Qué fallos del arranque se esperan y cuáles terminan el proceso: sin
// asociación, sin la entrada o con un nombre inválido, esperar no arregla nada.
const ESPERABLES = Object.freeze(['bloqueada', 'sin-keepassxc', 'timeout', 'sin-respuesta']);
const ESPERAS_MS = Object.freeze([5000, 10000, 20000, 40000, 60000]);

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * D7 — `resolverArranque` con espera: si KeePassXC está bloqueado, le pide que
 * muestre el desbloqueo una vez y espera su aviso (`database-unlocked`); si no
 * está abierto, reintenta con espera creciente. Vuelve con `{ resueltas, fallidas }`
 * cuando no queda nada por resolver o cuando un fallo no se arregla esperando.
 * `alEsperar({ codigo, motivo })` se llama al empezar cada espera (el daemon lo
 * escribe en el log; F2 lo deja en `arranque.json`).
 */
async function resolverArranqueEsperando(env = process.env, {
  cliente = keepassxc, omitir = () => false, alEsperar = () => {}, esperar = dormir, desbloqueoMs = 10 * 60 * 1000
} = {}) {
  const resueltas = [];
  for (let intento = 0; ; intento++) {
    const r = await resolverArranque(env, { cliente, omitir });
    resueltas.push(...r.resueltas);
    if (!r.fallidas.length) return { resueltas, fallidas: [] };
    const definitivo = r.fallidas.find((f) => !ESPERABLES.includes(f.codigo));
    if (definitivo) return { resueltas, fallidas: r.fallidas };
    const primero = r.fallidas[0];
    try { alEsperar({ codigo: primero.codigo, motivo: primero.motivo }); } catch {}
    if (primero.codigo === 'bloqueada') {
      try {
        if (await cliente.esperarDesbloqueo({ env, timeoutMs: desbloqueoMs })) continue;
      } catch {}
    }
    await esperar(ESPERAS_MS[Math.min(intento, ESPERAS_MS.length - 1)]);
  }
}

/** D9 — La última resolución de `variable` en este proceso, o `null` si no se leyó todavía. */
function ultimaResolucion(variable) {
  return ultimo.get(String(variable).toUpperCase()) || null;
}

const RE_TOKEN_TELEGRAM = /^TELEGRAM_BOT(_[A-Z0-9_]+)?_TOKEN$/i;

/**
 * D9 — Para un proceso que no es el daemon (`notify.js`, `bridge-status`): una copia
 * de `env` con las referencias de los tokens de Telegram resueltas, para pasarla a
 * `leerBots`. Lo que no se pudo resolver queda afuera de la copia y va en
 * `noVerificables` con su motivo. No toca `env`.
 */
async function resolverTokensDeBots(env, { cliente = keepassxc, timeoutMs, alEsperar = null } = {}) {
  const copia = { ...env };
  const noVerificables = [];
  for (const [nombre, valor] of Object.entries(env || {})) {
    if (!RE_TOKEN_TELEGRAM.test(nombre) || !esReferencia(valor)) continue;
    const r = await resolver(valor, { variable: nombre, cliente, timeoutMs, alEsperar });
    if (r.valor) copia[nombre] = r.valor;
    else { delete copia[nombre]; noVerificables.push({ variable: nombre, motivo: r.motivo }); }
  }
  return { env: copia, noVerificables };
}

/**
 * D9 — Lo que una vista puede decir de un secreto sin bloquear ni mostrar el valor:
 * `{ key, origen, lectura }`. `key` es `true` con literal o referencia (compatible con
 * el `key` de siempre); `origen` es `literal`, `keepassxc` o `null`; `lectura` es la
 * última resolución de este proceso (`{ estado, motivo }`) o `null` si no se leyó.
 */
function estadoDeVariable(valorCrudo, variable) {
  const v = typeof valorCrudo === 'string' ? valorCrudo.trim() : '';
  if (!v) return { key: false, origen: null, lectura: null };
  if (!esReferencia(v)) return { key: true, origen: 'literal', lectura: null };
  const u = ultimaResolucion(variable);
  return { key: true, origen: 'keepassxc', lectura: u ? { estado: u.estado, motivo: u.motivo || null } : null };
}

/** Para los tests. */
function _reiniciar() {
  cache.clear();
  ultimo.clear();
  alEsperarGlobal = null;
}

module.exports = {
  PREFIJO, CACHE_MS, KEYS_DE_MOTORES,
  esReferencia, entradaDe, esCredencial, configurarAviso, resolver, alResolver, resolverArranque, resolverArranqueEsperando,
  ultimaResolucion, estadoDeVariable, resolverTokensDeBots, _reiniciar
};
