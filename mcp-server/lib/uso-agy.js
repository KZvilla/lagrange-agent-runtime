/**
 * FEAT-069 — Dónde vive el uso de agy que cuenta Lagrange, y un resumen para
 * mostrarlo.
 *
 * El archivo lo escribe el MCP (`recordUsage` en `index.js`, con su lock y su
 * escritura atómica). Acá no se escribe nada: `resumenUso` es una proyección de
 * solo lectura para la consola, con los campos que se muestran y nada más
 * —nunca la ruta del archivo, que diría el usuario y su carpeta—.
 * `loadUsage` sigue en `index.js` con el objeto completo: si esta proyección
 * se escribiera, se perderían los contadores que no lista.
 */
const fs = require('node:fs');
const path = require('node:path');

function rutaUso(env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  return path.join(home, '.claude', 'antigravity-usage.json');
}

const numero = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * `null` si no hay archivo o no se entiende. «Hoy» usa el mismo día que el MCP
 * (UTC, `index.js` ~238): el MCP recién lo pone en cero cuando vuelve a
 * escribir, así que un día viejo en el archivo se lee como cero, no como hoy.
 */
function resumenUso({ ruta = rutaUso(), leer = (r) => fs.readFileSync(r, 'utf8'), ahora = new Date() } = {}) {
  let datos;
  try {
    datos = JSON.parse(leer(ruta));
  } catch {
    return null;
  }
  if (!datos || typeof datos !== 'object' || !datos.session || typeof datos.session !== 'object') return null;
  const s = datos.session;
  const hoyUtc = ahora.toISOString().slice(0, 10);
  const hoy = datos.today && typeof datos.today === 'object' && datos.today.date === hoyUtc ? datos.today : {};
  const porHerramienta = {};
  for (const [k, v] of Object.entries(s.calls_by_tool || {})) {
    if (/^[a-z_]{1,20}$/.test(k) && numero(v) > 0) porHerramienta[k] = numero(v);
  }
  const fecha = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  return {
    desde: fecha(datos.session_started_at),
    llamadas: numero(s.total_calls),
    tokens: numero(s.total_tokens),
    hoy: {
      llamadas: numero(hoy.total_calls),
      tokens: numero(hoy.total_tokens)
    },
    porHerramienta,
    cuota: typeof datos.quota_status === 'string' ? datos.quota_status.slice(0, 40) : null
  };
}

module.exports = { rutaUso, resumenUso };
