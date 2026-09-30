'use strict';

/**
 * BE-076 — Un directorio temporal que se borra al salir el proceso, salga como
 * salga: `process.exit` del reporte, el `main().catch` de un fallo o el final
 * natural. Antes, `almas-profunda.test.js` no borraba nada y otras suites solo
 * en el camino feliz: `%LOCALAPPDATA%\Temp` juntó cientos de `alya/memoria.md`
 * de prueba.
 *
 * El hook de `exit` tiene que ser síncrono: `removeFixture` lo es, y reintenta
 * el EBUSY de Windows que `fs.rmSync` no reintenta (BE-045). Si igual no se
 * puede borrar, se avisa y el código de salida no cambia: un temporal que queda
 * no hace fallar una suite que pasó.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeFixture } = require('./mcp-client');

function temporalQueSeBorra(prefijo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  process.on('exit', () => {
    try {
      removeFixture(dir);
    } catch (err) {
      process.stderr.write(`[temporales] No se pudo borrar ${dir}: ${err.message}\n`);
    }
  });
  return dir;
}

module.exports = { temporalQueSeBorra };
