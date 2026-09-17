/**
 * FEAT-065 — Adjuntos entrantes.
 *
 * Lo que se prueba acá es la defensa, porque el archivo viene de afuera: que el
 * nombre no pueda escaparse del directorio, que la lista blanca sea blanca de
 * verdad (incluida la doble extensión) y que los dos topes frenen.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const MODULO = pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'adjuntos.js')).href;
const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

async function main() {
  const adj = await import(MODULO);
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'adjuntos-'));

  try {
    await group('la extensión decide, y mira la última', () => {
      check('png pasa', adj.extensionPermitida('captura.png') === 'png');
      check('LOG en mayúsculas pasa como log', adj.extensionPermitida('SALIDA.LOG') === 'log');
      check('exe no pasa', adj.extensionPermitida('virus.exe') === null);
      check('ps1 no pasa', adj.extensionPermitida('script.ps1') === null);
      check('sh no pasa', adj.extensionPermitida('run.sh') === null);
      check('zip no pasa', adj.extensionPermitida('todo.zip') === null);
      check('sin extensión no pasa', adj.extensionPermitida('README') === null);
      // La trampa clásica: el doble sufijo.
      check('informe.txt.exe se lee como exe', adj.extensionPermitida('informe.txt.exe') === null);
      check('foto.exe.png sí es png', adj.extensionPermitida('foto.exe.png') === 'png');
    });

    await group('el nombre guardado no conserva nada peligroso', () => {
      const fijo = { ahora: () => new Date(Date.UTC(2026, 8, 17, 12, 30)), azar: () => 'abc123' };

      const travesia = adj.nombreSeguro('../../../../Windows/System32/notas.txt', fijo);
      check('una travesía de ruta se guarda igual', travesia.ok);
      check('sin separadores ni puntos dobles', !/[\\/]/.test(travesia.nombre) && !travesia.nombre.includes('..'), travesia.nombre);
      check('solo sobrevive el basename', travesia.nombre.endsWith('-notas.txt'), travesia.nombre);

      const windows = adj.nombreSeguro('C:\\Users\\otro\\secreto.log', fijo);
      check('una ruta de Windows tampoco deja rastro', !/[\\/:]/.test(windows.nombre), windows.nombre);

      // Nombres reservados de Windows: al llevar prefijo, dejan de serlo.
      const reservado = adj.nombreSeguro('NUL.txt', fijo);
      check('un nombre reservado queda prefijado', reservado.nombre !== 'NUL.txt' && reservado.nombre.endsWith('-nul.txt'), reservado.nombre);

      const raro = adj.nombreSeguro('  ¡Ñandú del 2026!.MD  ', fijo);
      check('los acentos y signos se normalizan', raro.nombre.endsWith('-nandu-del-2026.md'), raro.nombre);

      const largo = adj.nombreSeguro('a'.repeat(500) + '.txt', fijo);
      check('un nombre larguísimo se recorta', largo.nombre.length < 80, String(largo.nombre.length));

      const soloSignos = adj.nombreSeguro('####.txt', fijo);
      check('un nombre sin nada utilizable cae en «adjunto»', soloSignos.nombre.endsWith('-adjunto.txt'), soloSignos.nombre);

      check('una extensión prohibida ni llega a tener nombre', adj.nombreSeguro('x.exe', fijo).ok === false);
      check('y dice por qué', adj.nombreSeguro('x.exe', fijo).motivo === 'extension');

      const a = adj.nombreSeguro('igual.txt');
      const b = adj.nombreSeguro('igual.txt');
      check('dos archivos con el mismo nombre no colisionan', a.nombre !== b.nombre);
    });

    await group('guardar: topes y escritura', () => {
      const dir = path.join(raiz, 'guardar');

      const ok = adj.guardarAdjunto({ dir, nombreOriginal: 'log.txt', contenido: Buffer.from('hola') });
      check('guarda y devuelve la ruta', ok.ok && fs.existsSync(ok.ruta));
      check('la ruta queda DENTRO del directorio', path.dirname(path.resolve(ok.ruta)) === path.resolve(dir), ok.ruta);
      check('el contenido es el mismo', fs.readFileSync(ok.ruta, 'utf8') === 'hola');

      check('vacío se rechaza', adj.guardarAdjunto({ dir, nombreOriginal: 'v.txt', contenido: Buffer.alloc(0) }).motivo === 'vacio');
      check('algo que no es buffer se rechaza', adj.guardarAdjunto({ dir, nombreOriginal: 'v.txt', contenido: 'texto' }).motivo === 'vacio');
      check('una extensión prohibida se rechaza', adj.guardarAdjunto({ dir, nombreOriginal: 'a.exe', contenido: Buffer.from('MZ') }).motivo === 'extension');

      const gigante = adj.guardarAdjunto({ dir, nombreOriginal: 'g.txt', contenido: Buffer.alloc(adj.TOPE_ARCHIVO_BYTES + 1) });
      check('un archivo por encima del tope se rechaza', gigante.motivo === 'grande');

      // La travesía, de punta a punta: el archivo no puede aparecer fuera.
      const fuera = path.join(raiz, 'guardar-fuera.txt');
      const intento = adj.guardarAdjunto({ dir, nombreOriginal: '../guardar-fuera.txt', contenido: Buffer.from('x') });
      check('una travesía no escribe fuera del directorio', intento.ok && !fs.existsSync(fuera));
    });

    await group('el tope del directorio frena', () => {
      const dir = path.join(raiz, 'lleno');
      fs.mkdirSync(dir, { recursive: true });
      check('un directorio vacío no ocupa', adj.espacioUsado(dir) === 0);
      check('uno que no existe tampoco', adj.espacioUsado(path.join(raiz, 'no-existe')) === 0);

      // Se simula el tope con un archivo del tamaño del cupo.
      fs.writeFileSync(path.join(dir, 'ocupa.txt'), Buffer.alloc(adj.TOPE_TOTAL_BYTES));
      check('el usado refleja lo que hay', adj.espacioUsado(dir) === adj.TOPE_TOTAL_BYTES);
      const r = adj.guardarAdjunto({ dir, nombreOriginal: 'uno-mas.txt', contenido: Buffer.from('x') });
      check('con el cupo lleno se rechaza', r.motivo === 'lleno');
      check('y el mensaje dice dónde hacer lugar', adj.explicarMotivo('lleno', 'uno-mas.txt', dir).includes(dir));
    });

    await group('de qué archivo habla un mensaje', () => {
      check('sin adjunto devuelve null', adj.adjuntoDelMensaje({ text: 'hola' }) === null);
      check('un mensaje vacío también', adj.adjuntoDelMensaje() === null);

      const doc = adj.adjuntoDelMensaje({ document: { file_id: 'd1', file_name: 'salida.log' } });
      check('documento: id y nombre', doc.fileId === 'd1' && doc.nombreOriginal === 'salida.log' && doc.clase === 'documento');

      const sinNombre = adj.adjuntoDelMensaje({ document: { file_id: 'd2' } });
      check('documento sin nombre no rompe', sinNombre.nombreOriginal === 'documento');

      const foto = adj.adjuntoDelMensaje({ photo: [{ file_id: 'chica' }, { file_id: 'grande' }] });
      check('foto: se toma el tamaño más grande', foto.fileId === 'grande' && foto.clase === 'foto');
    });

    await group('los mensajes de rechazo explican', () => {
      const m = adj.explicarMotivo('extension', 'virus.exe', '/tmp');
      check('nombra el archivo', m.includes('virus.exe'));
      check('dice qué sí se acepta', m.includes('png') && m.includes('txt'));
      check('un motivo desconocido no rompe', typeof adj.explicarMotivo('marciano', 'x', '/tmp') === 'string');
    });
  } finally {
    borrar(raiz);
  }

  report();
}

main();
