const { check, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-lotes-web-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');

(async () => {
  const tareas = await import('../telegram-bridge/tareas.js');
  const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');
  const { crearNucleoWeb } = await import('../telegram-bridge/web/nucleo.js');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const madre = tareas.crearTarjeta({ titulo: 'Madre', pedido: 'Coordinar' }).tarea;
  const hacerHija = (titulo) => {
    const h = tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madre.id, titulo, pedido: `Editar ${titulo}`,
      sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1' }).tarea;
    tareas.aceptarPropuesta(h.id);
    return h;
  };
  const a = hacerHija('A');
  const b = hacerHija('B');
  let solicitud = null;
  let background = false;
  let descartado = false;
  const lotesGuardados = new Map();
  const servicio = {
    validarSolicitud(datos) { solicitud = datos; return datos; },
    async preparar(datos) {
      const lote = { id: datos.slug, estado: 'corriendo', repo, modelo: datos.modelo, creado: new Date().toISOString(), actualizado: new Date().toISOString(),
        tareas: datos.tareas.map((t) => ({ id: t.id, estado: 'corriendo', commit: null })) };
      lotesGuardados.set(datos.slug, lote);
      return { id: datos.slug, preparado: true };
    },
    ejecutarEnSegundoPlano() { background = true; return {}; },
    async cancelar() { return true; }
  };
  const registro = {
    marcarInterrumpidos() { return []; },
    listar() { return [...lotesGuardados.values()]; },
    leer(id) { return lotesGuardados.get(id) || null; }
  };
  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(), bot: {}, almas: {}, tareas,
    workspaces: () => [{ id: 'ws-1', name: 'Repo', path: repo }], ultimoWorkspace: () => null,
    logs: () => ({}), sesiones: () => ({}), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true,
    lotes: {
      servicio, registro, validarId: (id) => { if (!/^[\w-]+$/.test(id)) throw new Error('id inválido'); return id; },
      diff: async ({ commit }) => ({ commit, diff: 'diff exacto' }),
      descartar: async ({ id }) => { descartado = true; lotesGuardados.get(id).estado = 'descartado'; return { descartado: true, borrados: [], saltados: [] }; },
      git: () => ''
    }
  });
  const cuerpo = {
    modelo: 'gemini-3.8-flash', effort: 'high', concurrencia: 2, timeout_minutes: 30,
    hijas: [{ id: a.id, archivos: ['src/a.js'] }, { id: b.id, archivos: ['src/b.js'], prueba: { argv: ['npm', 'test'] } }]
  };
  const r = await nucleo.lanzarLote(madre.id, cuerpo);
  check('el POST devuelve 202 y arranca background', r.codigo === 202 && background);
  check('el servidor construye prompts desde tarjetas', solicitud.tareas[0].prompt.includes('Editar A') && !Object.hasOwn(cuerpo.hijas[0], 'prompt'));
  check('madre e hijas quedan vinculadas', tareas.obtener(madre.id).loteId === r.id && tareas.obtener(a.id).loteId === r.id);
  const lista = nucleo.lotes();
  check('la lista proyecta workspace sin ruta del host', lista.ok && !JSON.stringify(lista).includes(repo));
  const lote = lotesGuardados.get(r.id);
  lote.estado = 'para revisar';
  lote.tareas[0].commit = 'abcdef1';
  const detalle = nucleo.lote(r.id);
  check('el detalle conserva commit pero no repo', detalle.lote.tareas[0].commit === 'abcdef1' && !Object.hasOwn(detalle.lote, 'repo'));
  const diff = await nucleo.diffLote(r.id, a.id);
  check('el diff usa el commit persistido', diff.ok && diff.commit === 'abcdef1' && diff.diff === 'diff exacto');
  check('confirmación incorrecta no descarta', (await nucleo.descartarLote(r.id, { confirmacion: 'otro' })).codigo === 400 && !descartado);
  check('descarte confirmado desvincula tarjetas', (await nucleo.descartarLote(r.id, { confirmacion: r.id })).ok && descartado && tareas.obtener(madre.id).loteId === null);

  const cliente = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'app.js'), 'utf8');
  const servidor = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'servidor.js'), 'utf8');
  check('el cliente usa las rutas persistentes y no innerHTML', cliente.includes("api('/api/lotes')") && cliente.includes('/lote`') && !/\.innerHTML\s*=/.test(cliente));
  check('descarte envía el id exacto tras dos pasos', cliente.includes('{ confirmacion: l.id }') && cliente.includes('dosPasos(descartar'));
  check('la tarjeta madre muestra el estado actual y su detalle se refresca por sondeo',
    cliente.includes('`lote · ${lote?.estado || \'sin datos\'}`')
    && cliente.includes('if (estado.detalle?.tarea?.loteId) cargarDetalle();'));
  check('solo los lotes sin madre y no descartados tienen tarjeta propia',
    cliente.includes(".filter((l) => !l.madreId && l.estado !== 'descartado')"));
  check('el servidor declara las cinco rutas de fase 4',
    ['nucleo.lanzarLote', 'nucleo.lotes()', 'nucleo.lote(', 'nucleo.diffLote', 'nucleo.descartarLote'].every((x) => servidor.includes(x)));

  fs.rmSync(dir, { recursive: true, force: true });
  report();
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
