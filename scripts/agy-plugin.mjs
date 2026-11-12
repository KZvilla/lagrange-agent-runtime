#!/usr/bin/env node
/**
 * FEAT-192 — Instala el plugin de Lagrange para agy (`agy-plugin/`): valida el manifiesto y las skills, y copia la
 * carpeta a `~/.gemini/config/plugins/lagrange/`, de donde agy la carga sola (sus skills quedan disponibles desde el
 * próximo turno). No lanza agy: en modo manual (FEAT-191) Lagrange no lo arranca, e instalar es copiar archivos.
 *
 *   npm run agy:plugin              valida e instala
 *   npm run agy:plugin -- --validar solo valida
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGEN = path.join(RAIZ, 'agy-plugin');
export const NOMBRE = 'lagrange';
// Campos que el cargador de agy reconoce (los demás los descarta sin avisar).
const CAMPOS = new Set(['name', 'description', 'logo', 'suggestedPrompts', 'displayName', 'version', 'author', 'homepage', 'repository', 'disabled']);

export function destinoPorDefecto(home = os.homedir()) {
  return path.join(home, '.gemini', 'config', 'plugins', NOMBRE);
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
  return destino;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problemas = validarPlugin();
  if (problemas.length) {
    console.error(`[agy-plugin] inválido:\n- ${problemas.join('\n- ')}`);
    process.exit(1);
  }
  console.log('[agy-plugin] manifiesto y skills válidos.');
  if (!process.argv.includes('--validar')) {
    try {
      const destino = instalar();
      console.log(`[agy-plugin] instalado en ${destino}.`);
      console.log('[agy-plugin] agy lo carga solo: en tu sesión, /lagrange-auditar, /lagrange-revisar y /lagrange-planear (con el id del pedido).');
      console.log('[agy-plugin] La primera vez en cada proyecto agy te pide confiar en la carpeta: es decisión tuya.');
    } catch (err) {
      console.error(`[agy-plugin] ${err.message}`);
      process.exit(1);
    }
  }
}
