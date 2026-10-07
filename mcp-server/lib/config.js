/**
 * Configuración del plugin: variables de entorno más `.claude/antigravity.json`
 * global y del proyecto (el del proyecto gana).
 *
 * Vivía en `index.js`. Se extrajo (FEAT-055) para que el daemon de Telegram
 * resuelva la voz con la misma configuración que `say`: `index.js` no se
 * puede importar, porque arranca el servidor MCP al cargarse.
 */

const fs = require('node:fs');
const path = require('node:path');
const vb = require('../voicebox-server.js');
const { DENY_MATAR_POR_NOMBRE } = require('./higiene-procesos.js');
const roles = require('../motores/roles.js');

/**
 * BE-039 — `motores.<id>.freno_cuota_5h` (0-1): el freno opt-in de cuota que
 * aplica `motores/politicas.js`. Solo se acepta un número en rango; cualquier
 * otra cosa se ignora (sin freno), nunca frena por un valor mal escrito.
 */
function aplicarMotores(config, parsed, { global = true } = {}) {
  if (!parsed.motores || typeof parsed.motores !== 'object') return;
  for (const [id, valores] of Object.entries(parsed.motores)) {
    if (id === 'roles' || id === 'cuentas') continue;
    if (!/^[a-z][a-z0-9_-]{0,19}$/.test(id) || !valores || typeof valores !== 'object') continue;
    const freno = valores.freno_cuota_5h;
    const actual = config.motores[id] || {};
    if (freno === null) config.motores[id] = { ...actual, freno_cuota_5h: null };
    else if (Number.isFinite(freno) && freno >= 0 && freno <= 1) config.motores[id] = { ...actual, freno_cuota_5h: freno };
    // FEAT-072 — La ruta de claude.exe (§3.6). Mal escrita se ignora y se
    // resuelve por PATH.
    if (id === 'claude' && valores.bin !== undefined) {
      const bin = roles.validarBin(valores.bin);
      if (bin.ok) config.motores.claude = { ...(config.motores.claude || {}), bin: bin.bin };
      else config.avisos.push(bin.motivo);
    }
  }
  // FEAT-085 — Las cuentas de Claude (carpetas, nunca credenciales), solo de la
  // config global: un repo clonado no elige con qué login corre un rol. Todo o
  // nada, como los roles; un rol que nombre una cuenta ignorada lo frena el
  // `preflight` con el motivo.
  if (parsed.motores.cuentas !== undefined) {
    if (!global) {
      config.avisos.push('motores.cuentas solo se lee de la configuración global (~/.claude/antigravity.json); la del proyecto se ignora');
    } else {
      const c = roles.validarCuentas(parsed.motores.cuentas);
      if (c.ok) config.motores.cuentas = c.cuentas;
      else {
        delete config.motores.cuentas;
        config.avisos.push(`motores.cuentas se ignora entera: ${c.motivo}`);
      }
    }
  }
  // FEAT-072 — Qué motor corre cada rol. Todo o nada: una sección inválida se
  // reporta y se ignora entera, y todo queda en antigravity; nunca a medias.
  if (parsed.motores.roles !== undefined) {
    const r = roles.validarRoles(parsed.motores.roles);
    if (r.ok) {
      config.motores.roles = r.roles;
      config.avisos.push(...r.avisos);
    } else {
      delete config.motores.roles;
      config.avisos.push(`motores.roles se ignora entera: ${r.motivo}`);
    }
  }
}

/**
 * FEAT-097 — `fallback_agy`: `"claude@<cuenta>"` o `null`. Solo de la config
 * global: con el fallback, los textos (incluido el transcript de un resumen) y
 * las charlas van a otra cuenta, y un repositorio clonado no puede decidir eso.
 * La cuenta tiene que estar en `motores.cuentas` (que se aplica antes). El
 * `"codex"` de FEAT-093 se retiró: aviso y `null`. El aviso va a `avisos` y a
 * stderr, porque el MCP no muestra `avisos`.
 */
function aplicarFallback(config, parsed, { global = true, stderr = process.stderr } = {}) {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'fallback_agy')) return;
  const avisar = (texto) => {
    config.avisos.push(texto);
    try { stderr.write(`[antigravity-mcp] ${texto}
`); } catch {}
  };
  if (!global) {
    avisar('fallback_agy solo se lee de la configuración global (~/.claude/antigravity.json); la del proyecto se ignora');
    return;
  }
  const v = parsed.fallback_agy;
  config.fallbackAgy = null;
  if (v === null) return;
  if (v === 'codex') {
    avisar('fallback_agy: Codex se retiró como fallback (FEAT-097); usá "claude@<cuenta>" o null. Queda sin fallback');
    return;
  }
  const m = typeof v === 'string' ? /^claude@(.+)$/.exec(v) : null;
  // El valor no se repite en el aviso: podría ser cualquier cosa pegada por error.
  if (!m || !roles.RE_CUENTA.test(m[1])) {
    avisar(`fallback_agy tiene que ser "claude@<cuenta>" o null; se ignora un valor de tipo ${Array.isArray(v) ? 'array' : typeof v}`);
    return;
  }
  const cuentas = (config.motores && config.motores.cuentas) || {};
  if (!Object.prototype.hasOwnProperty.call(cuentas, m[1])) {
    avisar(`fallback_agy: la cuenta "${m[1]}" no está en motores.cuentas; queda sin fallback`);
    return;
  }
  config.fallbackAgy = v;
}

function loadConfig(cwd = process.cwd()) {
  const config = {
    defaultModel: process.env.AGY_MODEL || null,
    defaultEffort: process.env.AGY_EFFORT || null,
    defaultTimeoutMinutes: parseInt(process.env.AGY_TIMEOUT_MINUTES, 10) || 15,
    voiceboxUrl: process.env.VOICEBOX_URL || null,
    voiceboxPort: parseInt(process.env.VOICEBOX_PORT, 10) || null,
    ...vb.CONFIG_POR_DEFECTO,
    fanoutStatusline: true,
    fanoutStatuslineDelegate: null,
    fanoutControl: true,
    fanoutStopCheckIntervalMs: parseInt(process.env.AGY_FANOUT_STOP_INTERVAL_MS, 10) || 2000,
    fanoutProgressLog: true,
    // SEC-020 fase 2 — Dónde corren agy_plan/agy_review/agy_audit: auto | container | host.
    readonlyIsolation: 'auto',
    permissions: {
      allow: ['read', 'edit', 'commands', 'network'],
      deny: [],
      deny_paths: ['.env*', '**/*.key', '**/*.pem'],
      // BE-032 — Complemento de las reglas: matar procesos por nombre se lleva lo ajeno.
      deny_commands: ['git push*', 'git reset --hard*', 'npm publish*', 'rm -rf /*', ...DENY_MATAR_POR_NOMBRE],
      sandbox: false
    },
    motores: {},
    // FEAT-097 — `"claude@<cuenta>"` activa el fallback cuando agy no puede. Solo global.
    fallbackAgy: null,
    // FEAT-133 — `identidad_sesion` cruda, solo de la config global. La valida
    // quien la usa (`identidad-sesion.js`), igual que el statusline.
    identidadSesion: null,
    // FEAT-072 — Lo que se ignoró de la configuración, para mostrarlo.
    avisos: [],
    configFile: null
  };

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const globalPath = path.join(homeDir, '.claude', 'antigravity.json');
  const projectPath = path.join(cwd, '.claude', 'antigravity.json');

  if (fs.existsSync(globalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
      if (parsed.model) config.defaultModel = parsed.model;
      if (parsed.effort) config.defaultEffort = parsed.effort;
      if (parsed.timeout_minutes) config.defaultTimeoutMinutes = parsed.timeout_minutes;
      if (parsed.voicebox_url) config.voiceboxUrl = parsed.voicebox_url;
      if (parsed.voicebox_port) config.voiceboxPort = parsed.voicebox_port;
      if (parsed.fanout_statusline !== undefined) config.fanoutStatusline = !!parsed.fanout_statusline;
      if (parsed.fanout_statusline_delegate !== undefined) config.fanoutStatuslineDelegate = parsed.fanout_statusline_delegate;
      if (parsed.fanout_control !== undefined) config.fanoutControl = !!parsed.fanout_control;
      if (parsed.fanout_stop_check_interval_ms !== undefined) config.fanoutStopCheckIntervalMs = parsed.fanout_stop_check_interval_ms;
      if (parsed.fanout_progress_log !== undefined) config.fanoutProgressLog = !!parsed.fanout_progress_log;
      if (['auto', 'container', 'host'].includes(parsed.readonly_isolation)) config.readonlyIsolation = parsed.readonly_isolation;
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      vb.aplicarClavesVoicebox(config, parsed);
      aplicarMotores(config, parsed);
      aplicarFallback(config, parsed);
      aplicarIdentidad(config, parsed);
      config.configFile = globalPath;
    } catch {}
  }

  if (fs.existsSync(projectPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
      if (parsed.model) config.defaultModel = parsed.model;
      if (parsed.effort) config.defaultEffort = parsed.effort;
      if (parsed.timeout_minutes) config.defaultTimeoutMinutes = parsed.timeout_minutes;
      if (parsed.voicebox_url) config.voiceboxUrl = parsed.voicebox_url;
      if (parsed.voicebox_port) config.voiceboxPort = parsed.voicebox_port;
      if (parsed.fanout_statusline !== undefined) config.fanoutStatusline = !!parsed.fanout_statusline;
      if (parsed.fanout_statusline_delegate !== undefined) config.fanoutStatuslineDelegate = parsed.fanout_statusline_delegate;
      if (parsed.fanout_control !== undefined) config.fanoutControl = !!parsed.fanout_control;
      if (parsed.fanout_stop_check_interval_ms !== undefined) config.fanoutStopCheckIntervalMs = parsed.fanout_stop_check_interval_ms;
      if (parsed.fanout_progress_log !== undefined) config.fanoutProgressLog = !!parsed.fanout_progress_log;
      if (['auto', 'container', 'host'].includes(parsed.readonly_isolation)) config.readonlyIsolation = parsed.readonly_isolation;
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      vb.aplicarClavesVoicebox(config, parsed);
      aplicarMotores(config, parsed, { global: false });
      aplicarFallback(config, parsed, { global: false });
      aplicarIdentidad(config, parsed, { global: false });
      config.configFile = projectPath;
    } catch {}
  }

  return config;
}

/**
 * FEAT-133 — `identidad_sesion`: quién es cada cuenta y con qué voz habla. Solo
 * de la config global, como `motores.cuentas`: un repositorio clonado no decide
 * con qué voz habla una cuenta.
 */
function aplicarIdentidad(config, parsed, { global = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'identidad_sesion')) return;
  if (!global) {
    config.avisos.push('identidad_sesion solo se lee de la configuración global (~/.claude/antigravity.json); la del proyecto se ignora');
    return;
  }
  const v = parsed.identidad_sesion;
  config.identidadSesion = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

module.exports = { loadConfig, aplicarFallback, aplicarIdentidad };
