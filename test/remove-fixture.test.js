/**
 * BE-045 — `removeFixture` reintenta un EBUSY por su cuenta: Node no lo hace
 * cuando el directorio es el cwd de un proceso vivo, aunque reciba
 * `maxRetries`. El EBUSY de un cwd solo existe en Windows; en otros sistemas
 * esos casos se omiten con el motivo.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const esWin = process.platform === 'win32';
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const nuevoDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'remove-fixture-'));

/** Limpieza de último recurso: espera al hijo y borra lo que haya quedado, sin lanzar. */
async function limpiar(dir, salida) {
  await salida;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Un hijo vivo `vidaMs` con cwd en `dir`; resuelve cuando ya arrancó. */
async function hijoEn(dir, vidaMs) {
  const hijo = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${vidaMs})`], { cwd: dir, stdio: 'ignore' });
  const salida = new Promise(resolve => hijo.once('exit', resolve));
  await esperar(150);
  return { hijo, salida };
}

async function main() {
  await group('un cwd que se libera enseguida: reintenta y borra', async () => {
    if (!esWin) return check('omitido: el EBUSY de un cwd solo ocurre en Windows', true);
    const dir = nuevoDir();
    const { salida } = await hijoEn(dir, 300);
    try {
      let crudo = null;
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch (err) { crudo = err.code; }
      check('precondición: rmSync con maxRetries lanza EBUSY con el hijo vivo', crudo === 'EBUSY', String(crudo));
      const t0 = Date.now();
      let error = null;
      try { removeFixture(dir); } catch (err) { error = err; }
      const ms = Date.now() - t0;
      check('removeFixture no lanza', error === null, error && error.message);
      check('el directorio ya no existe', !fs.existsSync(dir));
      check('terminó antes del plazo', ms < 5000, `${ms} ms`);
    } finally {
      await limpiar(dir, salida);
    }
  });

  await group('un bloqueo que dura más que el plazo: lanza, no se lo traga', async () => {
    if (!esWin) return check('omitido: el EBUSY de un cwd solo ocurre en Windows', true);
    const dir = nuevoDir();
    const { salida } = await hijoEn(dir, 3000);
    try {
      const t0 = Date.now();
      let error = null;
      try { removeFixture(dir, { plazoMs: 400 }); } catch (err) { error = err; }
      const ms = Date.now() - t0;
      check('lanza EBUSY', error && error.code === 'EBUSY', error ? error.code : 'no lanzó');
      check('lanzó recién vencido el plazo', ms >= 400, `${ms} ms`);
      await salida;
      removeFixture(dir);
      check('con el hijo terminado, se borra', !fs.existsSync(dir));
    } finally {
      await limpiar(dir, salida);
    }
  });

  await group('un directorio inexistente no lanza', () => {
    const dir = path.join(os.tmpdir(), `remove-fixture-no-existe-${process.pid}-${Date.now()}`);
    let error = null;
    try { removeFixture(dir); } catch (err) { error = err; }
    check('no lanza', error === null, error && error.message);
  });

  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
