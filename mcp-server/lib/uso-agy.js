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

const USAGE_LOCK_STALE_MS = 5000;
const USAGE_LOCK_WAIT_MS = 2000;

function rutaUso(env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  return path.join(home, '.claude', 'antigravity-usage.json');
}

const dormirSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function crearAlmacenUso({ ruta = rutaUso(), ahora = () => new Date(), stderr = process.stderr } = {}) {
  const rutaLock = `${ruta}.lock`;
  const base = () => {
    const fecha = ahora();
    const hoy = fecha.toISOString().slice(0, 10);
    return {
      session_started_at: fecha.toISOString(),
      session: {
        total_calls: 0,
        calls_by_tool: { run: 0, plan: 0, review: 0, audit: 0, research: 0, summary: 0, narrate: 0, say: 0 },
        input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0,
        total_tokens: 0, total_duration_seconds: 0
      },
      today: { date: hoy, total_calls: 0, total_tokens: 0, total_duration_seconds: 0 },
      last_call: null,
      quota_status: 'HEALTHY'
    };
  };

  function adquirir() {
    const limite = Date.now() + USAGE_LOCK_WAIT_MS;
    for (;;) {
      try { return fs.openSync(rutaLock, 'wx'); } catch (err) {
        // En Windows un `open(..., "wx")` que choca con el unlink de otro
        // proceso puede informar EPERM/EACCES en vez de EEXIST. Si el lock
        // sigue ahí es contención normal: esperar evita perder un contador.
        const ocupado = err.code === 'EEXIST'
          || (['EPERM', 'EACCES'].includes(err.code) && fs.existsSync(rutaLock));
        if (!ocupado) {
          stderr.write(`[antigravity] No se pudo tomar el lock de uso: ${err.message}. Se escribe sin exclusión.\n`);
          return null;
        }
        try {
          if (Date.now() - fs.statSync(rutaLock).mtimeMs > USAGE_LOCK_STALE_MS) { fs.unlinkSync(rutaLock); continue; }
        } catch { continue; }
        if (Date.now() >= limite) { stderr.write('[antigravity] Lock de uso ocupado; Se escribe sin exclusión.\n'); return null; }
        dormirSync(20);
      }
    }
  }

  function liberar(fd) {
    if (fd === null) return;
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(rutaLock); } catch {}
  }

  function leer() {
    const defecto = base();
    try {
      const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (datos.today?.date !== defecto.today.date) datos.today = defecto.today;
      return { ...defecto, ...datos, usageFile: ruta };
    } catch (err) {
      if (err.code !== 'ENOENT') stderr.write(`[antigravity] ${ruta} ilegible (${err.message}); se parte de cero.\n`);
      return { ...defecto, usageFile: ruta };
    }
  }

  function escribir(datos) {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const { usageFile: _omitida, ...persistible } = datos;
    const temporal = `${ruta}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporal, JSON.stringify(persistible, null, 2), 'utf8');
      fs.renameSync(temporal, ruta);
    } catch (err) {
      try { fs.unlinkSync(temporal); } catch {}
      throw err;
    }
  }

  function registrar(tool, model, effort, conversationId, durationSeconds, usage, isError = false, errorMsg = '') {
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fd = adquirir();
      const datos = leer();
      const dur = Number.isFinite(durationSeconds) ? durationSeconds : 0;
      const inp = usage?.input_tokens || 0;
      const out = usage?.output_tokens || 0;
      const think = usage?.thinking_tokens || 0;
      const cache = usage?.cache_read_tokens || 0;
      const total = usage?.total_tokens || inp + out;
      datos.session.total_calls += 1;
      datos.session.calls_by_tool[tool] = (datos.session.calls_by_tool[tool] || 0) + 1;
      datos.session.input_tokens += inp;
      datos.session.output_tokens += out;
      datos.session.thinking_tokens += think;
      datos.session.cache_read_tokens += cache;
      datos.session.total_tokens += total;
      datos.session.total_duration_seconds += dur;
      datos.today.total_calls += 1;
      datos.today.total_tokens += total;
      datos.today.total_duration_seconds += dur;
      datos.quota_status = /429|quota/i.test(errorMsg || '') ? 'RATE_LIMITED / QUOTA EXCEEDED' : 'HEALTHY';
      datos.last_call = {
        tool, model: model || '(cli default)', effort: effort || 'default',
        conversation_id: conversationId || null, duration_seconds: dur,
        timestamp: ahora().toISOString(), is_error: isError,
        usage: { input_tokens: inp, output_tokens: out, thinking_tokens: think, cache_read_tokens: cache, total_tokens: total }
      };
      escribir(datos);
    } catch (err) {
      stderr.write(`[antigravity] Failed to record usage: ${err.message}\n`);
    } finally { liberar(fd); }
  }

  function reiniciar() {
    let fd = null;
    const datos = base();
    try { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fd = adquirir(); escribir(datos); }
    finally { liberar(fd); }
    return datos;
  }

  return { ruta, leer, registrar, reiniciar };
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

module.exports = { rutaUso, resumenUso, crearAlmacenUso };
