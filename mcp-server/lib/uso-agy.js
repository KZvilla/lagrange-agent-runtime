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
 *
 * BE-039 — El uso sabe qué motor corrió cada llamada. `registrarLlamada({…})`
 * es la firma nueva; el `registrar(...)` posicional queda como envoltorio con
 * `motor: 'antigravity'`, así que sus llamadas no cambian. Campos nuevos, sin
 * romper el archivo existente: `motor`, `modelo_real`, `costo_usd` y `origen`
 * en `last_call`; `por_motor` en `session` y `today`; `cuota.claude` con la
 * última utilización vista de la suscripción. `quota_status` sigue siendo de agy.
 *
 * FEAT-074 — `cuota.antigravity` llega de `/usage` (`lib/cuota-agy.js`), por
 * grupo (`grupos.gemini`, `grupos.claude_gpt`), con la cuenta enmascarada y su
 * hash. La escribe `registrarCuota`: no es una llamada.
 */
const fs = require('node:fs');
const path = require('node:path');

const USAGE_LOCK_STALE_MS = 5000;
const USAGE_LOCK_WAIT_MS = 2000;

function rutaUso(env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  return path.join(home, '.claude', 'antigravity-usage.json');
}

/**
 * FEAT-084 — «Hoy» es el día local de la máquina, no el UTC: en UTC−3 el día
 * UTC cambia a las 21:00 y el contador de hoy quedaba en cero tres horas por
 * noche. El archivo lo escriben procesos de esta misma máquina, así que todos
 * usan el mismo huso.
 */
function diaLocal(fecha = new Date()) {
  const dos = (n) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
}

const dormirSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// BE-050 — Códigos con los que Windows informa un lock en delete pending.
const OCUPADO_TRANSITORIO = new Set(['EPERM', 'EACCES', 'EBUSY']);

// FEAT-086 — A qué modelo resolvió el alias de cada rol de claude.
const RE_ROL_RESOLUCION = /^(alma|consolidar):[a-z0-9][a-z0-9-]{0,63}$|^cast:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_MOTOR_CLAUDE = /^claude(@([a-z0-9][a-z0-9-]{0,31}))?$/;
const TOPE_RESOLUCIONES = 200;

/**
 * FEAT-086 — La tabla de resoluciones con este turno sumado (pura). `rol` el del
 * sujeto (`alma:<clave>`, `cast:<nombre>`, `consolidar:<clave>`); `modelo` el
 * pedido (un alias o un ID); `modeloReal` el que informó Claude.
 *
 *   - Solo claude (`claude` o `claude@<cuenta>`): agy no informa qué modelo corrió.
 *   - `modeloReal === modelo` no suma nada: es el respaldo de "no informó", o un
 *     ID fijado que resolvió a sí mismo.
 *   - Mismo alias y cuenta, modelo distinto: guarda el `anterior` y marca
 *     `cambio_en` UNA vez; los turnos siguientes con el modelo nuevo no re-marcan.
 *   - Alias o cuenta distintos: el rol se reconfiguró; entrada nueva, sin marca.
 *
 * Tope de `TOPE_RESOLUCIONES` entradas: se descartan las vistas hace más tiempo.
 */
function actualizarResolucion(tabla, { rol, motor, modelo, modeloReal, ahora = new Date() } = {}) {
  const m = RE_MOTOR_CLAUDE.exec(String(motor || ''));
  if (!m || !rol || !RE_ROL_RESOLUCION.test(rol)) return null;
  if (typeof modelo !== 'string' || !modelo || typeof modeloReal !== 'string' || !modeloReal || modelo === modeloReal) return null;
  const salida = { ...(tabla && typeof tabla === 'object' && !Array.isArray(tabla) ? tabla : {}) };
  const cuenta = m[2] || null;
  const cuando = ahora.toISOString();
  const previa = salida[rol];
  const mismaConfig = previa && previa.alias === modelo && (previa.cuenta || null) === cuenta;
  if (mismaConfig && previa.modelo === modeloReal) {
    salida[rol] = { ...previa, visto_en: cuando };
  } else if (mismaConfig) {
    salida[rol] = {
      alias: modelo, cuenta, modelo: modeloReal, visto_en: cuando,
      anterior: { modelo: previa.modelo, hasta: previa.visto_en || null }, cambio_en: cuando
    };
  } else {
    salida[rol] = { alias: modelo, cuenta, modelo: modeloReal, visto_en: cuando, anterior: null, cambio_en: null };
  }
  const claves = Object.keys(salida);
  if (claves.length > TOPE_RESOLUCIONES) {
    claves.sort((a, b) => String(salida[a].visto_en || '').localeCompare(String(salida[b].visto_en || '')));
    for (const k of claves.slice(0, claves.length - TOPE_RESOLUCIONES)) delete salida[k];
  }
  return salida;
}

function crearAlmacenUso({ ruta = rutaUso(), ahora = () => new Date(), stderr = process.stderr } = {}) {
  const rutaLock = `${ruta}.lock`;
  const base = () => {
    const fecha = ahora();
    const hoy = diaLocal(fecha);
    return {
      session_started_at: fecha.toISOString(),
      session: {
        total_calls: 0,
        // Claves abiertas: cualquier tool nueva se suma sola.
        calls_by_tool: {
          run: 0, plan: 0, review: 0, audit: 0, research: 0, summary: 0, narrate: 0, say: 0,
          charla: 0, cast: 0, consolidar: 0
        },
        input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0,
        total_tokens: 0, total_duration_seconds: 0,
        por_motor: {}
      },
      today: { date: hoy, total_calls: 0, total_tokens: 0, total_duration_seconds: 0, por_motor: {} },
      last_call: null,
      quota_status: 'HEALTHY'
    };
  };

  function adquirir() {
    const limite = Date.now() + USAGE_LOCK_WAIT_MS;
    for (;;) {
      try { return fs.openSync(rutaLock, 'wx'); } catch (err) {
        // En Windows un `open(..., "wx")` que choca con el unlink de otro
        // proceso informa EPERM/EACCES en vez de EEXIST: el lock está en
        // delete pending. BE-050: ahí `existsSync` da false (medido en el 100 %
        // de los EPERM), así que no sirve de criterio; se espera acá mismo, con
        // deadline, sin pasar por el stat de abajo, que vuelve sin dormir.
        if (OCUPADO_TRANSITORIO.has(err.code)) {
          if (Date.now() < limite) { dormirSync(10); continue; }
          stderr.write(`[antigravity] No se pudo tomar el lock de uso: ${err.message}. Se escribe sin exclusión.\n`);
          return null;
        }
        if (err.code !== 'EEXIST') {
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

  /**
   * Una llamada, de cualquier motor. `error` (string o null) marca la falla.
   * `cuota` es la forma que guarda `cuota.<motor>` (ver `cuotaDesdeRateLimit`).
   * FEAT-086 — `rol` (opcional): con él, la resolución del alias se suma a
   * `resoluciones` (ver `actualizarResolucion`).
   */
  function registrarLlamada({
    tool, motor = 'antigravity', modelo = null, modeloReal = null, esfuerzo = null, conversationId = null,
    duracion = 0, usage = null, error = null, costoUsd = null, origen = null, cuota = null, esError = Boolean(error),
    rol = null
  } = {}) {
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fd = adquirir();
      const datos = leer();
      const dur = Number.isFinite(duracion) ? duracion : 0;
      const inp = usage?.input_tokens || 0;
      const out = usage?.output_tokens || 0;
      const think = usage?.thinking_tokens || 0;
      const cache = usage?.cache_read_tokens || 0;
      const total = usage?.total_tokens || inp + out;
      const clave = tool || 'desconocida';
      datos.session.total_calls += 1;
      datos.session.calls_by_tool[clave] = (datos.session.calls_by_tool[clave] || 0) + 1;
      datos.session.input_tokens += inp;
      datos.session.output_tokens += out;
      datos.session.thinking_tokens += think;
      datos.session.cache_read_tokens += cache;
      datos.session.total_tokens += total;
      datos.session.total_duration_seconds += dur;
      datos.today.total_calls += 1;
      datos.today.total_tokens += total;
      datos.today.total_duration_seconds += dur;
      for (const tramo of [datos.session, datos.today]) {
        // Un archivo anterior a BE-039 no trae el mapa.
        if (!tramo.por_motor || typeof tramo.por_motor !== 'object') tramo.por_motor = {};
        const m = tramo.por_motor[motor] || { llamadas: 0, tokens: 0 };
        tramo.por_motor[motor] = { llamadas: (m.llamadas || 0) + 1, tokens: (m.tokens || 0) + total };
      }
      if (motor === 'antigravity') {
        datos.quota_status = /429|quota/i.test(error || '') ? 'RATE_LIMITED / QUOTA EXCEEDED' : 'HEALTHY';
      }
      if (cuota && typeof cuota === 'object') {
        const previa = datos.cuota && typeof datos.cuota === 'object' ? datos.cuota : {};
        datos.cuota = { ...previa, [motor]: { ...cuota, visto_en: ahora().toISOString() } };
      }
      datos.last_call = {
        tool: clave, motor, model: modelo || '(cli default)', modelo_real: modeloReal || null, effort: esfuerzo || 'default',
        conversation_id: conversationId || null, duration_seconds: dur,
        timestamp: ahora().toISOString(), is_error: Boolean(esError), origen: origen || null,
        usage: { input_tokens: inp, output_tokens: out, thinking_tokens: think, cache_read_tokens: cache, total_tokens: total }
      };
      // Solo si el motor lo da. En Claude es precio de lista: informativo bajo suscripción.
      if (Number.isFinite(costoUsd)) datos.last_call.costo_usd = costoUsd;
      const resoluciones = actualizarResolucion(datos.resoluciones, { rol, motor, modelo, modeloReal, ahora: ahora() });
      if (resoluciones) datos.resoluciones = resoluciones;
      escribir(datos);
    } catch (err) {
      stderr.write(`[antigravity] Failed to record usage: ${err.message}\n`);
    } finally { liberar(fd); }
  }

  /** La firma de siempre (12 llamadas en el MCP y los lotes): agy. */
  function registrar(tool, model, effort, conversationId, durationSeconds, usage, isError = false, errorMsg = '') {
    registrarLlamada({
      tool, motor: 'antigravity', modelo: model, esfuerzo: effort, conversationId,
      duracion: durationSeconds, usage, error: errorMsg || null, esError: isError
    });
  }

  /**
   * FEAT-074 — Guarda la cuota de un motor tal cual, reemplazando la anterior
   * entera: cada captura trae todos los grupos, y así una cuenta nueva nunca
   * se mezcla con la vieja. Con el mismo lock que las llamadas.
   */
  function registrarCuota(motor, cuota) {
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fd = adquirir();
      const datos = leer();
      const previa = datos.cuota && typeof datos.cuota === 'object' ? datos.cuota : {};
      datos.cuota = { ...previa, [motor]: { ...cuota, visto_en: cuota.visto_en || ahora().toISOString() } };
      escribir(datos);
      return true;
    } catch (err) {
      stderr.write(`[antigravity] No se pudo guardar la cuota de ${motor}: ${err.message}
`);
      return false;
    } finally { liberar(fd); }
  }

  /** La última cuota vista de un motor, o `null`. La lee el freno del preflight. */
  function leerCuota(motor = 'claude') {
    const c = leer().cuota;
    return c && typeof c === 'object' && c[motor] && typeof c[motor] === 'object' ? c[motor] : null;
  }

  /** FEAT-086 — `{ [rol]: { alias, cuenta, modelo, visto_en, anterior, cambio_en } }`. */
  function leerResoluciones() {
    const r = leer().resoluciones;
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  }

  // FEAT-086 — Reiniciar los contadores no borra las resoluciones: no son uso
  // de la sesión sino historia de a qué modelo resolvió cada alias.
  function reiniciar() {
    let fd = null;
    const datos = base();
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fd = adquirir();
      const previas = leerResoluciones();
      if (Object.keys(previas).length) datos.resoluciones = previas;
      escribir(datos);
    } finally { liberar(fd); }
    return datos;
  }

  return { ruta, leer, registrar, registrarLlamada, registrarCuota, leerCuota, leerResoluciones, reiniciar };
}

const numero = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * `rate_limit_info` de un evento `rate_limit_event` de `claude -p` → la forma
 * que se guarda en `cuota.claude`. Medido el 2026-09-23 (`sonda-base.jsonl`):
 * `unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}`, con `resetsAt`
 * en segundos Unix. `null` si no se entiende.
 */
function cuotaDesdeRateLimit(info) {
  if (!info || typeof info !== 'object') return null;
  const v = info.unifiedWindows || {};
  const fecha = (x) => (Number.isFinite(x) ? new Date(x * 1000).toISOString() : null);
  const util = (w) => (w && Number.isFinite(w.utilization) ? w.utilization : null);
  const cuota = {
    ventana_5h: util(v.five_hour),
    ventana_7d: util(v.seven_day),
    resetea_5h: fecha(v.five_hour && v.five_hour.resetsAt),
    resetea_7d: fecha(v.seven_day && v.seven_day.resetsAt),
    estado: typeof info.status === 'string' ? info.status : null
  };
  return cuota.ventana_5h === null && cuota.ventana_7d === null ? null : cuota;
}

// FEAT-085 — Un motor, o un motor y su cuenta (`claude@trabajo`).
const RE_CLAVE_MOTOR = /^[a-z][a-z0-9_-]{0,19}(@[a-z0-9][a-z0-9-]{0,31})?$/;

function proyectarPorMotor(mapa) {
  const salida = {};
  for (const [k, v] of Object.entries(mapa && typeof mapa === 'object' ? mapa : {})) {
    if (RE_CLAVE_MOTOR.test(k) && v && typeof v === 'object') {
      salida[k] = { llamadas: numero(v.llamadas), tokens: numero(v.tokens) };
    }
  }
  return salida;
}

function proyectarCuota(c) {
  if (!c || typeof c !== 'object') return null;
  const frac = (v) => (Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);
  const fecha = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  return {
    ventana5h: frac(c.ventana_5h),
    ventana7d: frac(c.ventana_7d),
    resetea5h: fecha(c.resetea_5h),
    resetea7d: fecha(c.resetea_7d),
    vistoEn: fecha(c.visto_en)
  };
}

/** FEAT-074 — La cuota de agy por grupo, sin el hash de la cuenta. `null` sin dato. */
function proyectarCuotaAgy(c) {
  if (!c || typeof c !== 'object' || !c.grupos || typeof c.grupos !== 'object') return null;
  const grupos = {};
  for (const [k, g] of Object.entries(c.grupos)) {
    if (!/^[a-z_]{1,20}$/.test(k) || !g || typeof g !== 'object') continue;
    const p = proyectarCuota({ ...g, visto_en: c.visto_en });
    grupos[k] = { ventana5h: p.ventana5h, ventana7d: p.ventana7d, resetea5h: p.resetea5h, resetea7d: p.resetea7d };
  }
  if (!Object.keys(grupos).length) return null;
  const texto = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const vistoEn = typeof c.visto_en === 'string' && !Number.isNaN(Date.parse(c.visto_en)) ? c.visto_en : null;
  return { grupos, cuenta: texto(c.cuenta, 80), fuente: texto(c.fuente, 20), vistoEn };
}

/**
 * `null` si no hay archivo o no se entiende. «Hoy» usa el mismo día **local**
 * que el almacén (`diaLocal`): el MCP recién lo pone en cero cuando vuelve a
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
  const hoyLocal = diaLocal(ahora);
  const hoy = datos.today && typeof datos.today === 'object' && datos.today.date === hoyLocal ? datos.today : {};
  const porHerramienta = {};
  for (const [k, v] of Object.entries(s.calls_by_tool || {})) {
    if (/^[a-z_]{1,20}$/.test(k) && numero(v) > 0) porHerramienta[k] = numero(v);
  }
  const fecha = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  // BE-039 — Los campos por motor y de cuota aparecen solo si hay dato: un
  // archivo anterior se resume exactamente como antes.
  const porMotor = proyectarPorMotor(s.por_motor);
  const cuotaClaude = proyectarCuota(datos.cuota && datos.cuota.claude);
  const cuotaAntigravity = proyectarCuotaAgy(datos.cuota && datos.cuota.antigravity);
  // FEAT-085 — La cuota de cada cuenta de Claude, por nombre de cuenta.
  const cuotaClaudePorCuenta = {};
  for (const [k, v] of Object.entries(datos.cuota && typeof datos.cuota === 'object' ? datos.cuota : {})) {
    const m = /^claude@([a-z0-9][a-z0-9-]{0,31})$/.exec(k);
    const c = m ? proyectarCuota(v) : null;
    if (c) cuotaClaudePorCuenta[m[1]] = c;
  }
  return {
    desde: fecha(datos.session_started_at),
    llamadas: numero(s.total_calls),
    tokens: numero(s.total_tokens),
    hoy: {
      llamadas: numero(hoy.total_calls),
      tokens: numero(hoy.total_tokens)
    },
    porHerramienta,
    cuota: typeof datos.quota_status === 'string' ? datos.quota_status.slice(0, 40) : null,
    ...(Object.keys(porMotor).length ? { porMotor } : {}),
    ...(cuotaClaude ? { cuotaClaude } : {}),
    ...(Object.keys(cuotaClaudePorCuenta).length ? { cuotaClaudePorCuenta } : {}),
    ...(cuotaAntigravity ? { cuotaAntigravity } : {})
  };
}

module.exports = { rutaUso, resumenUso, crearAlmacenUso, cuotaDesdeRateLimit, diaLocal, actualizarResolucion, TOPE_RESOLUCIONES };
