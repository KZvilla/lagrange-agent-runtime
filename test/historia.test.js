/**
 * BE-028 — Archivo append-only de lo que se descarta.
 *
 * Tres contratos que el resto del sistema da por sentados:
 *   1. archivar NUNCA lanza (el llamador está en mitad de un guardado);
 *   2. es append de verdad — lo viejo sobrevive a la tanda siguiente;
 *   3. cada entrada cae en el mes de SU fecha, no en el de hoy.
 *
 * Además se prueba la rotación real del diario de un alma, que es uno de los
 * dos puntos donde antes se perdía historia de forma irreversible.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { check, group, report } = require('./lib/assert');

const historia = require('../mcp-server/lib/historia.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'historia-'));
  try {
    await group('agrupa por el mes de cada entrada', () => {
      const dir = path.join(raiz, 'porMes');
      fs.mkdirSync(dir, { recursive: true });
      const r = historia.archivar(dir, [
        { id: 'a', terminada: '2026-08-30T10:00:00.000Z' },
        { id: 'b', terminada: '2026-09-01T10:00:00.000Z' },
        { id: 'c', terminada: '2026-09-17T10:00:00.000Z' }
      ], (t) => t.terminada);

      check('archiva las tres', r.archivadas === 3 && r.fallidas === 0);
      check('agosto queda en su archivo', historia.leerMes(dir, '2026-08').map(e => e.id).join() === 'a');
      check('septiembre junta las dos', historia.leerMes(dir, '2026-09').map(e => e.id).join() === 'b,c');
      check('lista los meses ordenados', historia.mesesArchivados(dir).join() === '2026-08,2026-09');
    });

    await group('es append: una tanda nueva no pisa la anterior', () => {
      const dir = path.join(raiz, 'append');
      const fecha = () => '2026-09-05T00:00:00.000Z';
      historia.archivar(dir, [{ id: 'vieja' }], fecha);
      historia.archivar(dir, [{ id: 'nueva' }], fecha);
      const ids = historia.leerMes(dir, '2026-09').map(e => e.id);
      check('sobreviven las dos, en orden', ids.join() === 'vieja,nueva');
    });

    await group('una fecha ilegible no se archiva como si fuera de hoy', () => {
      const dir = path.join(raiz, 'sinFecha');
      historia.archivar(dir, [{ id: 'x' }, { id: 'y', ts: 'mañana' }], (e) => e.ts);
      check('van a sin-fecha', historia.leerMes(dir, 'sin-fecha').map(e => e.id).join() === 'x,y');
      check('no inventa un mes', historia.mesesArchivados(dir).join() === 'sin-fecha');
    });

    await group('no lanza nunca', () => {
      const dir = path.join(raiz, 'roto');
      // Un ciclo no es serializable: se cuenta como fallida y la tanda sigue.
      const ciclo = { id: 'ciclo' };
      ciclo.yo = ciclo;
      let r;
      check('con una entrada no serializable no lanza', (() => {
        try { r = historia.archivar(dir, [ciclo, { id: 'ok', ts: '2026-09-01T00:00:00.000Z' }], (e) => e.ts); return true; } catch { return false; }
      })());
      check('la cuenta como fallida', r.fallidas === 1);
      check('archiva igual la que sí se puede', r.archivadas === 1);

      // Un destino imposible (el directorio es un archivo) tampoco lanza.
      const ocupado = path.join(raiz, 'ocupado');
      fs.writeFileSync(ocupado, 'no soy un directorio');
      let r2;
      check('con un destino imposible no lanza', (() => {
        try { r2 = historia.archivar(ocupado, [{ id: 'z', ts: '2026-09-01T00:00:00.000Z' }], (e) => e.ts); return true; } catch { return false; }
      })());
      check('lo reporta como fallido', r2.fallidas === 1 && r2.archivadas === 0);

      check('sin entradas no hace nada', historia.archivar(dir, [], () => null).archivadas === 0);
      check('con algo que no es lista tampoco', historia.archivar(dir, null, () => null).archivadas === 0);
    });

    // Los tres caminos que la auditoría de BE-028 encontró lanzando: todo lo
    // que depende de la entrada o del destino tiene que estar cubierto, porque
    // el llamador está en mitad de un guardado.
    await group('no lanza tampoco por el selector de fecha ni por el destino', () => {
      const dir = path.join(raiz, 'noLanza2');
      const intentar = (fn) => { try { return { r: fn() }; } catch (err) { return { err }; } };

      const a = intentar(() => historia.archivar(dir, [{ id: 1 }], () => { throw new Error('boom'); }));
      check('un fechaDe que lanza no propaga', !a.err);
      check('y la entrada cuenta como fallida', a.r.fallidas === 1 && a.r.archivadas === 0);

      const b = intentar(() => historia.archivar(dir, [null], (t) => t.terminada));
      check('una entrada null no propaga', !b.err);
      check('y también cuenta como fallida', b.r.fallidas === 1);

      const c = intentar(() => historia.archivar(null, [{ id: 1 }], () => '2026-09-01T00:00:00.000Z'));
      check('un destino que no es ruta no propaga', !c.err);
      check('y se reporta entero como fallido', c.r.fallidas === 1 && c.r.archivadas === 0);

      const d = intentar(() => historia.archivar(dir, [{ id: 1, ts: '2026-09-01T00:00:00.000Z' }], 'no soy una función'));
      check('un fechaDe que no es función no propaga', !d.err);
      check('cae en sin-fecha en vez de romper', d.r.archivadas === 1 && historia.leerMes(dir, 'sin-fecha').length === 1);

      // Una entrada buena mezclada con una mala sigue archivándose.
      const e = intentar(() => historia.archivar(dir, [
        { id: 'mala' },
        { id: 'buena', ts: '2026-10-01T00:00:00.000Z' }
      ], (x) => x.ts.toUpperCase()));
      check('una mala no arrastra a la buena', !e.err && e.r.archivadas === 1 && e.r.fallidas === 1);
      check('la buena quedó en su mes', historia.leerMes(dir, '2026-10').map(x => x.id).join() === 'buena');

      const f = intentar(() => historia.leerMes(null, '2026-09'));
      check('leerMes con un destino inválido tampoco lanza', !f.err && f.r.length === 0);
      check('mesesArchivados con un destino inválido tampoco', intentar(() => historia.mesesArchivados(null)).r?.length === 0);
    });

    await group('leer un mes tolera una línea rota', () => {
      const dir = path.join(raiz, 'tolerante');
      historia.archivar(dir, [{ id: 'buena', ts: '2026-09-01T00:00:00.000Z' }], (e) => e.ts);
      fs.appendFileSync(historia.archivoDelMes(dir, '2026-09'), '{ esto no es json\n');
      historia.archivar(dir, [{ id: 'posterior', ts: '2026-09-02T00:00:00.000Z' }], (e) => e.ts);
      const ids = historia.leerMes(dir, '2026-09').map(e => e.id);
      check('saltea la rota y devuelve el resto', ids.join() === 'buena,posterior');
      check('un mes que no existe da lista vacía', historia.leerMes(dir, '1999-01').length === 0);
    });

    await group('la rotación del diario de un alma archiva lo expulsado', () => {
      const almas = path.join(raiz, 'almas');
      const env = { ...process.env, LAGRANGE_ALMAS_DIR: almas };
      // Cargado después de fijar el env: rutas.js lo lee por llamada, pero el
      // require de diario.js arrastra archivos.js y conviene el orden claro.
      const diario = require('../mcp-server/almas/diario.js');
      const { rutasDe } = require('../mcp-server/almas/rutas.js');

      let ultimo;
      for (let i = 1; i <= diario.MAX_LINEAS + 1; i++) {
        ultimo = diario.anotar('priscilla', { superficie: 'test', resumen: `entrada ${i}` }, env);
      }
      check('rotó al pasar el tope', ultimo.rotado === true);
      check('conserva las últimas', ultimo.lineas === diario.CONSERVAR);

      const dirAlma = path.dirname(rutasDe('priscilla', env).diario);
      const meses = historia.mesesArchivados(dirAlma);
      check('dejó un archivo mensual', meses.length === 1);

      const archivadas = historia.leerMes(dirAlma, meses[0]);
      const esperadas = diario.MAX_LINEAS + 1 - diario.CONSERVAR;
      check(`archivó las ${esperadas} expulsadas`, archivadas.length === esperadas);
      check('la primera entrada sobrevive con su texto', archivadas[0].resumen === 'entrada 1');
      check('y no está ya en el diario vivo', !fs.readFileSync(rutasDe('priscilla', env).diario, 'utf8').includes('entrada 1'));
      check('las entradas archivadas conservan su ts', typeof archivadas[0].ts === 'string');
    });
  } finally {
    borrar(raiz);
  }

  report();
}

main();
