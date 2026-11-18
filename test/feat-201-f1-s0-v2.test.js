/**
 * FEAT-201 F1 S0 — Lo que la API v2 suma para Charlas en la terminal: workspaces con el favorito de la terminal,
 * actividad y pie de memoria en el turno, el evento `turno.actividad` y el productor de `consolidacion.fin`. Cada
 * respuesta y evento nuevo se valida contra contrato-v2.json (V1), con un caso inválido por cada uno.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);

function registroFalso() {
  const subs = new Set();
  const tareas = new Map();
  return {
    suscribir: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    obtener: (id) => tareas.get(id) || null,
    avisar(tarea, info) { tareas.set(tarea.id, tarea); for (const fn of subs) fn(tarea, info); }
  };
}

const tarea = (extra = {}) => ({
  id: 't-1', estado: 'en_curso', origen: 'terminal', sujeto: { tipo: 'agente', nombre: 'lagrange-reviewer' },
  pedido: 'revisá', resultado: null, error: null, creada: '2026-11-17T09:00:00.000Z', iniciada: '2026-11-17T09:00:01.000Z',
  terminada: null, actividad: [], memoria: null, ...extra
});

// Las dos formas de bot.js: cierreDeCharla (alma) y cierreDeCast (agente).
const MEMORIA_ALMA = {
  recordo: 2, corrigio: 0, olvido: 1, archivo: 0, rechazos: 0,
  tablero: { propuestas: 1, notas: 0, rechazos: 0 },
  herramienta: { tipo: 'web', consulta: 'mareas', n: 3, fuentes: ['a.org', 'b.org'] },
  externo: ['foto'], bloqueado: true
};
const MEMORIA_AGENTE = { usada: true, recuperada: false, guardadas: 1, enCuarentena: 0, red: 'leer', herramientasRed: ['web_fetch'] };

async function main() {
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const prod = await importar('telegram-bridge/web/v2/productores.js');
  const lect = await importar('telegram-bridge/web/v2/lecturas.js');
  const { crearAlmacenEventos } = await importar('telegram-bridge/web/v2/almacen-eventos.js');
  const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
  const tareasMod = await importar('telegram-bridge/tareas.js');
  const contrato = esq.cargarContrato();
  const valida = (n, v) => esq.validar(contrato, n, v);

  await group('F1 S0 · el contrato', () => {
    check('sigue en 2.0', contrato.version === '2.0');
    check('turno.actividad está en el enum y en eventos', contrato.agregados.evento.properties.tipo.enum.includes('turno.actividad') && Boolean(contrato.eventos['turno.actividad']));
    check('workspace es un agregado', Boolean(contrato.agregados.workspace));
    check('consolidacion.fin acepta motivo opcional', Boolean(contrato.eventos['consolidacion.fin'].properties.motivo) && !contrato.eventos['consolidacion.fin'].required.includes('motivo'));
  });

  await group('F1 S0 · turno con actividad y memoria', () => {
    const alma = prod.turnoDe(tarea({ sujeto: { tipo: 'alma', clave: 'alya' }, estado: 'ok', memoria: MEMORIA_ALMA }), { recorte: tareasMod.RECORTE });
    check('pie de un alma: valida', valida('turno', alma).length === 0, valida('turno', alma).join('; '));
    check('pie de un alma: conserva fuentes y tablero', alma.memoria.herramienta.fuentes.length === 2 && alma.memoria.tablero.propuestas === 1);
    const agente = prod.turnoDe(tarea({ estado: 'ok', memoria: MEMORIA_AGENTE, actividad: [{ t: '2026-11-17T09:00:02.000Z', texto: 'leyendo' }] }), { recorte: tareasMod.RECORTE });
    check('pie de un agente y actividad: valida', valida('turno', agente).length === 0, valida('turno', agente).join('; '));
    check('la actividad sale con { t, texto }', agente.actividad.length === 1 && agente.actividad[0].texto === 'leyendo');
    const sin = prod.turnoDe(tarea(), { recorte: tareasMod.RECORTE });
    check('sin actividad ni memoria: los campos no aparecen', !('actividad' in sin) && !('memoria' in sin) && valida('turno', sin).length === 0);
    // Lo que no encaja se descarta en lugar de reenviarse.
    const raro = prod.memoriaDe({ recordo: -1, herramienta: { tipo: 'web', consulta: { html: '<img onerror=x>' }, fuentes: [1, 'ok'] }, otro: 'x' });
    check('memoria: tipos que no encajan se descartan', raro.recordo === undefined && raro.herramienta.consulta === undefined && raro.herramienta.fuentes.join() === 'ok' && !('otro' in raro));
    check('memoria: una herramienta de tipo desconocido no sale', prod.memoriaDe({ herramienta: { tipo: 'shell' } }) === null);
    const larga = prod.actividadDe(Array.from({ length: 60 }, (_, i) => ({ t: 'x', texto: 'p'.repeat(200) + i })));
    check('actividad: hasta 40 pasos de hasta 120 caracteres', larga.length === 40 && larga.every((p) => p.texto.length === 120));
    // Casos inválidos que el validador tiene que rechazar.
    check('inválido: memoria con un campo extra', valida('turno', { ...alma, memoria: { ...alma.memoria, extra: 1 } }).length > 0);
    check('inválido: herramienta con un objeto donde va texto', valida('turno', { ...alma, memoria: { herramienta: { tipo: 'web', consulta: {} } } }).length > 0);
    check('inválido: un paso sin texto', valida('turno', { ...agente, actividad: [{ t: 'x' }] }).length > 0);
  });

  await group('F1 S0 · evento turno.actividad', () => {
    const almacen = crearAlmacenEventos({ arranque: 'arr' });
    const registro = registroFalso();
    const vistos = [];
    almacen.suscribir(['sujeto:*'], (e) => vistos.push(e));
    const p = prod.crearProductoresV2({ almacen, registro, recorte: tareasMod.RECORTE });
    const t = tarea();
    registro.avisar({ ...t, estado: 'en_cola' }, { alta: true });
    registro.avisar(t, { estadoPrevio: 'en_cola', cambioEstado: true });
    for (const texto of ['leyendo', 'probando', 'escribiendo']) {
      t.actividad = [...t.actividad, { t: new Date().toISOString(), texto }];
      registro.avisar(t, { actividad: true });
    }
    const act = vistos.filter((e) => e.tipo === 'turno.actividad');
    check('un turno.en_curso y tres turno.actividad', vistos.filter((e) => e.tipo === 'turno.en_curso').length === 1 && act.length === 3);
    check('cada uno lleva solo el último paso', act.map((e) => e.datos.paso.texto).join() === 'leyendo,probando,escribiendo');
    check('turno.actividad valida', act.every((e) => valida('evento:turno.actividad', e.datos).length === 0));
    check('es efímero: no queda para reenviar', almacen.pendientes(['sujeto:*'], `${'arr'}:0`).eventos.every((e) => e.tipo !== 'turno.actividad'));
    check('inválido: turno.actividad sin paso', valida('evento:turno.actividad', { tareaId: 't-1' }).length > 0);
    p.cerrar();
  });

  await group('F1 S0 · consolidacion.fin desde el diario', async () => {
    const almacen = crearAlmacenEventos({ arranque: 'arr' });
    const diarios = { alya: [{ ts: '2026-11-17T08:00:00.000Z', tipo: 'consolidacion', resumen: 'vieja' }] };
    const diario = { ultimas: (clave, n) => (diarios[clave] || []).slice(-n) };
    const p = prod.crearProductoresV2({
      almacen, registro: registroFalso(), recorte: tareasMod.RECORTE, diario, almas: () => [{ clave: 'alya' }, { clave: 'lyra' }], intervaloDiarioMs: 60000
    });
    p.leerDiariosAhora();
    const vistos = [];
    const baja = almacen.suscribir(['sujeto:alya'], (e) => vistos.push(e));
    p.leerDiariosAhora();
    check('al suscribirse arranca desde el final: no publica lo viejo', vistos.length === 0);
    diarios.alya.push({ ts: '2026-11-17T09:00:00.000Z', tipo: 'consolidacion', resumen: '3 turnos, 2 aplicadas' });
    diarios.alya.push({ ts: '2026-11-17T09:00:00.000Z', tipo: 'memoria:agregar', resumen: 'x' });
    diarios.alya.push({ ts: '2026-11-17T09:00:01.000Z', tipo: 'consolidacion', motivo: 'agy no respondió' });
    p.leerDiariosAhora();
    const fin = vistos.filter((e) => e.tipo === 'consolidacion.fin');
    check('una por cada entrada consolidacion, nada por las demás', fin.length === 2 && vistos.length === 2);
    check('ok y fallo con motivo', fin[0].datos.ok === true && fin[1].datos.ok === false && fin[1].datos.motivo === 'agy no respondió' && fin[0].datos.sujeto === 'alya');
    check('consolidacion.fin valida, con y sin motivo', fin.every((e) => valida('evento:consolidacion.fin', e.datos).length === 0));
    p.leerDiariosAhora();
    check('releer no repite', vistos.length === 2);
    diarios.alya.push({ ts: '2026-11-17T09:00:01.000Z', tipo: 'consolidacion', resumen: 'otra en el mismo ms' });
    p.leerDiariosAhora();
    check('dos entradas en el mismo milisegundo cuentan las dos', vistos.length === 3);
    check('inválido: consolidacion.fin con campo extra', valida('evento:consolidacion.fin', { sujeto: 'alya', ok: true, ts: 1 }).length > 0);
    baja();
    diarios.alya.push({ ts: '2026-11-17T10:00:00.000Z', tipo: 'consolidacion', resumen: 'sin nadie' });
    p.leerDiariosAhora();
    check('sin suscriptores se apaga', vistos.length === 3);
    p.cerrar();
  });

  await group('F1 S0 · workspaces con el favorito de la terminal', async () => {
    const llamados = [];
    const favoritos = { 'web:local': '2', 'web:terminal': '1' };
    const nucleo = crearNucleoWeb({
      canal: { publicar() {} }, bot: {}, almas: {},
      workspaces: () => [{ id: 1, displayName: 'Lagrange' }, { id: 2, name: 'Desktop' }],
      ultimoWorkspace: (chat) => { llamados.push(chat); return favoritos[chat]; }
    });
    const v1 = nucleo.workspaces();
    const rutas = lect.rutasLecturaV2({ nucleo, estadoDeCarriles: () => [], recorte: tareasMod.RECORTE, arranque: 'arr', chatTerminal: 'web:terminal' });
    const ruta = rutas.find((r) => r.metodo === 'GET' && r.patron.test('/api/v2/workspaces'));
    const v2 = ruta.fn({ p: [], url: new URL('http://x/api/v2/workspaces') });
    check('v1 usa web:local y v2 usa web:terminal', llamados.join() === 'web:local,web:terminal');
    check('mismo conjunto y orden', v1.workspaces.map((w) => w.id).join() === v2.workspaces.map((w) => w.id).join());
    check('el favorito es el de cada chat', v1.workspaces[1].favorito && !v1.workspaces[0].favorito && v2.workspaces[0].favorito && !v2.workspaces[1].favorito);
    check('cada workspace valida', v2.workspaces.every((w) => valida('workspace', w).length === 0));
    check('inválido: workspace sin favorito', valida('workspace', { id: '1', nombre: 'x' }).length > 0);
    check('un chat ausente o que no es texto → 400', nucleo.workspaces({ chat: null }).codigo === 400 && nucleo.workspaces({ chat: 3 }).codigo === 400);
  });

  await group('F1 S0 · bot.js conecta los productores y el chat de la terminal', () => {
    const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8');
    check('productores con el diario de las almas', /diario: almasDiario, almas: almasDisponibles/.test(bot));
    check('las lecturas reciben chatTerminal', /secretos: intermediarioV2,\s*chatTerminal: CHAT_WEB_TERMINAL/.test(bot));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
