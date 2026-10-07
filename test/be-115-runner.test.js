/**
 * BE-115 — Cuando `npm test` falla, se sabe qué suite fue.
 *
 * - `test/run.js` nombra cada suite rota con su código de salida o su señal,
 *   debajo de la línea `N/M suites FAILED` (que otras partes leen tal cual).
 * - `scripts/gates.mjs` muestra esas líneas aunque la cola de 25 no las
 *   alcance, y guarda la salida completa de la puerta en un archivo.
 *
 * Nada sale de un directorio temporal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be115-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

async function main() {
  await group('BE-115 — run.js nombra las suites rotas', () => {
    fs.writeFileSync(path.join(dir, 'a-pasa.test.js'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(dir, 'b-rota.test.js'), 'process.exit(3);\n');
    fs.writeFileSync(path.join(dir, 'c-tira.test.js'), "throw new Error('read ECONNRESET');\n");
    fs.writeFileSync(path.join(dir, 'no-es-suite.js'), 'process.exit(9);\n');
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'test', 'run.js'), dir], { encoding: 'utf8' });
    const salida = `${r.stdout}${r.stderr}`;
    check('sale distinto de cero', r.status === 1, `status ${r.status}`);
    check('el resumen de siempre: 2/3 suites FAILED', /^2\/3 suites FAILED$/m.test(salida));
    check('nombra la que salió con 3', /^FAILED: b-rota\.test\.js \(exit 3\)$/m.test(salida));
    check('nombra la que tiró', /^FAILED: c-tira\.test\.js \(exit 1\)$/m.test(salida));
    check('no nombra la que pasó', !/FAILED: a-pasa/.test(salida));
    check('solo corre *.test.js', !/no-es-suite/.test(salida));
  });

  await group('BE-115 — run.js en verde no cambia', () => {
    const verde = fs.mkdtempSync(path.join(dir, 'verde-'));
    fs.writeFileSync(path.join(verde, 'a.test.js'), 'process.exit(0);\n');
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'test', 'run.js'), verde], { encoding: 'utf8' });
    check('sale con 0', r.status === 0);
    check('all 1 suites passed', /^all 1 suites passed$/m.test(r.stdout));
    check('sin líneas FAILED', !/FAILED/.test(r.stdout));
  });

  await group('BE-115 — gates.mjs muestra y guarda lo que falló', () => {
    const gates = fs.readFileSync(path.join(RAIZ, 'scripts', 'gates.mjs'), 'utf8');
    check('muestra las líneas FAILED: aunque la cola no llegue', /filter\(l => \/\^FAILED: \/\.test\(l\)\)/.test(gates));
    check('guarda la salida completa de la puerta rota', /guardarSalida\(r\)/.test(gates) && /writeFileSync\(ruta, r\.salida/.test(gates));
    check('dice dónde quedó', /salida completa: \$\{log\}/.test(gates));
  });

  report();
}

main();
