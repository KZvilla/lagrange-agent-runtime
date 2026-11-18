/**
 * FEAT-201 F0 S5 — Mutaciones v2: turnos y fotos idempotentes, cancelar,
 * reintentar, memoria con memoria.cambio, y el resto que delega en el núcleo.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const ID1 = '0c1d8b1e-4b8a-4a2f-9a0e-1f2e3d4c5b6a';
const ID2 = '9a1d8b1e-4b8a-4a2f-9a0e-1f2e3d4c5b6b';

/** Un registro y una cola falsos: el despacho encola en forma sincrónica (como bot.js) y después espera. */
function entorno() {
  const tareas = new Map();
  let n = 0;
  const despachos = [];
  const encolar = (datos) => {
    const t = { id: `t-${++n}`, estado: 'en_cola', origen: 'terminal', creada: '2026-11-17T09:00:00.000Z', iniciada: null, terminada: null, resultado: null, error: null, ...datos };
    tareas.set(t.id, t);
    return t;
  };
  const registro = { obtener: (id) => tareas.get(id) || null, tareas };
  const cola = {
    async dispatchCharla(ctx, { clave, texto, imagen = null, alEncolar }) {
      despachos.push({ tipo: 'charla', clave, texto, imagen, ctx });
      const t = encolar({ sujeto: { tipo: 'alma', clave }, pedido: imagen ? `🖼️ foto: ${texto}` : texto });
      alEncolar(t.id);
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, tareaId: t.id };
    },
    async dispatchCast(ctx, { agent, prompt, alEncolar }) {
      despachos.push({ tipo: 'cast', agent, prompt });
      const t = encolar({ sujeto: { tipo: 'agente', nombre: agent }, pedido: prompt });
      alEncolar(t.id);
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, tareaId: t.id };
    },
    async reintentarTarea(tareaId, ctx, { alEncolar }) {
      const vieja = tareas.get(tareaId);
      despachos.push({ tipo: 'reintento', tareaId });
      const t = encolar({ sujeto: vieja.sujeto, pedido: vieja.pedido });
      alEncolar(t.id);
      return { ok: true, tareaId: t.id };
    },
    cancelarTarea: (id) => { const t = tareas.get(id); if (t) t.estado = 'cancelada'; return { ok: true, accion: 'quitada' }; }
  };
  const guardadas = [];
  const nucleo = {
    sujetos: () => ({ ok: true, almas: [{ clave: 'alya', voz: 'Alya' }], agentes: [{ nombre: 'lagrange-reviewer' }] }),
    prepararCast: ({ agente, workspaceId, pedido }, { chat }) => (workspaceId ? { ok: true, cast: { agent: agente, prompt: pedido, cwd: '/p', workspaceName: 'p', workspaceId, chat } } : { codigo: 400, ok: false, error: 'Falta el proyecto.' }),
    validarFoto: (clave, { base64, texto }) => (base64 ? { ok: true, alma: { clave, voz: 'Alya' }, pie: texto || '', contenido: Buffer.from('x'), nombre: 'f.jpg' } : { codigo: 400, ok: false, error: 'Falta la imagen.' }),
    guardarFoto: () => { guardadas.push(1); return { ok: true, ruta: `/adj/${guardadas.length}.jpg` }; },
    recordar: (id, { texto }) => (texto ? { ok: true, id: 'm1', texto } : { codigo: 400, ok: false, error: 'Falta el texto.' }),
    olvidar: async () => ({ ok: true, olvidado: true }),
    promoverCuarentena: async () => ({ ok: true }),
    descartarCuarentena: () => ({ ok: true }),
    hiloNuevo: () => ({ ok: true }),
    guardarMotor: (c) => ({ ok: true, eco: c }),
    prepararVoz: () => ({ ok: true }),
    escucharTarea: () => ({ binario: Buffer.from('RIFF'), tipo: 'audio/wav' }),
    cancelar: (carril) => ({ ok: true, carril: carril ?? 'todos' }),
    lanzarClaude: (c) => ({ ok: true, eco: c }),
    // F2 — Detener responde la forma `parada` (sin pid): el eco va en `detenidas`.
    detenerClaude: (c) => ({ ok: true, detenidas: [{ key: c.key || 'todas', cuenta: 'principal', pid: 7, proyecto: 'p' }], proyectos: [] }),
    limpiarClaude: () => ({ ok: true })
  };
  return { registro, cola, nucleo, despachos, guardadas, tareas };
}

async function main() {
  const { rutasMutacionV2 } = await importar('telegram-bridge/web/v2/mutaciones.js');
  const { crearIdempotencia } = await importar('telegram-bridge/web/v2/idempotencia.js');
  const { crearAlmacenEventos } = await importar('telegram-bridge/web/v2/almacen-eventos.js');
  const tareasMod = await importar('telegram-bridge/tareas.js');
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const contrato = esq.cargarContrato();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-201-s5-'));
  const armar = ({ ahora = Date.now, archivo = path.join(dir, `idem-${Math.random()}.json`) } = {}) => {
    const e = entorno();
    const idem = crearIdempotencia({ archivo, registro: e.registro, ahora });
    const almacen = crearAlmacenEventos({ arranque: 'arr' });
    const rutas = rutasMutacionV2({ nucleo: e.nucleo, cola: e.cola, ctx: { chat: { id: 'web:terminal' } }, chatTerminal: 'web:terminal', registro: e.registro, idem, almacen, recorte: tareasMod.RECORTE });
    const llamar = (metodo, ruta, cuerpo = {}) => {
      const r = rutas.find((x) => x.metodo === metodo && x.patron.test(ruta));
      if (!r) return Promise.resolve({ sinRuta: true });
      const p = r.patron.exec(ruta).slice(1).filter((x) => x !== undefined).map(decodeURIComponent);
      return Promise.resolve(r.fn({ p, cuerpo, url: new URL(`http://x${ruta}`) }));
    };
    return { ...e, idem, almacen, llamar, archivo };
  };

  try {
    await group('S5 · turnos idempotentes', async () => {
      const x = armar();
      const [a, b] = await Promise.all([
        x.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID1, texto: 'hola' }),
        x.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID1, texto: 'hola' })
      ]);
      check('dos POST en paralelo con el mismo idCliente → un solo despacho', x.despachos.length === 1, `${x.despachos.length}`);
      check('los dos reciben el mismo turno', a.turno?.tid && a.turno.tid === b.turno?.tid && a.turno.tareaId === b.turno.tareaId);
      check('el primero 202, el repetido 200', [a.codigo, b.codigo].sort().join(',') === '200,202', `${a.codigo},${b.codigo}`);
      check('el turno valida contra el esquema y trae idCliente sin reintentoDe',
        esq.validar(contrato, 'turno', a.turno).length === 0 && a.turno.idCliente === ID1 && !a.turno.reintentoDe, esq.validar(contrato, 'turno', a.turno).join('; '));
      check('despacha con el ctx de la terminal', x.despachos[0].ctx.chat.id === 'web:terminal');
      const c = await x.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID2, texto: 'otro' });
      check('otro idCliente → otro despacho', x.despachos.length === 2 && c.turno.tid !== a.turno.tid);
      check('sin idCliente → 400', (await x.llamar('POST', '/api/v2/sujetos/alya/turnos', { texto: 'x' })).codigo === 400);
      check('texto vacío → 400 sin despachar', (await x.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: '1c1d8b1e-0000', texto: '  ' })).codigo === 400 && x.despachos.length === 2);
      check('sujeto que no existe → 404', (await x.llamar('POST', '/api/v2/sujetos/nadie/turnos', { idCliente: ID1, texto: 'x' })).codigo === 404);
    });

    await group('S5 · agentes: prepararCast con el chat de la terminal', async () => {
      const x = armar();
      const sin = await x.llamar('POST', '/api/v2/sujetos/lagrange-reviewer/turnos', { idCliente: ID1, texto: 'revisá' });
      check('sin workspaceId → 400, nada encolado', sin.codigo === 400 && x.despachos.length === 0);
      const con = await x.llamar('POST', '/api/v2/sujetos/lagrange-reviewer/turnos', { idCliente: ID1, texto: 'revisá', workspaceId: 'ws1' });
      check('con workspaceId → cast encolado', con.codigo === 202 && x.despachos[0].tipo === 'cast');
    });

    await group('S5 · reinicio y vencimiento', async () => {
      const archivo = path.join(dir, 'idem-reinicio.json');
      const x = armar({ archivo });
      const a = await x.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID1, texto: 'hola' });
      await new Promise((r) => setTimeout(r, 50));
      check('la tabla se escribe a disco', fs.existsSync(archivo));
      // Un "reinicio": otra tabla sobre el mismo archivo y el mismo registro.
      const idem2 = crearIdempotencia({ archivo, registro: x.registro });
      const e = idem2.buscar('alma:alya', ID1);
      check('después de reiniciar, la entrada sigue con su tid y tareaId', e && e.tid === a.turno.tid && e.tareaId === a.turno.tareaId);
      x.registro.tareas.get(a.turno.tareaId).estado = 'interrumpida';
      check('el estado se lee del registro (interrumpida)', x.registro.obtener(e.tareaId).estado === 'interrumpida');
      let t = 0;
      const y = armar({ ahora: () => t });
      await y.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID1, texto: 'hola' });
      t = 25 * 60 * 60 * 1000;
      check('pasadas 24 h → 409 vencido', (await y.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID1, texto: 'hola' })).codigo === 409);
      const z = armar();
      const r = await z.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID1, texto: 'hola' });
      z.registro.tareas.delete(r.turno.tareaId);
      check('si la tarea salió del registro → 409 por idCliente', (await z.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID1, texto: 'hola' })).codigo === 409);
      check('… y 410 por tid', (await z.llamar('POST', `/api/v2/turnos/${r.turno.tid}:cancelar`)).codigo === 410);
    });

    await group('S5 · fotos', async () => {
      const x = armar();
      const [a, b] = await Promise.all([
        x.llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: ID1, base64: 'eA==', texto: 'mirá' }),
        x.llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: ID1, base64: 'eA==', texto: 'mirá' })
      ]);
      check('un reenvío no guarda un segundo adjunto ni despacha otra vez', x.guardadas.length === 1 && x.despachos.length === 1);
      check('la foto viaja con su ruta y el turno dice adjunto', x.despachos[0].imagen?.ruta === '/adj/1.jpg' && a.turno.adjunto === true && a.turno.tid === b.turno.tid);
      check('sin imagen → 400, nada guardado', (await x.llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: ID2 })).codigo === 400 && x.guardadas.length === 1);
      check('a un agente → 404', (await x.llamar('POST', '/api/v2/sujetos/lagrange-reviewer/fotos', { idCliente: ID2, base64: 'eA==' })).codigo === 404);
      const re = await x.llamar('POST', `/api/v2/turnos/${a.turno.tid}:reintentar`);
      check('una foto no se reintenta → 409, nada despachado', re.codigo === 409 && x.despachos.length === 1);
    });

    await group('S5 · cancelar y reintentar', async () => {
      const x = armar();
      const a = await x.llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: ID1, texto: 'hola' });
      const c = await x.llamar('POST', `/api/v2/turnos/${a.turno.tid}:cancelar`);
      check('cancelar por tid llega a su tareaId', c.ok && x.registro.obtener(a.turno.tareaId).estado === 'cancelada');
      const r = await x.llamar('POST', `/api/v2/turnos/${a.turno.tid}:reintentar`);
      check('reintentar crea un tid y un tareaId nuevos', r.codigo === 202 && r.turno.tid !== a.turno.tid && r.turno.tareaId !== a.turno.tareaId);
      check('el reintento trae reintentoDe y no trae idCliente', r.turno.reintentoDe === a.turno.tid && !r.turno.idCliente);
      check('el reintento valida contra el esquema', esq.validar(contrato, 'turno', r.turno).length === 0);
      const c2 = await x.llamar('POST', `/api/v2/turnos/${r.turno.tid}:cancelar`);
      check('el reintento se cancela por su propio tid', c2.ok && x.registro.obtener(r.turno.tareaId).estado === 'cancelada');
      x.registro.tareas.set('t-telegram', { id: 't-telegram', estado: 'error', origen: 'telegram', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'de telegram', creada: '2026-11-17T08:00:00.000Z' });
      const tg = await x.llamar('POST', '/api/v2/turnos/t-telegram:reintentar');
      check('un turno de Telegram (sin tid) se reintenta por tareaId', tg.codigo === 202 && tg.turno.reintentoDe === 't-telegram');
      check('tareaId inexistente → 410', (await x.llamar('POST', '/api/v2/turnos/t-nada:cancelar')).codigo === 410);
    });

    await group('S5 · memoria y el resto', async () => {
      const x = armar();
      const vistos = [];
      x.almacen.suscribir(['sujeto:alya'], (e) => vistos.push(e));
      const r = await x.llamar('POST', '/api/v2/sujetos/alya/memoria', { texto: 'le gusta el té', sobre: 'usuario' });
      check('recordar delega y publica memoria.cambio', r.ok && vistos.some((e) => e.tipo === 'memoria.cambio' && e.datos.sujeto === 'alya'));
      const n = vistos.length;
      await x.llamar('POST', '/api/v2/sujetos/alya/memoria', {});
      check('un recordar que falla no publica', vistos.length === n);
      await x.llamar('DELETE', '/api/v2/sujetos/alya/memoria/m1');
      await x.llamar('POST', '/api/v2/sujetos/alya/cuarentena/q1:promover');
      await x.llamar('POST', '/api/v2/sujetos/alya/cuarentena/q2:descartar');
      check('olvidar, promover y descartar publican memoria.cambio', vistos.filter((e) => e.tipo === 'memoria.cambio').length === n + 3);
      check('memoria.cambio valida contra el esquema', esq.validar(contrato, 'evento:memoria.cambio', vistos.at(-1).datos).length === 0);
      check('frenar con un carril inválido → 400', (await x.llamar('POST', '/api/v2/carriles:frenar', { carril: 'principal' })).codigo === 400);
      check('frenar todos → nucleo.cancelar sin carril', (await x.llamar('POST', '/api/v2/carriles:frenar', { carril: 'todos' })).carril === 'todos');
      check('escuchar devuelve el binario', Buffer.isBuffer((await x.llamar('POST', '/api/v2/turnos/t-1:escuchar')).binario));
      check('detener Claude remoto pasa la key (y no saca el pid)', ((d) => d.key === 'k1' && !('pid' in d))((await x.llamar('DELETE', '/api/v2/claude/sesiones/k1')).detenidas[0]));
      check('motores/rol delega el cuerpo tal cual', (await x.llamar('POST', '/api/v2/motores/rol', { rol: 'alma:alya', motor: 'deepseek' })).eco.motor === 'deepseek');
    });

    await group('S5 · fuente de bot.js, canal.js y nucleo.js', () => {
      const bot = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'bot.js'), 'utf8').replace(/\r\n/g, '\n');
      const charla = bot.slice(bot.indexOf('export async function dispatchCharla('), bot.indexOf('export async function dispatchCharla(') + 3000);
      const iAl = charla.indexOf('avisarEncolada(alEncolar, task);');
      check('dispatchCharla avisa alEncolar antes de su primer await', iAl > 0 && iAl < charla.indexOf('await '));
      const cast = bot.slice(bot.indexOf('export async function dispatchCast('), bot.indexOf('export async function dispatchCast(') + 3000);
      check('dispatchCast avisa alEncolar antes de su primer await', cast.indexOf('avisarEncolada(alEncolar, task);') > 0 && cast.indexOf('avisarEncolada(alEncolar, task);') < cast.indexOf('await '));
      check('los dos devuelven el tareaId', (bot.match(/return \{ ok: true, tareaId: task\.tareaId \?\? null \};/g) || []).length === 2);
      check('reintentarTarea propaga alEncolar y devuelve el tareaId', /reintentarTarea\(tareaId, ctx, \{ alEncolar = null \} = \{\}\)/.test(bot) && (bot.match(/return \{ ok: true, tareaId: r\.tareaId \?\? null \};/g) || []).length === 2);
      check('datosDeTarea: web:terminal → terminal, comparando exacto', /origen: task\.chatId === CHAT_WEB_TERMINAL \? 'terminal' : esChatWeb\(task\.chatId\) \? 'web' : 'telegram'/.test(bot));
      const canal = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'canal.js'), 'utf8');
      check('canal.js exporta CHAT_WEB_TERMINAL = web:terminal', canal.includes('export const CHAT_WEB_TERMINAL = `${PREFIJO_CHAT_WEB}terminal`;'));
      const nucleo = fs.readFileSync(path.join(RAIZ, 'telegram-bridge', 'web', 'nucleo.js'), 'utf8');
      check('castear y fotoAlma usan las funciones compartidas', nucleo.includes('const c = api.prepararCast(cuerpo);') && nucleo.includes('const v = api.validarFoto(clave, cuerpo);') && nucleo.includes('const g = api.guardarFoto(v);'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
