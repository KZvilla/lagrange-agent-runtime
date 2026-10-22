// FEAT-151 / FEAT-152 — Salida de los borradores de Tuberías: archivar un draft y descartar un lote archivando
// sus tarjetas. Plan: docs/future-implementations/FEAT/FEAT-151/plan-feat-151-152-salida-de-borradores.md (local).
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat-151-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const fuente = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

(async () => {
  const tareas = await import('../telegram-bridge/tareas.js');
  const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');
  const { crearNucleoWeb } = await import('../telegram-bridge/web/nucleo.js');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  const familia = (titulo, n = 2) => {
    const madre = tareas.crearTarjeta({ titulo, pedido: 'Coordinar' }).tarea;
    const hijas = [];
    for (let i = 0; i < n; i++) {
      const h = tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madre.id, titulo: `${titulo} ${i}`, pedido: `Editar ${i}`,
        sujeto: { tipo: 'agente', nombre: 'worker' }, proyecto: 'Repo', workspaceId: 'ws-1' }).tarea;
      tareas.aceptarPropuesta(h.id);
      hijas.push(h);
    }
    return { madre, hijas };
  };
  const leer = (id) => tareas.obtener(id);
  const archivadaCancelada = (id) => leer(id).estado === 'cancelada' && Boolean(leer(id).archivada);

  await group('tareas.archivarFamilia', () => {
    const { madre, hijas } = familia('F1');
    const r = tareas.archivarFamilia(madre.id, { motivo: 'borrador_archivado' });
    check('madre e hijas quedan canceladas y archivadas', r.ok && [madre, ...hijas].every((t) => archivadaCancelada(t.id)), JSON.stringify(r));
    check('el evento lleva el motivo y la fecha de cierre', leer(madre.id).eventos.some((e) => e.tipo === 'cancelada' && e.detalle === 'borrador_archivado') && Boolean(leer(madre.id).terminada));
    check('devuelve las tocadas', r.archivadas.length === 3);

    const f2 = familia('F2');
    tareas.reservarFamilia([f2.madre.id, ...f2.hijas.map((h) => h.id)]);
    const reservada = tareas.archivarFamilia(f2.madre.id);
    check('con reserva → 409 sin tocar nada', reservada.codigo === 409 && [f2.madre, ...f2.hijas].every((t) => leer(t.id).estado === tareas.POR_HACER && !leer(t.id).archivada));
    tareas.liberarReservaFamilia([f2.madre.id, ...f2.hijas.map((h) => h.id)]);

    const f3 = familia('F3');
    tareas.vincularLote({ madre: f3.madre.id, hijas: f3.hijas.map((h) => h.id), loteId: 'lote-f3' });
    check('con un lote y sin loteId → 409', tareas.archivarFamilia(f3.madre.id).codigo === 409 && leer(f3.madre.id).loteId === 'lote-f3');
    check('con otro loteId → 409', tareas.archivarFamilia(f3.madre.id, { loteId: 'otro' }).codigo === 409 && !leer(f3.madre.id).archivada);
    const conLote = tareas.archivarFamilia(f3.madre.id, { loteId: 'lote-f3', motivo: 'lote_descartado_archivado' });
    check('con su loteId: limpia el lote, cancela y archiva en una pasada', conLote.ok && [f3.madre, ...f3.hijas].every((t) => archivadaCancelada(t.id) && leer(t.id).loteId === null
      && leer(t.id).eventos.some((e) => e.tipo === 'lote_descartado' && e.detalle === 'lote-f3')));

    const f4 = familia('F4');
    tareas.desvincularLote('nada');
    check('con loteId pero la familia ya desvinculada → se acepta', tareas.archivarFamilia(f4.madre.id, { loteId: 'lote-f4' }).ok && archivadaCancelada(f4.madre.id));

    check('madre inexistente → 404', tareas.archivarFamilia('t_noexiste').codigo === 404);
    check('madre ya archivada (no está en Por hacer) → 409', tareas.archivarFamilia(madre.id).codigo === 409);

    // Hallazgo de la auditoría Sonnet (2026-10-13): las dos ramas que no tenían test.
    const f5 = familia('F5');
    tareas.lanzarTarjeta(f5.hijas[0].id, { carril: 'agente', sujeto: { tipo: 'agente', nombre: 'worker' } });
    tareas.actualizar(f5.hijas[0].id, { estado: 'en_curso' });
    check('una hija en curso → 409 sin tocar nada', leer(f5.hijas[0].id).estado === 'en_curso' && tareas.archivarFamilia(f5.madre.id).codigo === 409
      && leer(f5.madre.id).estado === tareas.POR_HACER && !leer(f5.hijas[1].id).archivada);
    tareas.actualizar(f5.hijas[0].id, { estado: 'ok' });
    const r5 = tareas.archivarFamilia(f5.madre.id);
    check('una hija ya cerrada solo se archiva: sigue en ok y sin evento cancelada', r5.ok && leer(f5.hijas[0].id).estado === 'ok' && Boolean(leer(f5.hijas[0].id).archivada)
      && !leer(f5.hijas[0].id).eventos.some((e) => e.tipo === 'cancelada') && archivadaCancelada(f5.hijas[1].id));
  });

  // ---------------------------------------------------------------- núcleo
  let descartaOk = true;
  const lotesGuardados = new Map();
  const registro = { marcarInterrumpidos() { return []; }, listar() { return [...lotesGuardados.values()]; }, leer(id) { return lotesGuardados.get(id) || null; } };
  const nucleo = crearNucleoWeb({
    canal: crearCanalWeb(), bot: {}, almas: {}, tareas,
    workspaces: () => [{ id: 'ws-1', name: 'Repo', path: repo }], ultimoWorkspace: () => null,
    logs: () => ({}), sesiones: () => ({}), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true,
    lotes: {
      servicio: {}, registro, validarId: (id) => { if (!/^[\w-]+$/.test(id)) throw new Error('id inválido'); return id; },
      descartar: async ({ id }) => {
        if (!descartaOk) return { descartado: false, borrados: [], saltados: [] };
        lotesGuardados.get(id).estado = 'descartado';
        return { descartado: true, borrados: [], saltados: [] };
      },
      git: () => ''
    }
  });
  const loteDe = (f, id) => {
    tareas.vincularLote({ madre: f.madre.id, hijas: f.hijas.map((h) => h.id), loteId: id });
    lotesGuardados.set(id, { id, estado: 'para revisar', repo, tareas: f.hijas.map((h) => ({ id: h.id })) });
  };
  const esBorrador = (id) => nucleo.borradoresLote().borradores.some((b) => b.madreId === id);

  await group('núcleo: archivarBorrador (FEAT-151)', () => {
    const f = familia('Draft');
    check('arranca como borrador', esBorrador(f.madre.id));
    const r = nucleo.archivarBorrador(f.madre.id);
    check('archivar lo saca de Tuberías', r.ok && !esBorrador(f.madre.id) && archivadaCancelada(f.madre.id));
    check('id inválido → 400; inexistente → 404', nucleo.archivarBorrador('x').codigo === 400 && nucleo.archivarBorrador('t_noexiste').codigo === 404);
    const conLote = familia('Con lote');
    loteDe(conLote, 'lote-cl');
    check('con un lote → 409', nucleo.archivarBorrador(conLote.madre.id).codigo === 409);
    const sola = tareas.crearTarjeta({ titulo: 'Sin hijas', pedido: 'x' }).tarea;
    check('una tarjeta sin hijas no es un draft → 409', nucleo.archivarBorrador(sola.id).codigo === 409 && leer(sola.id).estado === tareas.POR_HACER);
  });

  await group('núcleo: descartarLote con tarjetas (FEAT-152)', async () => {
    const v = familia('Vuelve');
    loteDe(v, 'lote-v');
    const rv = await nucleo.descartarLote('lote-v', { confirmacion: 'lote-v' });
    check('sin tarjetas: igual que antes, la familia vuelve a ser borrador', rv.ok && !rv.tarjetas && leer(v.madre.id).loteId === null && esBorrador(v.madre.id));

    const ar = familia('Archiva');
    loteDe(ar, 'lote-a');
    const ra = await nucleo.descartarLote('lote-a', { confirmacion: 'lote-a', tarjetas: 'archivar' });
    check('archivar: familia cancelada y archivada, sin borrador', ra.ok && ra.tarjetas?.archivadas === true && [ar.madre, ...ar.hijas].every((t) => archivadaCancelada(t.id)) && !esBorrador(ar.madre.id));

    const mal = familia('Mal');
    loteDe(mal, 'lote-m');
    const rm = await nucleo.descartarLote('lote-m', { confirmacion: 'lote-m', tarjetas: 'otro' });
    check('valor desconocido → 400 y el lote no se descarta', rm.codigo === 400 && lotesGuardados.get('lote-m').estado === 'para revisar' && leer(mal.madre.id).loteId === 'lote-m');

    descartaOk = false;
    const rn = await nucleo.descartarLote('lote-m', { confirmacion: 'lote-m', tarjetas: 'archivar' });
    check('si el descarte falla, las tarjetas no se tocan', rn.codigo === 409 && leer(mal.madre.id).loteId === 'lote-m' && !leer(mal.madre.id).archivada);
    descartaOk = true;

    // Un lote cuya familia no tiene madre vinculada (lanzado fuera de la consola): no hay qué archivar.
    const huerfana = familia('Huérfana', 1);
    tareas.vincularLote({ madre: huerfana.madre.id, hijas: huerfana.hijas.map((h) => h.id), loteId: 'lote-c' });
    lotesGuardados.set('lote-c', { id: 'lote-c', estado: 'para revisar', repo, tareas: [] });
    leer(huerfana.madre.id).loteId = null;
    const rc = await nucleo.descartarLote('lote-c', { confirmacion: 'lote-c', tarjetas: 'archivar' });
    check('si archivar no puede: descartado igual, tarjetas desvinculadas en Por hacer y se informa',
      rc.ok && rc.tarjetas?.archivadas === false && /madre/.test(rc.tarjetas.error) && lotesGuardados.get('lote-c').estado === 'descartado'
      && leer(huerfana.hijas[0].id).loteId === null && leer(huerfana.hijas[0].id).estado === tareas.POR_HACER);
  });

  await group('interfaz (fuente)', () => {
    const borr = fuente('tuberias-borrador.js');
    check('«Archivar draft» con dos pasos y aviso de que no vuelve', /BotonDosPasos} clase="boton" texto="Archivar draft"/.test(borr) && /No vuelve a Tuberías/.test(borr) && /borradores\/\$\{enc\(b\.madreId\)\}\/archivar/.test(borr));
    const det = fuente('tuberias-detalle.js');
    check('Descartar ofrece archivar las tarjetas, desmarcado', /useState\(false\)/.test(det) && /archivar las tarjetas/.test(det) && /descartarLote\(l, recargar, \{ archivar \}\)/.test(det));
    const acc = fuente('lote-acciones.js');
    check('un archivado fallido se avisa como error', /archivadas === false/.test(acc) && /no se archivaron/.test(acc) && /'error'\)/.test(acc));
    check('archivos de ui/ ≤ 210 líneas', ['tuberias-borrador.js', 'tuberias-detalle.js', 'lote-acciones.js'].every((f) => fuente(f).split('\n').length <= 210));
  });

  report();
})().catch((err) => { console.error(err); process.exit(1); });
