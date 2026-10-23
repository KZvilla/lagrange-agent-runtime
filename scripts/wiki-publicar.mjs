#!/usr/bin/env node
/**
 * BE-157 — publica `wiki/` en el repositorio de la wiki de GitHub.
 *
 *   node scripts/wiki-publicar.mjs [--simular] [--forzar] [--repo <path>] [--remoto <url>]
 *
 * Publica solo lo mergeado (`HEAD == origin/main`), salvo `--simular`, que lee
 * los blobs de `HEAD` y no pushea. El commit lleva `Source: <sha>`; si después
 * de ese marcador hay commits que no escribió este script, aborta: alguien
 * editó la wiki en la web y hay que traerlo a `wiki/` por PR. `--forzar` lo
 * pisa con un commit nuevo, nunca con un push forzado.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  urlWiki,
  planificar,
  leerMarcador,
  edicionesExternas,
  mensajeDeCommit
} from './lib/wiki-publicar.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argumentos(argv) {
  const opciones = { simular: false, forzar: false, repo: RAIZ, remoto: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--simular') opciones.simular = true;
    else if (arg === '--forzar') opciones.forzar = true;
    else if (arg === '--repo' || arg === '--remoto') {
      const valor = argv[i + 1];
      if (!valor) throw new Error(`${arg} necesita un valor`);
      opciones[arg.slice(2)] = valor;
      i += 1;
    } else {
      throw new Error(`opción desconocida: ${arg}`);
    }
  }
  return opciones;
}

function git(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    const detalle = String(r.stderr || r.stdout || '').trim();
    throw new Error(`git ${args.join(' ')}: ${detalle}`);
  }
  return r.stdout;
}

function leerCommits(cwd) {
  let salida;
  try {
    salida = git(['log', '--format=%H%x1f%s%x1f%b%x1e'], cwd);
  } catch {
    return []; // wiki vacía: no hay marcador
  }
  return salida
    .split('\x1e')
    .map((registro) => registro.trim())
    .filter(Boolean)
    .map((registro) => {
      const [sha, subject, body] = registro.split('\x1f');
      return { sha, subject: subject || '', body: body || '' };
    });
}

function leerLocales(repo, wikiDir) {
  if (!fs.existsSync(wikiDir)) throw new Error('no existe wiki/');
  const entradas = fs.readdirSync(wikiDir, { withFileTypes: true });
  const malas = entradas.filter((e) => !e.isFile() || !e.name.endsWith('.md'));
  if (malas.length) {
    throw new Error(`wiki/ solo admite *.md en el nivel superior: ${malas.map((e) => e.name).join(', ')}`);
  }
  const archivos = entradas.map((e) => e.name).sort();
  if (!archivos.length) throw new Error('wiki/ está vacío: no voy a borrar la wiki publicada');

  const locales = new Map();
  for (const nombre of archivos) {
    // El blob de HEAD, no el working tree: publica LF y no depende del checkout.
    locales.set(nombre, git(['show', `HEAD:wiki/${nombre}`], repo));
  }
  return locales;
}

function leerRemotos(clone) {
  const remotos = new Map();
  for (const entrada of fs.readdirSync(clone, { withFileTypes: true })) {
    if (entrada.name === '.git') continue;
    if (!entrada.isFile() || !entrada.name.endsWith('.md')) {
      remotos.set(entrada.name, null);
      continue;
    }
    try {
      remotos.set(entrada.name, git(['show', `HEAD:${entrada.name}`], clone));
    } catch {
      remotos.set(entrada.name, null);
    }
  }
  return remotos;
}

function imprimirPlan(plan) {
  if (plan.agregar.length) console.log(`Agregar: ${plan.agregar.join(', ')}`);
  if (plan.actualizar.length) console.log(`Actualizar: ${plan.actualizar.join(', ')}`);
  if (plan.borrar.length) console.log(`Borrar: ${plan.borrar.join(', ')}`);
  if (!plan.agregar.length && !plan.actualizar.length && !plan.borrar.length) {
    console.log('Sin cambios.');
  }
}

function main() {
  const opciones = argumentos(process.argv.slice(2));
  const repo = path.resolve(opciones.repo);

  git(['fetch', 'origin', 'main'], repo);

  const sucio = git(['status', '--porcelain'], repo).trim();
  if (sucio) throw new Error(`el repo no está limpio:\n${sucio}`);

  const sha = git(['rev-parse', 'HEAD'], repo).trim();
  if (!opciones.simular) {
    const origen = git(['rev-parse', 'origin/main'], repo).trim();
    if (sha !== origen) {
      throw new Error('HEAD no es origin/main: mergeá primero, o usá --simular para revisar');
    }
  }

  const remoto = opciones.remoto || urlWiki(git(['remote', 'get-url', 'origin'], repo).trim());
  const locales = leerLocales(repo, path.join(repo, 'wiki'));
  const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-wiki-'));

  try {
    git(['clone', '--quiet', remoto, temporal], repo);
    git(['config', 'core.autocrlf', 'false'], temporal);
    git(['config', 'core.safecrlf', 'false'], temporal);

    const rama = git(['symbolic-ref', '--short', 'HEAD'], temporal).trim();
    if (!rama) throw new Error('la wiki clonada no tiene una rama actual');

    const commits = leerCommits(temporal);
    const marcador = leerMarcador(commits);
    const externas = marcador ? edicionesExternas(commits, marcador.sha) : [];

    if (externas.length && !opciones.forzar) {
      console.error('La wiki tiene ediciones externas desde la última publicación:');
      for (const commit of externas) console.error(`  ${commit.sha.slice(0, 12)} ${commit.subject}`);
      console.error('Traelas a wiki/ por PR, o usá --forzar para pisarlas con el contenido del repo.');
      process.exitCode = 1;
      return;
    }
    if (externas.length) {
      console.warn(`--forzar: se pisan ${externas.length} commit(s) externo(s) con wiki/.`);
    }

    const remotos = leerRemotos(temporal);
    const plan = planificar(locales, remotos);

    if (opciones.simular) {
      imprimirPlan(plan);
      return;
    }

    for (const entrada of fs.readdirSync(temporal)) {
      if (entrada === '.git') continue;
      fs.rmSync(path.join(temporal, entrada), { recursive: true, force: true, maxRetries: 3 });
    }
    for (const [nombre, contenido] of locales) {
      fs.writeFileSync(path.join(temporal, nombre), contenido, 'utf8');
    }
    git(['add', '-A'], temporal);

    const staged = git(['status', '--porcelain'], temporal).trim();
    if (!staged && marcador) {
      imprimirPlan(plan);
      return;
    }

    const mensaje = mensajeDeCommit(sha);
    if (staged) git(['commit', '-m', mensaje], temporal);
    else git(['commit', '--allow-empty', '-m', mensaje], temporal);
    git(['push', 'origin', `HEAD:${rama}`], temporal);

    imprimirPlan(plan);
    console.log(`Wiki publicada desde ${sha.slice(0, 12)} (${rama}).`);
  } finally {
    try {
      fs.rmSync(temporal, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.error(`No se pudo borrar el clon temporal ${temporal}: ${err.message}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
