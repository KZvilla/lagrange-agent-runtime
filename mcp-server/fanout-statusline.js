#!/usr/bin/env node
/**
 * Script standalone para `statusLine.command` (FEAT-005 V1).
 *
 * No depende del servidor MCP: se invoca como proceso aparte, cada
 * `refreshInterval` segundos, con el JSON de estado de Claude Code por stdin
 * (mismo contrato que usa claude-hud — ver
 * plugins/cache/claude-hud/<version>/dist/stdin.js e index.js:97, que leen
 * `stdin.cwd`). Lee el archivo que `fanout-estado.js` escribe durante un
 * `agy_fanout` en curso y agrega una línea de progreso a lo que ya hubiera en
 * la statusline, sin reemplazarlo.
 *
 * Nunca debe tirar una excepción sin capturar ni colgarse: una statusline
 * rota es peor que una statusline muda.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { resolverBash } = require('./lib/bash');
const { corridaMasReciente, estaExpirada, armarLinea } = require('./lib/fanout-linea');

const PRIMER_BYTE_TIMEOUT_MS = 250;
const INACTIVIDAD_TIMEOUT_MS = 30;
const MAX_BYTES_STDIN = 256 * 1024;

/** Devuelve { json, raw }: el JSON parseado (o null) y el texto crudo recibido. */
function leerStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({ json: null, raw: '' });

    let crudo = '';
    let asentado = false;
    let timerPrimerByte;
    let timerInactividad;

    const terminar = () => {
      if (asentado) return;
      asentado = true;
      clearTimeout(timerPrimerByte);
      clearTimeout(timerInactividad);
      process.stdin.pause();
      const texto = crudo.trim();
      let json = null;
      if (texto) {
        try { json = JSON.parse(texto); } catch { json = null; }
      }
      resolve({ json, raw: crudo });
    };

    const reprogramarInactividad = () => {
      clearTimeout(timerInactividad);
      timerInactividad = setTimeout(terminar, INACTIVIDAD_TIMEOUT_MS);
    };

    timerPrimerByte = setTimeout(terminar, PRIMER_BYTE_TIMEOUT_MS);

    try {
      process.stdin.setEncoding('utf8');
    } catch {
      return terminar();
    }

    process.stdin.on('data', (chunk) => {
      clearTimeout(timerPrimerByte);
      crudo += chunk;
      if (crudo.length > MAX_BYTES_STDIN) return terminar();
      reprogramarInactividad();
    });
    process.stdin.on('end', terminar);
    process.stdin.on('error', terminar);
  });
}


function leerDelegado(cwd) {
  // Mismo orden de resolución que loadConfig en index.js: global primero,
  // luego project pisa. Acá solo interesa un campo, no vale duplicar todo
  // el módulo de config del servidor MCP en un script standalone.
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const rutas = [
    path.join(homeDir, '.claude', 'antigravity.json'),
    path.join(cwd, '.claude', 'antigravity.json')
  ];
  let delegado = null;
  for (const ruta of rutas) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (parsed.fanout_statusline_delegate !== undefined) delegado = parsed.fanout_statusline_delegate;
    } catch {}
  }
  return delegado;
}

function ejecutarDelegado(comando, stdinCrudo) {
  if (!comando) return '';
  try {
    // Verificado en vivo el 2026-09-05: el delegado que guarda el setup (p. ej.
    // el propio comando de claude-hud) usa sintaxis POSIX (`case`, `${var:-x}`,
    // `$( )`) porque así es como Claude Code invoca `statusLine.command` — pero
    // el default de `execSync` en Windows es `cmd.exe` (ComSpec), que no
    // entiende nada de eso y falla con "cols no se reconoce como...". Hace falta
    // el bash que usa Claude Code (Git Bash), y no cualquier `bash` del PATH:
    // en Windows ese suele ser el lanzador de WSL, que no entiende rutas C:\
    // (lib/bash.js). Sin bash de Git se pierde este segmento, no se rompe nada.
    const shell = resolverBash();
    if (!shell) return '';
    return execSync(comando, { input: stdinCrudo || '', encoding: 'utf8', timeout: 5000, shell, windowsHide: true }).trimEnd();
  } catch {
    return '';
  }
}

function segmentoFanout(ctx) {
  const corrida = corridaMasReciente(ctx.cwd);
  if (!corrida || estaExpirada(corrida)) return null;
  return armarLinea(corrida);
}

// Si el módulo del segmento de Voicebox no carga, el fanout sigue pintándose.
let segmentoVoicebox = () => null;
try {
  ({ segmentoVoicebox } = require('./statusline-voicebox.js'));
} catch {}

// FEAT-104 — La primera línea propia (sin delegado) y la línea de Lagrange.
let armarBase = () => '';
let leerRama = () => null;
try {
  ({ armarBase, leerRama } = require('./lib/statusline-base.js'));
} catch {}
let segmentoLagrange = () => null;
let estadoDelDaemon = async () => null;
try {
  ({ segmentoLagrange, estadoDelDaemon } = require('./lib/statusline-lagrange.js'));
} catch {}

// Una línea por segmento, en este orden. Agregar información a la statusline
// es sumar una función `(ctx) => string | null` acá: sincrónica, lo asíncrono
// se resuelve en `main` antes y llega en `ctx`.
const SEGMENTOS = [segmentoLagrange, segmentoFanout, segmentoVoicebox];

async function main() {
  // El texto crudo de stdin se necesita dos veces: para nuestro propio parseo
  // y para pasárselo intacto al comando delegado (que espera el mismo
  // contrato de Claude Code).
  const { json: datosStdin, raw: crudo } = await leerStdin();

  const cwd = (datosStdin && typeof datosStdin.cwd === 'string' && datosStdin.cwd) || process.cwd();

  // Con delegado (p. ej. claude-hud), la primera línea es la suya, como antes;
  // sin delegado, la propia (FEAT-104).
  const delegado = leerDelegado(cwd);
  let base = '';
  if (delegado) {
    base = ejecutarDelegado(delegado, crudo);
  } else {
    try {
      const ws = (datosStdin && datosStdin.workspace) || {};
      base = armarBase(datosStdin, { rama: leerRama(ws.project_dir || cwd) });
    } catch {}
  }

  const ctx = { cwd, stdin: datosStdin, daemon: await estadoDelDaemon() };
  // Cada segmento aislado: uno que falla se pierde solo, no arrastra al resto.
  const lineas = SEGMENTOS.map((segmento) => {
    try {
      return segmento(ctx) || '';
    } catch {
      return '';
    }
  });

  const salida = [base, ...lineas].filter(Boolean).join('\n');
  process.stdout.write(salida);
}

main().catch(() => {
  // Nunca dejar un stack trace en la statusline.
  process.stdout.write('');
});
