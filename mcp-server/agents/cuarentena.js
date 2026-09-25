/**
 * SEC-021 — Aprendizajes de un agente retenidos hasta que el usuario los revise.
 *
 * Un cast que usó red (web, URL, una tool MCP) —o del que no se sabe si la
 * usó— puede traer en su bloque `<memoria>` una instrucción inyectada por lo
 * que leyó. Si se guardara directo en mcp-memory, el próximo cast de ese
 * agente la recibiría como criterio propio, en cualquier motor y con
 * cualquier cuenta. Acá quedan retenidos: nunca se hace el commit hasta que el
 * usuario los promueve desde la consola. Descartarlos no deja nada.
 *
 * `~/.claude/lagrange-cuarentena.json` (estado de lagrange, compartido entre
 * cuentas), con el lock y la escritura atómica de `almas/archivos.js`: lo
 * escriben el MCP y el bot.
 *
 * Fail-closed: `retener` que falla se informa y quien llama NO guarda en
 * mcp-memory (se pierde el aprendizaje antes que pasar algo sin revisar).
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { conLock, escribirAtomico, leerTexto } = require('../almas/archivos.js');
const procedencia = require('./procedencia.js');

/** La línea de procedencia de una entrada que sale de la cuarentena. */
function anotarSalida(entrada, destino, homeDir) {
  const r = procedencia.anotar({
    ...(entrada.procedencia || {}), agente: entrada.agente, destino, cuarentenaId: entrada.id,
    textos: [...(entrada.decisions || []), ...(entrada.userCorrections || [])]
  }, { homeDir });
  if (!r.ok) process.stderr.write(`[agentes] No se pudo anotar la procedencia (${destino}): ${r.motivo}\n`);
}

const TOPE = 200;
const TOPE_HILOS = 500;
const ID_VALIDO = /^q_[a-z0-9]{6,40}$/;
// Una promoción en curso (el commit puede tardar 8 s) bloquea otra de la misma
// entrada; una más vieja que esto se considera abandonada y se puede reintentar.
const PROMOCION_VENCE_MS = 2 * 60 * 1000;

function rutaCuarentena(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'lagrange-cuarentena.json');
}

function leerTabla(ruta) {
  const crudo = leerTexto(ruta).trim();
  if (!crudo) return { entradas: [], hilos: {} };
  const datos = JSON.parse(crudo);
  return {
    entradas: datos && Array.isArray(datos.entradas) ? datos.entradas : [],
    hilos: datos && datos.hilos && typeof datos.hilos === 'object' && !Array.isArray(datos.hilos) ? datos.hilos : {}
  };
}

/**
 * ¿Algún turno de este hilo usó red (o no se supo)? Un archivo ilegible cuenta
 * como que sí: fail-closed.
 */
function hiloContaminado(conversationId, { homeDir = os.homedir() } = {}) {
  if (!conversationId) return false;
  try {
    return Boolean(leerTabla(rutaCuarentena(homeDir)).hilos[conversationId]);
  } catch {
    return true;
  }
}

/** Marca el hilo: lo que aprendan sus turnos siguientes va a cuarentena. `{ ok }` o `{ ok: false, motivo }`. */
function marcarHilo(conversationId, agente, { homeDir = os.homedir(), ahora = new Date() } = {}) {
  if (!conversationId) return { ok: false, motivo: 'sin hilo' };
  const ruta = rutaCuarentena(homeDir);
  try {
    conLock(ruta, () => {
      const tabla = leerTabla(ruta);
      if (tabla.hilos[conversationId]) return;
      tabla.hilos[conversationId] = { agente, desde: ahora.toISOString() };
      const claves = Object.keys(tabla.hilos);
      if (claves.length > TOPE_HILOS) {
        claves.sort((a, b) => String(tabla.hilos[a].desde).localeCompare(String(tabla.hilos[b].desde)));
        for (const k of claves.slice(0, claves.length - TOPE_HILOS)) delete tabla.hilos[k];
      }
      guardarTabla(ruta, tabla);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

function guardarTabla(ruta, tabla) {
  escribirAtomico(ruta, `${JSON.stringify(tabla, null, 2)}\n`);
}

/**
 * `{ ok: true, id, expulsada }` o `{ ok: false, motivo }`. `expulsada` es la
 * entrada más vieja que se cayó por el tope (para registrarla), o `null`.
 */
function retener(agente, { decisions = [], userCorrections = [], taskSummary = '', procedencia = {} } = {}, {
  homeDir = os.homedir(), ahora = new Date()
} = {}) {
  if (!agente) return { ok: false, motivo: 'falta el agente' };
  if (!decisions.length && !userCorrections.length) return { ok: false, motivo: 'nada que retener' };
  const id = `q_${ahora.getTime().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const ruta = rutaCuarentena(homeDir);
  try {
    let expulsada = null;
    conLock(ruta, () => {
      const tabla = leerTabla(ruta);
      tabla.entradas.push({
        id, agente, creada: ahora.toISOString(),
        decisions: decisions.map(String), userCorrections: userCorrections.map(String),
        taskSummary: String(taskSummary || '').slice(0, 2000),
        procedencia
      });
      // La más vieja que no se esté promoviendo: una en pleno commit no se expulsa.
      if (tabla.entradas.length > TOPE) {
        const i = tabla.entradas.findIndex((e) => !promoviendoVigente(e, ahora.getTime()));
        if (i >= 0) expulsada = tabla.entradas.splice(i, 1)[0];
      }
      guardarTabla(ruta, tabla);
    });
    return { ok: true, id, expulsada };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

/** Las entradas de un agente (o todas), más nuevas primero. Un archivo ilegible es una lista vacía con motivo. */
function listar(agente = null, { homeDir = os.homedir() } = {}) {
  try {
    const { entradas } = leerTabla(rutaCuarentena(homeDir));
    return { ok: true, entradas: entradas.filter((e) => !agente || e.agente === agente).reverse() };
  } catch (err) {
    return { ok: false, entradas: [], motivo: err.message };
  }
}

function quitar(ruta, id) {
  let quitada = null;
  conLock(ruta, () => {
    const tabla = leerTabla(ruta);
    const i = tabla.entradas.findIndex((e) => e.id === id);
    if (i < 0) return;
    quitada = tabla.entradas.splice(i, 1)[0];
    guardarTabla(ruta, tabla);
  });
  return quitada;
}

/**
 * Hace el commit a mcp-memory con `cerrarSesion(agente, datos)` y, si lo
 * acepta, quita la entrada. `{ ok, entrada }` o `{ ok: false, motivo }`. Si
 * la memoria no acepta, la entrada queda como estaba. `agente` tiene que
 * coincidir (la consola promueve desde el panel de ese agente).
 *
 * El lock es sincrónico y el commit no: no se sostiene el lock durante la red.
 * En cambio, bajo el lock se marca `promoviendo` (una segunda promoción de la
 * misma entrada se rechaza mientras dure), el commit corre sin lock, y bajo el
 * lock otra vez se quita la entrada o se desmarca. `sessionId` es el id de la
 * entrada: un reintento después de un timeout reusa la misma sesión.
 */
async function promover(id, { agente, cerrarSesion, homeDir = os.homedir(), ahora = () => Date.now() } = {}) {
  if (!ID_VALIDO.test(String(id || ''))) return { ok: false, motivo: 'id inválido' };
  if (typeof cerrarSesion !== 'function') return { ok: false, motivo: 'sin servicio de memoria' };
  const ruta = rutaCuarentena(homeDir);
  let entrada = null;
  let motivo = null;
  try {
    conLock(ruta, () => {
      const tabla = leerTabla(ruta);
      const e = tabla.entradas.find((x) => x.id === id);
      if (!e || (agente && e.agente !== agente)) { motivo = 'no está en cuarentena'; return; }
      const marca = Date.parse(e.promoviendo || '');
      if (Number.isFinite(marca) && ahora() - marca < PROMOCION_VENCE_MS) { motivo = 'ya se está promoviendo'; return; }
      e.promoviendo = new Date(ahora()).toISOString();
      guardarTabla(ruta, tabla);
      entrada = e;
    });
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
  if (!entrada) return { ok: false, motivo };

  let r;
  try {
    r = await cerrarSesion(entrada.agente, {
      sessionId: entrada.id,
      taskSummary: entrada.taskSummary,
      outcome: 'success',
      decisions: entrada.decisions,
      userCorrections: entrada.userCorrections
    });
  } catch (err) {
    r = { ok: false, motivo: err.message };
  }
  if (!r || !r.ok) {
    try {
      conLock(ruta, () => {
        const tabla = leerTabla(ruta);
        const e = tabla.entradas.find((x) => x.id === id);
        if (e) { delete e.promoviendo; guardarTabla(ruta, tabla); }
      });
    } catch { /* la marca vence sola */ }
    return { ok: false, motivo: (r && r.motivo) || 'la memoria no aceptó el cierre' };
  }
  anotarSalida(entrada, 'promovida', homeDir);
  try { quitar(ruta, id); } catch (err) {
    // Ya está en la memoria; la marca `promoviendo` frena un segundo commit un rato.
    return { ok: true, entrada, aviso: `quedó guardada pero no se pudo quitar de la cuarentena: ${err.message}` };
  }
  return { ok: true, entrada };
}

/**
 * Quita la entrada sin guardar nada. `{ ok, entrada }` o `{ ok: false, motivo }`.
 * Validar y quitar van en el MISMO lock: si no, una promoción que marca la
 * entrada entre el chequeo y el borrado terminaría guardada y "descartada".
 */
function descartar(id, { agente = null, homeDir = os.homedir(), ahora = () => Date.now() } = {}) {
  if (!ID_VALIDO.test(String(id || ''))) return { ok: false, motivo: 'id inválido' };
  const ruta = rutaCuarentena(homeDir);
  let quitada = null;
  let motivo = null;
  try {
    conLock(ruta, () => {
      const tabla = leerTabla(ruta);
      const i = tabla.entradas.findIndex((e) => e.id === id);
      const e = tabla.entradas[i];
      if (!e || (agente && e.agente !== agente)) { motivo = 'no está en cuarentena'; return; }
      if (promoviendoVigente(e, ahora())) { motivo = 'se está promoviendo'; return; }
      quitada = tabla.entradas.splice(i, 1)[0];
      guardarTabla(ruta, tabla);
    });
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
  if (!quitada) return { ok: false, motivo };
  anotarSalida(quitada, 'descartada', homeDir);
  return { ok: true, entrada: quitada };
}

function promoviendoVigente(entrada, ahora) {
  const marca = Date.parse(entrada.promoviendo || '');
  return Number.isFinite(marca) && ahora - marca < PROMOCION_VENCE_MS;
}

module.exports = {
  TOPE, TOPE_HILOS, ID_VALIDO, PROMOCION_VENCE_MS, rutaCuarentena,
  retener, listar, promover, descartar, hiloContaminado, marcarHilo
};
