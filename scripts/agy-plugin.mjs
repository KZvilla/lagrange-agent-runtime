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

function rutaSinEspaciosWindows(destino) {
  if (!/[\s&|<>^%]/.test(destino)) return destino;
  if (fs.existsSync(destino)) {
    try {
      const corta = execFileSync('cmd', ['/d', '/s', '/c', `for %I in ("${destino}") do @echo %~sI`], {
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: true
      }).trim();
      if (corta && !/[\s&|<>^%]/.test(corta)) return corta;
    } catch {}
  }
  throw new Error(
    `la ruta de destino "${destino}" tiene espacios y no pudo acortarse a formato 8.3; `
    + 'agy en Windows invoca cmd /c sin desescapar comillas. Usá --home sin espacios.'
  );
}

export function comandoStatusLine(destino, { soloLagrange = false, platform = process.platform } = {}) {
  const wrapper = platform === 'win32' ? 'statusline.cmd' : 'statusline.sh';
  if (platform === 'win32') {
    const base = rutaSinEspaciosWindows(destino);
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

function respaldarSettings(ruta, { maxBackups = MAX_BACKUPS, ahora = () => new Date() } = {}) {
  const dirBackups = path.join(path.dirname(ruta), '.backups');
  fs.mkdirSync(dirBackups, { recursive: true });
  const marca = ahora().toISOString().replace(/[:.]/g, '-');
  let destino = path.join(dirBackups, `settings-${marca}.json`);
  for (let i = 1; fs.existsSync(destino); i++) {
    destino = path.join(dirBackups, `settings-${marca}-${i}.json`);
  }
  fs.copyFileSync(ruta, destino);
  const propios = fs.readdirSync(dirBackups)
    .filter((f) => f.startsWith('settings-') && f.endsWith('.json'))
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

export function parsearArgs(argv = process.argv.slice(2)) {
  const opts = { validar: false, statusline: false, statuslineStack: false, statuslineOff: false, force: false, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--validar') opts.validar = true;
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
  if (opts.validar && (opts.statusline || opts.statuslineStack || opts.statuslineOff || opts.force)) {
    throw new Error('--validar no admite flags de status line ni --force');
  }
  if (opts.force && !opts.statusline && !opts.statuslineStack) {
    throw new Error('--force solo puede usarse con --statusline o --statusline-stack');
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

  if (opts.statuslineOff) {
    try {
      const r = desactivarStatusLine({ home, settingsPath });
      if (r.cambiado) {
        console.log(`[agy-plugin] statusLine de Lagrange quitada de ${r.settingsPath}.`);
        if (r.backup) console.log(`[agy-plugin] respaldo en ${r.backup}.`);
      } else {
        console.log(`[agy-plugin] no había statusLine activa en ${r.settingsPath}.`);
      }
    } catch (err) {
      console.error(`[agy-plugin] ${err.message}`);
      process.exit(1);
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

  if (opts.statusline || opts.statuslineStack) {
    try {
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
    } catch (err) {
      console.error(`[agy-plugin] ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  try {
    const instaladoEn = instalar({ destino });
    console.log(`[agy-plugin] instalado en ${instaladoEn}.`);
    console.log('[agy-plugin] agy lo carga solo: en tu sesión, /lagrange-audit, /lagrange-review y /lagrange-plan (con el id del pedido).');
    console.log('[agy-plugin] Para activar también la status line de agy: npm run agy:plugin -- --statusline');
    console.log('[agy-plugin] La primera vez en cada proyecto agy te pide confiar en la carpeta: es decisión tuya.');
  } catch (err) {
    console.error(`[agy-plugin] ${err.message}`);
    process.exit(1);
  }
}
