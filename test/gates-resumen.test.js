/**
 * BE-166 — El resumen de `gates` nombra el fallo de los tres runners.
 *
 * `lineasDeFallo` es puro: no lanza las puertas ni toca el disco. Cubre
 * `FAILED:` de `test/run.js`, `FAIL` del arnés propio y `(fail)` de `bun test`,
 * con sangría y códigos ANSI.
 */
const { check, group, report } = require('./lib/assert');

async function main() {
  const { lineasDeFallo } = await import('../scripts/gates-resumen.mjs');

  await group('BE-166 - lineasDeFallo reconoce los tres formatos', () => {
    const salida = [
      'basura',
      'FAILED: test/foo.test.js (exit 1)',
      '  FAIL  voz: contesta — detalle',
      '  \x1b[31m(fail)\x1b[0m voz-mod > hace X',
      'not ok 3 - no se usa'
    ].join('\n');
    const lineas = lineasDeFallo(salida);
    check('nombra el archivo de test/run.js', lineas.includes('FAILED: test/foo.test.js (exit 1)'));
    check('nombra el check del arnés', lineas.includes('FAIL  voz: contesta — detalle'));
    check('nombra el test de bun sin ANSI', lineas.includes('(fail) voz-mod > hace X'));
    check('ignora not ok, que el repo no usa', !lineas.some((l) => l.startsWith('not ok')));
    check('no inventa líneas', lineas.length === 3, JSON.stringify(lineas));
  });

  await group('BE-166 - soporta CRLF, sangría y duplicados', () => {
    const salida = '  FAILED: test/a.test.js\r\n\tFAILED: test/a.test.js\r\n';
    check('quita duplicados y sangría', JSON.stringify(lineasDeFallo(salida)) === JSON.stringify(['FAILED: test/a.test.js']));
  });

  await group('BE-166 - vacío y tope', () => {
    check('salida vacía → []', lineasDeFallo('').length === 0);
    check('sin coincidencias → []', lineasDeFallo('todo bien\n0 fallos').length === 0);
    check('no string → []', lineasDeFallo(null).length === 0);
    const muchas = Array.from({ length: 25 }, (_, i) => `FAILED: test/${i}.test.js`).join('\n');
    const recortadas = lineasDeFallo(muchas, 20);
    check('corta en el máximo', recortadas.length === 21, String(recortadas.length));
    check('dice cuántas quedaron fuera', recortadas[20] === '… y 5 más', recortadas[20]);
  });

  process.exit(report() ? 0 : 1);
}

main();
