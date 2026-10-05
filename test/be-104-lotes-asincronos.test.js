/**
 * BE-104 — El camino del lote no frena el event loop: mientras git y tar
 * trabajan, un reloj de 10 ms sigue disparando. En P3 el daemon se quedó 6,3 s
 * sin atender nada al lanzar un lote, porque crear worktrees y copiar el repo
 * eran procesos hijo síncronos.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert.js');
const { temporalQueSeBorra } = require('./lib/temporales');
const wt = require('../mcp-server/worktrees.js');
const copia = require('../mcp-server/lotes/copia.js');

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });

/** Mide el hueco más largo entre ticks de un reloj de 10 ms mientras corre `fn`. */
async function huecoMaximo(fn) {
  let ultimo = Date.now();
  let maximo = 0;
  let ticks = 0;
  const reloj = setInterval(() => {
    const ahora = Date.now();
    maximo = Math.max(maximo, ahora - ultimo);
    ultimo = ahora;
    ticks++;
  }, 10);
  try {
    await fn();
  } finally {
    clearInterval(reloj);
  }
  return { maximo, ticks };
}

async function main() {
  const raiz = temporalQueSeBorra('be-104-');
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'trabajo');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(repo, `archivo-${i}.txt`), `contenido ${i}\n`.repeat(50));
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');

  await group('worktrees y copia corren sin frenar el event loop', async () => {
    let creados = [];
    const crear = await huecoMaximo(async () => {
      creados = await wt.crearWorktrees(repo, { slug: 'medir', cantidad: 2, ramaBase: 'trabajo' });
    });
    check(`crearWorktrees: el reloj siguió (${crear.ticks} ticks, hueco máx ${crear.maximo} ms)`, creados.length === 2 && crear.ticks > 0 && crear.maximo < 200);

    const copiar = await huecoMaximo(() => copia.copiaPlana({ worktree: creados[0].ruta, destino: path.join(raiz, 'copias', 'a'), raizPermitida: path.join(raiz, 'copias'), fiel: true }));
    check(`copiaPlana: el reloj siguió (${copiar.ticks} ticks, hueco máx ${copiar.maximo} ms)`, copiar.ticks > 0 && copiar.maximo < 200);
    check('la copia tiene los archivos y no tiene .git', fs.existsSync(path.join(raiz, 'copias', 'a', 'archivo-0.txt')) && !fs.existsSync(path.join(raiz, 'copias', 'a', '.git')));

    let lista = [];
    const listar = await huecoMaximo(async () => { lista = await wt.listarWorktrees(repo); });
    check(`listarWorktrees: el reloj siguió (hueco máx ${listar.maximo} ms)`, lista.length === 3 && listar.maximo < 200, JSON.stringify(lista));

    await wt.limpiarWorktrees(repo, 'trabajo');
  });

  await group('sincronizar recorre la copia entera sin frenar el event loop', async () => {
    // En vivo (2026-10-05) esto frenaba 3,6 s por tarea: readFileSync de ~420 archivos.
    const grande = path.join(raiz, 'grande');
    fs.mkdirSync(grande);
    git(grande, 'init', '-q', '-b', 'trabajo');
    git(grande, 'config', 'core.autocrlf', 'false');
    for (let d = 0; d < 20; d++) {
      fs.mkdirSync(path.join(grande, `dir${d}`));
      for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(grande, `dir${d}`, `f${i}.txt`), `linea ${d}-${i}\n`.repeat(1500));
    }
    git(grande, 'add', '-A');
    git(grande, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    const dest = path.join(raiz, 'copias', 'grande');
    await copia.copiaPlana({ worktree: grande, destino: dest, raizPermitida: path.join(raiz, 'copias') });
    fs.mkdirSync(path.join(dest, 'nuevo'));
    fs.writeFileSync(path.join(dest, 'nuevo', 'a.txt'), 'a\n');
    let res = null;
    const r = await huecoMaximo(async () => { res = await copia.sincronizar({ copia: dest, worktree: grande, archivos: ['nuevo/a.txt'] }); });
    check(`sincronizar sobre 400 archivos: el reloj siguió (${r.ticks} ticks, hueco máx ${r.maximo} ms)`, r.maximo < 200);
    check('y trae solo lo declarado, sin anomalías', JSON.stringify(res.tocados) === '["nuevo/a.txt"]' && res.anomalias.length === 0, JSON.stringify(res));
  });

  await group('un git lento no congela el proceso', async () => {
    // Un "git" que tarda 1 s: el commit de una tarea con un hook lento, un index.lock, el antivirus.
    const lento = (args, { cwd } = {}) => new Promise((resolve) => {
      require('node:child_process').execFile(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { windowsHide: true }, () => resolve(''));
    });
    const r = await huecoMaximo(() => copia.commitSeguro({ worktree: repo, tocados: ['archivo-0.txt'], mensaje: 'x', git: lento }));
    check(`con un git de 1 s el reloj siguió (${r.ticks} ticks, hueco máx ${r.maximo} ms)`, r.ticks >= 50 && r.maximo < 200);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
