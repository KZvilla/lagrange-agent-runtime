/**
 * BE-050 — En Windows, `openSync(lock, 'wx')` sobre un lock que su dueño está
 * borrando (delete pending) da EPERM, no EEXIST. Medido: 4 procesos × 300
 * ciclos de `conLock` daban 2 a 6 EPERM por corrida, y el test de concurrencia
 * de almas fallaba 2 de cada 6 veces.
 *
 * Se simula parcheando `fs.openSync` solo para la ruta del lock: el caso real
 * (el EPERM aparece SIN archivo de lock visible) no se puede fabricar a
 * voluntad sin otro proceso.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const archivos = require('../mcp-server/almas/archivos.js');
const { crearAlmacenUso } = require('../mcp-server/lib/uso-agy.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-eperm-'));
const openReal = fs.openSync;

/** `fs.openSync` falla `veces` veces con `code` al abrir `rutaLock` en 'wx'. */
function conFallos(rutaLock, code, veces, fn) {
  let quedan = veces;
  let intentos = 0;
  fs.openSync = function (p, flags, ...resto) {
    if (path.resolve(String(p)) === path.resolve(rutaLock) && flags === 'wx') {
      intentos++;
      if (quedan > 0) {
        quedan--;
        const err = new Error(`${code}: simulado, open '${p}'`);
        err.code = code;
        err.syscall = 'open';
        throw err;
      }
    }
    return openReal.call(fs, p, flags, ...resto);
  };
  try {
    return { resultado: fn(), intentos: () => intentos };
  } finally {
    fs.openSync = openReal;
  }
}

async function main() {
  await group('conLock: EPERM/EACCES/EBUSY transitorio es lock ocupado', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const ruta = path.join(base, `transitorio-${code}`, 'memoria.md');
      let corrio = false;
      const { intentos } = conFallos(`${ruta}.lock`, code, 3, () => archivos.conLock(ruta, () => { corrio = true; }, { esperaMs: 2000 }));
      check(`${code} ×3 y después libre → fn corre`, corrio);
      check(`${code}: reintentó hasta tomarlo`, intentos() === 4, String(intentos()));
      check(`${code}: suelta el lock`, !fs.existsSync(`${ruta}.lock`));
    }
  });

  await group('conLock: un permiso real no se disfraza ni se cuelga', () => {
    const ruta = path.join(base, 'permanente', 'memoria.md');
    let error = null;
    let corrio = false;
    const inicio = Date.now();
    conFallos(`${ruta}.lock`, 'EPERM', Infinity, () => {
      try { archivos.conLock(ruta, () => { corrio = true; }, { esperaMs: 300 }); } catch (err) { error = err; }
    });
    const duro = Date.now() - inicio;
    check('EPERM persistente sin lock → el EPERM original', error && error.code === 'EPERM' && !(error instanceof archivos.ErrorLock), error && `${error.name} ${error.code}`);
    check('fn no corre', !corrio);
    check('esperó esperaMs y terminó', duro >= 280 && duro < 3000, `${duro} ms`);

    const conArchivo = path.join(base, 'permanente-con-lock', 'memoria.md');
    fs.mkdirSync(path.dirname(conArchivo), { recursive: true });
    fs.writeFileSync(`${conArchivo}.lock`, '');
    let error2 = null;
    conFallos(`${conArchivo}.lock`, 'EPERM', Infinity, () => {
      try { archivos.conLock(conArchivo, () => {}, { esperaMs: 200 }); } catch (err) { error2 = err; }
    });
    check('EPERM persistente con el lock presente → ErrorLock', error2 instanceof archivos.ErrorLock, error2 && error2.message);

    const otro = path.join(base, 'otro-codigo', 'memoria.md');
    let error3 = null;
    const t0 = Date.now();
    conFallos(`${otro}.lock`, 'EISDIR', Infinity, () => {
      try { archivos.conLock(otro, () => {}, { esperaMs: 2000 }); } catch (err) { error3 = err; }
    });
    check('otro código → se lanza en el acto', error3 && error3.code === 'EISDIR' && Date.now() - t0 < 500, `${error3 && error3.code} ${Date.now() - t0} ms`);
  });

  await group('uso-agy: EPERM sin archivo de lock ya no escribe sin exclusión', () => {
    const ruta = path.join(base, 'uso', 'usage.json');
    const avisos = [];
    const almacen = crearAlmacenUso({ ruta, stderr: { write: (t) => avisos.push(String(t)) } });
    const { intentos } = conFallos(`${ruta}.lock`, 'EPERM', 2, () => almacen.registrarLlamada({ tool: 'run' }));
    check('reintentó hasta tomar el lock', intentos() === 3, String(intentos()));
    check('sin "Se escribe sin exclusión"', !avisos.some(a => /sin exclusi/.test(a)), avisos.join(' | '));
    check('el contador quedó escrito', fs.existsSync(ruta) && fs.readFileSync(ruta, 'utf8').includes('run'));
    check('suelta el lock', !fs.existsSync(`${ruta}.lock`));

    const avisos2 = [];
    const almacen2 = crearAlmacenUso({ ruta: path.join(base, 'uso2', 'usage.json'), stderr: { write: (t) => avisos2.push(String(t)) } });
    const inicio = Date.now();
    conFallos(path.join(base, 'uso2', 'usage.json.lock'), 'EPERM', Infinity, () => almacen2.registrarLlamada({ tool: 'run' }));
    const duro = Date.now() - inicio;
    check('EPERM permanente: termina cerca del deadline (sin spin)', duro < 5000, `${duro} ms`);
    check('y lo avisa', avisos2.some(a => /sin exclusi/.test(a)), avisos2.join(' | '));
  });

  fs.rmSync(base, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  fs.openSync = openReal;
  console.error(err);
  process.exit(1);
});
