import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { sanitizeEnv, isPathDenied, resolveWorkspace } from './policy.js';
import { bridgeDataDirPath } from './paths.js';
import {
  getActiveClaudeSession,
  getActiveClaudeSessions,
  setActiveClaudeSession,
  clearActiveClaudeSession,
  claudeSessionKey
} from './state.js';

export {
  getActiveClaudeSession,
  getActiveClaudeSessions,
  setActiveClaudeSession,
  clearActiveClaudeSession,
  claudeSessionKey
};

/**
 * BE-044 — `CLAUDE_CONFIG_DIR` explícito (otra cuenta), o `null`. El `claude`
 * que lanza el bridge hereda el entorno del daemon (`sanitizeEnv`), así que
 * escribe sus datos donde esta función dice. Misma regla que `claudeDataDir()`
 * en `mcp-server/session-source.js`, que el bridge no importa.
 *
 * @param {Object} [env]
 * @returns {string|null}
 */
export function claudeConfigDir(env = process.env) {
  const explicito = (env.CLAUDE_CONFIG_DIR || '').trim();
  return explicito ? path.resolve(explicito) : null;
}

/**
 * Resuelve la ruta canónica del archivo .claude.json en el perfil del usuario.
 * Con `CLAUDE_CONFIG_DIR`, Claude Code lo guarda dentro de ese directorio.
 * Permite inyectar una ruta personalizada para entornos de prueba.
 *
 * @param {string|null} [customPath]
 * @returns {string}
 */
export function resolveClaudeJsonPath(customPath = null) {
  if (customPath) return customPath;
  const home = claudeConfigDir() || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude.json');
}

/**
 * Resuelve el ejecutable de Claude Code en el sistema de manera segura y sin shell.
 * Prioriza PATH y ubicaciones estándar conocidas en Windows y POSIX.
 *
 * @returns {string} Ruta absoluta al ejecutable o nombre del comando fallback.
 */
export function resolveClaudeBin() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'claude.exe' : 'claude';

  // 1. Intentar encontrarlo en PATH sin interpolación de shell
  try {
    const finder = isWin ? 'where.exe' : 'which';
    const found = execFileSync(finder, [binName], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim().split(/\r?\n/)[0];

    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {}

  // 2. Ubicaciones estándar habituales en Windows
  if (isWin) {
    const userProfile = process.env.USERPROFILE || os.homedir();
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;

    const candidatos = [
      path.join(userProfile, '.local', 'bin', 'claude.exe'),
      localAppData ? path.join(localAppData, 'Programs', 'Claude', 'claude.exe') : null,
      appData ? path.join(appData, 'npm', 'claude.cmd') : null,
      path.join(userProfile, '.local', 'bin', 'claude')
    ].filter(Boolean);

    for (const cand of candidatos) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
  }

  // 3. Fallback al nombre estándar
  return binName;
}

/**
 * Comprueba si un PID numérico corresponde a un proceso vivo en ejecución.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parsea el conjunto de workspaces explícitamente permitidos desde variables de entorno.
 * Soporta ALLOWED_CLAUDE_WORKSPACES o ALLOWED_WORKSPACES (separados por coma).
 * Si no está definido, retorna null (permitiendo todos los proyectos válidos no denegados).
 *
 * @param {Object} [env]
 * @returns {Set<string>|null}
 */
export function parseAllowedWorkspacesEnv(env = process.env) {
  const raw = env.ALLOWED_CLAUDE_WORKSPACES || env.ALLOWED_WORKSPACES || '';
  if (!raw.trim()) return null;
  const items = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

/**
 * Comprueba si existe un panel de tmux en ejecución asociado a una ruta física dada
 * que esté corriendo una instancia de Claude Code.
 *
 * @param {string} projectPath
 * @param {Function} [execFileSyncFn]
 * @returns {{ pid: number, source: string, projectPath: string }|null}
 */
export function checkTmuxSession(projectPath, execFileSyncFn = execFileSync) {
  try {
    const output = execFileSyncFn('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #{pane_current_path} #{pane_current_command}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const normalizedTarget = path.resolve(projectPath).toLowerCase();
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(' ');
      if (parts.length >= 3) {
        const panePid = parseInt(parts[0], 10);
        const panePath = parts[1];
        const cmd = parts.slice(2).join(' ');
        if (path.resolve(panePath).toLowerCase() === normalizedTarget && /claude/i.test(cmd)) {
          return { pid: panePid, source: 'tmux', projectPath: panePath };
        }
      }
    }
  } catch {
    // tmux no está instalado o no hay servidor activo
  }
  return null;
}

/**
 * Busca de forma no invasiva si ya existe una sesión activa de Claude Remote Control
 * para un proyecto dado en cualquiera de las fuentes posibles:
 * 1. Estado activo del bridge (`state.json`).
 * 2. Puntero oficial persistido por Claude Code (`~/.claude/projects/<slug>/bridge-pointer.json`).
 * 3. Paneles de tmux ejecutando Claude en ese directorio.
 *
 * Garantiza idempotencia: una única sesión por proyecto.
 *
 * FEAT-169 — Con `account`, una por proyecto y cuenta: el estado se filtra por
 * esa cuenta y el puntero se busca en su carpeta (`claudeHome`). tmux no dice
 * con qué cuenta corre Claude, así que solo cuenta para `principal`.
 *
 * @param {string} projectPath Ruta física al proyecto
 * @param {Object} [options]
 * @param {string|null} [options.account] Cuenta de la sesión buscada
 * @param {string|null} [options.claudeHome] Carpeta de datos de esa cuenta (default: la de `account` en
 *   `getConfiguredClaudeAccounts`, y sin cuenta la del daemon)
 * @param {Function} [options.isPidAliveFn] Comprobador de vida de PID
 * @param {Function} [options.tmuxCheckerFn] Comprobador de tmux
 * @returns {{ pid: number, source: string, account?: string, sessionId?: string, environmentId?: string, sessionName?: string, projectPath: string, spawnMode?: string }|null}
 */
export function findExistingClaudeSession(projectPath, {
  account = null,
  claudeHome = null,
  isPidAliveFn = isPidAlive,
  tmuxCheckerFn = checkTmuxSession
} = {}) {
  if (!projectPath || typeof projectPath !== 'string') return null;
  if (!claudeHome && account) {
    const info = getConfiguredClaudeAccounts().find((c) => c.account === account);
    claudeHome = info ? info.claudeHome : null;
  }
  if (!claudeHome) claudeHome = claudeConfigDir() || path.join(os.homedir(), '.claude');

  const normalizedTarget = path.resolve(projectPath);
  const isWin = process.platform === 'win32';
  const targetKey = isWin ? normalizedTarget.toLowerCase() : normalizedTarget;

  // 1. Estado registrado en el bridge
  const active = getActiveClaudeSessions({ isAliveFn: isPidAliveFn }).find((s) => {
    const activeKey = isWin ? path.resolve(s.projectPath).toLowerCase() : path.resolve(s.projectPath);
    return activeKey === targetKey && (!account || s.account === account);
  });
  if (active) {
    return {
      pid: active.pid,
      source: 'bridge',
      account: active.account,
      sessionName: active.sessionName,
      projectPath: active.projectPath,
      spawnMode: active.spawnMode
    };
  }

  // 2. Puntero oficial bridge-pointer.json de Claude Code en <claudeHome>/projects/
  const possibleSlugs = [
    normalizedTarget.replace(/[^a-zA-Z0-9]/g, '-'),
    normalizedTarget.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-')
  ];

  for (const slug of possibleSlugs) {
    const pointerPath = path.join(claudeHome, 'projects', slug, 'bridge-pointer.json');
    if (fs.existsSync(pointerPath)) {
      try {
        const raw = fs.readFileSync(pointerPath, 'utf8');
        const data = JSON.parse(raw);
        if (data.pid && isPidAliveFn(data.pid)) {
          return {
            pid: data.pid,
            source: 'claude-pointer',
            account: account || undefined,
            sessionId: data.sessionId,
            environmentId: data.environmentId,
            projectPath: normalizedTarget
          };
        }
      } catch {}
    }
  }

  // 3. Comprobación en tmux
  if (account && account !== CUENTA_PRINCIPAL) return null;
  try {
    const tmuxSession = tmuxCheckerFn(normalizedTarget);
    if (tmuxSession && isPidAliveFn(tmuxSession.pid)) {
      return tmuxSession;
    }
  } catch {}

  return null;
}

// FEAT-169 — Módulos CJS del MCP, cargados al usarse: test-bridge importa bot.js
// desde una copia parcial del árbol donde no están todos.
const requireCjs = createRequire(import.meta.url);

/** FEAT-169 — La cuenta por defecto de Claude Code (`~/.claude`), como en `identidad_sesion`. */
export const CUENTA_PRINCIPAL = 'principal';

/**
 * FEAT-169 — Config global de Lagrange (cuentas, identidades, `sesiones_claude`),
 * o `null` si no se puede leer: sin config, `/claude` sigue como antes.
 */
export function configDeLagrange() {
  try {
    return requireCjs('../mcp-server/lib/config.js').loadConfig(resolveWorkspace());
  } catch (err) {
    console.warn(`[claude-launcher] No se pudo leer la configuración de Lagrange: ${err.message}`);
    return null;
  }
}

/**
 * FEAT-169 — Las cuentas de Claude con las que `/claude` puede abrir sesión:
 * `principal` y las de `motores.cuentas` (FEAT-085). Cada una sabe dónde está su
 * `.claude.json` y sus `projects/` (con `CLAUDE_CONFIG_DIR`, los dos van dentro
 * de esa carpeta; sin ella, `~/.claude.json` y `~/.claude/`).
 *
 * BE-044 — Si el daemon corre con un `CLAUDE_CONFIG_DIR` que no es una cuenta
 * declarada, esa carpeta hace de `principal`, como hasta ahora.
 *
 * @param {Object} [options]
 * @param {Object|null} [options.config] Config ya cargada (`loadConfig`)
 * @param {string} [options.homeDir]
 * @param {Object} [options.env]
 * @returns {Array<{ account: string, configDir: string|null, claudeHome: string, claudeJsonPath: string, label: string }>}
 */
export function getConfiguredClaudeAccounts({
  config = configDeLagrange(),
  homeDir = process.env.USERPROFILE || os.homedir(),
  env = process.env
} = {}) {
  const cuentas = (config && config.motores && config.motores.cuentas) || {};
  const identidades = (config && config.identidadSesion) || {};
  const apodo = (cuenta) => {
    const nombre = identidades[cuenta] && identidades[cuenta].nombre;
    return typeof nombre === 'string' && nombre.trim() ? nombre.trim() : cuenta;
  };
  const isWin = process.platform === 'win32';
  const clave = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));

  const delDaemon = claudeConfigDir(env);
  const declarada = delDaemon && Object.values(cuentas).some((c) => c && c.configDir && clave(c.configDir) === clave(delDaemon));
  const principalDir = delDaemon && !declarada ? delDaemon : null;
  const salida = [{
    account: CUENTA_PRINCIPAL,
    configDir: principalDir,
    claudeHome: principalDir || path.join(homeDir, '.claude'),
    claudeJsonPath: principalDir ? path.join(principalDir, '.claude.json') : path.join(homeDir, '.claude.json'),
    label: apodo(CUENTA_PRINCIPAL)
  }];
  for (const [cuenta, entrada] of Object.entries(cuentas)) {
    // `principal` es siempre la cuenta por defecto (config.js avisa del choque).
    if (cuenta === CUENTA_PRINCIPAL || !entrada || typeof entrada.configDir !== 'string') continue;
    salida.push({
      account: cuenta,
      configDir: entrada.configDir,
      claudeHome: entrada.configDir,
      claudeJsonPath: path.join(entrada.configDir, '.claude.json'),
      label: apodo(cuenta)
    });
  }
  return salida;
}

/** Los `projects` de un `.claude.json`, o `null`. Solo lectura. */
function leerProyectosDeClaude(claudeJsonPath, existsFn) {
  let rawContent;
  try {
    if (!existsFn(claudeJsonPath)) return null;
    rawContent = fs.readFileSync(claudeJsonPath, 'utf8');
  } catch (err) {
    console.warn(`[claude-launcher] No se pudo leer .claude.json en ${claudeJsonPath}: ${err.message}`);
    return null;
  }
  let data;
  try {
    data = JSON.parse(rawContent);
  } catch (err) {
    console.warn(`[claude-launcher] Formato JSON inválido en ${claudeJsonPath}: ${err.message}`);
    return null;
  }
  const rawProjects = data?.projects;
  if (!rawProjects || typeof rawProjects !== 'object' || Array.isArray(rawProjects)) return null;
  return rawProjects;
}

/**
 * Lee de forma estrictamente segura y de solo lectura la Project Allowlist
 * (lista cerrada de workspaces autorizados).
 *
 * Invariantes de seguridad:
 * 1. NUNCA abre archivos en modo de escritura ni altera la configuración.
 * 2. Aplica filtro de rutas prohibidas de política (`isPathDenied`).
 * 3. Si se define ALLOWED_CLAUDE_WORKSPACES en el entorno, acota la lista solo a ellos.
 * 4. Descarta rutas inexistentes, WSL y duplicados de casing.
 *
 * FEAT-169 — Sin `claudeJsonPath`, junta los proyectos de confianza de todas
 * las cuentas (`getConfiguredClaudeAccounts`), suma `sesiones_claude.directorios`
 * y resta `sesiones_claude.ocultos`. Los invariantes 2 y 3 valen también para
 * las carpetas agregadas a mano. Con `claudeJsonPath`, lee solo ese archivo, como
 * cuenta `principal` (así lo usan los tests).
 *
 * @param {Object} [options]
 * @param {string|null} [options.claudeJsonPath] Ruta alternativa a .claude.json
 * @param {(p: string) => boolean} [options.existsFn] Verificador de existencia
 * @param {Set<string>|null} [options.allowedWorkspacesSet] Filtro explícito de allowlist
 * @param {string[]} [options.denyPaths] Patrones de exclusión
 * @param {Array|null} [options.accounts] Cuentas (`getConfiguredClaudeAccounts`)
 * @param {Object|null} [options.sesionesClaude] `config.sesionesClaude`
 * @returns {Array<{ id: string, numericId: number, path: string, name: string, displayName: string, spawnMode: string, hasTrustDialogAccepted: boolean, trustedAccounts: string[], preferredAccount: string|null, manual: boolean }>}
 */
export function getProjectAllowlist({
  claudeJsonPath = null,
  existsFn = (p) => fs.existsSync(p),
  allowedWorkspacesSet = parseAllowedWorkspacesEnv(),
  denyPaths = null,
  requireTrust = true,
  accounts = null,
  sesionesClaude = null
} = {}) {
  let fuentes;
  let sesiones = sesionesClaude;
  if (claudeJsonPath) {
    fuentes = [{ account: CUENTA_PRINCIPAL, claudeJsonPath }];
  } else if (accounts) {
    fuentes = accounts;
  } else {
    const config = configDeLagrange();
    fuentes = getConfiguredClaudeAccounts({ config });
    if (!sesiones) sesiones = config && config.sesionesClaude;
  }

  const isWin = process.platform === 'win32';
  const workspacesByDedup = new Map();

  // Normalizar a ruta completa canónica con el casing oficial del sistema de archivos.
  const canonica = (trimmed) => {
    let normalized = path.resolve(path.normalize(trimmed));
    if (isWin) {
      try {
        normalized = fs.realpathSync.native(normalized);
      } catch {
        if (/^[a-z]:/i.test(normalized)) {
          normalized = normalized[0].toUpperCase() + normalized.slice(1);
        }
      }
    }
    return normalized;
  };

  // Existencia física, políticas de rutas prohibidas (deny_paths) y la allowlist explícita del entorno.
  const admitida = (normalized, crudo) => {
    try {
      if (!existsFn(normalized)) return false;
    } catch {
      return false;
    }
    try {
      if (isPathDenied(normalized, denyPaths)) return false;
    } catch {}
    if (allowedWorkspacesSet) {
      const baseName = path.basename(normalized).toLowerCase();
      const normLower = normalized.toLowerCase();
      return allowedWorkspacesSet.has(normLower) ||
        allowedWorkspacesSet.has(baseName) ||
        allowedWorkspacesSet.has(crudo.toLowerCase());
    }
    return true;
  };

  const nuevo = (normalized) => ({
    path: normalized,
    name: path.basename(normalized) || normalized,
    parent: path.basename(path.dirname(normalized)) || '',
    spawnMode: null,
    trustedAccounts: [],
    untrusted: false,
    preferredAccount: null,
    manual: false
  });

  for (const fuente of fuentes) {
    const rawProjects = leerProyectosDeClaude(fuente.claudeJsonPath, existsFn);
    if (!rawProjects) continue;

    for (const rawPath of Object.keys(rawProjects)) {
      if (!rawPath || typeof rawPath !== 'string') continue;

      const trimmed = rawPath.trim();
      if (!trimmed) continue;

      // Descartar rutas WSL en runtime nativo Win32
      if (trimmed.startsWith('wsl:') || trimmed.startsWith('wsl.localhost')) {
        continue;
      }

      const normalized = canonica(trimmed);
      if (!admitida(normalized, trimmed)) continue;

      const dedupKey = isWin ? normalized.toLowerCase() : normalized;
      const projectConfig = (rawProjects[rawPath] && typeof rawProjects[rawPath] === 'object')
        ? rawProjects[rawPath]
        : {};

      // F-07: Si hay múltiples entradas para la misma ruta física (ej. c:/ vs C:\),
      // basta una con hasTrustDialogAccepted para confiar, y gana el primer
      // remoteControlSpawnMode explícito (las cuentas se recorren con principal primero).
      let entry = workspacesByDedup.get(dedupKey);
      if (!entry) {
        entry = nuevo(normalized);
        workspacesByDedup.set(dedupKey, entry);
      } else if (isWin && /^[A-Z]:/.test(normalized)) {
        entry.path = normalized;
      }
      if (projectConfig.hasTrustDialogAccepted === false) {
        entry.untrusted = true;
      } else if (!entry.trustedAccounts.includes(fuente.account)) {
        entry.trustedAccounts.push(fuente.account);
      }
      if (projectConfig.remoteControlSpawnMode && !entry.spawnMode) {
        entry.spawnMode = projectConfig.remoteControlSpawnMode;
      }
    }
  }

  // FEAT-169 — Las carpetas agregadas a mano: aparecen aunque ninguna cuenta les
  // haya aceptado la confianza (el launcher avisa al lanzar), y fijan modo y cuenta.
  for (const [rutaManual, meta] of Object.entries((sesiones && sesiones.directorios) || {})) {
    const normalized = canonica(rutaManual);
    if (!admitida(normalized, rutaManual)) continue;
    const dedupKey = isWin ? normalized.toLowerCase() : normalized;
    let entry = workspacesByDedup.get(dedupKey);
    if (!entry) {
      entry = nuevo(normalized);
      workspacesByDedup.set(dedupKey, entry);
    }
    entry.manual = true;
    if (meta && meta.modo) entry.spawnMode = meta.modo;
    if (meta && meta.cuenta) entry.preferredAccount = meta.cuenta;
  }

  for (const oculto of (sesiones && sesiones.ocultos) || []) {
    const normalized = canonica(oculto);
    workspacesByDedup.delete(isWin ? normalized.toLowerCase() : normalized);
  }

  const validWorkspaces = Array.from(workspacesByDedup.values())
    .filter((ws) => !requireTrust || ws.manual || ws.trustedAccounts.length > 0);

  return validWorkspaces.map((ws, index) => {
    // La carpeta padre va siempre, no solo ante colisiones: un botón que dice
    // «frontend» no dice de qué repo es, y el nombre de la carpeta de un
    // subproyecto rara vez lo identifica sin su padre.
    const displayName = ws.parent ? `${ws.name} (${ws.parent})` : ws.name;

    // F-05: Generar un ID determinista y compacto (8 chars hex) derivado de la ruta normalizada
    const hashId = crypto.createHash('sha256').update(ws.path.toLowerCase()).digest('hex').slice(0, 8);

    return {
      id: hashId,
      numericId: index,
      path: ws.path,
      name: ws.name,
      displayName,
      spawnMode: ws.spawnMode || 'same-dir',
      hasTrustDialogAccepted: ws.trustedAccounts.length > 0,
      trustedAccounts: ws.trustedAccounts,
      preferredAccount: ws.preferredAccount,
      manual: ws.manual
    };
  });
}

/**
 * Alias de compatibilidad retroactiva para getProjectAllowlist.
 *
 * @param {Object} [options]
 * @returns {Array<{ id: string, numericId: number, path: string, name: string, displayName: string, spawnMode: string }>}
 */
export function getKnownWorkspaces(options) {
  return getProjectAllowlist(options);
}

/**
 * Valida si una ruta física dada pertenece a la Project Allowlist.
 *
 * @param {string} workspacePath Ruta a validar
 * @param {Object} [options] Opciones de allowlist
 * @returns {boolean}
 */
export function isWorkspaceAllowed(workspacePath, options = {}) {
  if (!workspacePath || typeof workspacePath !== 'string') return false;
  const allowlist = getProjectAllowlist(options);
  const isWin = process.platform === 'win32';
  const target = isWin ? path.resolve(workspacePath).toLowerCase() : path.resolve(workspacePath);
  return allowlist.some((ws) => (isWin ? ws.path.toLowerCase() : ws.path) === target);
}

/**
 * FEAT-169 — Con qué cuenta se abre un workspace. La pedida (tiene que estar
 * configurada), si no la fija de `sesiones_claude.directorios`, si no la única
 * confiable, si no `cuenta_por_defecto` cuando es confiable ahí, si no la
 * primera confiable. Sin ninguna confiable (carpeta agregada a mano), la fija,
 * la por defecto o `principal`: el launcher avisa después que falta la confianza.
 *
 * @param {Object|null} targetWs Workspace de `getProjectAllowlist`
 * @param {Object} options
 * @param {string|null} [options.requestedAccount]
 * @param {string|null} [options.defaultAccount] `sesiones_claude.cuenta_por_defecto`
 * @param {Array<{ account: string }>} options.accounts
 * @returns {{ ok: true, account: string } | { ok: false, error: string }}
 */
export function resolveTargetAccount(targetWs, { requestedAccount = null, defaultAccount = null, accounts = [] } = {}) {
  const nombres = accounts.map((a) => a.account);
  if (requestedAccount) {
    if (!nombres.includes(requestedAccount)) {
      return { ok: false, error: `La cuenta "${requestedAccount}" no está configurada. Cuentas disponibles: ${nombres.join(', ')}.` };
    }
    return { ok: true, account: requestedAccount };
  }
  const confiables = (targetWs && targetWs.trustedAccounts) || [];
  const fija = targetWs && targetWs.preferredAccount && nombres.includes(targetWs.preferredAccount) ? targetWs.preferredAccount : null;
  const porDefecto = defaultAccount && nombres.includes(defaultAccount) ? defaultAccount : null;
  if (fija) return { ok: true, account: fija };
  if (confiables.length === 1) return { ok: true, account: confiables[0] };
  if (confiables.length > 1) return { ok: true, account: porDefecto && confiables.includes(porDefecto) ? porDefecto : confiables[0] };
  return { ok: true, account: porDefecto || CUENTA_PRINCIPAL };
}

/**
 * FEAT-169 — `Mobile-<carpeta>`, y con más de una cuenta configurada
 * `Mobile-<carpeta>-<apodo>`, para distinguirlas en la app de Claude. El apodo
 * pierde todo lo que no sea letra, dígito, `_` o `-`: el nombre viaja como
 * argumento, y con un `.cmd` pasa por cmd.exe.
 */
function nombreDeSesion(canonicalPath, accountInfo, cantidadDeCuentas) {
  const base = `Mobile-${path.basename(canonicalPath)}`;
  if (cantidadDeCuentas <= 1 || !accountInfo) return base;
  const apodo = String(accountInfo.label || accountInfo.account).replace(/[^\p{L}\p{N}_-]/gu, '');
  return apodo ? `${base}-${apodo}` : base;
}

/** FEAT-169 F4 — `<cuenta>:<id de 8 hex>`, la clave de `claudeSessionKey`. */
export const RE_CLAVE_SESION_CLAUDE = /^[a-z0-9][a-z0-9-]{0,31}:[0-9a-f]{8}$/;

/**
 * FEAT-169 — El log de una sesión: `claude-session-<cuenta>-<id>.log`. F4: la
 * consola lo lee por la clave, así que una clave que no tiene la forma no
 * arma ninguna ruta (null).
 */
export function rutaLogDeSesion(key) {
  if (typeof key !== 'string' || !RE_CLAVE_SESION_CLAUDE.test(key)) return null;
  return path.join(bridgeDataDirPath(), `claude-session-${key.replace(':', '-')}.log`);
}

/**
 * Inicia una sesión desacoplada de Claude Code en modo control remoto (remote-control).
 * Valida la existencia del workspace, verifica que pertenezca a la Project Allowlist,
 * aplica control de idempotencia (no spawnea si ya hay una sesión viva para el proyecto),
 * sanea el entorno para no heredar secretos de Telegram y persiste el PID atómicamente.
 *
 * FEAT-169 — Una sesión por proyecto y cuenta, hasta `sesiones_claude.max_sesiones`
 * a la vez. El hijo corre con la carpeta de la cuenta (`entornoParaClaude`) y
 * escribe su propio log, `claude-session-<cuenta>-<id>.log`.
 *
 * @param {Object} options
 * @param {string} options.workspacePath Ruta física al proyecto
 * @param {string} [options.sessionName] Nombre para la sesión remota (default: Mobile-<basename>[-<apodo>])
 * @param {string} [options.spawnMode] Modo de spawn: same-dir o worktree (default: el del workspace o same-dir)
 * @param {string|null} [options.account] Cuenta de Claude (default: `resolveTargetAccount`)
 * @param {Object|null} [options.config] Config de Lagrange ya cargada
 * @param {Array|null} [options.accounts] Cuentas (`getConfiguredClaudeAccounts`; inyectable para testing)
 * @param {number|null} [options.maxSessions] Tope de sesiones simultáneas (default: `sesiones_claude.max_sesiones`)
 * @param {string} [options.claudeBin] Ruta al binario de Claude (default: resolveClaudeBin())
 * @param {Function} [options.spawnFn] Función de spawn inyectable para testing (default: spawn)
 * @param {boolean} [options.replaceActive] Detiene todas las sesiones previas antes de lanzar (default: false)
 * @param {Object} [options.stopOptions] Opciones inyectables para stopClaudeRemoteSession (testing)
 * @param {Object} [options.allowlistOptions] Opciones inyectables para getProjectAllowlist
 * @param {boolean} [options.skipAllowlistCheck] Omite la verificación de allowlist (testing)
 * @param {Function} [options.findExistingFn] Comprobador inyectable de sesiones existentes (testing)
 * @returns {{ success: boolean, key?: string, account?: string, pid?: number, sessionName?: string, projectPath?: string, spawnMode?: string, logFile?: string, alreadyRunning?: boolean, source?: string, environmentId?: string, error?: string, limitReached?: boolean, activeSessions?: object[], untrustedAccount?: string, trustedAccounts?: string[] }}
 */
export function launchClaudeRemoteSession({
  workspacePath,
  sessionName,
  spawnMode,
  account = null,
  config = null,
  accounts = null,
  maxSessions = null,
  claudeBin = resolveClaudeBin(),
  spawnFn = spawn,
  replaceActive = false,
  stopOptions = {},
  allowlistOptions = {},
  skipAllowlistCheck = false,
  findExistingFn = findExistingClaudeSession,
  stdio = null
} = {}) {
  if (!workspacePath || typeof workspacePath !== 'string' || !fs.existsSync(workspacePath)) {
    return {
      success: false,
      error: `El directorio de trabajo no existe: ${workspacePath || '(no especificado)'}`
    };
  }

  const cfg = config || (accounts ? null : configDeLagrange());
  const cuentas = accounts || getConfiguredClaudeAccounts({ config: cfg });
  const sesiones = (cfg && cfg.sesionesClaude) || null;
  const listaOpciones = { accounts: cuentas, sesionesClaude: sesiones, ...allowlistOptions };

  // 1. Verificación de seguridad contra Project Allowlist (Separación de Allowlists)
  if (!skipAllowlistCheck && !isWorkspaceAllowed(workspacePath, listaOpciones)) {
    return {
      success: false,
      error: `Acceso denegado: El directorio '${workspacePath}' no pertenece a la Project Allowlist de workspaces autorizados.`
    };
  }

  // Obtener metadatos consolidados del workspace desde la Project Allowlist
  const isWin = process.platform === 'win32';
  const allowlist = getProjectAllowlist(listaOpciones);
  const targetKey = isWin ? path.resolve(workspacePath).toLowerCase() : path.resolve(workspacePath);
  const targetWs = allowlist.find((w) => (isWin ? w.path.toLowerCase() : w.path) === targetKey);
  const canonicalPath = (targetWs && targetWs.path) || workspacePath;

  const resuelta = resolveTargetAccount(targetWs, {
    requestedAccount: account,
    defaultAccount: sesiones && sesiones.cuentaPorDefecto,
    accounts: cuentas
  });
  if (!resuelta.ok) return { success: false, error: resuelta.error };
  const effectiveAccount = resuelta.account;
  const accountInfo = cuentas.find((c) => c.account === effectiveAccount) || null;

  // F-06: Validar si el workspace tiene aceptado el diálogo de confianza en Claude Code.
  // FEAT-169 — En la cuenta elegida. El .claude.json de Claude no se escribe nunca.
  const confiables = targetWs ? (targetWs.trustedAccounts || (targetWs.hasTrustDialogAccepted === false ? [] : [effectiveAccount])) : null;
  if (confiables && !confiables.includes(effectiveAccount)) {
    const otras = confiables.length ? ` (Este proyecto ya es confiable en: ${confiables.join(', ')}).` : '';
    const error = effectiveAccount === CUENTA_PRINCIPAL && !(accountInfo && accountInfo.configDir)
      ? `Workspace no confiable en Claude Code: Abre una terminal en '${canonicalPath}' y ejecuta 'claude' para aceptar el diálogo de confianza antes de usar Remote Control.${otras}`
      : `Workspace no confiable en la cuenta "${effectiveAccount}": abrí una terminal en '${canonicalPath}' con CLAUDE_CONFIG_DIR="${accountInfo ? accountInfo.configDir : ''}" y ejecutá 'claude' para aceptar el diálogo de confianza.${otras}`;
    return { success: false, untrustedAccount: effectiveAccount, trustedAccounts: confiables, error };
  }

  const effectiveSessionName = (typeof sessionName === 'string' && sessionName.trim().length > 0)
    ? sessionName.trim()
    : nombreDeSesion(canonicalPath, accountInfo, cuentas.length);

  const effectiveSpawnMode = (typeof spawnMode === 'string' && spawnMode.trim().length > 0)
    ? spawnMode.trim()
    : ((targetWs && targetWs.spawnMode) || 'same-dir');

  // 2. Idempotencia: Verificar si ya hay una sesión viva para este proyecto y cuenta (en bridge, Claude pointer o tmux)
  const existing = findExistingFn(canonicalPath, {
    account: effectiveAccount,
    ...(accountInfo ? { claudeHome: accountInfo.claudeHome } : {})
  });
  if (existing) {
    const registrada = setActiveClaudeSession({
      pid: existing.pid,
      projectPath: canonicalPath,
      sessionName: existing.sessionName || effectiveSessionName,
      account: effectiveAccount,
      spawnMode: existing.spawnMode || effectiveSpawnMode
    });

    return {
      success: true,
      alreadyRunning: true,
      key: registrada.key,
      account: effectiveAccount,
      pid: existing.pid,
      sessionName: existing.sessionName || effectiveSessionName,
      projectPath: canonicalPath,
      source: existing.source,
      environmentId: existing.environmentId,
      spawnMode: existing.spawnMode || effectiveSpawnMode
    };
  }

  // 3. Las otras sesiones: con replaceActive se detienen todas; si no, conviven hasta el tope.
  if (replaceActive) {
    if (getActiveClaudeSessions().length > 0) stopClaudeRemoteSession({ ...stopOptions, all: true });
  } else {
    const tope = maxSessions || (sesiones && sesiones.maxSesiones) || 3;
    const activas = getActiveClaudeSessions();
    if (activas.length >= tope) {
      return {
        success: false,
        limitReached: true,
        activeSessions: activas,
        error: `Se alcanzó el límite de sesiones remotas simultáneas (${activas.length}/${tope}). Detené una con /claude stop antes de abrir otra.`
      };
    }
  }

  // F-02: En Windows Node 20+, invocar .cmd/.bat con shell: false lanza EINVAL (CVE-2024-27980)
  const isCmdWrapper = isWin && /\.(cmd|bat)$/i.test(claudeBin);

  const spawnBin = isCmdWrapper ? (process.env.ComSpec || 'cmd.exe') : claudeBin;
  const spawnArgs = isCmdWrapper
    ? ['/d', '/s', '/c', claudeBin, 'remote-control', '--name', effectiveSessionName, `--spawn=${effectiveSpawnMode}`]
    : ['remote-control', '--name', effectiveSessionName, `--spawn=${effectiveSpawnMode}`];

  // Redirigir stdout y stderr a un log por sesión para trazabilidad, captura de URL y diagnóstico.
  // Se trunca al lanzar: a los 800 ms tiene solo la salida de este proceso.
  const sessionKey = claudeSessionKey(effectiveAccount, canonicalPath);
  const logFile = rutaLogDeSesion(sessionKey);
  let logFd = null;
  if (!stdio) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      logFd = fs.openSync(logFile, 'w');
    } catch {}
  }
  const effectiveStdio = stdio || (logFd !== null ? ['ignore', logFd, logFd] : 'ignore');

  // FEAT-169 — El entorno de la cuenta: sin la CLAUDE_CONFIG_DIR del daemon (BE-047),
  // con la de la cuenta si tiene carpeta propia, y sin los secretos de Lagrange (SEC-027).
  const { entornoParaClaude } = requireCjs('../mcp-server/motores/entorno.js');
  const childEnv = entornoParaClaude(sanitizeEnv(), { configDir: accountInfo ? accountInfo.configDir : null });

  let child;
  try {
    child = spawnFn(
      spawnBin,
      spawnArgs,
      {
        cwd: canonicalPath,
        detached: true,
        stdio: effectiveStdio,
        env: childEnv
      }
    );
  } catch (err) {
    if (logFd !== null) { try { fs.closeSync(logFd); } catch {} }
    return {
      success: false,
      error: `Error al invocar spawn sobre Claude: ${err.message}`
    };
  }

  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch {}
  }

  // F-01: Proteger el daemon contra eventos de error no capturados en el proceso hijo.
  // FEAT-169 — Solo se borra esta sesión, y solo si sigue con este PID.
  child.on?.('error', (err) => {
    console.error(`[claude-launcher] Error en el proceso hijo de Claude: ${err.message}`);
    clearActiveClaudeSession(sessionKey, { soloSiPid: child.pid });
  });

  // Limpiar la sesión si el proceso hijo finaliza de forma anticipada
  child.on?.('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`[claude-launcher] Proceso de Claude (PID ${child.pid}) finalizó (código: ${code}, señal: ${signal})`);
    }
    clearActiveClaudeSession(sessionKey, { soloSiPid: child.pid });
  });

  child.unref?.();

  setActiveClaudeSession({
    pid: child.pid,
    projectPath: canonicalPath,
    sessionName: effectiveSessionName,
    account: effectiveAccount,
    spawnMode: effectiveSpawnMode,
    logFile: stdio ? null : logFile
  });

  return {
    success: true,
    key: sessionKey,
    account: effectiveAccount,
    pid: child.pid,
    sessionName: effectiveSessionName,
    projectPath: canonicalPath,
    spawnMode: effectiveSpawnMode,
    logFile: stdio ? null : logFile
  };
}

/** Termina el árbol de procesos de una sesión. */
function terminarArbol(pid, { execFileSyncFn, execFileFn, platform, killFn }) {
  if (platform === 'win32') {
    // F-04: Ejecución síncrona para asegurar que el árbol de procesos muera antes de limpiar el estado
    const runner = execFileSyncFn || (execFileFn ? (cmd, args) => execFileFn(cmd, args, () => {}) : execFileSync);
    try {
      runner('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (err) {
      console.warn(`[claude-launcher] Aviso en taskkill: ${err.message}`);
    }
  } else {
    const doKill = killFn || process.kill;
    try {
      doKill(-pid, 'SIGTERM');
    } catch {
      try { doKill(pid, 'SIGTERM'); } catch {}
    }
    try {
      doKill(-pid, 'SIGKILL');
    } catch {
      try { doKill(pid, 'SIGKILL'); } catch {}
    }
  }
}

/**
 * Detiene la sesión remota activa de Claude Code terminando el árbol de procesos
 * y limpiando el estado de forma atómica.
 *
 * En Windows utiliza `taskkill /pid <PID> /T /F` para terminar todos los descendientes.
 * En POSIX envía señales SIGTERM y SIGKILL.
 *
 * FEAT-169 — Con `key`, esa sesión; con `all`, todas. Sin ninguno, la única que
 * haya; con varias no detiene nada y devuelve `ambiguous` con la lista, para
 * que quien llama pregunte cuál.
 *
 * @param {Object} [options]
 * @param {string|null} [options.key] Clave de la sesión (`<cuenta>:<id>`)
 * @param {boolean} [options.all] Detener todas
 * @param {Function} [options.execFileSyncFn] Función síncrona de ejecución (default: execFileSync)
 * @param {Function} [options.execFileFn] Función de compatibilidad para testing (default: null)
 * @param {string} [options.platform] Plataforma de destino (default: process.platform)
 * @param {Function} [options.killFn] Función de envío de señales para POSIX testing (default: process.kill)
 * @returns {{ success: boolean, pid?: number, sessionName?: string, projectPath?: string, account?: string, stopped?: object[], ambiguous?: boolean, sessions?: object[], error?: string }}
 */
export function stopClaudeRemoteSession({
  key = null,
  all = false,
  execFileSyncFn = null,
  execFileFn = null,
  platform = process.platform,
  killFn = null
} = {}) {
  const activas = getActiveClaudeSessions();
  let objetivo;
  if (all) {
    objetivo = activas;
  } else if (key) {
    objetivo = activas.filter((s) => s.key === key);
    if (!objetivo.length) return { success: false, error: 'No se encontró esa sesión activa de Claude.' };
  } else if (activas.length > 1) {
    return {
      success: false,
      ambiguous: true,
      sessions: activas,
      error: `Hay ${activas.length} sesiones activas: elegí cuál detener.`
    };
  } else {
    objetivo = activas;
  }

  if (!objetivo.length) {
    return {
      success: false,
      error: 'No hay ninguna sesión activa de Claude para detener.'
    };
  }

  const stopped = [];
  for (const sesion of objetivo) {
    terminarArbol(sesion.pid, { execFileSyncFn, execFileFn, platform, killFn });
    clearActiveClaudeSession(sesion.key, { soloSiPid: sesion.pid });
    stopped.push({
      key: sesion.key,
      account: sesion.account,
      pid: sesion.pid,
      sessionName: sesion.sessionName,
      projectPath: sesion.projectPath
    });
  }

  const [primera] = stopped;
  return {
    success: true,
    pid: primera.pid,
    sessionName: primera.sessionName,
    projectPath: primera.projectPath,
    account: primera.account,
    stopped
  };
}

/**
 * Inspecciona los worktrees de Git creados por Claude Code en el proyecto.
 * Clasifica cada worktree en limpio o con cambios según dos criterios estrictos:
 * 1. Working tree sin cambios locales (git status --porcelain está vacío).
 * 2. Rama sin commits por delante de la rama base (git log base..branch está vacío).
 *
 * @param {string} projectPath Ruta física al proyecto
 * @param {Function} [execFileSyncFn] Función inyectable para testing
 * @returns {{ cleanWorktrees: Array<{ path: string, branch: string, sessionId: string }>, dirtyWorktrees: Array<{ path: string, branch: string, sessionId: string, reason: string }> }}
 */
export function inspectClaudeWorktrees(projectPath, execFileSyncFn = execFileSync) {
  const result = { cleanWorktrees: [], dirtyWorktrees: [] };
  if (!projectPath || typeof projectPath !== 'string' || !fs.existsSync(projectPath)) {
    return result;
  }

  // Verificar si es un repositorio Git
  try {
    const isGit = execFileSyncFn('git', ['-C', projectPath, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (isGit !== 'true') return result;
  } catch {
    return result;
  }

  // Obtener la rama base del repositorio principal (ej. master o main)
  let baseBranch = 'master';
  try {
    const headRef = execFileSyncFn('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (headRef && headRef !== 'HEAD') {
      baseBranch = headRef;
    }
  } catch {}

  // Listar todos los worktrees con git worktree list --porcelain
  let rawList = '';
  try {
    rawList = execFileSyncFn('git', ['-C', projectPath, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return result;
  }

  // Parsear bloques por worktree
  const blocks = rawList.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let wtPath = '';
    let wtBranch = '';

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice(9).trim();
      } else if (line.startsWith('branch refs/heads/')) {
        wtBranch = line.slice(18).trim();
      }
    }

    if (!wtPath) continue;

    // Solo inspeccionar worktrees creados por Claude Code (en .claude/worktrees/bridge- o con rama worktree-bridge-)
    const isClaudeWorktree = wtPath.includes('.claude/worktrees/bridge-') ||
      wtPath.includes('.claude\\worktrees\\bridge-') ||
      wtBranch.startsWith('worktree-bridge-');

    if (!isClaudeWorktree) continue;

    // Extraer identificador de sesión si está presente
    const idMatch = wtBranch.match(/worktree-bridge-([a-zA-Z0-9_-]+)/) ||
      wtPath.match(/bridge-([a-zA-Z0-9_-]+)/);
    const sessionId = idMatch ? idMatch[1] : '';

    // Si la carpeta del worktree ya no existe en disco, se considera huérfano en metadata
    if (!fs.existsSync(wtPath)) {
      result.cleanWorktrees.push({ path: wtPath, branch: wtBranch, sessionId });
      continue;
    }

    // Criterio 1: Comprobar cambios sin commitear
    let statusOutput = '';
    try {
      statusOutput = execFileSyncFn('git', ['-C', wtPath, 'status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {
      statusOutput = 'error';
    }

    if (statusOutput.length > 0) {
      result.dirtyWorktrees.push({
        path: wtPath,
        branch: wtBranch,
        sessionId,
        reason: 'Archivos modificados sin commitear'
      });
      continue;
    }

    // Criterio 2: Comprobar commits por delante de la rama base
    let commitsAhead = 0;
    if (wtBranch && baseBranch && wtBranch !== baseBranch) {
      try {
        const logOutput = execFileSyncFn('git', ['-C', projectPath, 'log', `${baseBranch}..${wtBranch}`, '--oneline'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (logOutput.length > 0) {
          commitsAhead = logOutput.split(/\r?\n/).filter(Boolean).length;
        }
      } catch {}
    }

    if (commitsAhead > 0) {
      result.dirtyWorktrees.push({
        path: wtPath,
        branch: wtBranch,
        sessionId,
        reason: `${commitsAhead} commit(s) sin mergear hacia ${baseBranch}`
      });
      continue;
    }

    // Está 100% limpio y seguro para eliminar
    result.cleanWorktrees.push({ path: wtPath, branch: wtBranch, sessionId });
  }

  return result;
}

/**
 * Elimina de forma segura ÚNICAMENTE los worktrees de Claude Code que estén 100% limpios
 * (sin archivos modificados y sin commits propios por delante).
 *
 * @param {string} projectPath Ruta física al proyecto
 * @param {Function} [execFileSyncFn] Función inyectable para testing
 * @returns {{ removedCount: number, removedWorktrees: Array<{ path: string, branch: string }>, preservedCount: number, preservedWorktrees: Array<{ path: string, branch: string, reason: string }> }}
 */
export function pruneCleanClaudeWorktrees(projectPath, execFileSyncFn = execFileSync) {
  const { cleanWorktrees, dirtyWorktrees } = inspectClaudeWorktrees(projectPath, execFileSyncFn);
  const removedWorktrees = [];

  for (const wt of cleanWorktrees) {
    // 1. Desbloquear worktree
    try {
      execFileSyncFn('git', ['-C', projectPath, 'worktree', 'unlock', wt.path], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
    } catch {}

    // 2. Remover directorio del worktree
    try {
      execFileSyncFn('git', ['-C', projectPath, 'worktree', 'remove', wt.path, '--force'], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
    } catch {}

    // Si la carpeta sigue existiendo en disco, intentar removerla
    try {
      if (fs.existsSync(wt.path)) {
        fs.rmSync(wt.path, { recursive: true, force: true });
      }
    } catch {}

    // 3. Eliminar la rama temporal asociada
    if (wt.branch) {
      try {
        execFileSyncFn('git', ['-C', projectPath, 'branch', '-D', wt.branch], {
          stdio: ['ignore', 'ignore', 'ignore']
        });
      } catch {}
    }

    removedWorktrees.push(wt);
  }

  // 4. Limpiar metadatos huérfanos de git worktree
  try {
    execFileSyncFn('git', ['-C', projectPath, 'worktree', 'prune'], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch {}

  return {
    removedCount: removedWorktrees.length,
    removedWorktrees,
    preservedCount: dirtyWorktrees.length,
    preservedWorktrees: dirtyWorktrees
  };
}

