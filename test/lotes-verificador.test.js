const { check, group, report } = require('./lib/assert.js');
const { validarPrueba, ejecutarAcotado, MAX_SALIDA } = require('../mcp-server/lotes/verificador.js');

async function main() {
  await group('contrato de prueba', () => {
    check('ausente significa no configurada', validarPrueba(null) === null);
    const p = validarPrueba({ argv: ['node', 'x.js'] });
    check('default de diez minutos', p.timeout_minutes === 10);
    let fallo = false;
    try { validarPrueba({ argv: ['node'], timeout_minutes: 16 }); } catch { fallo = true; }
    check('rechaza timeout mayor a quince', fallo);
    fallo = false;
    try { validarPrueba({ argv: ['x'.repeat(4097)] }); } catch { fallo = true; }
    check('acota cada argumento', fallo);
  });

  await group('runner acotado por chunks', async () => {
    const ok = await ejecutarAcotado(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 5000 });
    check('propaga exit cero', ok.code === 0 && ok.salida === 'ok');
    const flood = await ejecutarAcotado(process.execPath, ['-e', `process.stdout.write("x".repeat(${MAX_SALIDA * 4}))`], { timeoutMs: 5000 });
    check('trunca un flood sin saltos', flood.salidaTruncada && flood.salida.length === MAX_SALIDA);
    const rojo = await ejecutarAcotado(process.execPath, ['-e', 'process.stderr.write("mal");process.exit(7)'], { timeoutMs: 5000 });
    check('conserva exit y stderr', rojo.code === 7 && rojo.salida === 'mal');
  });

  report();
}

main();
