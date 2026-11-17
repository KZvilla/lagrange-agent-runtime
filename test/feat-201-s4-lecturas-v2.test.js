/**
 * FEAT-201 F0 S4 — Las rutas de lectura v2, el recolector con pausa reversible
 * y los productores de salud y de Claude remoto.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const TAREAS = [
  { id: 't-1', estado: 'ok', origen: 'telegram', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'uno', resultado: 'r1', error: null, creada: '2026-11-17T09:00:00.000Z', iniciada: null, terminada: null },
  { id: 't-2', estado: 'ok', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'dos', resultado: 'r2', error: null, creada: '2026-11-17T09:01:00.000Z', iniciada: null, terminada: null },
  { id: 't-3', estado: 'en_curso', origen: 'terminal', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'tres', resultado: null, error: null, creada: '2026-11-17T09:02:00.000Z', iniciada: '2026-11-17T09:02:01.000Z', terminada: null }
];

/** Un núcleo con la forma de nucleo.js para lo que leen las rutas v2. Cuenta las llamadas. */
function nucleoFalso({ falla = null } = {}) {
  const llamadas = [];
  const anotar = (m, v) => { llamadas.push(m); if (falla === m) throw new Error('se rompió'); return v; };
  return {
    llamadas,
    sujetos: () => anotar('sujetos', { ok: true, almas: [{ clave: 'alya', voz: 'Alya', enCurso: { desde: 'x' }, ultima: '2026-11-17T09:01:00.000Z' }], agentes: [{ nombre: 'lagrange-reviewer' }] }),
    tareas: (clave) => anotar('tareas', { ok: true, sujeto: clave, tareas: clave === 'alma:alya' ? TAREAS : [] }),
    memoria: (id) => anotar('memoria', { ok: true, recuerdos: [`de ${id}`] }),
    hiloAlma: (id) => anotar('hilo', { ok: true, hilos: [id] }),
    diarioAlma: (id) => anotar('diario', { ok: true, entradas: [id] }),
    contextoAgente: (n) => anotar('contexto', { ok: true, contexto: n }),
    criterioAgente: (n) => anotar('criterio', { ok: true, criterio: n }),
    cuarentenaAgente: (n) => anotar('cuarentena', { ok: true, items: [n] }),
    reglasAgente: (n) => anotar('reglas', { ok: true, reglas: [n] }),
    reglaAgente: (n, id) => anotar('regla', { ok: true, regla: `${n}/${id}` }),
    buscarProfunda: (id, q) => anotar('profunda', { ok: true, q, de: id }),
    motores: () => anotar('motores', { ok: true, sujetos: [], catalogo: {} }),
    cupoMotor: (m) => anotar('cupo', { ok: true, motor: m }),
    claude: () => anotar('claude', { ok: true, sesiones: [{ key: 'k1', sessionName: 'remota-1', cuenta: 'spica', proyecto: 'lagrange', modo: 'plan', desde: '2026-11-17T08:40:00.000Z', url: null }], maxSesiones: 3 }),
    sesiones: () => anotar('sesiones', { ok: true, chats: [{ canal: 'telegram', conversationId: 'c' }], almas: [], agentes: [] }),
    logs: (n) => anotar('logs', { ok: true, n, lineas: ['a'] })
  };
}

async function main() {
  const lect = await importar('telegram-bridge/web/v2/lecturas.js');
  const { crearAlmacenEventos } = await importar('telegram-bridge/web/v2/almacen-eventos.js');
  const { crearRecolectorRendimiento } = await importar('telegram-bridge/rendimiento.js');
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const tareasMod = await importar('telegram-bridge/tareas.js');
  const contrato = esq.cargarContrato();

  const nucleo = nucleoFalso();
  const rutas = lect.rutasLecturaV2({ nucleo, estadoDeCarriles: () => [{ carril: 'alma', enCurso: { tareaId: 't-3', voz: 'Alya', desde: 1700000000000, extracto: 'tres' }, pendientes: [] }], recorte: tareasMod.RECORTE, arranque: 'arr', version: '9.9.9' });
  const llamar = async (metodo, ruta) => {
    const url = new URL(`http://x${ruta}`);
    const r = rutas.find((x) => x.metodo === metodo && x.patron.test(url.pathname));
    if (!r) return { sinRuta: true };
    const p = r.patron.exec(url.pathname).slice(1).filter((x) => x !== undefined).map(decodeURIComponent);
    return r.fn({ p, url });
  };
  const valida = (agregado, valor) => esq.validar(contrato, agregado, valor);

  await group('S4 · sujetos y turnos', async () => {
    const s = await llamar('GET', '/api/v2/sujetos');
    check('sujetos: almas y agentes con la forma del contrato', s.sujetos.length === 2 && s.sujetos.every((x) => valida('sujeto', x).length === 0),
      s.sujetos.map((x) => valida('sujeto', x).join(';')).join(' | '));
    check('un alma en curso está pensando', s.sujetos[0].pensando === true && s.sujetos[1].pensando === false);
    const t = await llamar('GET', '/api/v2/sujetos/alya/turnos');
    check('turnos: los del sujeto, en orden, con la forma del contrato', t.turnos.length === 3 && t.turnos.every((x) => valida('turno', x).length === 0) && t.turnos[0].tareaId === 't-1');
    check('el origen terminal se conserva', t.turnos[2].origen === 'terminal');
    const pag = await llamar('GET', '/api/v2/sujetos/alya/turnos?antes=t-3&n=1');
    check('paginado: antes=t-3&n=1 → t-2, hayMas', pag.turnos.length === 1 && pag.turnos[0].tareaId === 't-2' && pag.hayMas === true);
    check('un sujeto que no existe → 404', (await llamar('GET', '/api/v2/sujetos/nadie/turnos')).codigo === 404);
    check('un id inválido → 404', (await llamar('GET', '/api/v2/sujetos/..%2F/turnos')).codigo === 404);
  });

  await group('S4 · panel agregado', async () => {
    const a = await llamar('GET', '/api/v2/sujetos/alya/panel');
    check('alma: memoria, hilo y diario por defecto', Object.keys(a.secciones).sort().join(',') === 'diario,hilo,memoria');
    check('cada sección es la respuesta del núcleo', a.secciones.memoria.recuerdos[0] === 'de alya');
    const g = await llamar('GET', '/api/v2/sujetos/lagrange-reviewer/panel?secciones=contexto,reglas');
    check('agente: las secciones pedidas', Object.keys(g.secciones).sort().join(',') === 'contexto,reglas');
    check('una sección que no es del tipo → 400', (await llamar('GET', '/api/v2/sujetos/alya/panel?secciones=contexto')).codigo === 400);
    const roto = lect.rutasLecturaV2({ nucleo: nucleoFalso({ falla: 'hilo' }), estadoDeCarriles: () => [], recorte: tareasMod.RECORTE, arranque: 'arr' });
    const ruta = roto.find((r) => r.patron.test('/api/v2/sujetos/alya/panel'));
    const r = await ruta.fn({ p: ['alya'], url: new URL('http://x/api/v2/sujetos/alya/panel') });
    check('una sección que falla no tumba las demás', r.ok === true && r.secciones.hilo.ok === false && r.secciones.memoria.ok === true);
  });

  await group('S4 · las rutas que delegan devuelven lo mismo que v1', async () => {
    const pares = [
      ['/api/v2/sujetos/alya/archivo?q=mar', () => nucleo.buscarProfunda('alya', 'mar')],
      ['/api/v2/agentes/lagrange-reviewer/reglas', () => nucleo.reglasAgente('lagrange-reviewer')],
      ['/api/v2/agentes/lagrange-reviewer/reglas/r1', () => nucleo.reglaAgente('lagrange-reviewer', 'r1')],
      ['/api/v2/motores', () => nucleo.motores()],
      ['/api/v2/motores/cupo?motor=deepseek', () => nucleo.cupoMotor('deepseek')],
      ['/api/v2/logs?n=30', () => nucleo.logs('30')]
    ];
    for (const [ruta, v1] of pares) {
      check(`${ruta} = v1`, JSON.stringify(await llamar('GET', ruta)) === JSON.stringify(await v1()));
    }
    check('archivo de un agente → 404', (await llamar('GET', '/api/v2/sujetos/lagrange-reviewer/archivo?q=x')).codigo === 404);
  });

  await group('S4 · carriles, Claude remoto, Telegram y salud', async () => {
    const c = await llamar('GET', '/api/v2/carriles');
    check('carriles con la forma del contrato', c.carriles.every((x) => valida('carril', x).length === 0) && c.carriles[0].enCurso.desde.startsWith('2023'));
    const cl = await llamar('GET', '/api/v2/claude/sesiones');
    check('sesiones remotas con la forma del contrato', cl.sesiones.length === 1 && valida('sesionRemota', cl.sesiones[0]).length === 0 && cl.maxSesiones === 3);
    check('telegram/hilos: los chats', (await llamar('GET', '/api/v2/telegram/hilos')).hilos.length === 1);
    const s = await llamar('GET', '/api/v2/salud');
    const { ok, ...salud } = s;
    check('salud con la forma del contrato', ok === true && valida('salud', salud).length === 0, valida('salud', salud).join('; '));
    check('sin recolector, eventLoop es null', salud.eventLoop === null);
  });

  await group('S4 · recolector: pausar y reanudar (dos ciclos)', () => {
    const timers = [];
    const rec = crearRecolectorRendimiento({
      enabled: true, programar: (fn) => { const t = { fn }; timers.push(t); return { unref() {}, t }; }, cancelar: () => {}
    });
    rec.iniciar();
    check('iniciar muestrea y queda encendido', rec.instantanea().enabled === true && rec.instantanea().muestras.length === 1);
    rec.pausar();
    const p = rec.instantanea();
    check('pausar vacía el anillo y no cuenta como encendido', p.enabled === false && p.muestras.length === 0 && p.motivo === 'pausado');
    rec.reanudar();
    const r = rec.instantanea();
    check('reanudar vuelve a muestrear desde cero', r.enabled === true && r.muestras.length === 1);
    check('la primera muestra después de la pausa no tiene base vieja (sin elapsedMs)', r.muestras[0].elapsedMs === null || r.muestras[0].elapsedMs === undefined);
    rec.pausar(); rec.reanudar();
    check('segundo ciclo igual', rec.instantanea().enabled === true && rec.instantanea().muestras.length === 1);
    rec.cerrar(); rec.reanudar();
    check('después de cerrar, reanudar no hace nada', rec.instantanea().enabled === false);
  });

  await group('S4 · productores de salud y de Claude remoto', async () => {
    const almacen = crearAlmacenEventos({ arranque: 'arr' });
    const pausas = [];
    const reanudaciones = [];
    const rec = { pausar: () => pausas.push(1), reanudar: () => reanudaciones.push(1), instantanea: () => ({ enabled: true, muestras: [{ eventLoop: { utilizacion: 0.03 } }] }) };
    const ncl = nucleoFalso();
    const p = lect.crearProductoresLectura({ almacen, recolector: rec, nucleo: ncl, arranque: 'arr', pausaMs: 50, intervaloSaludMs: 20, intervaloClaudeMs: 60_000 });
    const vistos = [];
    const baja = almacen.suscribir(['salud'], (e) => vistos.push(e));
    await esperar(70);
    check('con un suscriptor a salud: reanuda y publica', reanudaciones.length === 1 && vistos.length >= 1);
    check('el evento salud valida contra el esquema', esq.validar(contrato, 'evento:salud', vistos[0].datos).length === 0, esq.validar(contrato, 'evento:salud', vistos[0].datos).join('; '));
    check('trae la utilización del event loop', vistos[0].datos.eventLoop.utilizacion === 0.03);
    baja();
    await esperar(90);
    check('sin suscriptores, pausa después del plazo', pausas.length === 1);
    const cl = [];
    const bajaC = almacen.suscribir(['claude'], (e) => cl.push(e));
    await esperar(10);
    ncl.claude = () => ({ ok: true, sesiones: [{ key: 'k1', sessionName: 'remota-1', cuenta: 'spica', proyecto: 'lagrange', url: 'https://claude.ai/code/x' }, { key: 'k2', sessionName: 'remota-2', cuenta: 'epikouros', proyecto: 'desktop', url: null }] });
    await p.compararClaude();
    check('Claude remoto: alta y enlace por comparación', cl.some((e) => e.tipo === 'claude.sesion.alta' && e.datos.key === 'k2') && cl.some((e) => e.tipo === 'claude.sesion.enlace' && e.datos.key === 'k1'));
    ncl.claude = () => ({ ok: true, sesiones: [] });
    await p.compararClaude();
    check('Claude remoto: baja', cl.filter((e) => e.tipo === 'claude.sesion.baja').length === 2);
    bajaC();
    p.cerrar();
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
