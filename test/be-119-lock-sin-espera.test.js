/**
 * BE-119 — `conLock` con `esperaMs: 0` (las vistas de FEAT-129) no puede tirar
 * un EPERM de Windows como error real cuando el lock está en delete pending.
 *
 * Antes: con el plazo ya vencido en el primer intento, `existsSync` daba false
 * durante el borrado y el EPERM salía tal cual (≈70 de 1600 en este estrés);
 * `conocimiento.test.js` fallaba de vez en cuando en «sin EPERM/EBUSY sin
 * capturar» y `npm run gates` se ponía rojo sin causa visible.
 *
 * Cuatro procesos compiten por el mismo lock sin espera: cada intento tiene
 * que entrar o salir con ErrorLock, nunca con otro error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { check, group, report } = require('./lib/assert');

const ARCHIVOS = path.join(__dirname, '..', 'mcp-server', 'almas', 'archivos.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be119-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const CICLOS = 300;
const hijo = `
const { conLock, ErrorLock } = require(${JSON.stringify(ARCHIVOS)});
let ok = 0, ocupado = 0, otros = [];
for (let i = 0; i < ${CICLOS}; i++) {
  try { conLock(${JSON.stringify(path.join(dir, 'x'))}, () => { ok++; }, { esperaMs: 0 }); }
  catch (e) { if (e instanceof ErrorLock) ocupado++; else otros.push(e.code || e.message); }
}
console.log(JSON.stringify({ ok, ocupado, otros }));`;

function correr() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', hijo], { windowsHide: true });
    let salida = '';
    p.stdout.on('data', (c) => { salida += c; });
    p.on('exit', () => { try { resolve(JSON.parse(salida)); } catch { resolve({ ok: 0, ocupado: 0, otros: ['salida ilegible'] }); } });
  });
}

async function main() {
  await group('BE-119 — conLock sin espera bajo contención', async () => {
    const rs = await Promise.all([correr(), correr(), correr(), correr()]);
    const otros = rs.flatMap((r) => r.otros);
    const total = rs.reduce((n, r) => n + r.ok + r.ocupado + r.otros.length, 0);
    check('cada intento terminó', total === 4 * CICLOS, String(total));
    check('solo «entró» u «ocupado»: ningún EPERM/EBUSY suelto', otros.length === 0, otros.slice(0, 5).join(', '));
    check('alguno entró', rs.some((r) => r.ok > 0));
    check('no quedó el lock', !fs.existsSync(path.join(dir, 'x.lock')));
  });
  report();
}

main();
