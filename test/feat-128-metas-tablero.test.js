/**
 * FEAT-128 — Metas en el tablero, del lado del daemon y de las reglas: el tipo `tarjetas` en metas.js (sin comandos,
 * `medir` no la toca, la foto y la regla de cumplida), el vínculo en la tarjeta (herencia, devolver, familia,
 * desvincular), el conteo con la madre contenedora, el módulo de la consola (solo `fecha` y `tarjetas`, sin argv
 * hacia el navegador, la foto con rebote) y las rutas (niveles, orquestador, nodos). La UI, en su propio grupo.
 *
 * Todo en carpetas temporales: LAGRANGE_CONOCIMIENTO_DIR y TELEGRAM_BRIDGE_STATE_FILE.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-128-'));
process.env.LAGRANGE_CONOCIMIENTO_DIR = path.join(base, 'conocimiento');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(base, 'datos', 'state.json');
fs.mkdirSync(path.join(base, 'datos'), { recursive: true });
const proyecto = path.join(base, 'proyecto');
fs.mkdirSync(proyecto, { recursive: true });

const lib = require('../mcp-server/lib/metas.js');
const rutas = require('../mcp-server/conocimiento/rutas.js');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const leerTxt = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');

async function main() {
  const { ruta } = lib.rutaMetas(proyecto);

  await group('metas.js: el tipo tarjetas', async () => {
    const m = lib.parsear('tarjetas "Tablero v2"', { ahora: 0, id: 'g_aaaaaaaa' });
    check('sin comandos ni hashes', m.tipo === 'tarjetas' && m.medir === null && m.riesgo === null && lib.hashesDe(proyecto, m).length === 0);
    check('arranca 0/0 sin cerrar', m.objetivo === 0 && m.estado.valor === 0 && m.cerrada === false);
    let error = null;
    try { lib.parsear('tarjetas "x" -- node a.js'); } catch (e) { error = e.message; }
    check('no acepta comandos', /no lleva comandos/.test(error || ''), error);
    const web = lib.crearDesdeWeb({ ruta, tipo: 'tarjetas', nombre: 'Web', id: 'g_bbbbbbbb' });
    check('la consola crea tarjetas', web.tipo === 'tarjetas' && lib.leer(ruta).metas.some((x) => x.id === 'g_bbbbbbbb'));
    let e2 = null;
    try { lib.crearDesdeWeb({ ruta, tipo: 'conteo', nombre: 'x' }); } catch (e) { e2 = e.message; }
    check('la consola no crea conteo', /solo se crean metas de tarjetas o de fecha/.test(e2 || ''), e2);
    const f = lib.crearDesdeWeb({ ruta, tipo: 'fecha', nombre: 'Fecha', fin: '2030-01-01T00:00Z', id: 'g_cccccccc' });
    check('ni fecha sin fin', f.fin === '2030-01-01T00:00:00.000Z');
    let corrio = false;
    await lib.medir({ cwd: proyecto, permitidos: [], correr: async () => { corrio = true; return { code: 0, stdout: '1' }; } });
    const tras = lib.leer(ruta).metas.find((x) => x.id === 'g_bbbbbbbb');
    check('medir no la toca', !corrio && tras.estado.medidoEn === null && tras.estado.valor === 0);
  });

  await group('metas.js: la foto y la regla de cumplida', () => {
    const foto = (hechas, total) => lib.sincronizarTarjetas({ ruta, conteos: { g_bbbbbbbb: { hechas, total } }, ahora: Date.parse('2026-10-17T12:00:00Z') });
    const estado = () => lib.leer(ruta).metas.find((x) => x.id === 'g_bbbbbbbb');
    check('sin cambios no escribe', lib.sincronizarTarjetas({ ruta, conteos: { g_bbbbbbbb: { hechas: 0, total: 0 } } }).cambiado === false);
    foto(1, 2);
    check('1/2 no cumplida', estado().objetivo === 2 && estado().estado.valor === 1 && !estado().estado.cumplida);
    foto(2, 2);
    check('2/2 cumplida con fecha', estado().estado.cumplida && estado().estado.cumplidaEn === '2026-10-17T12:00:00.000Z');
    foto(2, 3);
    check('una tarjeta nueva sin hacer la reabre', !estado().estado.cumplida && estado().estado.cumplidaEn === null);
    foto(3, 3);
    foto(0, 0);
    check('0/0 (archivadas) no la reabre', estado().estado.cumplida === true);
    lib.editar({ ruta, id: 'g_bbbbbbbb', cambios: { cerrada: true } });
    foto(1, 4);
    check('cerrada a mano sigue cumplida', estado().cerrada && estado().estado.cumplida);
    lib.editar({ ruta, id: 'g_bbbbbbbb', cambios: { cerrada: false, nombre: 'Renombrada' } });
    check('reabrir la deja como dice su medida', !estado().cerrada && !estado().estado.cumplida && estado().nombre === 'Renombrada');
    let e = null;
    try { lib.editar({ ruta, id: 'g_bbbbbbbb', cambios: { fin: '2030-01-01' } }); } catch (x) { e = x.message; }
    check('solo una de fecha tiene fecha', /Solo una meta de fecha/.test(e || ''), e);
    lib.editar({ ruta, id: 'g_cccccccc', cambios: { fin: '2031-02-03T00:00Z' } });
    check('la de fecha cambia su fin', lib.leer(ruta).metas.find((x) => x.id === 'g_cccccccc').fin === '2031-02-03T00:00:00.000Z');
  });

  const reglas = await importar('telegram-bridge/web/public/ui/reglas-metas.js');
  await group('reglas-metas: el conteo', () => {
    const t = (id, extra) => ({ id, estado: 'por_hacer', propuesta: false, motivo: 'mensaje', madre: null, metaId: 'g_1', ...extra });
    const c = reglas.conteoDeMetas([
      t('suelta', { estado: 'ok' }), t('otra'),
      t('madre'), t('h1', { motivo: 'hija', madre: 'madre', estado: 'ok' }), t('h2', { motivo: 'hija', madre: 'madre' }),
      t('prop', { propuesta: true }), t('ajena', { metaId: 'g_2', estado: 'ok' }), t('sin', { metaId: null })
    ]);
    check('la madre contenedora no suma; la propuesta tampoco', c.g_1.total === 4 && c.g_1.hechas === 2, JSON.stringify(c));
    check('cada meta por su lado', c.g_2.total === 1 && c.g_2.hechas === 1);
    const madreSola = reglas.conteoDeMetas([t('madre'), t('h1', { motivo: 'hija', madre: 'madre', metaId: 'g_2' })]);
    check('una madre con hijas de OTRA meta sí suma', madreSola.g_1.total === 1);
    const m = { tipo: 'tarjetas', cerrada: false, estado: { cumplida: true } };
    check('en vivo: 0/0 conserva', reglas.cumplidaEnVivo(m, undefined) === true);
    check('en vivo: 1/2 no', reglas.cumplidaEnVivo(m, { hechas: 1, total: 2 }) === false);
    check('detalle 1/2 tarjetas', reglas.detalleEnVivo({ tipo: 'tarjetas', estado: {} }, { hechas: 1, total: 2 }) === '1/2 tarjetas');
    check('progreso 0,5', reglas.progresoEnVivo({ tipo: 'tarjetas', estado: {} }, { hechas: 1, total: 2 }) === 0.5);
  });

  const tareas = await importar('telegram-bridge/tareas.js');
  await group('tareas.js: el vínculo', () => {
    const r = tareas.crearTarjeta({ titulo: 'A', pedido: 'hacer A', metaId: 'g_bbbbbbbb' });
    check('crear con meta', r.ok && r.tarea.metaId === 'g_bbbbbbbb');
    check('crear con meta mala → 400', tareas.crearTarjeta({ titulo: 'B', pedido: 'x', metaId: '../x' }).codigo === 400);
    const madre = tareas.crearTarjeta({ titulo: 'Madre', pedido: 'partir', sujeto: { tipo: 'agente', nombre: 'lagrange-architect' } }).tarea;
    tareas.asignarMeta(madre.id, { metaId: 'g_bbbbbbbb' });
    const hija = tareas.proponerTarjeta({ autor: 'agente:lagrange-architect', madre: madre.id, titulo: 'Hija', pedido: 'parte 1' });
    check('la hija hereda la meta de la madre', hija.ok && hija.tarea.metaId === 'g_bbbbbbbb', JSON.stringify(hija.error || ''));
    tareas.asignarMeta(madre.id, { metaId: null, familia: true });
    check('familia: desvincula madre e hija', tareas.obtener(madre.id).metaId === null && tareas.obtener(hija.tarea.id).metaId === null);
    tareas.asignarMeta(hija.tarea.id, { metaId: 'g_cccccccc', familia: true });
    check('familia desde una hija: la madre también', tareas.obtener(madre.id).metaId === 'g_cccccccc');
    check('metaId mal formado → 400', tareas.asignarMeta(madre.id, { metaId: 'nada' }).codigo === 400);
    const d = tareas.desvincularMeta('g_cccccccc');
    check('desvincular limpia todas', d.tareas.length === 2 && tareas.listar().every((t) => t.metaId !== 'g_cccccccc'));
    check('el resumen lleva metaId', tareas.resumen(tareas.obtener(r.tarea.id)).metaId === 'g_bbbbbbbb');
    const fuente = leerTxt('telegram-bridge/tareas.js');
    check('devolver pasa la meta a la nueva', /if \(original\.metaId\) \{\n    tarjeta\.metaId = original\.metaId;\n    original\.metaId = null;/.test(fuente));
  });

  const { crearMetasWeb } = await importar('telegram-bridge/web/metas-web.js');
  await group('metas-web: la consola', async () => {
    const eventos = [];
    const lista = [{ id: 'g_bbbbbbbb', metaId: 'g_bbbbbbbb', estado: 'ok', propuesta: false }];
    const falsas = { listar: () => lista.map((t, i) => ({ ...t, id: `t${i}` })), asignarMeta: (id, o) => ({ ok: true, tareas: [{ id, metaId: o.metaId }] }), desvincularMeta: () => ({ ok: true, tareas: [] }) };
    const w = crearMetasWeb({ workspaces: () => [{ id: 7, name: 'proyecto', path: proyecto }, { id: 8, name: 'clon', path: proyecto }], tareas: falsas, publicar: (e) => eventos.push(e), lib, rutas, reboteMs: 30, vigilarMs: 60000 });
    const l = await w.listar();
    check('un proyecto por slug', l.proyectos.length === 1 && l.proyectos[0].id === '7');
    check('sin argv ni rutas hacia el navegador', !JSON.stringify(l).includes('"medir"') && !JSON.stringify(l).includes(base.replace(/\\/g, '\\\\')));
    check('trae tieneComando y proyecto', l.metas.every((m) => typeof m.tieneComando === 'boolean' && m.proyecto.nombre === 'proyecto'));
    const c = await w.crear({ tipo: 'tarjetas', nombre: 'Desde la web' });
    check('crear sin proyecto elige el único', c.ok && c.meta.tipo === 'tarjetas' && eventos.some((e) => e.tipo === 'metas'));
    check('crear conteo → 400', (await w.crear({ tipo: 'conteo', nombre: 'x' })).codigo === 400);
    check('asignar a meta inexistente → 404', (await w.asignar('t1', { metaId: 'g_99999999' })).codigo === 404);
    check('editar inexistente → 404', (await w.editar('g_99999999', { nombre: 'x' })).codigo === 404);
    lib.editar({ ruta, id: 'g_bbbbbbbb', cambios: { cerrada: false } });
    w.programarFoto();
    w.programarFoto();
    await new Promise((r) => setTimeout(r, 120));
    const tras = lib.leer(ruta).metas.find((x) => x.id === 'g_bbbbbbbb');
    check('la foto con rebote deja el conteo', tras.objetivo === 1 && tras.estado.valor === 1 && tras.estado.cumplida, JSON.stringify(tras.estado));
    const b = await w.borrar(c.meta.id);
    check('borrar', b.ok && !lib.leer(ruta).metas.some((x) => x.id === c.meta.id));
    w.cerrar();
  });

  await group('rutas, niveles, orquestador y nodos', async () => {
    const srv = await importar('telegram-bridge/web/servidor.js');
    const nuevos = ['crearMeta', 'editarMeta', 'borrarMeta', 'asignarMetaTarea'];
    check('las mutaciones son operar', nuevos.every((m) => srv.NIVEL_DE_MUTACION[m] === 'operar'));
    check('el orquestador no las toca', nuevos.every((m) => srv.NUNCA_ORQUESTADOR.includes(m)));
    const bot = leerTxt('telegram-bridge/bot.js');
    check('un nodo no atiende metas', /METODOS_DE_METAS = Object\.freeze\(\['metas', 'crearMeta', 'editarMeta', 'borrarMeta', 'asignarMetaTarea'\]\)/.test(bot)
      && /!METODOS_DE_METAS\.includes\(m\)/.test(bot));
    check('la foto no corre en el SSE de tareas: solo se reprograma', /metasWeb\.programarFoto\(\);\n  \}\);/.test(bot) && /metasWeb\.cerrar\(\);/.test(bot));
    check('editarTarjeta no recibe metaId', !/editarTarjeta[^\n]*metaId/.test(leerTxt('telegram-bridge/tareas.js')));
    check('/meta acepta tarjetas', /verbo === 'tarjetas'/.test(leerTxt('hooks/mods.tsx')));
  });

  await group('UI: franja, filtro, chip y selector', async () => {
    const UI = 'telegram-bridge/web/public/ui/';
    const { FILTRO_VACIO } = await importar(`${UI}reglas-filtro.js`);
    check('FILTRO_VACIO sigue con 7 claves (Desktop)', Object.keys(FILTRO_VACIO).length === 7 && !('meta' in FILTRO_VACIO));
    const filtros = leerTxt(`${UI}tablero-filtros.js`);
    check('metaFiltro va aparte y se valida', /export const metaFiltro = persistente\('tablero\.meta', ''/.test(filtros));
    check('limpiar filtros también limpia la meta', /metaFiltro\.value = '';/.test(filtros));
    check('CLAVES_NATIVAS no incluye la meta', !/tablero\.meta/.test(leerTxt(`${UI}persistencia.js`)));
    check('pasaMeta: sin filtro pasa todo', reglas.pasaMeta({ id: 'a' }, '') === true);
    check('pasaMeta: solo las suyas', reglas.pasaMeta({ metaId: 'g_1' }, 'g_1') && !reglas.pasaMeta({ metaId: 'g_2' }, 'g_1'));
    check('pasaMeta: los lotes se ocultan', reglas.pasaMeta({ lote: true }, 'g_1') === false);
    const metasUi = leerTxt(`${UI}tablero-metas.js`);
    const lineas = metasUi.split(/\n/).length;
    check('tablero-metas.js ≤ 210 líneas', lineas <= 210, String(lineas));
    check('es hoja: no importa vista-tablero.js', !/vista-tablero/.test(metasUi.replace(/^ \*.*$/gm, '')));
    check('la consola crea solo tarjetas y fecha', /value="tarjetas"/.test(metasUi) && /value="fecha"/.test(metasUi) && !/["']conteo["']|condicion/.test(metasUi.replace(/^ \*.*$/gm, '')));
    check('la barra es un progressbar accesible', /role="progressbar"/.test(metasUi) && /aria-pressed=/.test(metasUi));
    check('solo en la consola local', /nodo\.value !== 'local'/.test(metasUi));
    const vista = leerTxt(`${UI}vista-tablero.js`);
    check('vista: franja, chip, selector y filtro', /<\$\{FranjaMetas\} tareas=/.test(vista) && /<\$\{ChipMeta\} t=\$\{t\} \/>/.test(vista)
      && /<\$\{SelectorMeta\}/.test(vista) && /pasaMeta\(x, metaLocal\(\)\)/.test(vista) && /nodo\.value === 'local' \? metaFiltro\.value : ''/.test(vista));
    const css = leerTxt('telegram-bridge/web/public/app.css');
    check('CSS sin :has(', !css.includes(':has('));
    check('CSS con tokens en la franja', /\.franja-metas \{/.test(css) && /\.meta-barra > span \{[^}]*var\(--acento\)/.test(css));
    for (const f of ['tablero-metas.js', 'reglas-metas.js']) {
      const r = require('child_process').spawnSync(process.execPath, ['--check', '--input-type=module'], { input: leerTxt(UI + f), encoding: 'utf8' });
      check(`${f} parsea como ESM`, r.status === 0, r.stderr);
    }
  });

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  report();
}

main().catch((e) => { console.error(e); process.exit(1); });
