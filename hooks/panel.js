#!/usr/bin/env node
'use strict';

/**
 * FEAT-101 — Los datos del panel de Lagrange, para `hooks/panel-mod.tsx`.
 *
 *   node panel.js fanout <cwd>   { fanout }: la corrida de fan-out en curso (liviano).
 *   node panel.js red <cwd>      { red }: la red del daemon local (FEAT-121, liviano).
 *   node panel.js avisos <cwd>   { lotes, cuota, propia, tipos }: lo que miran los
 *                                avisos de fondo (FEAT-135, liviano: no refresca agy).
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
/** La clave de la cuenta de esta sesión (`claude` o `claude@<cuenta>`), o `null`. */
function claveDeEstaCuenta(cwd, env = process.env) {
  const { loadConfig } = require('../mcp-server/lib/config.js');
  const recall = require('../mcp-server/recall.js');
  const { claveDeCuenta, mismaRuta } = require('../mcp-server/motores/roles.js');
  const config = loadConfig(cwd);
  // Como en `versiones`: el hijo de `$.process.run` no hereda CLAUDECODE (S4) y
  // la cuenta principal no tiene CLAUDE_CONFIG_DIR.
  const f = recall.fuentes({ cuentas: (config.motores && config.motores.cuentas) || {}, env: { ...env, CLAUDECODE: '1' } });
  const cuenta = f.actual ? f.todas.find((c) => mismaRuta(path.resolve(c.dir), path.resolve(f.actual))) : null;
  if (!cuenta) return null;
  return claveDeCuenta('claude', cuenta.nombre === recall.PRINCIPAL ? null : cuenta.nombre);
}

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

  const clave = claveDeEstaCuenta(cwd, env);
  if (!clave) return { ok: false, motivo: 'cuenta desconocida' };
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

/**
 * FEAT-121 — La red del daemon local (`GET /red` del enlace): este daemon, los
 * nodos que conoce y las colas. Sin enlace vivo, `sin-enlace` (el daemon no
 * corre, o no levantó el enlace); un error o el timeout tiran y la sección
 * queda en `null`. El daemon ya manda solo nombres, versiones y estados.
 */
// ----------------------------------------------------------------- FEAT-135

/**
 * Los lotes para los avisos de fondo: id, motor, estado, cuándo se creó y
 * cuántas tareas quedaron para revisar. Ni repo, ni ramas, ni worktrees, ni
 * salidas: el toast solo dice qué terminó y cómo.
 */
function lotesAviso(env = process.env) {
  const buzones = require('../mcp-server/lib/buzones.js');
  const { crearRegistro } = require('../mcp-server/lotes/registro.js');
  const { lotes } = crearRegistro({ dir: buzones.dataDirPath(env) }).listarConEstado();
  return lotes.map((l) => {
    const tareas = Array.isArray(l.tareas) ? l.tareas : [];
    return {
      id: String(l.id),
      motor: typeof l.motor === 'string' ? l.motor : null,
      estado: String(l.estado),
      creado: typeof l.creado === 'string' ? l.creado : null,
      total: tareas.length,
      listas: tareas.filter((t) => t && t.estado === 'para revisar').length
    };
  });
}

/** `background_toasts` ya resuelto a una lista de tipos (FEAT-135). */
function tiposAvisos(cwd) {
  const { loadConfig, TIPOS_AVISOS_FONDO } = require('../mcp-server/lib/config.js');
  const t = loadConfig(cwd).backgroundToasts;
  return Array.isArray(t) ? t : [...TIPOS_AVISOS_FONDO];
}

async function red(env = process.env) {
  const buzones = require('../mcp-server/lib/buzones.js');
  const { leerEnlace } = require('../mcp-server/lib/mensajes-cliente.js');
  const enlace = leerEnlace(buzones.dataDirPath(env));
  if (!enlace) return { estado: 'sin-enlace' };
  let res;
  try {
    res = await fetch(`${enlace.url}/red`, { headers: { 'x-lagrange-token': enlace.token }, signal: AbortSignal.timeout(TIMEOUT_AGENTES_MS) });
  } catch (err) {
    // El enlace.json quedó de un daemon que ya no escucha: para el usuario es lo mismo.
    if (err && (err.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(err.message)))) return { estado: 'sin-enlace' };
    throw err;
  }
  const r = await res.json();
  if (!r || !r.ok || !r.local || !Array.isArray(r.nodos) || !Array.isArray(r.carriles)) throw new Error('respuesta inválida');
  return { estado: 'ok', local: r.local, servidor: r.servidor || null, nodos: r.nodos, carriles: r.carriles };
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
  let recientes = [];
  try { recientes = almasRecientes(env); } catch {}
  return { pendientes, cuarentena: lista.entradas.length, recientes };
}

// FEAT-127 — Quién estuvo activa, dónde y cuándo. Nunca memoria.md, usuario.md ni el resumen del diario:
// la memoria del alma no se le muestra al usuario (almas/bloque.js) y este texto vuelve a la conversación.
const VENTANA_RECIENTES_MS = 24 * 3600 * 1000;
const MAX_RECIENTES = 3;
const SUPERFICIE = /^[a-z-]{1,20}$/;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/g;

function almasRecientes(env = process.env, ahora = Date.now()) {
  const rutas = require('../mcp-server/almas/rutas.js');
  const diario = require('../mcp-server/almas/diario.js');
  // El `# Nombre` de alma.md, como `nombreEnAlma` de almas/operaciones.js (no exportado).
  const nombreEnAlma = (ruta) => {
    try { const m = /^#\s+(.+)$/m.exec(fs.readFileSync(ruta, 'utf8')); return m ? m[1].trim() : null; } catch { return null; }
  };
  let claves = [];
  try {
    claves = fs.readdirSync(rutas.dirAlmas(env), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const clave of claves) {
    try {
      const ultimo = diario.ultimas(clave, 1, env)[0];
      const ts = Date.parse(ultimo && ultimo.ts);
      if (!Number.isFinite(ts) || ahora - ts > VENTANA_RECIENTES_MS || ts - ahora > 60 * 1000) continue;
      const nombre = String(nombreEnAlma(rutas.rutasDe(clave, env).alma) || clave).replace(CONTROLES, '').trim().slice(0, 24) || clave;
      const superficie = typeof ultimo.superficie === 'string' && SUPERFICIE.test(ultimo.superficie) ? ultimo.superficie : null;
      out.push({ nombre, superficie, ts });
    } catch {}
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, MAX_RECIENTES);
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
  // FEAT-121 — Liviano: solo la red, para los avisos del mod.
  if (modo === 'red') return { red: await seccionAsync(() => red(env)) };
  // FEAT-135 — Liviano: sin refrescar agy (la liberación de una cuota se decide con el reloj).
  if (modo === 'avisos') {
    return {
      lotes: seccion(() => lotesAviso(env)),
      cuota: seccion(cuota),
      propia: seccion(() => claveDeEstaCuenta(cwd, env)),
      tipos: seccion(() => tiposAvisos(cwd))
    };
  }
  if (modo === 'foto') {
    await seccionAsync(refrescar);
    return {
      fanout: seccion(() => fanout(cwd)),
      cuota: seccion(cuota),
      versiones: seccion(() => versiones(cwd)),
      agentes: await seccionAsync(() => agentes(env)),
      red: await seccionAsync(() => red(env)),
      almas: seccion(() => almas(env)),
      programaciones: seccion(() => programaciones(env)),
      worktrees: seccion(() => worktrees(cwd)),
      // FEAT-126 — Solo lee metas.json: medir es de hooks/metas.js, con los comandos aprobados por la cuenta.
      metas: seccion(() => require('../mcp-server/lib/metas.js').listar({ cwd, env }).metas)
    };
  }
  return { error: 'modo desconocido' };
}

if (require.main === module) {
  const escribir = (salida) => process.stdout.write(JSON.stringify(salida));
  main().then(escribir, () => escribir({ error: 'falló' }));
}

module.exports = { main, fanout, pasoDe, cuota, versiones, cuotaSesion, claveDeEstaCuenta, lotesAviso, tiposAvisos, agentes, red, almas, almasRecientes, programaciones, worktrees, refrescarAgy };
