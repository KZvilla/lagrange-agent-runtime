/**
 * BE-166 -- Extrae del log de una puerta las lineas que nombran un fallo.
 *
 * Existe porque `npm run gates` solo citaba las lineas `FAILED:` de
 * `test/run.js`: los `(fail)` de `bun test` (`test:mod`) y los `FAIL` del arnes
 * propio se perdian, y un fallo intermitente quedaba sin nombre. Es una funcion
 * pura para poder probarla sin lanzar las puertas.
 */

const ANSI = /\x1b\[[0-9;]*m/g;

// Formatos reales del repositorio:
//   FAILED: test/foo.test.js            test/run.js
//   FAIL  <check> — <detalle>           test/lib/assert.js
//   (fail) <test>                       bun test (test:mod)
const PATRONES = [
  /^FAILED:\s+\S/,
  /^FAIL\s{2,}\S/,
  /^\(fail\)\s+\S/
];

export function lineasDeFallo(salida, maximo = 20) {
  if (typeof salida !== 'string' || !salida) return [];
  const vistas = new Set();
  const lineas = [];
  for (const cruda of salida.split(/\r?\n/)) {
    const linea = cruda.replace(ANSI, '').trimStart();
    if (!PATRONES.some((patron) => patron.test(linea))) continue;
    if (vistas.has(linea)) continue;
    vistas.add(linea);
    lineas.push(linea);
  }
  if (lineas.length > maximo) {
    const resto = lineas.length - maximo;
    return [...lineas.slice(0, maximo), `… y ${resto} más`];
  }
  return lineas;
}
