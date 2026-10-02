#!/usr/bin/env node
'use strict';

/**
 * FEAT-101 — Los datos del panel de Lagrange, para `hooks/panel-mod.tsx`.
 *
 *   node panel.js fanout <cwd>   { fanout }: la corrida de fan-out en curso (liviano).
 *   node panel.js foto <cwd>     { fanout, cuota, versiones }: todo el panel.
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

function fanout(cwd) {
  const d = corridaMasReciente(cwd);
  if (!d || estaExpirada(d)) return null;
  const tareas = Object.entries(d.tareas || {}).map(([id, t]) => ({ id, estado: (t && t.estado) || 'desconocido' }));
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

function seccion(fn) {
  try { return fn(); } catch { return null; }
}

function main(argv = process.argv.slice(2)) {
  const [modo, cwd = process.cwd(), ...resto] = argv;
  if (modo === 'cuota-sesion') return cuotaSesion(cwd, resto);
  if (modo === 'fanout') return { fanout: seccion(() => fanout(cwd)) };
  if (modo === 'foto') {
    return { fanout: seccion(() => fanout(cwd)), cuota: seccion(cuota), versiones: seccion(() => versiones(cwd)) };
  }
  return { error: 'modo desconocido' };
}

if (require.main === module) {
  let salida;
  try { salida = main(); } catch { salida = { error: 'falló' }; }
  process.stdout.write(JSON.stringify(salida));
}

module.exports = { main, fanout, cuota, versiones, cuotaSesion };
