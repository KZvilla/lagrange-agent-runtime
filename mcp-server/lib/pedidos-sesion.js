'use strict';

/**
 * FEAT-194 — Cursor único de pedidos manuales (`agy_modo: "manual"`) por sesión de Claude Code.
 *
 * Guarda `<dataDir>/buzones/pedidos-<claudePid>.json` bajo `conLock` (almas/archivos.js)
 * y escritura atómica `0o600` (buzones.escribirAtomico), encapsulando el aislamiento
 * de host para que OpenCode CLI y Codex nunca creen ni lean este archivo.
 */

const fs = require('node:fs');
const path = require('node:path');
const nombresTools = require('./nombres-tools.js');
const buzones = require('./buzones.js');
const { conLock } = require('../almas/archivos.js');
const { esHookDeCodex, codigoEnCacheDeCodex } = require('./host-del-hook.js');
const { rutaConfig } = require('./agy-modo.js');
const pedidosAgy = require('./pedidos-agy.js');
const colaAuditorias = require('./cola-auditorias.js');

const RAIZ_PLUGIN = path.join(__dirname, '..', '..');
const TOPE_PEDIDOS = 50;
const ESTADOS = new Set(['pendiente', 'avisado', 'recogido', 'descartado']);
const ESTADOS_ACTIVOS = new Set(['pendiente', 'avisado']);

const pidValido = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 1 ? n : null;
};

/** Solo Claude Code real: nunca OpenCode CLI ni Codex. */
function esHostClaudeReal(env = process.env, raizPlugin = RAIZ_PLUGIN) {
  if (!env || env.CLAUDECODE !== '1') return false;
  // FEAT-195 (auditoría 41cdbc F2) — opencode y agy (FEAT-196) marcan su MCP; ninguno es Claude Code aunque herede CLAUDECODE.
  if (['opencode', 'agy'].includes(String(env.LAGRANGE_HOST || '').trim().toLowerCase())) return false;
  if (esHookDeCodex(env)) return false;
  if (codigoEnCacheDeCodex(raizPlugin, env)) return false;
  return true;
}

/** Resuelve PID explícito, luego `CLAUDE_PID`, luego `ppid` opcional (si lo pasó el llamador). */
function resolverClaudePid({ env = process.env, pid = null, ppid = null } = {}) {
  return pidValido(pid) || pidValido(env && env.CLAUDE_PID) || pidValido(ppid) || null;
}

/** Lee `agy_auto_recoger` solo desde la config global (`~/.claude/antigravity.json`), fail-closed a `false`. */
function autoRecogerGlobal(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(rutaConfig(env), 'utf8')).agy_auto_recoger === true;
  } catch {
    return false;
  }
}

function normalizarEntrada(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !/^[0-9a-f]{6}$/.test(e.id)) return null;
  if (typeof e.raiz !== 'string' || !e.raiz) return null;
  const estado = ESTADOS.has(e.estado) ? e.estado : 'pendiente';
  return {
    id: e.id,
    tipo: typeof e.tipo === 'string' && pedidosAgy.TIPOS[e.tipo] ? e.tipo : 'audit',
    modo: typeof e.modo === 'string' ? e.modo : null,
    tool: typeof e.tool === 'string' ? e.tool : (pedidosAgy.TIPOS[e.tipo]?.tool || 'agy_audit'),
    raiz: e.raiz,
    creadoMs: Number.isFinite(Number(e.creadoMs)) ? Number(e.creadoMs) : 0,
    estado
  };
}

function leerJsonSeguro(ruta) {
  try {
    const crudo = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    const lista = Array.isArray(crudo && crudo.pedidos) ? crudo.pedidos.map(normalizarEntrada).filter(Boolean) : [];
    return { pedidos: lista };
  } catch {
    return { pedidos: [] };
  }
}

function escribirCursorSeguro(ruta, pedidos, dataDir) {
  buzones.asegurarDir(dataDir);
  const recortado = pedidos.slice(-TOPE_PEDIDOS);
  buzones.escribirAtomico(ruta, JSON.stringify({ pedidos: recortado }, null, 2));
  return recortado;
}

function conCursorLock(dataDir, claudePid, fn) {
  const pid = pidValido(claudePid);
  if (!pid) return { ok: false, motivo: 'sin-pid' };
  const ruta = buzones.rutaPedidos(dataDir, pid);
  try {
    buzones.asegurarDir(dataDir);
    const valor = conLock(ruta, () => fn(leerJsonSeguro(ruta), ruta));
    return { ok: true, valor };
  } catch (err) {
    return { ok: false, locked: err && err.name === 'ErrorLock', error: err };
  }
}

function leerPedidos(dataDir, claudePid) {
  const pid = pidValido(claudePid);
  if (!pid) return [];
  return leerJsonSeguro(buzones.rutaPedidos(dataDir, pid)).pedidos;
}

function hayPendientes(dataDir, claudePid) {
  return leerPedidos(dataDir, claudePid).some((p) => ESTADOS_ACTIVOS.has(p.estado));
}

function registrarPedido({
  dataDir = buzones.dataDirPath(),
  env = process.env,
  raizPlugin = RAIZ_PLUGIN,
  pid = null,
  ppid = null,
  id,
  tipo,
  modo = null,
  tool,
  raiz,
  creadoMs = Date.now()
}) {
  if (!esHostClaudeReal(env, raizPlugin)) return { ok: false, motivo: 'no-claude' };
  const claudePid = resolverClaudePid({ env, pid, ppid });
  if (!claudePid) return { ok: false, motivo: 'sin-pid' };
  const nuevo = normalizarEntrada({ id, tipo, modo, tool, raiz, creadoMs, estado: 'pendiente' });
  if (!nuevo) return { ok: false, motivo: 'entrada-invalida' };
  const r = conCursorLock(dataDir, claudePid, (datos, ruta) => {
    const sinDup = datos.pedidos.filter((p) => p.id !== nuevo.id);
    sinDup.push(nuevo);
    escribirCursorSeguro(ruta, sinDup, dataDir);
    return true;
  });
  return r.ok ? { ok: true, claudePid } : r;
}

function marcarEstado({
  dataDir = buzones.dataDirPath(),
  claudePid = null,
  id,
  estado,
  soloSiActivo = false,
  exigirHostClaude = false,
  env = process.env,
  raizPlugin = RAIZ_PLUGIN,
  ppid = null
}) {
  if (!ESTADOS.has(estado)) return { ok: false, motivo: 'estado-invalido' };
  if (exigirHostClaude && !esHostClaudeReal(env, raizPlugin)) return { ok: false, motivo: 'no-claude' };
  const pid = pidValido(claudePid) || resolverClaudePid({ env, ppid });
  if (!pid) return { ok: false, motivo: 'sin-pid' };
  const r = conCursorLock(dataDir, pid, (datos, ruta) => {
    const idx = datos.pedidos.findIndex((p) => p.id === id);
    if (idx === -1) return { encontrado: false, cambiado: false, pedido: null };
    const actual = datos.pedidos[idx];
    if (soloSiActivo && !ESTADOS_ACTIVOS.has(actual.estado)) {
      return { encontrado: true, cambiado: false, pedido: actual };
    }
    const actualizado = { ...actual, estado };
    const siguientes = [...datos.pedidos];
    siguientes[idx] = actualizado;
    escribirCursorSeguro(ruta, siguientes, dataDir);
    return { encontrado: true, cambiado: actual.estado !== estado, pedido: actualizado };
  });
  return r.ok ? { ok: true, ...r.valor } : r;
}

function tomarListoParaDespertar({
  dataDir = buzones.dataDirPath(),
  claudePid,
  umbralMs = 5000,
  ahora = Date.now(),
  // FEAT-195 — Las dos colas: la de auditorías (tool `auditoria`) y la de agy (FEAT-192).
  informeEstableFn = colaAuditorias.informeEstable
}) {
  const pid = pidValido(claudePid);
  if (!pid) return { listo: null };
  const activos = leerPedidos(dataDir, pid).filter((p) => ESTADOS_ACTIVOS.has(p.estado));
  for (const cand of activos) {
    let estable = false;
    try {
      estable = Boolean(informeEstableFn(cand.raiz, cand.id, { umbralMs, ahora }));
    } catch {
      estable = false;
    }
    if (!estable) continue;
    const tomado = conCursorLock(dataDir, pid, (datos, ruta) => {
      const idx = datos.pedidos.findIndex((p) => p.id === cand.id);
      if (idx === -1) return null;
      if (!ESTADOS_ACTIVOS.has(datos.pedidos[idx].estado)) return null;
      const actualizado = { ...datos.pedidos[idx], estado: 'recogido' };
      const siguientes = [...datos.pedidos];
      siguientes[idx] = actualizado;
      escribirCursorSeguro(ruta, siguientes, dataDir);
      return actualizado;
    });
    if (!tomado.ok) return { listo: null, locked: Boolean(tomado.locked) };
    if (tomado.valor) return { listo: tomado.valor };
  }
  return { listo: null };
}

// FEAT-195 — Las tools que recogen un informe. Una entrada del cursor con otra cosa en `tool` cae a la de su tipo:
// el texto va a un prompt y no lleva nada que no salga de esta lista.
const TOOLS_RECOGER = new Set(['auditoria', ...Object.values(pedidosAgy.TIPOS).map((t) => t.tool)]);

function toolDeRecoger(entrada) {
  if (entrada && TOOLS_RECOGER.has(entrada.tool)) return entrada.tool;
  // FEAT-197 (r1 F6) — Una entrada con el nombre público (`audit_queue`, `audit`…) vale lo mismo que la interna.
  const interno = entrada && typeof entrada.tool === 'string' ? nombresTools.nombreInterno(entrada.tool) : null;
  if (interno && TOOLS_RECOGER.has(interno)) return interno;
  return pedidosAgy.TIPOS[entrada && entrada.tipo]?.tool || 'agy_audit';
}

/** FEAT-195 — Dónde queda el informe de una entrada (relativo a la raíz del proyecto), según la cola de su tool. */
function rutaInforme(entrada) {
  const id = entrada && /^[0-9a-f]{6}$/.test(entrada.id) ? entrada.id : null;
  if (!id) return null;
  return toolDeRecoger(entrada) === 'auditoria'
    ? `.lagrange/${colaAuditorias.CARPETA}/informes/${id}.md`
    : `.lagrange/agy/informes/${id}.md`;
}

/**
 * FEAT-195 (D8) — Único armador del texto con que Claude recoge un informe: lo usan `hooks/buzon.js` (despertar) y
 * `hooks/panel.js` (`informes[].recoger`, que la banda de `mods.tsx` manda tal cual). La cola nueva se recoge con
 * `auditoria` + `accion: "recoger"`; la de agy (FEAT-192), con su tool y `pedido:`.
 */
function textoRecoger(entrada) {
  const id = entrada && /^[0-9a-f]{6}$/.test(entrada.id) ? entrada.id : null;
  if (!id) return null;
  // FEAT-197 — El cursor guarda el nombre interno (los de antes del cambio siguen valiendo); el texto, el público.
  const tool = toolDeRecoger(entrada);
  if (tool === 'auditoria') {
    return `Recogé el informe de la auditoría ${id} con \`audit_queue\` (\`action: "collect"\`, \`id: "${id}"\`, \`wait_seconds: 0\`).`;
  }
  return `Recogé el informe del pedido manual ${id} con \`${nombresTools.nombreNuevo(tool)}\` (\`request_id: "${id}"\`, \`wait_seconds: 0\`).`;
}

module.exports = {
  textoRecoger,
  rutaInforme,
  RAIZ_PLUGIN,
  TOPE_PEDIDOS,
  ESTADOS,
  ESTADOS_ACTIVOS,
  esHostClaudeReal,
  resolverClaudePid,
  autoRecogerGlobal,
  leerPedidos,
  hayPendientes,
  registrarPedido,
  marcarEstado,
  tomarListoParaDespertar
};
