#!/usr/bin/env node
/**
 * FEAT-192 / FEAT-193 — Instala el plugin de Lagrange para agy (`agy-plugin/`) y opcionalmente configura su status line.
 *
 * Valida el manifiesto, las skills y los scripts de status line, y copia la carpeta a
 * `~/.gemini/config/plugins/lagrange/` (o `--home <dir>`). No lanza agy (FEAT-191).
 *
 *   npm run agy:plugin                    valida e instala el plugin (sin tocar settings.json)
 *   npm run agy:plugin -- --validar       solo valida
 *   npm run agy:plugin -- --statusline    instala y registra la status line completa en agy
 *   npm run agy:plugin -- --statusline-stack  instala y registra solo el complemento (stack_with_default: true)
 *   npm run agy:plugin -- --statusline-off    quita la status line de Lagrange de settings.json
 *   npm run agy:plugin -- --mcp           instala y registra el MCP de Lagrange en ~/.gemini/config/mcp_config.json (FEAT-196)
 *   npm run agy:plugin -- --mcp-off       quita ese servidor (solo si lo registró Lagrange)
 *
 * `--force` reemplaza una status line o un servidor "lagrange" ajenos (con respaldo). `--mcp` se combina con
 * `--statusline` / `--statusline-stack`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { escribirAtomico } = require('../mcp-server/lib/fs-atomico.js');

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGEN = path.join(RAIZ, 'agy-plugin');
export const NOMBRE = 'lagrange';
const MAX_BACKUPS = 10;
// Campos que el cargador de agy reconoce (los demás los descarta sin avisar).
const CAMPOS = new Set(['name', 'description', 'logo', 'suggestedPrompts', 'displayName', 'version', 'author', 'homepage', 'repository', 'disabled']);
const ARCHIVOS_STATUSLINE = ['statusline.mjs', 'statusline.cmd', 'statusline.sh'];

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function destinoPorDefecto(home = os.homedir()) {
  return path.join(home, '.gemini', 'config', 'plugins', NOMBRE);
}

export function rutaSettings(home = os.homedir()) {
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

export function esComandoPropio(comando) {
  if (typeof comando !== 'string' || !comando.trim()) return false;
  const norm = comando.replace(/\\/g, '/');
  return /\/plugins\/lagrange\/scripts\/statusline\.(mjs|cmd|sh)(?:$|\s|["'])/i.test(norm)
    || /(?:^|["'\s])plugins\/lagrange\/scripts\/statusline\.(mjs|cmd|sh)(?:$|\s|["'])/i.test(norm);
}

export function rutaSinEspaciosWindows(destino, { intentarCorta = true } = {}) {
  if (!/[\s&|<>^%()]/.test(destino)) return destino;
  if (intentarCorta && fs.existsSync(destino)) {
    try {
      const corta = execFileSync('cmd', ['/d', '/s', '/c', `for %I in ("${destino}") do @echo %~sI`], {
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: true
      }).trim();
      if (corta && !/[\s&|<>^%()]/.test(corta)) return corta;
    } catch {}
  }
  // Si 8.3 está deshabilitado en el volumen (p. ej. runners efímeros de CI), cmd /c acepta espacios con `^ `.
  if (!/[&|<>^%()\t\r\n]/.test(destino)) {
    return destino.replace(/\\/g, '/').replace(/ /g, '^ ');
  }
  throw new Error(
    `la ruta de destino "${destino}" contiene caracteres incompatibles con cmd /c sin comillas; `
    + 'usá --home sin espacios ni símbolos.'
  );
}

export function comandoStatusLine(destino, { soloLagrange = false, platform = process.platform, intentarCorta = true } = {}) {
  const wrapper = platform === 'win32' ? 'statusline.cmd' : 'statusline.sh';
  if (platform === 'win32') {
    const base = rutaSinEspaciosWindows(destino, { intentarCorta });
    const ruta = path.join(base, 'scripts', wrapper).replace(/\\/g, '/');
    return soloLagrange ? `${ruta} --solo-lagrange` : ruta;
  }
  const ruta = path.join(destino, 'scripts', wrapper).replace(/\\/g, '/');
  return soloLagrange ? `"${ruta}" --solo-lagrange` : `"${ruta}"`;
}

function frontmatter(texto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  if (!m) return null;
  const campos = {};
  for (const l of m[1].split(/\r?\n/)) {
    const c = /^([a-z_-]+):\s*(.*)$/.exec(l);
    if (c) campos[c[1]] = c[2].trim();
  }
  return campos;
}

/** Problemas del plugin (vacío = válido). */
export function validarPlugin(dir = ORIGEN) {
  const problemas = [];
  let manifiesto;
  try { manifiesto = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch (err) {
    return [`plugin.json ilegible: ${err.message}`];
  }
  if (manifiesto.name !== NOMBRE) problemas.push(`plugin.json: name tiene que ser "${NOMBRE}"`);
  if (!String(manifiesto.description || '').trim()) problemas.push('plugin.json: falta description');
  for (const k of Object.keys(manifiesto)) if (!CAMPOS.has(k)) problemas.push(`plugin.json: campo desconocido "${k}" (agy lo descartaría)`);
  if (manifiesto.suggestedPrompts && (!Array.isArray(manifiesto.suggestedPrompts) || manifiesto.suggestedPrompts.length > 3)) {
    problemas.push('plugin.json: suggestedPrompts es una lista de hasta 3');
  }
  const dirSkills = path.join(dir, 'skills');
  let skills = [];
  try { skills = fs.readdirSync(dirSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  if (!skills.length) problemas.push('no hay skills en skills/');
  for (const s of skills) {
    let texto;
    try { texto = fs.readFileSync(path.join(dirSkills, s, 'SKILL.md'), 'utf8'); } catch { problemas.push(`skills/${s}: falta SKILL.md`); continue; }
    const fm = frontmatter(texto);
    if (!fm) { problemas.push(`skills/${s}/SKILL.md: sin frontmatter`); continue; }
    if (fm.name !== s) problemas.push(`skills/${s}/SKILL.md: name "${fm.name || ''}" no coincide con la carpeta`);
    if (!fm.description) problemas.push(`skills/${s}/SKILL.md: falta description`);
    if (!s.startsWith(`${NOMBRE}-`)) problemas.push(`skills/${s}: el nombre lleva el prefijo "${NOMBRE}-" (los nombres de skill de agy son globales)`);
  }

  const dirScripts = path.join(dir, 'scripts');
  if (path.resolve(dir) === path.resolve(ORIGEN) || fs.existsSync(dirScripts)) {
    for (const archivo of ARCHIVOS_STATUSLINE) {
      const ruta = path.join(dirScripts, archivo);
      try {
        const contenido = fs.readFileSync(ruta, 'utf8');
        if (!contenido.trim()) problemas.push(`scripts/${archivo}: archivo vacío`);
      } catch {
        problemas.push(`scripts/${archivo}: falta o es ilegible`);
      }
    }
  }
  return problemas;
}

/** Copia el plugin al destino. Solo pisa una carpeta que ya sea este plugin. */
export function instalar({ origen = ORIGEN, destino = destinoPorDefecto() } = {}) {
  const problemas = validarPlugin(origen);
  if (problemas.length) throw new Error(`el plugin no es válido:\n- ${problemas.join('\n- ')}`);
  if (fs.existsSync(destino)) {
    let ajeno = true;
    try { ajeno = JSON.parse(fs.readFileSync(path.join(destino, 'plugin.json'), 'utf8')).name !== NOMBRE; } catch {}
    if (ajeno) throw new Error(`${destino} ya existe y no es el plugin de Lagrange: no se toca`);
    fs.rmSync(destino, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.cpSync(origen, destino, { recursive: true });
  try {
    const sh = path.join(destino, 'scripts', 'statusline.sh');
    if (process.platform !== 'win32' && fs.existsSync(sh)) fs.chmodSync(sh, 0o755);
  } catch {}
  return destino;
}

function leerSettings(ruta) {
  if (!fs.existsSync(ruta)) return { existe: false, datos: {} };
  let texto;
  try {
    texto = fs.readFileSync(ruta, 'utf8');
  } catch (err) {
    throw new Error(`no se pudo leer ${ruta}: ${err.message}`);
  }
  const limpio = texto.replace(/^\uFEFF/, '');
  let datos;
  try {
    datos = JSON.parse(limpio);
  } catch (err) {
    throw new Error(`${ruta} no contiene JSON válido (no se modifica): ${err.message}`);
  }
  if (!esObjeto(datos)) {
    throw new Error(`${ruta} debe tener un objeto JSON en la raíz (no se modifica)`);
  }
  return { existe: true, datos };
}

function respaldarSettings(ruta, { maxBackups = MAX_BACKUPS, ahora = () => new Date(), prefijo = 'settings' } = {}) {
  const dirBackups = path.join(path.dirname(ruta), '.backups');
  fs.mkdirSync(dirBackups, { recursive: true });
  const marca = ahora().toISOString().replace(/[:.]/g, '-');
  let destino = path.join(dirBackups, `${prefijo}-${marca}.json`);
  for (let i = 1; fs.existsSync(destino); i++) {
    destino = path.join(dirBackups, `${prefijo}-${marca}-${i}.json`);
  }
  fs.copyFileSync(ruta, destino);
  const propios = fs.readdirSync(dirBackups)
    .filter((f) => f.startsWith(`${prefijo}-`) && f.endsWith('.json'))
    .sort();
  for (const viejo of propios.slice(0, Math.max(0, propios.length - maxBackups))) {
    try { fs.rmSync(path.join(dirBackups, viejo), { force: true }); } catch {}
  }
  return destino;
}

function preflightStatusLine({ settingsPath, force = false, off = false }) {
  const { existe, datos } = leerSettings(settingsPath);
  const actual = datos.statusLine;
  const cmdActual = esObjeto(actual) && typeof actual.command === 'string' ? actual.command.trim() : '';

  if (off) {
    if (!existe || actual === undefined) return { existe, datos, accion: 'nada', reemplazoAjeno: false };
    if (!esObjeto(actual) || !esComandoPropio(cmdActual)) {
      throw new Error(`statusLine en ${settingsPath} no pertenece a Lagrange ("${cmdActual || String(actual)}"): no se toca`);
    }
    return { existe, datos, accion: 'quitar', reemplazoAjeno: false };
  }

  const esAjena = Boolean(cmdActual) && !esComandoPropio(cmdActual);
  if (esAjena && !force) {
    throw new Error(
      `ya existe una statusLine ajena en ${settingsPath} ("${cmdActual}"). `
      + 'Usá --force para reemplazarla (se crea respaldo previo en .backups/).'
    );
  }
  return { existe, datos, accion: 'poner', reemplazoAjeno: esAjena };
}

/** Valida, hace preflight sobre `settings.json`, instala el plugin y registra `statusLine`. */
export function configurarStatusLine({
  origen = ORIGEN,
  home = os.homedir(),
  destino = destinoPorDefecto(home),
  settingsPath = rutaSettings(home),
  soloLagrange = false,
  force = false,
  platform = process.platform,
  ahora = () => new Date()
} = {}) {
  const problemas = validarPlugin(origen);
  if (problemas.length) throw new Error(`el plugin no es válido:\n- ${problemas.join('\n- ')}`);
  for (const archivo of ARCHIVOS_STATUSLINE) {
    if (!fs.existsSync(path.join(origen, 'scripts', archivo))) {
      throw new Error(`falta ${path.join(origen, 'scripts', archivo)}`);
    }
  }

  const pre = preflightStatusLine({ settingsPath, force, off: false });
  instalar({ origen, destino });

  const wrapper = platform === 'win32' ? 'statusline.cmd' : 'statusline.sh';
  if (!fs.existsSync(path.join(destino, 'scripts', 'statusline.mjs')) || !fs.existsSync(path.join(destino, 'scripts', wrapper))) {
    throw new Error(`la instalación en ${destino} no dejó scripts/statusline`);
  }

  const backup = pre.existe ? respaldarSettings(settingsPath, { ahora }) : null;
  const comando = comandoStatusLine(destino, { soloLagrange, platform });
  pre.datos.statusLine = {
    type: 'command',
    command: comando,
    enabled: true,
    padding: 0,
    stack_with_default: Boolean(soloLagrange)
  };
  escribirAtomico(settingsPath, `${JSON.stringify(pre.datos, null, 2)}\n`);
  return { destino, settingsPath, comando, backup, reemplazoAjeno: pre.reemplazoAjeno };
}

/** Quita `statusLine` de `settings.json` solo si pertenece a Lagrange, creando respaldo previo. */
export function desactivarStatusLine({
  home = os.homedir(),
  settingsPath = rutaSettings(home),
  ahora = () => new Date()
} = {}) {
  const pre = preflightStatusLine({ settingsPath, off: true });
  if (pre.accion === 'nada') return { settingsPath, cambiado: false, backup: null };
  const backup = pre.existe ? respaldarSettings(settingsPath, { ahora }) : null;
  delete pre.datos.statusLine;
  escribirAtomico(settingsPath, `${JSON.stringify(pre.datos, null, 2)}\n`);
  return { settingsPath, cambiado: true, backup };
}

// ---------------------------------------------------------------------------
// FEAT-196 — El MCP de Lagrange dentro de agy (`--mcp` / `--mcp-off`)
// ---------------------------------------------------------------------------

export const SERVIDOR_MCP = 'lagrange';
export const MCP_DEL_SCRIPT = path.join(RAIZ, 'mcp-server', 'index.js');

export function rutaMcpConfig(home = os.homedir()) {
  return path.join(home, '.gemini', 'config', 'mcp_config.json');
}

/** La entrada que se escribe: la forma medida en la sonda S4 (`command`, `args`, `env`). */
export function entradaMcp(servidor = MCP_DEL_SCRIPT) {
  return { command: 'node', args: [servidor.replace(/\\/g, '/')], env: { LAGRANGE_HOST: 'agy' } };
}

/** ¿La entrada `lagrange` de `mcp_config.json` es de este instalador? (`\` de Windows y mayúsculas no importan.) */
export function esEntradaMcpPropia(entrada, { platform = process.platform } = {}) {
  if (!esObjeto(entrada) || !esObjeto(entrada.env) || entrada.env.LAGRANGE_HOST !== 'agy') return false;
  if (!Array.isArray(entrada.args) || typeof entrada.args[0] !== 'string') return false;
  let script = entrada.args[0].replace(/\\/g, '/');
  if (platform === 'win32') script = script.toLowerCase();
  return script.endsWith('/mcp-server/index.js');
}

/**
 * Antes de escribir nada: `mcp_config.json` es un objeto con `mcpServers` objeto (o sin él), el MCP existe bajo la raíz
 * del script, y un `lagrange` ajeno no se pisa sin `force`. Nunca imprime el contenido (trae credenciales de otros).
 */
export function preflightMcp({ mcpPath, servidor = MCP_DEL_SCRIPT, force = false, off = false, platform = process.platform }) {
  const { existe, datos } = leerSettings(mcpPath);
  if (datos.mcpServers !== undefined && !esObjeto(datos.mcpServers)) {
    throw new Error(`${mcpPath}: "mcpServers" no es un objeto (no se modifica)`);
  }
  const actual = esObjeto(datos.mcpServers) ? datos.mcpServers[SERVIDOR_MCP] : undefined;
  if (off) {
    if (actual === undefined) return { existe, datos, accion: 'nada', reemplazoAjeno: false };
    if (!esEntradaMcpPropia(actual, { platform })) {
      throw new Error(`el servidor "${SERVIDOR_MCP}" de ${mcpPath} no lo registró Lagrange: no se toca`);
    }
    return { existe, datos, accion: 'quitar', reemplazoAjeno: false };
  }
  if (!fs.existsSync(servidor)) throw new Error(`no existe ${servidor}: corré esto desde un plugin de Lagrange completo`);
  const ajena = actual !== undefined && !esEntradaMcpPropia(actual, { platform });
  if (ajena && !force) {
    throw new Error(`ya hay un servidor "${SERVIDOR_MCP}" ajeno en ${mcpPath}. Usá --force para reemplazarlo (se crea respaldo previo en .backups/).`);
  }
  return { existe, datos, accion: 'poner', reemplazoAjeno: ajena };
}

function escribirMcp(pre, mcpPath, ahora) {
  const backup = pre.existe ? respaldarSettings(mcpPath, { ahora, prefijo: 'mcp_config' }) : null;
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  escribirAtomico(mcpPath, `${JSON.stringify(pre.datos, null, 2)}\n`);
  return backup;
}

/** Registra el servidor `lagrange` en `mcp_config.json` (con un `pre` ya hecho, o lo hace). */
export function configurarMcp({ home = os.homedir(), mcpPath = rutaMcpConfig(home), servidor = MCP_DEL_SCRIPT, force = false, pre = null, platform = process.platform, ahora = () => new Date() } = {}) {
  const p = pre || preflightMcp({ mcpPath, servidor, force, platform });
  if (!esObjeto(p.datos.mcpServers)) p.datos.mcpServers = {};
  p.datos.mcpServers[SERVIDOR_MCP] = entradaMcp(servidor);
  const backup = escribirMcp(p, mcpPath, ahora);
  return { mcpPath, servidor, backup, reemplazoAjeno: p.reemplazoAjeno };
}

/** Quita el servidor `lagrange` solo si es propio, con respaldo. */
export function desactivarMcp({ home = os.homedir(), mcpPath = rutaMcpConfig(home), platform = process.platform, ahora = () => new Date() } = {}) {
  const pre = preflightMcp({ mcpPath, off: true, platform });
  if (pre.accion === 'nada') return { mcpPath, cambiado: false, backup: null };
  delete pre.datos.mcpServers[SERVIDOR_MCP];
  const backup = escribirMcp(pre, mcpPath, ahora);
  return { mcpPath, cambiado: true, backup };
}

/** La versión de este script y la estable más nueva de la caché de Claude Code de `claudeDir`, si es más nueva. */
export async function copiaVieja({ claudeDir, raiz = RAIZ }) {
  const { parsearSemver, compararSemver } = await import('./opencode-setup.mjs');
  let propia = null;
  try { propia = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version; } catch { return null; }
  const versiones = [];
  const cache = path.join(claudeDir, 'plugins', 'cache');
  let mercados = [];
  try { mercados = fs.readdirSync(cache, { withFileTypes: true }); } catch { return null; }
  for (const m of mercados) {
    if (!m.isDirectory()) continue;
    try {
      for (const d of fs.readdirSync(path.join(cache, m.name, 'lagrange'), { withFileTypes: true })) {
        const s = d.isDirectory() ? parsearSemver(d.name) : null;
        if (s && !s.pre.length) versiones.push(d.name);
      }
    } catch {}
  }
  const ultima = versiones.sort((a, b) => compararSemver(b, a))[0] || null;
  return ultima && compararSemver(ultima, propia) > 0 ? { propia, ultima } : null;
}

export function parsearArgs(argv = process.argv.slice(2)) {
  const opts = { validar: false, statusline: false, statuslineStack: false, statuslineOff: false, mcp: false, mcpOff: false, force: false, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--validar') opts.validar = true;
    else if (a === '--mcp') opts.mcp = true;
    else if (a === '--mcp-off') opts.mcpOff = true;
    else if (a === '--statusline') opts.statusline = true;
    else if (a === '--statusline-stack') opts.statuslineStack = true;
    else if (a === '--statusline-off') opts.statuslineOff = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--home') {
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) throw new Error('--home requiere una ruta de directorio');
      opts.home = val;
      i++;
    } else {
      throw new Error(`opción desconocida: ${a}`);
    }
  }
  if (opts.statusline && opts.statuslineStack) throw new Error('--statusline y --statusline-stack son excluyentes');
  if ((opts.statusline || opts.statuslineStack) && opts.statuslineOff) {
    throw new Error('no se puede combinar --statusline-off con --statusline / --statusline-stack');
  }
  if (opts.validar && (opts.statusline || opts.statuslineStack || opts.statuslineOff || opts.mcp || opts.mcpOff || opts.force)) {
    throw new Error('--validar no admite flags de status line, de MCP ni --force');
  }
  if (opts.mcp && opts.mcpOff) throw new Error('--mcp y --mcp-off son excluyentes');
  if (opts.mcpOff && (opts.statusline || opts.statuslineStack)) {
    throw new Error('no se puede combinar --mcp-off con --statusline / --statusline-stack');
  }
  if (opts.mcp && opts.statuslineOff) throw new Error('no se puede combinar --mcp con --statusline-off');
  if (opts.force && !opts.statusline && !opts.statuslineStack && !opts.mcp) {
    throw new Error('--force solo puede usarse con --statusline, --statusline-stack o --mcp');
  }
  return opts;
}

function esEntrypoint() {
  try {
    if (!process.argv[1]) return false;
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (esEntrypoint()) {
  let opts;
  try {
    opts = parsearArgs();
  } catch (err) {
    console.error(`[agy-plugin] ${err.message}`);
    process.exit(1);
  }

  const home = opts.home ? path.resolve(opts.home) : os.homedir();
  const destino = destinoPorDefecto(home);
  const settingsPath = rutaSettings(home);

  const salir = (err) => {
    console.error(`[agy-plugin] ${err.message}`);
    process.exit(1);
  };

  if (opts.statuslineOff || opts.mcpOff) {
    try {
      if (opts.mcpOff) {
        const r = desactivarMcp({ home });
        if (r.cambiado) {
          console.log(`[agy-plugin] servidor MCP "${SERVIDOR_MCP}" quitado de ${r.mcpPath}.`);
          if (r.backup) console.log(`[agy-plugin] respaldo en ${r.backup}.`);
          console.log('[agy-plugin] Reiniciá agy para que lo suelte.');
        } else {
          console.log(`[agy-plugin] no había servidor MCP "${SERVIDOR_MCP}" en ${r.mcpPath}.`);
        }
      }
      if (opts.statuslineOff) {
        const r = desactivarStatusLine({ home, settingsPath });
        if (r.cambiado) {
          console.log(`[agy-plugin] statusLine de Lagrange quitada de ${r.settingsPath}.`);
          if (r.backup) console.log(`[agy-plugin] respaldo en ${r.backup}.`);
        } else {
          console.log(`[agy-plugin] no había statusLine activa en ${r.settingsPath}.`);
        }
      }
    } catch (err) {
      salir(err);
    }
    process.exit(0);
  }

  const problemas = validarPlugin();
  if (problemas.length) {
    console.error(`[agy-plugin] inválido:\n- ${problemas.join('\n- ')}`);
    process.exit(1);
  }
  console.log('[agy-plugin] manifiesto, skills y scripts válidos.');

  if (opts.validar) process.exit(0);

  // FEAT-196 (r1 F3) — El preflight del MCP va antes de copiar el plugin o tocar settings.json: si falla, no se escribe nada.
  const mcpPath = rutaMcpConfig(home);
  let preMcp = null;
  if (opts.mcp) {
    try { preMcp = preflightMcp({ mcpPath, force: opts.force }); } catch (err) { salir(err); }
  }

  try {
    if (opts.statusline || opts.statuslineStack) {
      const r = configurarStatusLine({
        home,
        destino,
        settingsPath,
        soloLagrange: opts.statuslineStack,
        force: opts.force
      });
      console.log(`[agy-plugin] instalado en ${r.destino}.`);
      console.log(`[agy-plugin] statusLine configurada en ${r.settingsPath} (${opts.statuslineStack ? 'stack_with_default: true' : 'barra completa'}).`);
      if (r.backup) console.log(`[agy-plugin] respaldo previo guardado en ${r.backup}.`);
      console.log('[agy-plugin] En agy podés revertir con: npm run agy:plugin -- --statusline-off (o /statusline delete).');
    } else {
      const instaladoEn = instalar({ destino });
      console.log(`[agy-plugin] instalado en ${instaladoEn}.`);
      console.log('[agy-plugin] agy lo carga solo: en tu sesión, /lagrange-audit, /lagrange-review y /lagrange-plan (con el id del pedido).');
      if (!opts.mcp) {
        console.log('[agy-plugin] Para activar también la status line de agy: npm run agy:plugin -- --statusline');
        console.log('[agy-plugin] Para darle a agy las tools de Lagrange (cola de auditorías): npm run agy:plugin -- --mcp');
      }
      console.log('[agy-plugin] La primera vez en cada proyecto agy te pide confiar en la carpeta: es decisión tuya.');
    }

    if (opts.mcp) {
      const r = configurarMcp({ mcpPath, pre: preMcp });
      console.log(`[agy-plugin] servidor MCP "${SERVIDOR_MCP}" registrado en ${r.mcpPath} -> ${r.servidor} (LAGRANGE_HOST=agy).`);
      if (r.reemplazoAjeno) console.log('[agy-plugin] reemplazó un servidor "lagrange" ajeno (--force).');
      if (r.backup) console.log(`[agy-plugin] respaldo previo guardado en ${r.backup}.`);
      console.log('[agy-plugin] Dentro de agy, Lagrange muestra solo audit_queue, status y usage; agy te pide permiso en cada llamada.');
      console.log('[agy-plugin] Reiniciá agy para que lo cargue. Para quitarlo: npm run agy:plugin -- --mcp-off');
      const claudeDir = opts.home ? path.join(home, '.claude') : (process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
      const vieja = await copiaVieja({ claudeDir });
      if (vieja) {
        console.log(`[agy-plugin] aviso (copia-vieja): este script es ${vieja.propia} y la caché de Claude Code tiene ${vieja.ultima}; corré --mcp desde la más nueva.`);
      }
    }
  } catch (err) {
    salir(err);
  }
}
