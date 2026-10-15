/**
 * FEAT-162 — Una sesión orquesta la consola con su propia credencial: el servidor
 * aplica el modo (operar / pedir / yolo), lo vedado y la orquestación activa; el
 * registro guarda plan, acciones y aprobaciones; la herramienta `consola` habla
 * con todo eso. Servidor y núcleo reales sobre un estado temporal; el bot es falso.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat-162-'));
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
  const herramienta = require('../mcp-server/lib/consola-herramienta.js');

  const partidas = [];
  const bot = { async partirTarjetaWeb(id, datos) { partidas.push({ id, ...datos }); return { ok: true }; } };
  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(), bot, almas: {}, tareas, orquestaciones: orq,
    workspaces: () => [], ultimoWorkspace: () => null,
    logs: () => ({ ok: true, lineas: ['secreto'] }), sesiones: () => ({ ok: true }), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true
  });
  let modo = 'pedir';
  const servidor = srv.crearServidorWeb({ nucleo, token: TOKEN, orquestador: { token: TOKEN_ORQ, modo: () => modo } });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const acceso = { url: base, token: TOKEN_ORQ };
  const como = (quien) => ({ acceso, quien });
  const pedir = (metodo, ruta, cuerpo, quien = 'Spica') => consolaApi.pedir(metodo, ruta, cuerpo, como(quien));
  const conCookie = async (metodo, ruta, cuerpo) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'x-lagrange-token': TOKEN, origin: base, 'content-type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, datos: await r.json() };
  };

  try {
    await group('La credencial', async () => {
      const r = await fetch(`${base}/api/tareas`, { headers: { 'x-lagrange-orquestador': 'c'.repeat(48), 'x-lagrange-quien': 'Spica' } });
      check('un token de orquestador inválido da 401 (nunca cae a la cookie)', r.status === 401);
      const sinQuien = await fetch(`${base}/api/tareas`, { headers: { 'x-lagrange-orquestador': TOKEN_ORQ } });
      check('sin quién: 400', sinQuien.status === 400);
      for (const ruta of ['/api/ajustes', '/api/ajustes/perfiles', '/api/n/otro/tareas', '/api/red/tablero', '/api/eventos', '/api/rendimiento', '/api/nodos']) {
        check(`fuera de la lista blanca: ${ruta} → 403`, (await pedir('GET', ruta)).status === 403);
      }
      for (const ruta of ['/', '/app.js', '/tablero']) {
        const r = await fetch(base + ruta, { headers: { 'x-lagrange-orquestador': TOKEN_ORQ, 'x-lagrange-quien': 'Spica' } });
        check(`ni la interfaz: ${ruta} → 403`, r.status === 403);
      }
      check('el token completo sigue andando igual', (await conCookie('GET', '/api/tareas')).status === 200);
      check('la cookie no ve las rutas de la herramienta (abrir es solo del orquestador)', (await conCookie('POST', '/api/orquestaciones', { titulo: 'x' })).status === 405);
    });

    let tarjeta;
    await group('Sin orquestación abierta', async () => {
      check('leer el tablero se puede', (await pedir('GET', '/api/tareas')).status === 200);
      check('lo vedado no, ni para leer (logs, sesiones)', (await pedir('GET', '/api/logs')).status === 403 && (await pedir('GET', '/api/sesiones')).status === 403);
      const r = await pedir('POST', '/api/tarjetas', { titulo: 'x', pedido: 'y' });
      check('cambiar algo exige abrir una orquestación (409)', r.status === 409 && /Abrí una orquestación/.test(r.datos.error));
    });

    let o;
    await group('Abrir, plan y firma', async () => {
      const a = await pedir('POST', '/api/orquestaciones', { titulo: 'Prueba FEAT-162', pasos: ['Crear la tarjeta', 'Partirla', { texto: 'Cerrar', estado: 'pendiente' }] });
      o = a.datos.orquestacion;
      check('abre con tres pasos, quién y modo', a.status === 200 && o.quien === 'Spica' && o.pasos.length === 3 && o.modo === 'pedir', JSON.stringify(a.datos).slice(0, 200));
      check('una segunda abierta de la misma sesión: 409', (await pedir('POST', '/api/orquestaciones', { titulo: 'otra' })).status === 409);
      check('otra sesión puede tener la suya', (await pedir('POST', '/api/orquestaciones', { titulo: 'de Epikouros' }, 'Epikouros')).status === 200);
      await pedir('POST', `/api/orquestaciones/${o.id}/pasos`, { pasos: [{ id: o.pasos[0].id, estado: 'en_curso' }, { id: o.pasos[1].id }, { id: o.pasos[2].id }] });
      const c = await pedir('POST', '/api/tarjetas', { titulo: 'Tarjeta de la sesión', pedido: 'Hacer algo' });
      tarjeta = c.datos.tarea;
      check('crear (operar) pasa y la tarjeta lleva la firma', c.status === 200 && tareas.obtener(tarjeta.id).creadaPor === 'sesion:Spica');
      const ahora = orq.obtener(o.id);
      check('la acción quedó registrada, sin cuerpo', ahora.acciones.at(-1).metodo === 'crearTarjeta' && ahora.acciones.at(-1).resultado === 'ok' && !('cuerpo' in ahora.acciones.at(-1)));
      check('y se enlazó al paso en curso', ahora.pasos[0].enlaces.some((e) => e.tipo === 'tarjeta' && e.id === tarjeta.id));
      check('los pasos de otra sesión no se tocan', (await pedir('POST', `/api/orquestaciones/${o.id}/pasos`, { pasos: ['x'] }, 'Epikouros')).status === 403);
    });

    await group('Modos', async () => {
      const r = await pedir('POST', `/api/tarjetas/${tarjeta.id}/partir`, { agente: 'lagrange-architect' });
      check('pedir: ejecutar da 202 con la aprobación, y no corre', r.status === 202 && /^a_/.test(r.datos.pendiente) && partidas.length === 0, JSON.stringify(r));
      const aid = r.datos.pendiente;
      check('la aprobación guarda método y args (no se exponen)', orq.obtener(o.id).aprobaciones[0].args[0] === tarjeta.id && !('args' in (await conCookie('GET', '/api/orquestaciones')).datos.orquestaciones.find((x) => x.id === o.id).aprobaciones[0]));
      check('la sesión no puede aprobarse sola', (await pedir('POST', `/api/orquestaciones/${o.id}/aprobaciones/${aid}/aprobar`, {})).status === 403);
      const ap = await conCookie('POST', `/api/orquestaciones/${o.id}/aprobaciones/${aid}/aprobar`, {});
      check('el usuario aprueba y se ejecuta con los mismos argumentos', ap.status === 200 && ap.datos.ejecutada === 'partirTarjeta' && partidas[0]?.id === tarjeta.id && partidas[0].agente === 'lagrange-architect', JSON.stringify(ap.datos));
      check('aprobar dos veces: 409', (await conCookie('POST', `/api/orquestaciones/${o.id}/aprobaciones/${aid}/aprobar`, {})).status === 409);
      const r2 = await pedir('POST', `/api/tarjetas/${tarjeta.id}/partir`, { agente: 'otro' });
      const re = await conCookie('POST', `/api/orquestaciones/${o.id}/aprobaciones/${r2.datos.pendiente}/rechazar`, {});
      check('rechazar no ejecuta', re.status === 200 && partidas.length === 1);
      modo = 'operar';
      const op = await pedir('POST', `/api/tarjetas/${tarjeta.id}/partir`, { agente: 'x' });
      check('operar: ejecutar da 403 y queda como rechazada', op.status === 403 && orq.obtener(o.id).acciones.at(-1).resultado === 'rechazada');
      modo = 'yolo';
      const yo = await pedir('POST', `/api/tarjetas/${tarjeta.id}/partir`, { agente: 'y' });
      check('yolo: pasa sin aprobación', yo.status === 200 && partidas.length === 2);
      for (const ruta of ['/api/programaciones', `/api/almas/alya/olvidar`, '/api/motores/rol']) {
        const v = await pedir('POST', ruta, {});
        check(`yolo tampoco toca lo vedado: ${ruta}`, v.status === 403, String(v.status));
      }
      modo = 'pedir';
    });

    await group('Frenar', async () => {
      check('la sesión no puede frenarse (es del usuario)', (await pedir('POST', `/api/orquestaciones/${o.id}/frenar`, {})).status === 403);
      const fr = await conCookie('POST', `/api/orquestaciones/${o.id}/frenar`, {});
      check('el usuario la frena', fr.status === 200 && orq.obtener(o.id).estado === 'frenada');
      check('frenada: nada más en su nombre, ni leer', (await pedir('GET', '/api/tareas')).status === 409 && (await pedir('POST', '/api/tarjetas', { titulo: 'z', pedido: 'z' })).status === 409);
      check('pero ve su orquestación', (await pedir('GET', '/api/orquestaciones')).status === 200);
      const t = await pedir('POST', `/api/orquestaciones/${o.id}/terminar`, {});
      check('terminarla libera a la sesión', t.status === 200 && (await pedir('GET', '/api/tareas')).status === 200);
    });

    await group('Registro', () => {
      let ahora = Date.parse('2026-10-15T12:00:00Z');
      orq.fijarRelojParaTests(() => ahora);
      const a = orq.abrir({ quien: 'Reloj', titulo: 'vencer', modo: 'pedir' }).orquestacion;
      const p = orq.pedirAprobacion(a.id, { metodo: 'partirTarjeta', args: ['t_x'], ruta: '/api/x', nivel: 'ejecutar' });
      ahora += orq.VENCE_APROBACION_MS + 1;
      check('a los 30 min vence y suelta los args', orq.listar().find((x) => x.id === a.id).aprobaciones[0].estado === 'vencida' && !('args' in orq.obtener(a.id).aprobaciones[0]));
      check('una vencida ya no se aprueba', orq.resolverAprobacion(a.id, p.aprobacion, true).codigo === 409);
      check('un pedido de más de 16 KB: 413', orq.pedirAprobacion(a.id, { metodo: 'x', args: ['y'.repeat(17 * 1024)], ruta: '/', nivel: 'ejecutar' }).codigo === 413);
      for (let i = 0; i < orq.TOPE_ACCIONES + 5; i++) orq.registrarAccion(a.id, { metodo: 'm', ruta: '/', nivel: 'operar', resultado: 'ok' });
      check('las acciones se recortan al tope', orq.obtener(a.id).acciones.length === orq.TOPE_ACCIONES);
      check('más de 50 pasos: 400', orq.actualizarPasos(a.id, 'Reloj', Array(51).fill('x')).codigo === 400);
      check('quién inválido: 400', orq.abrir({ quien: '<script>', titulo: 'x', modo: 'pedir' }).codigo === 400);
      orq.fijarRelojParaTests(() => Date.now());
    });

    await group('Listas y catálogo', () => {
      const metodos = new Set(srv.catalogoOrquestador('yolo').map((r) => r.nucleo));
      const fantasmas = [...srv.NUNCA_ORQUESTADOR, ...srv.LECTURA_VEDADA].filter((m) => !metodos.has(m) && !['guardarAjustes', 'probarVoz'].includes(m));
      check('las listas solo nombran métodos que existen', fantasmas.length === 0, fantasmas.join(' '));
      const cat = srv.catalogoOrquestador('operar');
      check('en operar, lo de ejecutar no está permitido', cat.filter((r) => r.nivel === 'ejecutar').every((r) => r.permitido === 'no'));
      check('en pedir, va con aprobación', srv.catalogoOrquestador('pedir').find((r) => r.nucleo === 'partirTarjeta').permitido === 'con aprobación');
      check('las rutas son legibles', srv.catalogoOrquestador('pedir').some((r) => r.ruta === '/api/tarjetas/:x/partir'));
      check('enlaceDe: tarjeta creada y lote lanzado', srv.enlaceDe('crearTarjeta', { tarea: { id: 't_a' } })?.id === 't_a' && srv.enlaceDe('lanzarLote', { id: 'l1' })?.tipo === 'lote' && srv.enlaceDe('editarTarjeta', {}) === null);
    });

    await group('La vista', () => {
      const leer = (rel) => fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', rel), 'utf8').replace(/\r\n/g, '\n');
      const app = leer('public/app.js');
      const vista = leer('public/ui/vista-orquestacion.js');
      check('ruta, pintado y SSE', app.includes("if (p === '/orquestacion') return { vista: 'orquestacion' };") && app.includes("if (r.vista === 'orquestacion') return pintarOrquestacion(centro);")
        && app.includes("else if (e.tipo === 'orquestacion' && e.orquestacion) alCambiarOrquestacion(e.orquestacion);"));
      check('segmento en la barra y en el cajón', leer('public/index.html').includes('href="/orquestacion" data-ruta data-vista="orquestacion"') && leer('public/ui/lateral.js').includes("['/orquestacion', 'orquestacion', 'Orquestación']"));
      check('el servidor sirve el shell', leer('servidor.js').includes('/^\\/orquestacion$/'));
      check('aprobar, rechazar y frenar con dos pasos', vista.includes('texto="Aprobar"') && vista.includes('texto="Rechazar"') && vista.includes('texto="⏹ Frenar orquestación"'));
      check('el aviso de YOLO', vista.includes("o.modo === 'yolo'"));
      check('sin estilos en texto (CSP): el ancho va por CSSOM', !vista.includes('style=${`') && vista.includes('style=${{ width:'));
      check('vista-orquestacion.js: 210 líneas o menos', vista.split('\n').length <= 210);
    });

    await group('La herramienta', async () => {
      const r = await herramienta.accion({ accion: 'abrir', titulo: 'Desde la herramienta', pasos: ['uno'] }, como('Herramienta'));
      check('abrir', r.ok && /Abierta/.test(r.texto), r.texto);
      const e = await herramienta.accion({ accion: 'estado' }, como('Herramienta'));
      check('estado trae el modo, el plan y el tablero', e.ok && /Modo: pedir/.test(e.texto) && /Desde la herramienta/.test(e.texto) && /Tarjeta de la sesión/.test(e.texto), e.texto.slice(0, 300));
      const c = await herramienta.accion({ accion: 'llamar', metodo: 'POST', ruta: '/api/tarjetas', cuerpo: { titulo: 'Otra', pedido: 'z' } }, como('Herramienta'));
      check('llamar devuelve el JSON de la consola', c.ok && /"ok": true/.test(c.texto));
      const t = (await tareas.listar()).find((x) => x.titulo === 'Otra');
      const p = await herramienta.accion({ accion: 'llamar', metodo: 'POST', ruta: `/api/tarjetas/${t.id}/partir`, cuerpo: { agente: 'z' } }, como('Herramienta'));
      check('un 202 vuelve como pendiente de aprobación', p.ok && /Pendiente de aprobación/.test(p.texto));
      const rutas = await herramienta.accion({ accion: 'rutas' }, como('Herramienta'));
      check('rutas: el catálogo sin lo vedado', rutas.ok && /\/api\/tarjetas\/:x\/partir/.test(rutas.texto) && !/\/api\/logs/.test(rutas.texto));
      const mala = await herramienta.accion({ accion: 'llamar', metodo: 'GET', ruta: 'tareas' }, como('Herramienta'));
      check('una ruta sin /api/ se rechaza con el motivo', !mala.ok && /\/api\//.test(mala.texto));
      const sin = await herramienta.accion({ accion: 'estado' }, { acceso: undefined, quien: 'x', fetchImpl: () => { throw new Error('no'); } }).catch((err) => ({ ok: false, texto: err.message }));
      check('sin consola: error claro', !sin.ok);
      check('sin archivo de credencial: «la consola no está activa»', (() => { try { consolaApi.leerAcceso({ dataDir: dir }); return false; } catch (err) { return /no está activa/.test(err.message); } })());
      const fin = await herramienta.accion({ accion: 'terminar' }, como('Herramienta'));
      check('terminar', fin.ok && /terminada/.test(fin.texto));
    });
    // Lo que encontró la auditoría de la implementación (hilo 421627e0).
    await group('Correcciones de la auditoría', async () => {
      const falsa = await conCookie('POST', '/api/tarjetas', { titulo: 'Falsa', pedido: 'x', autorSesion: 'Spica' });
      check('la firma no se falsifica desde el cuerpo de una ruta HTTP', falsa.status === 200 && tareas.obtener(falsa.datos.tarea.id).creadaPor === 'usuario');

      // La poda saca solo terminadas: una frenada sigue frenando.
      const f = orq.abrir({ quien: 'Frenada', titulo: 'vieja', modo: 'pedir' }).orquestacion;
      orq.frenar(f.id);
      for (let i = 0; i < orq.TOPE_ORQUESTACIONES + 3; i++) {
        const x = orq.abrir({ quien: `Relleno ${i}`, titulo: 'x', modo: 'pedir' }).orquestacion;
        orq.terminar(x.id);
      }
      check('pasado el tope, la frenada sigue en el registro', orq.obtener(f.id)?.estado === 'frenada' && orq.activaDe('Frenada')?.id === f.id);
      check('y su sesión sigue sin poder hacer nada', (await pedir('GET', '/api/tareas', undefined, 'Frenada')).status === 409);
      const cerrada = await conCookie('POST', `/api/orquestaciones/${f.id}/cerrar`, {});
      check('el usuario la cierra desde la vista y la sesión queda libre', cerrada.status === 200 && orq.obtener(f.id).estado === 'terminada' && (await pedir('GET', '/api/tareas', undefined, 'Frenada')).status === 200);
      check('la sesión no puede cerrar por la ruta del usuario', (await pedir('POST', `/api/orquestaciones/${f.id}/cerrar`, {})).status === 403);

      // esperar: sin estados, espera un cambio; con estados, uno de ellos; con tope, devuelve lo último.
      const secuencia = (estados) => {
        let i = 0;
        return async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, tarea: { estado: estados[Math.min(i++, estados.length - 1)] } }) });
      };
      const base2 = { acceso, quien: 'Spica', dormir: async () => {}, pasoMs: 1 };
      const sinEstados = await consolaApi.esperar({ tipo: 'tarea', id: 't_x', estados: [], ...base2, fetchImpl: secuencia(['por_hacer', 'por_hacer', 'en_cola']) });
      check('sin estados no vuelve al instante: espera el cambio', sinEstados.llego && sinEstados.estado === 'en_cola');
      const conEstados = await consolaApi.esperar({ tipo: 'tarea', id: 't_x', estados: ['ok', 'error'], ...base2, fetchImpl: secuencia(['en_cola', 'en_curso', 'ok']) });
      check('con estados, hasta uno de ellos', conEstados.llego && conEstados.estado === 'ok');
      const tope = await consolaApi.esperar({ tipo: 'tarea', id: 't_x', estados: ['ok'], ...base2, topeMs: 0, fetchImpl: secuencia(['en_curso']) });
      check('con el tope cumplido, devuelve lo último sin llegar', !tope.llego && tope.estado === 'en_curso');
    });
  } finally {
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
