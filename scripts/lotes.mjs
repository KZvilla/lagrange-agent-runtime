#!/usr/bin/env node
/**
 * Herramienta de línea de comandos de los lotes en contenedor (FEAT-061 fase 2).
 *
 *   npm run lotes -- imagenes        construye las dos imágenes en WSL
 *   npm run lotes -- login           imprime el comando de login (no lo corre)
 *   npm run lotes -- listar          los lotes registrados
 *   npm run lotes -- recolectar      poda contenedores, redes, volúmenes y copias
 *   npm run lotes -- descartar <id>  borra worktrees y ramas de ESE lote
 *
 * POR QUÉ `descartar` VIVE ACÁ Y NO EN LA TOOL
 * -------------------------------------------
 * Descartar borra ramas: es la única operación de la feature que destruye
 * trabajo. El RFC (§2 R4) la puso del lado del humano a propósito, y en la fase
 * 2 el humano tiene una terminal, no un botón. Pide escribir el id otra vez
 * porque un `-f` no es una confirmación: es una costumbre.
 */
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBridgeDataDir } from '../telegram-bridge/paths.js';

const require = createRequire(import.meta.url);
const { crearRegistro } = require('../mcp-server/lotes/registro.js');
const {
  crearDocker, IMAGEN_AGY, IMAGEN_PROXY, VOLUMEN_CREDENCIALES,
  VOLUMEN_CA_PRIVADA, VOLUMEN_CA_PUBLICA, argvInicializarCA, argvVerificarCA
} = require('../mcp-server/lotes/docker.js');
const { recolectar } = require('../mcp-server/lotes/recolector.js');
const { descartarLote } = require('../mcp-server/lotes/descartar.js');

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirImagenes = path.join(raiz, 'mcp-server', 'lotes', 'imagenes');

function raizCopias() {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'AppData', 'Local');
  return path.join(base, 'lagrange', 'lotes');
}

function wsl(args, { heredado = false } = {}) {
  const r = spawnSync('wsl', args, { stdio: heredado ? 'inherit' : 'pipe', encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    const detalle = heredado ? `código ${r.status}` : String(r.stderr || '').trim().slice(0, 300);
    throw new Error(`wsl ${args.slice(0, 3).join(' ')} falló: ${detalle}`);
  }
  return r;
}

function aRutaWsl(rutaWindows) {
  const r = spawnSync('wsl', ['-e', 'wslpath', '-a', rutaWindows.replace(/\\/g, '/')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`no se pudo traducir la ruta ${rutaWindows} a WSL`);
  return String(r.stdout).trim();
}

function comandoImagenes() {
  const contexto = aRutaWsl(dirImagenes);
  console.log(`Construyendo ${IMAGEN_AGY} y ${IMAGEN_PROXY} desde ${dirImagenes}\n`);
  wsl(['-e', 'docker', 'build', '-f', `${contexto}/Dockerfile.agy`, '-t', IMAGEN_AGY, contexto], { heredado: true });
  wsl(['-e', 'docker', 'build', '-f', `${contexto}/Dockerfile.proxy`, '-t', IMAGEN_PROXY, contexto], { heredado: true });
  wsl(['-e', 'docker', 'volume', 'create', VOLUMEN_CA_PRIVADA], { heredado: true });
  wsl(['-e', 'docker', 'volume', 'create', VOLUMEN_CA_PUBLICA], { heredado: true });
  wsl(['-e', 'docker', ...argvInicializarCA()], { heredado: true });
  wsl(['-e', 'docker', ...argvVerificarCA()], { heredado: true });

  // La versión de agy queda registrada en la imagen: sirve para saber con qué
  // corrió un lote sin abrir un contenedor.
  const version = spawnSync('wsl', ['-e', 'docker', 'run', '--rm', IMAGEN_AGY, 'agy', '--version'], { encoding: 'utf8', windowsHide: true });
  console.log(`\nListo. agy en la imagen: ${String(version.stdout || '').trim() || '(no lo dijo)'}`);
  console.log('CA TLS del proxy inicializada y separada en volúmenes privado/público.');
}

function comandoLogin() {
  console.log(`El login de agy es interactivo (abre un navegador), así que este script NO lo corre.

Copiá y pegá esto en tu terminal:

  wsl -e docker run -it --rm -v ${VOLUMEN_CREDENCIALES}:/home/agy ${IMAGEN_AGY} agy

Cuando termine, cerrá agy con /exit. El OAuth queda en el volumen
\`${VOLUMEN_CREDENCIALES}\`, que solo monta el refrescador: el contenedor de una
tarea nunca lo ve.

Renovar el acceso más adelante es el mismo comando.`);
}

function abrirRegistro() {
  return crearRegistro({ dir: resolveBridgeDataDir() });
}

function comandoListar() {
  const lotes = abrirRegistro().listar();
  if (!lotes.length) {
    console.log('No hay lotes registrados.');
    return;
  }
  for (const lote of lotes) {
    console.log(`\n${lote.id}  [${lote.estado}]  ${lote.creado}`);
    console.log(`  repo: ${lote.repo}`);
    console.log(`  rama base: ${lote.ramaBase}`);
    for (const t of lote.tareas) {
      const anomalias = (t.anomalias || []).length ? ` · ${t.anomalias.length} anomalía(s)` : '';
      console.log(`  - ${t.id}: ${t.estado}${t.commit ? ` · ${t.commit.slice(0, 8)}` : ''}${anomalias}`);
    }
  }
}

async function comandoRecolectar() {
  const registro = abrirRegistro();
  registro.marcarInterrumpidos();
  const corriendo = registro.listar().filter(l => l.estado === 'corriendo').map(l => l.id);
  const docker = crearDocker({});
  const podados = await recolectar({ docker, lotesCorriendo: corriendo, raizCopias: raizCopias() });
  console.log(`Contenedores: ${podados.contenedores.length}`);
  console.log(`Redes: ${podados.redes.length}`);
  console.log(`Volúmenes: ${podados.volumenes.length}`);
  console.log(`Copias en disco: ${podados.copias.length}`);
  if (!corriendo.length) return;
  console.log(`\nSin tocar (lotes corriendo): ${corriendo.join(', ')}`);
}

function git(repo, args, { permitirFallo = false } = {}) {
  try {
    // stderr capturado: si no, los avisos de git de un worktree que ya no
    // existe se mezclan con lo que este script le esta contando al usuario.
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (permitirFallo) return null;
    throw err;
  }
}

async function comandoDescartar(id) {
  if (!id) throw new Error('falta el id: npm run lotes -- descartar <id>');
  const registro = abrirRegistro();

  const r = await descartarLote({
    registro,
    id,
    git,
    informar: (linea) => console.log(linea),
    confirmar: async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const respuesta = await rl.question('\nEscribí el id del lote para confirmar: ');
      rl.close();
      return respuesta;
    },
    // Ojo con la lista de lotes corriendo: recolectar con la lista vacía
    // podaría los contenedores de OTRO lote que esté corriendo ahora mismo.
    recolectarRestos: async () => {
      const corriendo = registro.listar().filter(l => l.estado === 'corriendo').map(l => l.id);
      await recolectar({ docker: crearDocker({}), lotesCorriendo: corriendo, raizCopias: raizCopias() });
    }
  });

  if (!r.descartado) process.exitCode = 1;
}

const [accion, ...resto] = process.argv.slice(2);

try {
  switch (accion) {
    case 'imagenes': comandoImagenes(); break;
    case 'login': comandoLogin(); break;
    case 'listar': comandoListar(); break;
    case 'recolectar': await comandoRecolectar(); break;
    case 'descartar': await comandoDescartar(resto[0]); break;
    default:
      console.log('Uso: npm run lotes -- <imagenes|login|listar|recolectar|descartar <id>>');
      process.exitCode = accion ? 1 : 0;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
