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
const { SOLO_A_PEDIDO } = require('../motores/niveles.js');
const { formaDeFallback, validarMapaRespaldos, DESTINOS_VALIDOS_TEXTO } = require('./forma-fallback.js');

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
    // FEAT-166 — Un motor sin nada que configurar no tiene sección: así no queda
    // un `freno_cuota_5h` que nunca podría frenar (deepseek no informa cuota).
    if (roles.SIN_SECCION.includes(id)) {
      config.avisos.push(`motores.${id} no existe como sección (el motor no tiene nada que configurar); se ignora`);
      continue;
    }
    // FEAT-202 S4 (D5) — `freno_cuota` en todo motor con cupo por ventanas; `freno_cuota_5h`, el alias de antes, solo
    // donde ya existía. Una clave que el motor no acepta se avisa y se ignora.
    const aceptadas = roles.CLAVES_DE_SECCION[id] || ['freno_cuota', 'freno_cuota_5h'];
    for (const claveFreno of ['freno_cuota', 'freno_cuota_5h']) {
      if (valores[claveFreno] === undefined) continue;
      if (!aceptadas.includes(claveFreno)) {
        config.avisos.push(`motores.${id}.${claveFreno} no existe (el motor acepta: ${aceptadas.join(', ')}); se ignora`);
        continue;
      }
      const freno = valores[claveFreno];
      const actual = config.motores[id] || {};
      if (freno === null) config.motores[id] = { ...actual, [claveFreno]: null };
      else if (Number.isFinite(freno) && freno >= 0 && freno <= 1) config.motores[id] = { ...actual, [claveFreno]: freno };
    }
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
    // FEAT-166 — Un rol en deepseek manda la memoria de las almas a un tercero con
    // la key del usuario: solo lo decide la config global, como `motores.cuentas`.
    // Del proyecto se descarta ese rol con un aviso; el resto de la tabla sigue.
    let tabla = parsed.motores.roles;
    if (!global && tabla && typeof tabla === 'object' && !Array.isArray(tabla)) {
      const deProyecto = Object.entries(tabla).filter(([, e]) => e && typeof e === 'object' && roles.SOLO_GLOBAL.includes(e.motor));
      if (deProyecto.length) {
        tabla = Object.fromEntries(Object.entries(tabla).filter(([rol]) => !deProyecto.some(([r]) => r === rol)));
        config.avisos.push(`${deProyecto.map(([rol]) => rol).join(', ')}: un rol en ${deProyecto[0][1].motor} solo se lee de la configuración global (~/.claude/antigravity.json); el del proyecto se ignora`);
      }
    }
    const r = roles.validarRoles(tabla);
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
 * FEAT-097 — `fallback_agy`: `"claude@<cuenta>"`, `"deepseek"` (FEAT-168),
 * `"opencode-go"` (FEAT-175) o `null`. Solo de la config global: con el
 * fallback, los textos (incluido el transcript de un resumen) y las charlas van
 * a otra cuenta o a la API de DeepSeek u OpenCode Go, y un repositorio clonado
 * no puede decidir eso.
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
    avisar(`fallback_agy: Codex se retiró como fallback (FEAT-097); usá ${DESTINOS_VALIDOS_TEXTO}. Queda sin fallback`);
    return;
  }
  // FEAT-168 — `"deepseek"` (y `"opencode-go"`, FEAT-175) no tiene cuenta: la key va en el `.env` unificado.
  const forma = formaDeFallback(v);
  // El valor no se repite en el aviso: podría ser cualquier cosa pegada por error.
  if (!forma) {
    avisar(`fallback_agy tiene que ser ${DESTINOS_VALIDOS_TEXTO}; se ignora un valor de tipo ${Array.isArray(v) ? 'array' : typeof v}`);
    return;
  }
  const cuentas = (config.motores && config.motores.cuentas) || {};
  if (forma.motor === 'claude' && !Object.prototype.hasOwnProperty.call(cuentas, forma.cuenta)) {
    avisar(`fallback_agy: la cuenta "${forma.cuenta}" no está en motores.cuentas; queda sin fallback`);
    return;
  }
  config.fallbackAgy = v;
}

/**
 * FEAT-205 — `fallback_agy_roles`: el respaldo de cada rol (`{ rol: destino | null }`), con el global
 * (`fallback_agy`) como valor por defecto. Solo global, por la misma razón que `fallback_agy`. La carga es tolerante:
 * una entrada que no vale se ignora con un aviso y el resto sigue (la escritura es estricta). Va después de
 * `aplicarMotores`, que trae las cuentas.
 */
function aplicarFallbackRoles(config, parsed, { global = true, stderr = process.stderr } = {}) {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'fallback_agy_roles')) return;
  const avisar = (texto) => {
    config.avisos.push(texto);
    try { stderr.write(`[antigravity-mcp] ${texto}
`); } catch {}
  };
  if (!global) {
    avisar('fallback_agy_roles solo se lee de la configuración global (~/.claude/antigravity.json); la del proyecto se ignora');
    return;
  }
  config.fallbackAgyRoles = {};
  const cuentas = Object.keys((config.motores && config.motores.cuentas) || {});
  // FEAT-206 — Con los roles ya cargados: claude a claude se conserva con un aviso (no rige).
  const r = validarMapaRespaldos(parsed.fallback_agy_roles, cuentas, { roles: (config.motores && config.motores.roles) || {} });
  if (!r.ok) { avisar(`${r.motivo}; se ignora`); return; }
  for (const a of r.avisos) avisar(a);
  config.fallbackAgyRoles = r.mapa;
}

// FEAT-135 / FEAT-194 — `background_toasts`: qué avisos de fondo muestra el mod. "all"
// (por defecto), "none" o una lista ("fanout,lotes" o ["fanout", "lotes"]).
const TIPOS_AVISOS_FONDO = ['fanout', 'lotes', 'cuota', 'mensajes', 'informes'];

/** La lista de tipos, o `null` si el valor no se entiende. */
function tiposAvisosFondo(valor) {
  if (valor === 'all') return [...TIPOS_AVISOS_FONDO];
  if (valor === 'none') return [];
  const lista = Array.isArray(valor) ? valor : typeof valor === 'string' ? valor.split(',') : null;
  if (!lista) return null;
  const tipos = lista.map((x) => String(x).trim()).filter(Boolean);
  if (!tipos.length || tipos.some((x) => !TIPOS_AVISOS_FONDO.includes(x))) return null;
  return [...new Set(tipos)];
}

// FEAT-159 — `timeout_minutes`: entero de 1 a 120. Antes valía cualquier cosa
// no falsa (un "15" de texto llegaba a la aritmética del timeout).
const TIMEOUT_MAX = 120;
const timeoutValido = (v) => Number.isInteger(v) && v >= 1 && v <= TIMEOUT_MAX;

function aplicarTimeout(config, parsed) {
  if (parsed.timeout_minutes === undefined || parsed.timeout_minutes === null) return;
  if (timeoutValido(parsed.timeout_minutes)) config.defaultTimeoutMinutes = parsed.timeout_minutes;
  else config.avisos.push(`timeout_minutes = ${JSON.stringify(parsed.timeout_minutes)} se ignora: tiene que ser un entero de 1 a ${TIMEOUT_MAX}`);
}

/** FEAT-162 — Los modos del orquestador: solo leer y operar, pedir permiso para ejecutar, o todo (YOLO). */
const MODOS_ORQUESTACION = Object.freeze(['operar', 'pedir', 'yolo']);

/**
 * FEAT-169 — `sesiones_claude`: qué carpetas ofrece `/claude` además de las de
 * confianza de cada cuenta, cuáles oculta, con qué cuenta y modo abre cada una
 * y cuántas sesiones remotas corren a la vez. Solo de la config global: un repo
 * clonado no agrega rutas a la lista ni elige el login. Se valida por entrada:
 * una carpeta mal escrita no tira abajo `ocultos`, que volvería a mostrar lo
 * que el usuario escondió. Corre después de `aplicarMotores` (usa sus cuentas).
 */
const MODOS_SPAWN_CLAUDE = Object.freeze(['same-dir', 'worktree']);
const MAX_SESIONES_CLAUDE_DEFECTO = 3;
const MAX_SESIONES_CLAUDE_TOPE = 10;
const CUENTA_PRINCIPAL = 'principal';

function sesionesClaudePorDefecto() {
  return { cuentaPorDefecto: null, maxSesiones: MAX_SESIONES_CLAUDE_DEFECTO, directorios: {}, ocultos: [] };
}

function aplicarSesionesClaude(config, parsed, { global = true, homeDir = '' } = {}) {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'sesiones_claude')) return;
  if (!global) {
    config.avisos.push('sesiones_claude solo se lee de la configuración global (~/.claude/antigravity.json); la del proyecto se ignora');
    return;
  }
  const crudo = parsed.sesiones_claude;
  const salida = sesionesClaudePorDefecto();
  config.sesionesClaude = salida;
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) {
    config.avisos.push('sesiones_claude tiene que ser un objeto; se ignora');
    return;
  }
  const cuentas = (config.motores && config.motores.cuentas) || {};
  if (Object.prototype.hasOwnProperty.call(cuentas, CUENTA_PRINCIPAL)) {
    config.avisos.push('motores.cuentas tiene una cuenta "principal": en sesiones_claude ese nombre es siempre ~/.claude');
  }
  const cuentaValida = (c) => c === CUENTA_PRINCIPAL || (typeof c === 'string' && roles.RE_CUENTA.test(c) && Object.prototype.hasOwnProperty.call(cuentas, c));
  const ruta = (r) => {
    if (typeof r !== 'string' || !r.trim() || /[\x00-\x1f]/.test(r)) return null;
    const t = r.trim();
    if (!path.isAbsolute(t) && t !== '~' && !/^~[\\/]/.test(t)) return null;
    return roles.expandirRuta(t, homeDir);
  };

  if (crudo.cuenta_por_defecto !== undefined && crudo.cuenta_por_defecto !== null) {
    if (cuentaValida(crudo.cuenta_por_defecto)) salida.cuentaPorDefecto = crudo.cuenta_por_defecto;
    else config.avisos.push(`sesiones_claude.cuenta_por_defecto "${crudo.cuenta_por_defecto}" no es principal ni una cuenta de motores.cuentas; se ignora`);
  }
  if (crudo.max_sesiones !== undefined) {
    const n = crudo.max_sesiones;
    if (Number.isInteger(n) && n >= 1 && n <= MAX_SESIONES_CLAUDE_TOPE) salida.maxSesiones = n;
    else config.avisos.push(`sesiones_claude.max_sesiones = ${JSON.stringify(n)} se ignora: tiene que ser un entero de 1 a ${MAX_SESIONES_CLAUDE_TOPE}`);
  }
  if (crudo.directorios !== undefined) {
    const dirs = crudo.directorios;
    if (!dirs || typeof dirs !== 'object' || Array.isArray(dirs)) {
      config.avisos.push('sesiones_claude.directorios tiene que ser un objeto { "<ruta>": { modo, cuenta } }; se ignora');
    } else {
      for (const [clave, meta] of Object.entries(dirs)) {
        const resuelta = ruta(clave);
        if (!resuelta) { config.avisos.push(`sesiones_claude.directorios: "${clave}" no es una ruta absoluta; se ignora`); continue; }
        const m = meta === null || meta === undefined ? {} : meta;
        if (typeof m !== 'object' || Array.isArray(m)) { config.avisos.push(`sesiones_claude.directorios["${clave}"] tiene que ser un objeto; se ignora`); continue; }
        if (m.modo !== undefined && !MODOS_SPAWN_CLAUDE.includes(m.modo)) {
          config.avisos.push(`sesiones_claude.directorios["${clave}"].modo "${m.modo}" no es ${MODOS_SPAWN_CLAUDE.join(' ni ')}; se ignora la entrada`);
          continue;
        }
        if (m.cuenta !== undefined && !cuentaValida(m.cuenta)) {
          config.avisos.push(`sesiones_claude.directorios["${clave}"].cuenta "${m.cuenta}" no es principal ni una cuenta de motores.cuentas; se ignora la entrada`);
          continue;
        }
        salida.directorios[resuelta] = { modo: m.modo || null, cuenta: m.cuenta || null };
      }
    }
  }
  if (crudo.ocultos !== undefined) {
    if (!Array.isArray(crudo.ocultos)) {
      config.avisos.push('sesiones_claude.ocultos tiene que ser una lista de rutas; se ignora');
    } else {
      for (const r of crudo.ocultos) {
        const resuelta = ruta(r);
        if (resuelta) salida.ocultos.push(resuelta);
        else config.avisos.push(`sesiones_claude.ocultos: ${JSON.stringify(r)} no es una ruta absoluta; se ignora`);
      }
    }
  }
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
    // FEAT-135 — Los avisos de fondo del mod (toasts).
    backgroundToasts: [...TIPOS_AVISOS_FONDO],
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
    // FEAT-205 — El respaldo de cada rol; sin la clave, todos heredan el global. Solo global.
    fallbackAgyRoles: {},
    // FEAT-133 — `identidad_sesion` cruda, solo de la config global. La valida
    // quien la usa (`identidad-sesion.js`), igual que el statusline.
    identidadSesion: null,
    // FEAT-162 — Qué puede hacer una sesión que orquesta la consola: operar | pedir | yolo. Solo global.
    orquestacionModo: 'pedir',
    // FEAT-194 — Despertar automático para recoger informes del modo manual. Solo global.
    agyAutoRecoger: false,
    // FEAT-169 — Las sesiones remotas de `/claude`. Solo global.
    sesionesClaude: sesionesClaudePorDefecto(),
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
      aplicarTimeout(config, parsed);
      if (parsed.voicebox_url) config.voiceboxUrl = parsed.voicebox_url;
      if (parsed.voicebox_port) config.voiceboxPort = parsed.voicebox_port;
      if (parsed.fanout_statusline !== undefined) config.fanoutStatusline = !!parsed.fanout_statusline;
      if (parsed.fanout_statusline_delegate !== undefined) config.fanoutStatuslineDelegate = parsed.fanout_statusline_delegate;
      if (parsed.fanout_control !== undefined) config.fanoutControl = !!parsed.fanout_control;
      if (parsed.fanout_stop_check_interval_ms !== undefined) config.fanoutStopCheckIntervalMs = parsed.fanout_stop_check_interval_ms;
      if (parsed.fanout_progress_log !== undefined) config.fanoutProgressLog = !!parsed.fanout_progress_log;
      if (['auto', 'container', 'host'].includes(parsed.readonly_isolation)) config.readonlyIsolation = parsed.readonly_isolation;
      if (tiposAvisosFondo(parsed.background_toasts)) config.backgroundToasts = tiposAvisosFondo(parsed.background_toasts);
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      vb.aplicarClavesVoicebox(config, parsed);
      aplicarMotores(config, parsed);
      aplicarFallback(config, parsed);
      aplicarFallbackRoles(config, parsed);
      aplicarIdentidad(config, parsed);
      aplicarSesionesClaude(config, parsed, { homeDir });
      aplicarAutoRecoger(config, parsed);
      if (MODOS_ORQUESTACION.includes(parsed.orquestacion_modo)) config.orquestacionModo = parsed.orquestacion_modo;
      config.configFile = globalPath;
    } catch {}
  }

  if (fs.existsSync(projectPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
      if (parsed.model) config.defaultModel = parsed.model;
      if (parsed.effort) config.defaultEffort = parsed.effort;
      aplicarTimeout(config, parsed);
      if (parsed.voicebox_url) config.voiceboxUrl = parsed.voicebox_url;
      if (parsed.voicebox_port) config.voiceboxPort = parsed.voicebox_port;
      if (parsed.fanout_statusline !== undefined) config.fanoutStatusline = !!parsed.fanout_statusline;
      if (parsed.fanout_statusline_delegate !== undefined) config.fanoutStatuslineDelegate = parsed.fanout_statusline_delegate;
      if (parsed.fanout_control !== undefined) config.fanoutControl = !!parsed.fanout_control;
      if (parsed.fanout_stop_check_interval_ms !== undefined) config.fanoutStopCheckIntervalMs = parsed.fanout_stop_check_interval_ms;
      if (parsed.fanout_progress_log !== undefined) config.fanoutProgressLog = !!parsed.fanout_progress_log;
      if (['auto', 'container', 'host'].includes(parsed.readonly_isolation)) config.readonlyIsolation = parsed.readonly_isolation;
      if (tiposAvisosFondo(parsed.background_toasts)) config.backgroundToasts = tiposAvisosFondo(parsed.background_toasts);
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      vb.aplicarClavesVoicebox(config, parsed);
      aplicarMotores(config, parsed, { global: false });
      aplicarFallback(config, parsed, { global: false });
      aplicarFallbackRoles(config, parsed, { global: false });
      aplicarIdentidad(config, parsed, { global: false });
      aplicarSesionesClaude(config, parsed, { global: false });
      aplicarAutoRecoger(config, parsed, { global: false });
      config.configFile = projectPath;
    } catch {}
  }

  bajarEsfuerzoSoloAPedido(config);
  return config;
}

/**
 * FEAT-190 — `xhigh` (y `max`) nunca es el esfuerzo por defecto: solo a pedido
 * explícito en la llamada. Set_config y Ajustes ya no lo dejan guardar; esto
 * cubre la edición a mano y `AGY_EFFORT`. Se descarta con aviso y rige el
 * implícito del modelo (`medium` en Hydrogen).
 */
function bajarEsfuerzoSoloAPedido(config) {
  const e = config.defaultEffort ? String(config.defaultEffort).toLowerCase() : null;
  if (!e || !SOLO_A_PEDIDO.includes(e)) return;
  config.avisos.push(`effort "${config.defaultEffort}" no puede ser el esfuerzo por defecto (solo a pedido explícito en la llamada); se ignora y rige el del modelo`);
  config.defaultEffort = null;
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

/** FEAT-194 — `agy_auto_recoger`: booleano opt-in solo global (fail-closed a false). */
function aplicarAutoRecoger(config, parsed, { global = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'agy_auto_recoger')) return;
  if (!global) {
    config.avisos.push('agy_auto_recoger solo se lee de la configuración global (~/.claude/antigravity.json); la del proyecto se ignora');
    return;
  }
  if (typeof parsed.agy_auto_recoger === 'boolean') config.agyAutoRecoger = parsed.agy_auto_recoger;
  else config.avisos.push(`agy_auto_recoger = ${JSON.stringify(parsed.agy_auto_recoger)} se ignora: tiene que ser booleano`);
}

module.exports = {
  MODOS_SPAWN_CLAUDE, MAX_SESIONES_CLAUDE_TOPE, CUENTA_PRINCIPAL, aplicarSesionesClaude,
  MODOS_ORQUESTACION, loadConfig, aplicarFallback, aplicarFallbackRoles, aplicarIdentidad, tiposAvisosFondo, TIPOS_AVISOS_FONDO, timeoutValido, TIMEOUT_MAX };
