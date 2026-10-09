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
  const integrados = [];
  const { evaluarIntegrable } = require('../mcp-server/lotes/integrar.js');
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
      // FEAT-108 — La puerta real; la integración, simulada (la de git se prueba en lotes-integrar).
      evaluarIntegrable,
      integrar: async ({ id, confirmar }) => {
        if ((await confirmar()) !== id) return { integrado: false };
        const puerta = evaluarIntegrable(lotesGuardados.get(id));
        if (!puerta.ok) throw Object.assign(new Error(`no se puede integrar: ${puerta.motivos.join('; ')}`), { motivos: puerta.motivos });
        integrados.push(id);
        lotesGuardados.get(id).estado = 'integrado';
        return { integrado: true, rama: 'trabajo', despues: 'f'.repeat(40), merges: [{}], saltados: [] };
      },
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

  // FEAT-148 G3 — Borradores y actores.
  const borr = nucleo.borradoresLote();
  check('G3: una familia con su lote descartado vuelve a ser un borrador lanzable', borr.ok && borr.borradores.some((x) => x.madreId === madre.id && x.lanzable));
  const madreG = tareas.crearTarjeta({ titulo: 'Madre G', pedido: 'x' }).tarea;
  const g1 = tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madreG.id, titulo: 'G1', pedido: 'Editar G1',
    sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1' }).tarea;
  const bPropuesta = nucleo.borradoresLote().borradores.find((x) => x.madreId === madreG.id);
  check('G3: una hija sin aceptar → borrador no lanzable, con el motivo de familiaLanzable',
    bPropuesta && bPropuesta.lanzable === false && /aceptadas/.test(bPropuesta.motivo));
  tareas.aceptarPropuesta(g1.id);
  const bOk = nucleo.borradoresLote().borradores.find((x) => x.madreId === madreG.id);
  check('G3: aceptada → lanzable, con proyecto y sus hijas, sin ruta del host',
    bOk.lanzable === true && bOk.motivo === null && bOk.workspace.nombre === 'Repo' && bOk.hijas.map((h) => h.id).join() === g1.id && !JSON.stringify(bOk).includes(repo));
  const malos = await nucleo.lanzarLote(madreG.id, { ...cuerpo, hijas: [{ id: g1.id, archivos: ['src/g.js'] }], actores: { escribir: { motor: 'x'.repeat(200) }, auditar: {} } });
  check('G3: actores con forma inválida → 400 sin tocar el servicio', malos.codigo === 400 && /actores inválidos/.test(malos.error));
  solicitud = null;
  const rG = await nucleo.lanzarLote(madreG.id, { ...cuerpo, hijas: [{ id: g1.id, archivos: ['src/g.js'] }],
    actores: { escribir: { motor: 'claude@trabajo', modelo: 'sonnet', esfuerzo: 'medium' }, auditar: { modelo: 'gemini-3.1-pro' } } });
  check('G3: una familia vinculada a un lote ya no es un borrador', !nucleo.borradoresLote().borradores.some((x) => x.madreId === madreG.id));
  check('G3: los actores llegan a la solicitud (motor, modelo, effort, modelo_auditor) y ganan sobre modelo/effort sueltos',
    rG.codigo === 202 && solicitud.motor === 'claude@trabajo' && solicitud.modelo === 'sonnet' && solicitud.effort === 'medium' && solicitud.modelo_auditor === 'gemini-3.1-pro');

  // FEAT-108 — Integrar.
  const madre2 = tareas.crearTarjeta({ titulo: 'Madre 2', pedido: 'Coordinar' }).tarea;
  const hija2 = (titulo) => {
    const h = tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madre2.id, titulo, pedido: `Editar ${titulo}`,
      sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1' }).tarea;
    tareas.aceptarPropuesta(h.id);
    return h;
  };
  const c = hija2('C');
  const d = hija2('D');
  const r2 = await nucleo.lanzarLote(madre2.id, { ...cuerpo, hijas: [{ id: c.id, archivos: ['src/c.js'] }, { id: d.id, archivos: ['src/d.js'] }] });
  const lote2 = lotesGuardados.get(r2.id);
  lote2.estado = 'para revisar';
  lote2.ramaBase = 'trabajo';
  const pasa = { prueba: { estado: 'paso', exitCode: 0 }, auditoria: { estado: 'completa', veredicto: 'PASS' } };
  Object.assign(lote2.tareas[0], { commit: 'abcdef1', ...pasa });
  Object.assign(lote2.tareas[1], { commit: 'abcdef2', prueba: { estado: 'fallo', exitCode: 1 }, auditoria: { estado: 'completa', veredicto: 'PASS' } });
  const vista = nucleo.lote(r2.id).lote;
  check('el detalle trae la rama base y la puerta cerrada con su motivo',
    vista.ramaBase === 'trabajo' && vista.integrable.ok === false && vista.integrable.motivos.some((m) => m.includes(`${d.id}: prueba fallo`)));
  check('integrar con confirmación incorrecta → 400', (await nucleo.integrarLote(r2.id, { confirmacion: 'otro' })).codigo === 400 && !integrados.length);
  const rechazo = await nucleo.integrarLote(r2.id, { confirmacion: r2.id });
  check('con una prueba roja → 409 con los motivos, sin integrar', rechazo.codigo === 409 && rechazo.motivos.length === 1 && !integrados.length);
  Object.assign(lote2.tareas[1], pasa);
  check('con todo verde la puerta se abre', nucleo.lote(r2.id).lote.integrable.ok === true);
  const hecho = await nucleo.integrarLote(r2.id, { confirmacion: r2.id });
  check('integrar devuelve rama y sha corto', hecho.ok && hecho.rama === 'trabajo' && hecho.despuesCorto === 'ffffffff' && integrados[0] === r2.id);
  check('la familia queda hecha y conserva el lote',
    [madre2, c, d].every((t) => tareas.obtener(t.id).estado === 'ok' && tareas.obtener(t.id).loteId === r2.id
      && tareas.obtener(t.id).eventos.some((e) => e.tipo === 'lote_integrado')));
  check('un lote integrado no ofrece la puerta', nucleo.lote(r2.id).lote.integrable === null);

  // Reconciliación: lo que el CLI hizo sin el daemon se pone al día al listar.
  const madre3 = tareas.crearTarjeta({ titulo: 'Madre 3', pedido: 'x' }).tarea;
  const e3 = tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madre3.id, titulo: 'E', pedido: 'Editar E',
    sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1' }).tarea;
  tareas.aceptarPropuesta(e3.id);
  const r3 = await nucleo.lanzarLote(madre3.id, { ...cuerpo, hijas: [{ id: e3.id, archivos: ['src/e.js'] }] });
  lotesGuardados.get(r3.id).estado = 'integrado';
  nucleo.lotes();
  check('integrado por CLI → la familia queda hecha al listar', tareas.obtener(madre3.id).estado === 'ok' && tareas.obtener(e3.id).estado === 'ok');
  const madre4 = tareas.crearTarjeta({ titulo: 'Madre 4', pedido: 'x' }).tarea;
  const f4 = tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madre4.id, titulo: 'F', pedido: 'Editar F',
    sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1' }).tarea;
  tareas.aceptarPropuesta(f4.id);
  const r4 = await nucleo.lanzarLote(madre4.id, { ...cuerpo, hijas: [{ id: f4.id, archivos: ['src/f.js'] }] });
  lotesGuardados.get(r4.id).estado = 'descartado';
  nucleo.reconciliarLotes();
  check('descartado por CLI → la familia queda libre y en Por hacer', tareas.obtener(madre4.id).loteId === null && tareas.obtener(f4.id).estado === tareas.POR_HACER);

  // FEAT-136 — El cliente: app.js más sus módulos de ui/ (el tablero vive en ui/vista-tablero.js).
  const publico = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
  const cliente = [fs.readFileSync(path.join(publico, 'app.js'), 'utf8'), ...fs.readdirSync(path.join(publico, 'ui')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(publico, 'ui', f), 'utf8'))].join('\n');
  const servidor = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'servidor.js'), 'utf8');
  check('el cliente usa las rutas persistentes y no innerHTML', cliente.includes("api('/api/lotes')") && cliente.includes('/lote`') && !/\.innerHTML\s*=/.test(cliente));
  check('descarte envía el id exacto tras dos pasos', cliente.includes('{ confirmacion: l.id }') && cliente.includes('texto="Descartar lote"') && cliente.includes('alConfirmar=${descartar}'));
  check('la tarjeta madre muestra el estado actual y su detalle se refresca por sondeo',
    cliente.includes("lote · ${lote?.estado || 'sin datos'}")
    && cliente.includes('d?.tarea?.loteId) cargarDetalle();'));
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
