/**
 * FEAT-165 — Mover una meta de proyecto: `lib.mover` (dos `metas.json`, mismo id, sin comandos, tope del destino sin
 * tocar el origen), `metas-web.editar` con `workspaceId` (las tarjetas no se tocan) y el campo Proyecto del diálogo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-165-'));
process.env.LAGRANGE_CONOCIMIENTO_DIR = path.join(base, 'conocimiento');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(base, 'datos', 'state.json');
fs.mkdirSync(path.join(base, 'datos'), { recursive: true });
const pa = path.join(base, 'alfa');
const pb = path.join(base, 'beta');
fs.mkdirSync(pa, { recursive: true });
fs.mkdirSync(pb, { recursive: true });

const lib = require('../mcp-server/lib/metas.js');
const rutas = require('../mcp-server/conocimiento/rutas.js');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const leerTxt = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');
const error = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

async function main() {
  const ra = lib.rutaMetas(pa).ruta;
  const rb = lib.rutaMetas(pb).ruta;

  group('lib.mover', () => {
    check('dos proyectos, dos archivos', ra !== rb);
    const m = lib.crearDesdeWeb({ ruta: ra, tipo: 'fecha', nombre: 'Lanzar', fin: '2030-01-01T00:00Z', id: 'g_11111111' });
    const movida = lib.mover({ desde: ra, hacia: rb, id: 'g_11111111' });
    const enB = lib.leer(rb).metas.find((x) => x.id === 'g_11111111');
    check('queda en el destino con el mismo id y campos', enB && JSON.stringify(enB) === JSON.stringify(m) && movida.id === m.id);
    check('el origen queda sin ella', !lib.leer(ra).metas.some((x) => x.id === 'g_11111111'));
    check('desde === hacia no hace nada', lib.mover({ desde: rb, hacia: rb, id: 'g_11111111' }).id === 'g_11111111' && lib.leer(rb).metas.length === 1);
    check('una inexistente da error', /No hay una meta/.test(error(() => lib.mover({ desde: ra, hacia: rb, id: 'g_99999999' })) || ''));

    const conComando = { ...lib.parsear('conteo "Tests" 10 -- node -e 1', { ahora: 0, id: 'g_22222222' }) };
    const d = lib.leer(ra); d.metas.push(conComando); fs.writeFileSync(ra, JSON.stringify(d));
    check('con comandos no se mueve', /con comandos no se mueve/.test(error(() => lib.mover({ desde: ra, hacia: rb, id: 'g_22222222' })) || '')
      && lib.leer(ra).metas.some((x) => x.id === 'g_22222222') && !lib.leer(rb).metas.some((x) => x.id === 'g_22222222'));

    const lleno = { version: 1, metas: Array.from({ length: lib.TOPE_METAS }, (_, i) => ({ id: `g_f${String(i).padStart(7, '0')}`, nombre: `m${i}`, tipo: 'tarjetas' })) };
    fs.writeFileSync(rb, JSON.stringify(lleno));
    lib.crearDesdeWeb({ ruta: ra, tipo: 'tarjetas', nombre: 'Tablero', id: 'g_33333333' });
    check('con el destino en el tope rechaza sin tocar el origen', /metas en ese proyecto/.test(error(() => lib.mover({ desde: ra, hacia: rb, id: 'g_33333333' })) || '')
      && lib.leer(ra).metas.some((x) => x.id === 'g_33333333') && lib.leer(rb).metas.length === lib.TOPE_METAS);
    check('si el traslado falla, los cambios tampoco quedan', /metas en ese proyecto/.test(error(() => lib.mover({ desde: ra, hacia: rb, id: 'g_33333333', cambios: { nombre: 'Otro' } })) || '')
      && lib.leer(ra).metas.find((x) => x.id === 'g_33333333')?.nombre === 'Tablero');
    fs.writeFileSync(rb, JSON.stringify({ version: 1, metas: [] }));
    check('un cambio inválido no mueve nada', Boolean(error(() => lib.mover({ desde: ra, hacia: rb, id: 'g_33333333', cambios: { nombre: '' } })))
      && lib.leer(ra).metas.some((x) => x.id === 'g_33333333') && !lib.leer(rb).metas.length);
  });

  const { crearMetasWeb } = await importar('telegram-bridge/web/metas-web.js');
  await group('metas-web.editar con workspaceId', async () => {
    const tocadas = [];
    const falsas = { listar: () => [{ id: 't1', metaId: 'g_33333333', estado: 'ok', propuesta: false }],
      asignarMeta: (...a) => { tocadas.push(['asignar', a]); return { ok: true, tareas: [] }; },
      desvincularMeta: (...a) => { tocadas.push(['desvincular', a]); return { ok: true, tareas: [] }; } };
    const w = crearMetasWeb({ workspaces: () => [{ id: 1, name: 'alfa', path: pa }, { id: 2, name: 'beta', path: pb }], tareas: falsas, lib, rutas, reboteMs: 30, vigilarMs: 60000 });
    const l = await w.listar();
    check('dos proyectos', l.proyectos.length === 2);
    const r = await w.editar('g_33333333', { nombre: 'Tablero v2', workspaceId: 2 });
    check('la mueve con el cambio de nombre', r.ok && r.meta.proyecto.id === '2' && r.meta.nombre === 'Tablero v2'
      && lib.leer(rb).metas.some((x) => x.id === 'g_33333333' && x.nombre === 'Tablero v2') && !lib.leer(ra).metas.some((x) => x.id === 'g_33333333'));
    check('el listado la ve en el otro proyecto', (await w.listar()).metas.find((m) => m.id === 'g_33333333')?.proyecto.nombre === 'beta');
    check('las tarjetas no se tocan', tocadas.length === 0);
    check('un proyecto desconocido da 400', (await w.editar('g_33333333', { workspaceId: 99 })).codigo === 400);
    check('el mismo proyecto no la mueve', (await w.editar('g_33333333', { workspaceId: '2', nombre: 'Tablero v3' })).meta?.proyecto.id === '2');
    check('con comandos, 400 y queda donde estaba', (await w.editar('g_22222222', { workspaceId: 2 })).codigo === 400 && lib.leer(ra).metas.some((x) => x.id === 'g_22222222'));
    w.cerrar();
  });

  group('el diálogo', () => {
    const ui = leerTxt('telegram-bridge/web/public/ui/tablero-metas.js');
    check('campo Proyecto si hay más de uno y no tiene comandos', ui.includes("const proyectos = m.tieneComando ? [] : (metas.value?.proyectos || []);")
      && ui.includes('${proyectos.length > 1 ? html`<${Campo} texto="Proyecto">'));
    check('manda workspaceId solo si cambió', ui.includes("...(otro ? { workspaceId: otro.id } : {})") && ui.includes('Meta movida a «${otro.nombre}».'));
    check('tablero-metas.js ≤ 210 líneas', ui.split('\n').length <= 210);
  });
}

main().catch((e) => { check(`sin excepciones: ${e.message}`, false); }).finally(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  report();
});
