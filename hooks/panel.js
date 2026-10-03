#!/usr/bin/env node
'use strict';

/**
 * FEAT-101 — Los datos del panel de Lagrange, para `hooks/panel-mod.tsx`.
 *
 *   node panel.js fanout <cwd>   { fanout }: la corrida de fan-out en curso (liviano).
 *   node panel.js foto <cwd>     { fanout, cuota, versiones, agentes, almas,
 *                                programaciones, worktrees }: todo el panel (FEAT-105).
 *   node panel.js cuota-sesion <cwd> <pct5h> <reset5h> <pct7d> <reset7d>
 *                                { ok, clave?, motivo? }: guarda la cuota de Claude
 *                                que midió la sesión (BE-093); `-` = sin dato.
 *
 * Solo lo lanza el mod, que existe solo en Claude Code. Siempre sale en 0 con
 * JSON: una sección que falla queda en `null` y las demás salen igual.
 *
 * Nada de rutas ni comandos en la salida: el comando del panel la devuelve como
 * texto a la conversación. Por eso no se usa el texto de `avisosDeDeriva`, que
 * arma un comando con la carpeta de la cuenta.
 */

const fs = require('fs');
const path = require('path');
const { corridaMasReciente, estaExpirada, armarLinea } = require('../mcp-server/lib/fanout-linea.js');

// FEAT-109 — Solo la cola del log de cada subagente: puede pesar megas.
const COLA_PROGRESO_BYTES = 16 * 1024;

/**
 * FEAT-109 — El paso de un subagente: su último `step_update`. Una tool en
 * ACTIVE da el nombre de la tool, sin el parámetro (puede traer rutas o un
 * comando); una tool en DONE o una respuesta del agente, `respondiendo`. Una
 * tool en DONE nunca cuenta como activa aunque más atrás esté su ACTIVE.
 */
function pasoDe(ruta) {
  const { interpretarEvento } = require('../mcp-server/fanout-tail.js');
  let fd;
  try {
    fd = fs.openSync(ruta, 'r');
    const tam = fs.fstatSync(fd).size;
    const desde = Math.max(0, tam - COLA_PROGRESO_BYTES);
    const buf = Buffer.alloc(tam - desde);
    fs.readSync(fd, buf, 0, buf.length, desde);
    const lineas = buf.toString('utf8').split('\n');
    // Solo si se cortó: la primera puede haber quedado a medias.
    if (desde > 0) lineas.shift();
    for (let i = lineas.length - 1; i >= 0; i--) {
      const linea = lineas[i].trim();
      if (!linea) continue;
      let ev;
      try { ev = JSON.parse(linea); } catch { continue; }
      if (!ev || ev.event === 'result') return null;
      if (ev.event !== 'step_update') continue;
      const su = ev.step_update || {};
      if (su.step_type === 'tool') {
        if (su.state && su.state !== 'ACTIVE') return 'respondiendo';
        const r = interpretarEvento(linea);
        return r && r.tipo === 'tool' ? r.texto.split(' → ')[0] : null;
      }
      if (su.step_type === 'agent_response') return 'respondiendo';
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function fanout(cwd) {
  const d = corridaMasReciente(cwd);
  if (!d || estaExpirada(d)) return null;
  const { rutaProgreso } = require('../mcp-server/fanout-estado.js');
  const tareas = Object.entries(d.tareas || {}).map(([id, t]) => {
    const estado = (t && t.estado) || 'desconocido';
    const tarea = { id, estado, modelo: (t && t.modelo) || null, inicio: (t && t.inicio) || null, fin: (t && t.fin) || null };
    if (estado === 'corriendo' && d.slug) tarea.paso = pasoDe(rutaProgreso(cwd, d.slug, id));
    return tarea;
  });
  return { slug: d.slug || null, linea: armarLinea(d), tareas, terminado: Boolean(d.terminado) };
}

function cuota() {
  const { resumenUso } = require('../mcp-server/lib/uso-agy.js');
  const r = resumenUso();
  if (!r) return null;
  const agy = r.cuotaAntigravity ? { grupos: r.cuotaAntigravity.grupos, vistoEn: r.cuotaAntigravity.vistoEn || null } : null;
  const claude = r.cuotaClaude || null;
  const claudePorCuenta = r.cuotaClaudePorCuenta || null;
  if (!agy && !claude && !claudePorCuenta) return null;
  return { antigravity: agy, claude, claudePorCuenta };
}

function versiones(cwd, env = process.env) {
  const { loadConfig } = require('../mcp-server/lib/config.js');
  const recall = require('../mcp-server/recall.js');
  const instalaciones = require('../mcp-server/lib/instalaciones.js');
  const { compararVersiones } = require('../mcp-server/lib/proveedores.js');
  let propia = null;
  try { propia = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || null; } catch {}
  const config = loadConfig(cwd);
  // El hijo de `$.process.run` no hereda CLAUDECODE (sonda S4), pero esto solo
  // corre bajo Claude Code: sin esto no habría cuenta actual.
  const f = recall.fuentes({ cuentas: (config.motores && config.motores.cuentas) || {}, env: { ...env, CLAUDECODE: '1' } });
  const lista = instalaciones.versionesInstaladas({ todas: f.todas, actual: f.actual });
  const max = instalaciones.versionMaxima(lista);
  const cuentas = lista.map((i) => ({
    cuenta: i.cuenta,
    estado: i.estado,
    version: i.version || null,
    propia: Boolean(i.propia),
    desactualizada: Boolean(max && i.version && (compararVersiones(i.version, max) || 0) < 0)
  }));
  return { propia, cuentas };
}

/**
 * BE-093 — La cuota de la sesión interactiva (`session.measure` del mod), con la
 * misma forma que `cuotaDesdeRateLimit`, bajo la clave de la cuenta de la
 * sesión. Una carpeta que no es la principal ni una cuenta declarada no se
 * guarda: no se inventa una clave.
 */
function cuotaSesion(cwd, [pct5h, reset5h, pct7d, reset7d] = [], env = process.env) {
  const fraccion = (v) => {
    if (v === undefined || v === '-' || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : null;
  };
  const fecha = (v) => (typeof v === 'string' && v !== '-' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const cuota = {
    ventana_5h: fraccion(pct5h),
    ventana_7d: fraccion(pct7d),
    resetea_5h: fecha(reset5h),
    resetea_7d: fecha(reset7d),
    estado: null,
    fuente: 'sesion'
  };
  if (cuota.ventana_5h === null && cuota.ventana_7d === null) return { ok: false, motivo: 'sin ventanas' };

  const { loadConfig } = require('../mcp-server/lib/config.js');
  const recall = require('../mcp-server/recall.js');
  const { claveDeCuenta, mismaRuta } = require('../mcp-server/motores/roles.js');
  const config = loadConfig(cwd);
  // Como en `versiones`: el hijo de `$.process.run` no hereda CLAUDECODE (S4) y
  // la cuenta principal no tiene CLAUDE_CONFIG_DIR.
  const f = recall.fuentes({ cuentas: (config.motores && config.motores.cuentas) || {}, env: { ...env, CLAUDECODE: '1' } });
  const cuenta = f.actual ? f.todas.find((c) => mismaRuta(path.resolve(c.dir), path.resolve(f.actual))) : null;
  if (!cuenta) return { ok: false, motivo: 'cuenta desconocida' };
  const clave = claveDeCuenta('claude', cuenta.nombre === recall.PRINCIPAL ? null : cuenta.nombre);
  const { crearAlmacenUso } = require('../mcp-server/lib/uso-agy.js');
  return crearAlmacenUso().registrarCuota(clave, cuota) ? { ok: true, clave } : { ok: false, motivo: 'no se pudo guardar' };
}

// ----------------------------------------------------------------- FEAT-105

const TIMEOUT_AGENTES_MS = 2000;
const TOPE_TITULO = 60;
const PROXIMAS = 3;

/**
 * Las sesiones de la red, del daemon (`GET /sesiones`). Sin enlace vivo,
 * `sin-enlace`; un error o el timeout tiran y la sección queda en `null`.
 * Solo nodo, nombre, proyecto (ya es el nombre de la carpeta), desde y si
 * está silenciada: ni host ni rutas.
 */
async function agentes(env = process.env) {
  const buzones = require('../mcp-server/lib/buzones.js');
  const { leerEnlace } = require('../mcp-server/lib/mensajes-cliente.js');
  const enlace = leerEnlace(buzones.dataDirPath(env));
  if (!enlace) return { estado: 'sin-enlace', sesiones: [] };
  const res = await fetch(`${enlace.url}/sesiones`, {
    headers: { 'x-lagrange-token': enlace.token },
    signal: AbortSignal.timeout(TIMEOUT_AGENTES_MS)
  });
  const r = await res.json();
  if (!r || !r.ok || !Array.isArray(r.sesiones)) throw new Error('respuesta inválida');
  const texto = (v) => (typeof v === 'string' ? v : null);
  const sesiones = r.sesiones.map((s) => ({
    nodo: texto(s.nodo) || '?', nombre: texto(s.nombre) || '?', proyecto: texto(s.proyecto), desde: texto(s.desde) || '?',
    silenciada: Boolean(s.silenciada)
  }));
  return { estado: 'ok', sesiones, ...(typeof r.aviso === 'string' ? { aviso: r.aviso } : {}) };
}

function almas(env = process.env) {
  const rutas = require('../mcp-server/almas/rutas.js');
  const cuarentena = require('../mcp-server/agents/cuarentena.js');
  let pendientes = 0;
  try {
    pendientes = fs.readdirSync(path.join(rutas.dirAlmas(env), '.pendientes')).filter((n) => n.endsWith('.json')).length;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const lista = cuarentena.listar(null, { homeDir: rutas.homeDir(env) });
  if (!lista.ok) throw new Error('cuarentena ilegible');
  return { pendientes, cuarentena: lista.entradas.length };
}

/** Solo título y próxima fecha: nunca el pedido ni el proyecto (vuelve a la conversación). */
function programaciones(env = process.env) {
  const buzones = require('../mcp-server/lib/buzones.js');
  let datos;
  try {
    datos = JSON.parse(fs.readFileSync(path.join(buzones.dataDirPath(env), 'programaciones.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { proximas: [], activas: 0, pausadas: 0 };
    throw err;
  }
  const lista = Array.isArray(datos && datos.programaciones) ? datos.programaciones.filter((p) => p && typeof p === 'object') : [];
  const activas = lista.filter((p) => p.activa);
  const proximas = activas
    .filter((p) => typeof p.proxima === 'string' && !Number.isNaN(Date.parse(p.proxima)))
    .sort((a, b) => Date.parse(a.proxima) - Date.parse(b.proxima))
    .slice(0, PROXIMAS)
    .map((p) => ({ titulo: String(p.titulo || '(sin título)').slice(0, TOPE_TITULO), proxima: p.proxima }));
  return { proximas, activas: activas.length, pausadas: lista.length - activas.length };
}

/** Carpetas de `.worktrees/` sin `.git`: git ya no las tiene. Solo avisa, no borra. */
function worktrees(cwd) {
  const dir = path.join(cwd, '.worktrees');
  let nombres;
  try {
    nombres = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const huerfanas = [];
  for (const nombre of nombres.sort()) {
    const carpeta = path.join(dir, nombre);
    if (fs.existsSync(path.join(carpeta, '.git'))) continue;
    let vacia = false;
    try { vacia = fs.readdirSync(carpeta).length === 0; } catch {}
    huerfanas.push({ nombre, vacia });
  }
  return huerfanas;
}

function seccion(fn) {
  try { return fn(); } catch { return null; }
}

async function seccionAsync(fn) {
  try { return await fn(); } catch { return null; }
}

/**
 * BE-095 — Antes de leer la cuota, la de agy se refresca si tiene más de 10 min,
 * solo por `agy -p /usage --output-format json` (agy ≥ 1.2.15). Nunca la captura
 * por PTY: es lenta y es para `agy_usage refresh_quota`. Con la cuota fresca no
 * lanza ningún proceso.
 */
async function refrescarAgy() {
  const { refrescarConAgy } = require('../mcp-server/lib/cuota-agy.js');
  return refrescarConAgy({ soloJson: true, umbralMs: 10 * 60 * 1000 });
}

async function main(argv = process.argv.slice(2), env = process.env, { refrescar = refrescarAgy } = {}) {
  const [modo, cwd = process.cwd(), ...resto] = argv;
  if (modo === 'cuota-sesion') return cuotaSesion(cwd, resto);
  if (modo === 'fanout') return { fanout: seccion(() => fanout(cwd)) };
  if (modo === 'foto') {
    await seccionAsync(refrescar);
    return {
      fanout: seccion(() => fanout(cwd)),
      cuota: seccion(cuota),
      versiones: seccion(() => versiones(cwd)),
      agentes: await seccionAsync(() => agentes(env)),
      almas: seccion(() => almas(env)),
      programaciones: seccion(() => programaciones(env)),
      worktrees: seccion(() => worktrees(cwd))
    };
  }
  return { error: 'modo desconocido' };
}

if (require.main === module) {
  const escribir = (salida) => process.stdout.write(JSON.stringify(salida));
  main().then(escribir, () => escribir({ error: 'falló' }));
}

module.exports = { main, fanout, pasoDe, cuota, versiones, cuotaSesion, agentes, almas, programaciones, worktrees, refrescarAgy };
