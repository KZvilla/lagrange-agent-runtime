/**
 * FEAT-162 F3 — Con una orquestación abierta, agy_lote (lanzar), agy_fanout y cast_agent (cast, register,
 * unregister, forget, importar) pasan por el modo: `operar` las frena, `pedir` da una aprobación local (aprobarla
 * no ejecuta nada; la sesión la consume una vez, con la misma huella y dentro de los 30 min) y `yolo` las deja.
 * Servidor y núcleo reales sobre un estado temporal; `politica-herramientas` contra ese servidor.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat-162-f3p-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
const TOKEN = 'a'.repeat(48);
const TOKEN_ORQ = 'b'.repeat(48);

(async () => {
  const tareas = await import('../telegram-bridge/tareas.js');
  const orq = await import('../telegram-bridge/orquestaciones.js');
  const srv = await import('../telegram-bridge/web/servidor.js');
  const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');
  const { crearNucleoWeb } = await import('../telegram-bridge/web/nucleo.js');
  const consolaApi = require('../mcp-server/lib/consola-api.js');
  const politica = require('../mcp-server/lib/politica-herramientas.js');

  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(), bot: {}, almas: {}, tareas, orquestaciones: orq,
    workspaces: () => [], ultimoWorkspace: () => null,
    logs: () => ({ ok: true, lineas: [] }), sesiones: () => ({ ok: true }), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true
  });
  let modo = 'pedir';
  const servidor = srv.crearServidorWeb({ nucleo, token: TOKEN, orquestador: { token: TOKEN_ORQ, modo: () => modo } });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const acceso = { url: base, token: TOKEN_ORQ };
  const opciones = { acceso, quien: 'Spica' };
  const pedir = (metodo, ruta, cuerpo, quien = 'Spica') => consolaApi.pedir(metodo, ruta, cuerpo, { acceso, quien });
  const conCookie = async (metodo, ruta, cuerpo) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'x-lagrange-token': TOKEN, origin: base, 'content-type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, datos: await r.json() };
  };
  let corridas = 0;
  const correr = (r = { content: [{ type: 'text', text: 'corrió' }] }) => async () => { corridas++; return r; };
  const cast = { action: 'cast', agent: 'lagrange-architect', prompt: 'Revisá el plan' };

  try {
    await group('Qué pasa por la política', () => {
      check('las listas del MCP y del servidor coinciden', JSON.stringify(politica.CON_POLITICA) === JSON.stringify(srv.HERRAMIENTAS_CON_POLITICA));
      check('agy_lote lanzar sí, estado no', politica.pasaPorPolitica('agy_lote', politica.accionDe('agy_lote', {})) && !politica.pasaPorPolitica('agy_lote', politica.accionDe('agy_lote', { accion: 'estado' })));
      check('agy_fanout siempre', politica.pasaPorPolitica('agy_fanout', politica.accionDe('agy_fanout', {})));
      check('cast_agent cast/register sí; list/skills/exportar no', ['cast', 'register', 'unregister', 'forget', 'importar'].every((a) => politica.pasaPorPolitica('cast_agent', a))
        && ['list', 'skills', 'exportar'].every((a) => !politica.pasaPorPolitica('cast_agent', a)) && politica.accionDe('cast_agent', {}) === 'cast');
      check('la huella no depende del orden de las claves ni de aprobacion', politica.huella({ b: 1, a: { y: 2, x: [1, { q: 1, p: 2 }] } }) === politica.huella({ aprobacion: 'a_x', a: { x: [1, { p: 2, q: 1 }], y: 2 }, b: 1 }));
      check('y cambia con los argumentos', politica.huella(cast) !== politica.huella({ ...cast, prompt: 'Otra cosa' }));
      check('el resumen dice qué corre, sin el prompt entero', politica.resumir('cast_agent', 'cast', { agent: 'x', prompt: 'p'.repeat(1000) }).length < 260);
    });

    await group('Sin consola o sin orquestación: como antes de F3', async () => {
      corridas = 0;
      const sinConsola = await politica.conPolitica('cast_agent', cast, correr(), { acceso: { url: 'http://127.0.0.1:1', token: 'x' }, quien: 'Spica', timeoutMs: 500 });
      check('sin consola que responda, corre', corridas === 1 && !sinConsola.isError);
      const libre = await politica.conPolitica('cast_agent', cast, correr(), opciones);
      check('sin orquestación abierta, corre', corridas === 2 && !libre.isError);
      const lista = await politica.conPolitica('cast_agent', { action: 'list' }, correr(), opciones);
      check('una acción que no pasa por la política ni consulta', corridas === 3 && !lista.isError);
    });

    let o;
    await group('Modo pedir', async () => {
      o = (await pedir('POST', '/api/orquestaciones', { titulo: 'Política', pasos: [{ texto: 'Lanzar', estado: 'en_curso' }] })).datos.orquestacion;
      corridas = 0;
      const r = await politica.conPolitica('cast_agent', cast, correr(), opciones);
      const aid = /`(a_[^`]+)`/.exec(r.content[0].text)?.[1];
      check('no corre y devuelve la aprobación pendiente', corridas === 0 && !r.isError && aid && /aprobacion: "a_/.test(r.content[0].text), r.content[0].text);
      const vista = (await conCookie('GET', '/api/orquestaciones')).datos.orquestaciones.find((x) => x.id === o.id);
      const a = vista.aprobaciones.find((x) => x.id === aid);
      check('el panel la ve como local, con el resumen y sin la huella', a.local === true && /cast a lagrange-architect/.test(a.resumen) && a.huella === undefined);
      const ap = await conCookie('POST', `/api/orquestaciones/${o.id}/aprobaciones/${aid}/aprobar`);
      check('aprobarla no ejecuta nada: { ok, local }', ap.status === 200 && ap.datos.local === true && corridas === 0);
      const otra = await politica.conPolitica('cast_agent', { ...cast, aprobacion: aid, prompt: 'Borrá todo' }, correr(), opciones);
      check('con otros argumentos, la aprobación no vale', corridas === 0 && otra.isError && /no son los que el usuario aprobó/.test(otra.content[0].text));
      const bien = await politica.conPolitica('cast_agent', { ...cast, aprobacion: aid }, correr(), opciones);
      check('con los mismos, corre', corridas === 1 && !bien.isError);
      const acciones = orq.obtener(o.id).acciones.filter((x) => x.id);
      check('y queda la acción cerrada en ok', acciones.length === 1 && acciones[0].resultado === 'ok' && acciones[0].metodo === 'herramienta:cast_agent:cast');
      const otraVez = await politica.conPolitica('cast_agent', { ...cast, aprobacion: aid }, correr(), opciones);
      check('una aprobación se usa una sola vez', corridas === 1 && otraVez.isError && /ya se usó/.test(otraVez.content[0].text));
      check('otra sesión no puede consumirla', (await pedir('POST', '/api/orquestaciones/herramienta', { herramienta: 'cast_agent', accion: 'cast', huella: politica.huella(cast), aprobacion: aid }, 'Epikouros')).datos.libre === true);
    });

    await group('agy_lote: el lote queda enlazado al paso en curso', async () => {
      const lote = { accion: 'lanzar', slug: 'lote-prueba', tareas: [{ id: 't1', titulo: 'Uno' }] };
      const p = await politica.conPolitica('agy_lote', lote, correr(), opciones);
      const aid = /`(a_[^`]+)`/.exec(p.content[0].text)[1];
      await conCookie('POST', `/api/orquestaciones/${o.id}/aprobaciones/${aid}/aprobar`);
      await politica.conPolitica('agy_lote', { ...lote, aprobacion: aid }, correr(), opciones);
      const ox = orq.obtener(o.id);
      check('el paso en curso enlaza el lote', ox.pasos[0].enlaces.some((e) => e.tipo === 'lote' && e.id === 'lote-prueba'));
      const fallo = await politica.conPolitica('agy_fanout', { tasks: [] }, correr(), opciones);
      const aid2 = /`(a_[^`]+)`/.exec(fallo.content[0].text)[1];
      await conCookie('POST', `/api/orquestaciones/${o.id}/aprobaciones/${aid2}/aprobar`);
      await politica.conPolitica('agy_fanout', { tasks: [], aprobacion: aid2 }, correr({ isError: true, content: [{ type: 'text', text: 'falló' }] }), opciones);
      check('una herramienta que falla cierra la acción en error', orq.obtener(o.id).acciones.filter((x) => x.id).at(-1).resultado === 'error');
    });

    await group('Vencimiento de una local aprobada', async () => {
      const p = await politica.conPolitica('cast_agent', { ...cast, prompt: 'tarde' }, correr(), opciones);
      const aid = /`(a_[^`]+)`/.exec(p.content[0].text)[1];
      await conCookie('POST', `/api/orquestaciones/${o.id}/aprobaciones/${aid}/aprobar`);
      const ahora = Date.now();
      orq.fijarRelojParaTests(() => ahora + orq.VENCE_APROBACION_MS + 1000);
      corridas = 0;
      const tarde = await politica.conPolitica('cast_agent', { ...cast, prompt: 'tarde', aprobacion: aid }, correr(), opciones);
      check('aprobada hace más de 30 min y sin usar: vencida', corridas === 0 && tarde.isError && /vencida/.test(tarde.content[0].text), tarde.content[0].text);
      orq.fijarRelojParaTests(() => Date.now());
      const rechazo = await politica.conPolitica('cast_agent', { ...cast, prompt: 'no' }, correr(), opciones);
      const aid2 = /`(a_[^`]+)`/.exec(rechazo.content[0].text)[1];
      await conCookie('POST', `/api/orquestaciones/${o.id}/aprobaciones/${aid2}/rechazar`);
      const r2 = await politica.conPolitica('cast_agent', { ...cast, prompt: 'no', aprobacion: aid2 }, correr(), opciones);
      check('una rechazada no se puede usar', corridas === 0 && r2.isError && /rechazada/.test(r2.content[0].text));
    });

    await group('Modos operar y yolo, y frenada', async () => {
      modo = 'operar';
      corridas = 0;
      const op = await politica.conPolitica('agy_fanout', { tasks: [] }, correr(), opciones);
      check('operar frena con el motivo y no corre', corridas === 0 && op.isError && /operar/.test(op.content[0].text));
      check('y lo deja rechazado en el registro', orq.obtener(o.id).acciones.at(-1).resultado === 'rechazada');
      modo = 'yolo';
      const yo = await politica.conPolitica('cast_agent', cast, correr(), opciones);
      check('yolo corre y lo registra', corridas === 1 && !yo.isError && orq.obtener(o.id).acciones.filter((x) => x.id).at(-1).resultado === 'ok');
      modo = 'pedir';
      await conCookie('POST', `/api/orquestaciones/${o.id}/frenar`);
      const fr = await politica.conPolitica('cast_agent', cast, correr(), opciones);
      check('frenada: 409 y no corre', corridas === 1 && fr.isError && /frenó/.test(fr.content[0].text));
    });

    await group('El servidor', async () => {
      check('una herramienta que no pasa por la política: 400', (await pedir('POST', '/api/orquestaciones/herramienta', { herramienta: 'agy_run', accion: 'lanzar' })).status === 400);
      check('la cookie no llega a /herramienta', [404, 405].includes((await conCookie('POST', '/api/orquestaciones/herramienta', { herramienta: 'cast_agent', accion: 'cast' })).status));
      const r = orq.abrir({ quien: 'Cierre', titulo: 'Cierre', modo: 'yolo' });
      const hid = orq.iniciarAccion(r.orquestacion.id, { metodo: 'herramienta:cast_agent:cast', nivel: 'ejecutar' });
      check('cerrar una acción ajena: 403', orq.cerrarAccion(r.orquestacion.id, 'Otra', hid, { resultado: 'ok' }).codigo === 403);
      check('cerrarla dos veces: 409', orq.cerrarAccion(r.orquestacion.id, 'Cierre', hid, { resultado: 'ok' }).ok && orq.cerrarAccion(r.orquestacion.id, 'Cierre', hid, { resultado: 'ok' }).codigo === 409);
      check('aprobarOrquestacion mira local antes que el método del núcleo', /if \(r\.local\) return \{ ok: true, local: true \};/.test(fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'nucleo.js'), 'utf8')));
    });

    await group('index.js', () => {
      const idx = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
      check('las tres herramientas pasan por conPolitica', idx.includes("const POLITICA_HERRAMIENTAS = new Set(['agy_lote', 'agy_fanout', 'cast_agent']);") && idx.includes('.conPolitica(name, toolArgs || {}, correr, { sesion: sesionDeBuzon() })'));
      check('y las tres aceptan aprobacion', (idx.match(/aprobacion: \{ type: 'string', description: 'FEAT-162/g) || []).length === 3);
      check('consola manda el buzón de la sesión', idx.includes("accion(args, { sesion: sesionDeBuzon() })"));
    });
  } finally {
    orq.fijarRelojParaTests(() => Date.now());
    await new Promise((r) => servidor.close(r));
    tareas.reiniciarParaTests();
    orq.reiniciarParaTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  report();
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
