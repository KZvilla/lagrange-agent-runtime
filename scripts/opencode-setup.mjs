#!/usr/bin/env node
/**
 * FEAT-177 — Track H de `lagrange:setup`: opencode nativo fuera del clon.
 *
 * Diagnostica dónde está parado el usuario (¿su cwd está en el clon?, ¿qué
 * versión de Lagrange corre este script?, ¿qué config de opencode manda?, ¿el
 * plugin global está al día?) y dice qué falta con acciones cerradas. Sin
 * dependencias: solo built-ins de Node.
 *
 *   node scripts/opencode-setup.mjs --diagnose [--json] [--probe]
 *
 * `--diagnose` no escribe nada. `--probe` agrega lo que consulta el servicio de
 * fondo de opencode (`mcp list`, `plugin list`) o crea directorios
 * (`debug paths`), así que es opt-in.
 *
 * El script exporta `diagnose(options)`: el CLI es una cáscara. Los tests
 * inyectan `spawn`, `resolveBin`, `version`, `cwd`, `home`, `configDir`, `env`
 * y `sourceRoot` para no depender de un opencode real.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// D9: la fuente es la raíz del plugin que ejecuta este script. No se usa
// `import.meta.dirname`: es Node 20.11+ y el repo soporta Node >= 18.
const RAIZ_DEL_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TIMEOUT_MS = 1_800_000;
const TIMEOUT_SERVICIO = { startup: 10_000, catalog: 10_000, execution: TIMEOUT_MS };
const RELATIVO_PLUGIN = path.join('.opencode', 'plugins', 'lagrange.js');
const RELATIVO_MCP = path.join('mcp-server', 'index.js');
const MAX_SALIDA_PROBE = 4000;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const esAbsoluta = (p) => path.win32.isAbsolute(p) || path.posix.isAbsolute(p);

/** Normaliza separadores para comparar rutas de cualquier plataforma. */
const normalizar = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

function leerTexto(ruta) {
  try { return fs.readFileSync(ruta, 'utf8'); } catch { return null; }
}

function sha256(ruta) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex'); } catch { return null; }
}

/** Semver completo: `1.56.0-beta.1` es anterior a `1.56.0` y no es estable. */
export function parsearSemver(texto) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(texto).trim());
  if (!m) return null;
  return {
    mayor: Number(m[1]),
    menor: Number(m[2]),
    parche: Number(m[3]),
    pre: m[4] ? m[4].split('.') : []
  };
}

/** <0, 0 o >0 según a < b, a = b, a > b. Devuelve 0 si alguno no es semver. */
export function compararSemver(a, b) {
  const x = parsearSemver(a);
  const y = parsearSemver(b);
  if (!x || !y) return 0;
  for (const k of ['mayor', 'menor', 'parche']) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  const largo = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < largo; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pNum !== qNum) {
      return pNum ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

const esEstable = (v) => {
  const s = parsearSemver(v);
  return Boolean(s) && s.pre.length === 0;
};

/** Quita los comentarios de línea y de bloque de un .jsonc, respetando las cadenas. */
function quitarComentarios(texto) {
  let salida = '';
  let i = 0;
  let enCadena = false;
  while (i < texto.length) {
    const c = texto[i];
    const n = texto[i + 1];
    if (enCadena) {
      salida += c;
      if (c === '\\') { salida += n ?? ''; i += 2; continue; }
      if (c === '"') enCadena = false;
      i++;
      continue;
    }
    if (c === '"') { enCadena = true; salida += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < texto.length && texto[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    salida += c;
    i++;
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Fuente, clon y directorios
// ---------------------------------------------------------------------------

/** La raíz del plugin que ejecuta el script, o null si le falta algo (`no-source`). */
function detectarFuente(raiz) {
  const plugin = path.join(raiz, RELATIVO_PLUGIN);
  const mcpServer = path.join(raiz, RELATIVO_MCP);
  if (!fs.existsSync(plugin) || !fs.existsSync(mcpServer)) return null;
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version ?? null; } catch { /* sin package.json */ }
  if (!version || !parsearSemver(version)) return null;
  return { root: raiz, version, plugin, mcpServer };
}

const tieneArchivosDeLagrange = (dir) =>
  fs.existsSync(path.join(dir, RELATIVO_MCP)) && fs.existsSync(path.join(dir, RELATIVO_PLUGIN));

/**
 * D12: ¿el cwd del usuario está dentro de un clon de Lagrange? Se mide sobre el
 * cwd, nunca sobre la raíz del script: el setup corre desde la caché aunque el
 * usuario esté parado en el clon.
 */
function estaDentroDelClon(cwd) {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (git.status === 0 && git.stdout.trim()) return tieneArchivosDeLagrange(path.resolve(git.stdout.trim()));
  // Sin git: caminar hacia arriba buscando `.git` junto a los dos archivos.
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) && tieneArchivosDeLagrange(dir)) return true;
    const padre = path.dirname(dir);
    if (padre === dir) return false;
    dir = padre;
  }
}

/** Precedencia de la config global de opencode (§5.1). */
function resolverConfigDir({ configDir, env, home, cwd }) {
  if (configDir) return path.resolve(cwd, configDir);
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(cwd, env.OPENCODE_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'opencode');
  return path.join(home, '.config', 'opencode');
}

/** Lo que `plugins/cache/<mercado>/lagrange/<versión>/` tiene instalado, de la más nueva a la más vieja. */
function leerCache(claudeDir) {
  const versiones = [];
  const cache = path.join(claudeDir, 'plugins', 'cache');
  let mercados = [];
  try { mercados = fs.readdirSync(cache, { withFileTypes: true }); } catch { /* sin caché */ }
  for (const mercado of mercados) {
    if (!mercado.isDirectory()) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(cache, mercado.name, 'lagrange'), { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (d.isDirectory() && parsearSemver(d.name) && !versiones.includes(d.name)) versiones.push(d.name);
    }
  }
  versiones.sort((a, b) => compararSemver(b, a));
  return { latest: versiones.find(esEstable) ?? null, versions: versiones };
}

// ---------------------------------------------------------------------------
// Config de opencode
// ---------------------------------------------------------------------------

/** La versión que codifica la ruta `.../<versión>/mcp-server/index.js`, o null. */
function versionDelComando(script) {
  if (!script || !esAbsoluta(script)) return null;
  const partes = normalizar(script).split('/');
  const n = partes.length;
  if (n < 3 || partes[n - 1] !== 'index.js' || partes[n - 2] !== 'mcp-server') return null;
  return parsearSemver(partes[n - 3]) ? partes[n - 3] : null;
}

/** El elemento del `command` que es el script (el primero después del ejecutable que no es un flag). */
function scriptDelComando(command) {
  if (!Array.isArray(command)) return null;
  return command.slice(1).find((x) => typeof x === 'string' && !x.startsWith('-')) ?? null;
}

function describirEntrada(entrada) {
  const command = Array.isArray(entrada.command) ? entrada.command : null;
  const script = scriptDelComando(command);
  const timeout = esObjeto(entrada.timeout)
    ? (typeof entrada.timeout.execution === 'number' ? entrada.timeout.execution : null)
    : (typeof entrada.timeout === 'number' ? entrada.timeout : null);
  return {
    command,
    absolute: script === null ? null : esAbsoluta(script),
    hostMarker: esObjeto(entrada.environment) && typeof entrada.environment.LAGRANGE_HOST === 'string'
      ? entrada.environment.LAGRANGE_HOST
      : null,
    timeout,
    commandVersion: versionDelComando(script),
    entryType: typeof entrada.type === 'string' ? entrada.type : null
  };
}

/**
 * Lee la config efectiva de `configDir`. Cuando hay `.json` y `.jsonc`, opencode
 * lee el último existente y gana el `.jsonc` (D5): el `.json` queda tapado.
 */
function leerConfig(configDir) {
  const json = path.join(configDir, 'opencode.json');
  const jsonc = path.join(configDir, 'opencode.jsonc');
  const hayJson = fs.existsSync(json);
  const hayJsonc = fs.existsSync(jsonc);
  const config = {
    dir: configDir,
    file: null,
    format: 'none',
    shadowed: hayJson && hayJsonc,
    shape: 'none',
    problem: null,
    ambiguous: false,
    command: null,
    absolute: null,
    hostMarker: null,
    timeout: null,
    commandVersion: null,
    entryType: null,
    text: null
  };
  if (!hayJson && !hayJsonc) return config;

  const archivo = hayJsonc ? jsonc : json;
  config.file = path.basename(archivo);
  const texto = leerTexto(archivo);
  if (texto === null) {
    config.format = 'invalid';
    config.problem = 'unreadable';
    return config;
  }

  if (hayJsonc) {
    // Sin parser JSONC: escaneo de texto, solo para decidir qué fragmento mostrar.
    config.format = 'jsonc';
    config.text = texto;
    const limpio = quitarComentarios(texto);
    const lagrange = (limpio.match(/"lagrange"\s*:/g) ?? []).length;
    const tieneMcp = /"mcp"\s*:/.test(limpio);
    const tieneServers = /"servers"\s*:/.test(limpio);
    if (lagrange === 0) config.shape = 'none';
    else if (lagrange === 1 && tieneMcp && tieneServers) config.shape = 'servers';
    else if (lagrange === 1 && tieneMcp) config.shape = 'legacy';
    else { config.shape = 'both'; config.ambiguous = true; }
    config.hostMarker = /"LAGRANGE_HOST"\s*:\s*"([^"]*)"/.exec(limpio)?.[1] ?? null;
    return config;
  }

  let datos;
  try { datos = JSON.parse(texto); } catch {
    config.format = 'invalid';
    config.problem = 'invalid-json';
    return config;
  }
  config.format = 'json';
  if (!esObjeto(datos)) { config.problem = 'not-object'; return config; }
  if (datos.mcp !== undefined && !esObjeto(datos.mcp)) { config.problem = 'mcp-not-object'; return config; }
  const mcp = datos.mcp ?? {};
  if (mcp.servers !== undefined && !esObjeto(mcp.servers)) { config.problem = 'servers-not-object'; return config; }

  const nueva = esObjeto(mcp.servers) && esObjeto(mcp.servers.lagrange) ? mcp.servers.lagrange : null;
  const legacy = esObjeto(mcp.lagrange) ? mcp.lagrange : null;
  config.shape = nueva && legacy ? 'both' : nueva ? 'servers' : legacy ? 'legacy' : 'none';
  const entrada = nueva ?? legacy;
  if (entrada) Object.assign(config, describirEntrada(entrada));
  return config;
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

/** Las funciones reales de `opencode-session.js`, cargadas solo si hacen falta (el script puede estar sin `mcp-server/`). */
function cargarHelpers() {
  return require(path.join(RAIZ_DEL_SCRIPT, 'mcp-server', 'opencode-session.js'));
}

/** El entorno con el que se lanza opencode: la misma config y el mismo HOME que usa el diagnóstico. */
function entornoDeOpencode(env, configDir, home, homeExplicito) {
  const hijo = { ...env, OPENCODE_CONFIG_DIR: configDir };
  if (homeExplicito) {
    if (process.platform === 'win32') hijo.USERPROFILE = home;
    else hijo.HOME = home;
  }
  return hijo;
}

const recortar = (s) => String(s ?? '').trim().slice(0, MAX_SALIDA_PROBE);

async function sondear(opencode, { helpers, spawn, cwd, env }) {
  opencode.probed = true;
  const correr = async (args) => {
    const r = await helpers.runProcess(opencode.bin, args, { spawnImpl: spawn, env, cwd, timeoutMs: 20_000 });
    return { code: r.code, output: recortar(r.stdout || r.stderr) };
  };
  for (const [clave, args] of [
    ['mcpList', ['mcp', 'list']],
    ['pluginList', ['plugin', 'list']],
    ['debugPaths', ['debug', 'paths', 'config']]
  ]) {
    try { opencode[clave] = await correr(args); } catch (e) { opencode[clave] = { code: null, output: e.message }; }
  }
}

// ---------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------

/** Qué le falta a una config `.json` efectiva para que apunte a esta copia de Lagrange (D6/D7). */
function motivosDeMerge(config, fuente) {
  const motivos = [];
  const esperado = normalizar(fuente.mcpServer);
  if (config.shape === 'none') return ['la entrada «lagrange» no existe'];
  const script = scriptDelComando(config.command);
  if (!config.command || config.command[0] !== 'node' || !script || normalizar(script) !== esperado) {
    motivos.push(`update-command: el command debe ser node ${fuente.mcpServer}`);
  }
  if (config.hostMarker !== 'opencode') motivos.push('add-host-marker: falta LAGRANGE_HOST=opencode');
  if (config.timeout === null || config.timeout < TIMEOUT_MS) motivos.push(`update-timeout: el timeout de ejecución debe ser ${TIMEOUT_MS} ms`);
  return motivos;
}

/**
 * El informe de §5.2. No escribe nada; con `probe` consulta el servicio de
 * fondo de opencode. Nunca lanza por falta de opencode: lo reporta.
 */
export async function diagnose(options = {}) {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const homeExplicito = Boolean(options.home);
  const home = path.resolve(options.home ?? os.homedir());
  const configDir = resolverConfigDir({ configDir: options.configDir, env, home, cwd });
  const claudeDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');

  const warnings = [];
  const actions = [];

  const fuente = detectarFuente(path.resolve(options.sourceRoot ?? RAIZ_DEL_SCRIPT));
  const insideClone = estaDentroDelClon(cwd);
  const config = leerConfig(configDir);
  const cache = leerCache(claudeDir);

  const rutaPlugin = path.join(configDir, 'plugins', 'lagrange.js');
  const existe = fs.existsSync(rutaPlugin);
  const globalPlugin = {
    path: rutaPlugin,
    exists: existe,
    stale: Boolean(fuente) && existe && sha256(rutaPlugin) !== sha256(fuente.plugin)
  };

  const host = env.OPENCODE === '1' || env.OPENCODE_SESSION_ID
    ? { detected: 'opencode', reason: env.OPENCODE === '1' ? 'OPENCODE=1' : 'OPENCODE_SESSION_ID' }
    : Object.keys(env).some((k) => k.toUpperCase().startsWith('CLAUDE_CODE_'))
      ? { detected: 'claude', reason: 'CLAUDE_CODE_*' }
      : { detected: 'unknown', reason: 'unknown' };

  // D3: `versionOpencode` corre siempre y nunca propaga: sin binario, con shim o
  // con opencode 1.x el setup tiene que seguir funcionando.
  const opencode = { probed: false, bin: null, version: null, ok: false, error: null, mcpList: null, pluginList: null, debugPaths: null };
  const entornoHijo = entornoDeOpencode(env, configDir, home, homeExplicito);
  let helpers = null;
  try {
    helpers = options.resolveBin && options.version ? null : cargarHelpers();
    const resolveBin = options.resolveBin ?? helpers.resolveOpencodeBin;
    const versionDe = options.version ?? helpers.versionOpencode;
    const explicito = options.opencodeBin ? { ...entornoHijo, OPENCODE_BIN: options.opencodeBin } : entornoHijo;
    opencode.bin = resolveBin({ env: explicito });
    opencode.version = await versionDe(opencode.bin, { env: explicito, spawnImpl: options.spawn });
    opencode.ok = true;
  } catch (e) {
    opencode.error = e instanceof Error ? e.message : String(e);
    const vieja = /found (\d+\.\d+\.\d+)/.exec(opencode.error);
    if (vieja) opencode.version = vieja[1];
    warnings.push(vieja || /\bopencode >= 2\b/.test(opencode.error)
      ? `upgrade-opencode: ${opencode.error}`
      : `install-opencode: ${opencode.error}`);
  }
  if (options.probe && opencode.ok) {
    await sondear(opencode, { helpers: helpers ?? cargarHelpers(), spawn: options.spawn, cwd, env: entornoHijo });
  }

  if (!fuente) {
    actions.push({ id: 'no-source', reason: 'este script no está dentro de un plugin de Lagrange completo (falta mcp-server/index.js, .opencode/plugins/lagrange.js o package.json): no hay qué copiar; usá el clon' });
  } else {
    if (!globalPlugin.exists) actions.push({ id: 'copy-plugin', reason: `falta ${rutaPlugin}` });
    else if (globalPlugin.stale) actions.push({ id: 'copy-plugin', reason: `${rutaPlugin} difiere de la copia ${fuente.version}` });

    if (config.format === 'invalid') {
      actions.push({ id: 'manual-merge', reason: `${config.file} no se puede leer (${config.problem}); arreglalo a mano` });
      warnings.push(`config-invalid: ${path.join(configDir, config.file)} (${config.problem})`);
    } else if (config.problem) {
      actions.push({ id: 'manual-merge', reason: `la forma del config no es la esperada (${config.problem})` });
    } else if (config.shape === 'both') {
      actions.push({ id: 'manual-merge', reason: 'hay una entrada «lagrange» en mcp.servers y otra en mcp (legacy): elegí una a mano' });
    } else if (config.entryType !== null && config.entryType !== 'local') {
      actions.push({ id: 'manual-merge', reason: `la entrada «lagrange» es de tipo ${config.entryType}, no local: no se convierte sola` });
    } else if (config.format === 'jsonc') {
      const listo = config.shape !== 'none'
        && normalizar(config.text).includes(normalizar(fuente.mcpServer))
        && config.hostMarker === 'opencode';
      if (!listo) actions.push({ id: 'manual-jsonc', reason: `${config.file} es JSONC y no se reescribe: pegá el fragmento de merge` });
    } else {
      const motivos = config.format === 'none' ? [`${path.join(configDir, 'opencode.json')} no existe: se crea`] : motivosDeMerge(config, fuente);
      if (motivos.length) actions.push({ id: 'merge-config', reason: motivos.join('; ') });
    }
    if (actions.some((a) => a.id === 'copy-plugin' || a.id === 'merge-config')) {
      actions.push({ id: 'restart-opencode', reason: 'después de aplicar, reiniciá opencode o corré `opencode reload`; verificá en una corrida posterior' });
    }
    if (cache.latest && compararSemver(cache.latest, fuente.version) > 0) {
      warnings.push(`copia-vieja: este script es ${fuente.version} y la caché tiene ${cache.latest}; corré el setup desde la última`);
    }
  }
  if (config.shadowed) warnings.push('shadowed: opencode.jsonc tapa a opencode.json; el .json no se toca');

  const { text, problem, ambiguous, entryType, ...configPublica } = config;
  return {
    host,
    cwd,
    insideClone,
    source: fuente,
    config: { ...configPublica, ...(problem ? { problem } : {}), ...(ambiguous ? { ambiguous } : {}), entryType },
    globalPlugin,
    cache,
    opencode,
    actions,
    warnings
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parsearArgumentos(argv) {
  const opciones = {};
  const valor = (i, nombre) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${nombre} necesita un valor`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--diagnose') opciones.diagnose = true;
    else if (a === '--json') opciones.json = true;
    else if (a === '--probe') opciones.probe = true;
    else if (a === '--cwd') opciones.cwd = valor(i++, a);
    else if (a === '--home') opciones.home = valor(i++, a);
    else if (a === '--config-dir') opciones.configDir = valor(i++, a);
    else if (a === '--opencode-bin') opciones.opencodeBin = valor(i++, a);
    else throw new Error(`argumento desconocido: ${a}`);
  }
  return opciones;
}

function informe(r) {
  const l = [];
  l.push(`Host: ${r.host.detected} (${r.host.reason})`);
  l.push(`cwd: ${r.cwd}${r.insideClone ? '  — dentro de un clon de Lagrange' : ''}`);
  l.push(r.source ? `Fuente: Lagrange ${r.source.version} en ${r.source.root}` : 'Fuente: ninguna (no-source)');
  const c = r.config;
  l.push(`Config de opencode: ${c.dir}`);
  l.push(c.file
    ? `  efectiva: ${c.file} (${c.format}${c.shadowed ? ', tapa a opencode.json' : ''}); forma: ${c.shape}`
    : '  sin opencode.json ni opencode.jsonc');
  if (c.command) l.push(`  command: ${c.command.join(' ')}${c.absolute === false ? '  (ruta relativa)' : ''}${c.commandVersion ? `  [v${c.commandVersion}]` : ''}`);
  if (c.hostMarker !== null || c.timeout !== null) l.push(`  LAGRANGE_HOST: ${c.hostMarker ?? '—'}; timeout: ${c.timeout ?? '—'}`);
  l.push(`Plugin global: ${r.globalPlugin.exists ? (r.globalPlugin.stale ? 'desactualizado' : 'al día') : 'no está'} (${r.globalPlugin.path})`);
  const vistas = r.cache.versions.slice(0, 5).join(', ') + (r.cache.versions.length > 5 ? `, … (${r.cache.versions.length} en total)` : '');
  l.push(`Caché de Claude Code: ${r.cache.versions.length ? `${vistas}; última estable ${r.cache.latest ?? '—'}` : 'vacía'}`);
  const o = r.opencode;
  l.push(o.ok ? `opencode: ${o.version} (${o.bin})` : `opencode: no disponible${o.version ? ` (versión ${o.version})` : ''} — ${o.error}`);
  if (o.probed) {
    for (const k of ['mcpList', 'pluginList', 'debugPaths']) {
      if (o[k]) l.push(`  ${k}: exit ${o[k].code}\n${o[k].output.split('\n').map((x) => `    ${x}`).join('\n')}`);
    }
  }
  l.push('');
  l.push(r.actions.length ? 'Acciones:' : 'Acciones: ninguna, todo está al día.');
  for (const a of r.actions) l.push(`  - ${a.id}: ${a.reason}`);
  if (r.warnings.length) {
    l.push('Avisos:');
    for (const w of r.warnings) l.push(`  - ${w}`);
  }
  return l.join('\n');
}

async function main(argv) {
  let opciones;
  try { opciones = parsearArgumentos(argv); } catch (e) {
    console.error(`${e.message}\nUso: node scripts/opencode-setup.mjs --diagnose [--json] [--probe] [--cwd <dir>] [--home <dir>] [--config-dir <dir>] [--opencode-bin <path>]`);
    return 2;
  }
  if (!opciones.diagnose) {
    console.error('Falta --diagnose. Uso: node scripts/opencode-setup.mjs --diagnose [--json] [--probe]');
    return 2;
  }
  const reporte = await diagnose(opciones);
  console.log(opciones.json ? JSON.stringify(reporte, null, 2) : informe(reporte));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((codigo) => { process.exitCode = codigo; }, (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
