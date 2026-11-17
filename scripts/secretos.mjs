#!/usr/bin/env node
/**
 * FEAT-198 F3 — Los secretos de Lagrange en KeePassXC, desde la terminal.
 *
 *   node scripts/secretos.mjs asociar            asocia Lagrange con la base abierta de KeePassXC
 *   node scripts/secretos.mjs migrar [--simular] mueve las credenciales en texto plano del .env a KeePassXC
 *   node scripts/secretos.mjs probar             resuelve cada referencia y dice sí o no, sin valores
 *
 * `--env <ruta>` elige el .env; si no, el mismo que carga el daemon (el primero que
 * existe de `bridgeEnvCandidates`).
 *
 * `migrar` crea cada entrada (`lagrange://<entrada>`, grupo `Lagrange`), la relee y
 * solo si coincide reemplaza la línea del .env por `keepassxc:<entrada>`. El .env se
 * reescribe atómico y sin copia del original: una copia sería otro archivo con
 * secretos en texto plano. Si querés una, hacela antes.
 *
 * Nada de lo que imprime lleva valores: solo variables, entradas y motivos.
 * KeePassXC no suena ni roba el foco: si algo tarda, mirá su ventana.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const kp = require('../mcp-server/lib/keepassxc.js');
const secretos = require('../mcp-server/lib/secretos.js');
const { escribirAtomico } = require('../mcp-server/lib/fs-atomico.js');

/** La entrada de KeePassXC para cada variable: corta y legible. `null` si no es una credencial. */
export function entradaPara(variable) {
  const v = String(variable).toUpperCase();
  if (!secretos.esCredencial(v)) return null;
  if (v === 'TELEGRAM_BOT_TOKEN') return 'telegram';
  if (v === 'DEEPSEEK_API_KEY') return 'deepseek';
  if (v === 'OPENCODE_GO_API_KEY') return 'opencode-go';
  if (v === 'LAGRANGE_MEMORY_TOKEN') return 'memoria';
  const m = /^TELEGRAM_BOT_([A-Z0-9_]+)_TOKEN$/.exec(v);
  if (m) return `telegram-${m[1].toLowerCase().replace(/_/g, '-')}`;
  return null;
}

/** Reemplaza cada definición de `variable` en el texto del .env por `variable=valor`. Conserva el resto tal cual. */
export function reemplazarLinea(texto, variable, valor) {
  const re = new RegExp(`^(\\s*(?:export\\s+)?)${variable}\\s*=.*$`, 'gmi');
  return texto.replace(re, (_, prefijo) => `${prefijo}${variable}=${valor}`);
}

async function rutaDelEnv(args) {
  const i = args.indexOf('--env');
  if (i !== -1) {
    if (!args[i + 1]) throw new Error('--env necesita una ruta');
    return path.resolve(args[i + 1]);
  }
  const paths = await import(pathToFileURL(path.join(RAIZ, 'telegram-bridge', 'paths.js')).href);
  const candidatos = paths.bridgeEnvCandidates(path.join(RAIZ, 'telegram-bridge'));
  const archivo = candidatos.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (!archivo) throw new Error(`no se encontró ningún .env. Se buscó en:\n${candidatos.map((c) => `  - ${c}`).join('\n')}`);
  return archivo;
}

const esperar = ({ entrada }) => console.log(`  … KeePassXC espera tu confirmación${entrada ? ` (${entrada})` : ''}: mirá su ventana.`);

function motivo(err) {
  return err instanceof kp.ErrorKeepassxc ? err.message : 'error inesperado (sin detalles, para no mostrar datos)';
}

export async function asociar({ env = process.env, args = [], log = console.log } = {}) {
  const previa = kp.leerAsociacion(env);
  if (previa && !args.includes('--forzar')) {
    const sesion = await kp.abrirSesion({ env });
    try {
      await kp.probarAsociacion(sesion, previa);
      log(`Ya está asociado con esta base (${previa.id}). Para asociar de nuevo: --forzar.`);
      return 0;
    } catch (err) {
      if (!(err instanceof kp.ErrorKeepassxc) || err.codigo !== 'sin-asociacion') throw err;
      log(`La asociación guardada (${previa.id}) no vale para esta base: se pide una nueva.`);
    } finally {
      sesion.cerrar();
    }
  }
  log('KeePassXC va a mostrar un diálogo: ponele un nombre (por ejemplo «lagrange») y aceptá.');
  const a = await kp.asociar({ env });
  kp.guardarAsociacion(a, env);
  log(`Asociado como «${a.id}». La asociación quedó en ${kp.rutaAsociacion(env)} (solo tu usuario).`);
  log('Se revoca desde KeePassXC: Base de datos → Configuración de la base de datos → Integración con navegador.');
  return 0;
}

export async function migrar({ env = process.env, args = [], log = console.log } = {}) {
  const simular = args.includes('--simular');
  const archivo = await rutaDelEnv(args);
  let texto = fs.readFileSync(archivo, 'utf8');
  const valores = parseEnv(texto);
  const pendientes = Object.entries(valores)
    .filter(([k, v]) => entradaPara(k) && String(v || '').trim() && !secretos.esReferencia(v));
  log(`.env: ${archivo}`);
  if (!pendientes.length) { log('No hay credenciales en texto plano: nada que migrar.'); return 0; }
  for (const [k] of pendientes) log(`  ${k} → keepassxc:${entradaPara(k)}`);
  if (simular) { log('(--simular: no se tocó nada)'); return 0; }

  const asociacion = kp.leerAsociacion(env);
  if (!asociacion) { log('Falta asociar: corré primero `node scripts/secretos.mjs asociar`.'); return 1; }
  log('KeePassXC puede pedirte confirmar el grupo «Lagrange» y el acceso a cada entrada (tildá «Recordar»).');

  let fallas = 0;
  for (const [variable, crudo] of pendientes) {
    const entrada = entradaPara(variable);
    const valor = String(crudo).trim();
    try {
      // Una entrada que ya existe no se pisa: si coincide se usa, si no se avisa.
      let existente = null;
      try {
        existente = await kp.leerSecreto(entrada, { env, asociacion, alEsperar: esperar });
      } catch (err) {
        if (!(err instanceof kp.ErrorKeepassxc) || err.codigo !== 'sin-entrada') throw err;
      }
      if (existente !== null && existente !== valor) {
        log(`  ✗ ${variable}: ya hay una entrada lagrange://${entrada} con otro valor. No se toca; revisala en KeePassXC.`);
        fallas++;
        continue;
      }
      if (existente === null) await kp.guardarSecreto(entrada, valor, { env, asociacion });
      // guardarSecreto ya relee y compara; si falla, lanza y la línea no se toca.
      texto = reemplazarLinea(texto, variable, `${secretos.PREFIJO}${entrada}`);
      escribirAtomico(archivo, texto, { mode: 0o600 });
      log(`  ✓ ${variable} → keepassxc:${entrada}${existente !== null ? ' (la entrada ya existía, con el mismo valor)' : ''}`);
    } catch (err) {
      log(`  ✗ ${variable}: ${motivo(err)}. La línea del .env queda como estaba.`);
      fallas++;
    }
  }
  log(fallas ? `${fallas} sin migrar.` : 'Listo. Reiniciá el daemon para que lea los secretos de KeePassXC.');
  return fallas ? 1 : 0;
}

export async function probar({ env = process.env, args = [], log = console.log } = {}) {
  const archivo = await rutaDelEnv(args);
  const valores = parseEnv(fs.readFileSync(archivo, 'utf8'));
  const asociacion = kp.leerAsociacion(env);
  log(`.env: ${archivo}`);
  let fallas = 0;
  let alguna = false;
  for (const [variable, crudo] of Object.entries(valores)) {
    if (!secretos.esCredencial(variable) || !String(crudo || '').trim()) continue;
    alguna = true;
    if (!secretos.esReferencia(crudo)) { log(`  ⚠ ${variable}: en texto plano`); continue; }
    const entrada = secretos.entradaDe(crudo);
    try {
      await kp.leerSecreto(entrada, { env, asociacion, alEsperar: esperar });
      log(`  ✓ ${variable}: se lee de KeePassXC (${entrada})`);
    } catch (err) {
      log(`  ✗ ${variable}: ${motivo(err)}`);
      fallas++;
    }
  }
  if (!alguna) log('No hay credenciales de Lagrange en este .env.');
  return fallas ? 1 : 0;
}

const COMANDOS = { asociar, migrar, probar };

async function main() {
  const [comando, ...args] = process.argv.slice(2);
  const fn = COMANDOS[comando];
  if (!fn) {
    console.log('Uso: node scripts/secretos.mjs <asociar|migrar|probar> [--env <ruta>] [--simular] [--forzar]');
    return comando ? 2 : 0;
  }
  try {
    return await fn({ args });
  } catch (err) {
    console.error(`Error: ${err instanceof kp.ErrorKeepassxc ? err.message : (err && err.message ? err.message : 'inesperado')}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((codigo) => process.exit(codigo));
}
