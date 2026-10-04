/**
 * FEAT-104 — La línea de Lagrange en la statusline: solo lo que hay que saber
 * ya, y nada si no hay nada que decir.
 *
 *   - agy sin cuota (y a qué cuenta va el fallback), o agy cerca del tope;
 *   - el daemon del bridge caído (lock huérfano: murió sin limpiar);
 *   - esta copia de Lagrange más vieja que otra cuenta;
 *   - memoria esperando en cuarentena.
 *
 * Sincrónica: el estado del daemon lo resuelve `main` antes (`ctx.daemon`),
 * porque `estadoDaemon` vive en un módulo ESM del bridge. Cada parte por su
 * lado: una que falla se pierde sola.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SEP = ' │ ';
const CUOTA_AGY_FRESCA_MS = 6 * 60 * 60 * 1000;
const UMBRAL_AGY = 0.7;

// BE-102 — Cómo se muestra cada grupo de cuota de agy. Es el mismo mapa que `NOMBRE_GRUPO_AGY` en
// hooks/panel-texto.ts: el mod no puede importar este archivo (sin Node) ni este al mod (TypeScript).
const NOMBRE_GRUPO_AGY = { claude_gpt: 'claude/gpt' };

function hora(ms) {
  return new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function parteAgy({ cwd, ahora }) {
  const { crearAlmacenUso, resumenUso } = require('./uso-agy.js');
  const fallback = require('./fallback-agy.js');
  const hasta = fallback.crearEstado(crearAlmacenUso()).cuotaHasta();
  if (hasta > ahora) {
    const { loadConfig } = require('./config.js');
    const cuenta = fallback.cuentaDeFallback(loadConfig(cwd));
    return cuenta ? `agy sin cuota → claude@${cuenta} hasta ${hora(hasta)}` : `agy sin cuota hasta ${hora(hasta)}`;
  }
  const c = (resumenUso() || {}).cuotaAntigravity;
  const visto = c ? Date.parse(c.vistoEn || '') : NaN;
  if (!c || !Number.isFinite(visto) || ahora - visto > CUOTA_AGY_FRESCA_MS) return null;
  let peor = null;
  for (const [grupo, v] of Object.entries(c.grupos || {})) {
    if (v && Number.isFinite(v.ventana5h) && (!peor || v.ventana5h > peor.uso)) peor = { grupo, uso: v.ventana5h };
  }
  return peor && peor.uso > UMBRAL_AGY ? `agy ${NOMBRE_GRUPO_AGY[peor.grupo] || peor.grupo} ${Math.round(peor.uso * 100)}%` : null;
}

/** Solo un lock huérfano: `sin-lock` es un apagado limpio (o nunca instalado), no una caída. */
function parteDaemon({ daemon }) {
  return daemon && (daemon.motivo === 'pid-muerto' || daemon.motivo === 'otro-arranque') ? 'bridge caído' : null;
}

function parteVersion({ cwd }) {
  const { versiones } = require('../../hooks/panel.js');
  const { compararVersiones } = require('./proveedores.js');
  const v = versiones(cwd);
  if (!v || !v.propia) return null;
  let max = null;
  for (const c of v.cuentas || []) {
    if (c.version && (!max || (compararVersiones(c.version, max) || 0) > 0)) max = c.version;
  }
  return max && (compararVersiones(v.propia, max) || 0) < 0 ? `⟳ lagrange ${v.propia} < ${max}` : null;
}

function parteCuarentena() {
  const { listar } = require('../agents/cuarentena.js');
  const r = listar();
  const n = r && r.ok ? r.entradas.length : 0;
  return n > 0 ? `🧪 ${n} en cuarentena` : null;
}

const PARTES = [parteAgy, parteDaemon, parteVersion, parteCuarentena];

function segmentoLagrange(ctx) {
  const datos = { cwd: (ctx && ctx.cwd) || process.cwd(), daemon: ctx ? ctx.daemon : null, ahora: (ctx && ctx.ahora) || Date.now() };
  const textos = PARTES.map((parte) => {
    try { return parte(datos); } catch { return null; }
  }).filter(Boolean);
  return textos.length ? textos.join(SEP) : null;
}

/**
 * El estado del daemon con la función canónica del bridge (`paths.js`, ESM),
 * o `null`. Va `pathToFileURL`: en Windows, `import()` no acepta `C:\...`.
 */
async function estadoDelDaemon() {
  try {
    const { pathToFileURL } = require('node:url');
    const ruta = path.join(__dirname, '..', '..', 'telegram-bridge', 'paths.js');
    if (!fs.existsSync(ruta)) return null;
    const rutas = await import(pathToFileURL(ruta).href);
    return rutas.estadoDaemon();
  } catch {
    return null;
  }
}

module.exports = { segmentoLagrange, estadoDelDaemon, parteAgy, parteDaemon, parteVersion, parteCuarentena };
