/**
 * FEAT-160 F0 — Las reglas del tablero (ui/reglas-tablero.js) ejecutadas, no
 * leídas como texto: la matriz de transiciones, quién puede, qué confirma, la
 * revalidación al confirmar y el orden de Por hacer (04-pruebas T1, C1-C6, O1, O3).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat-160-f0-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const RUTA = path.join(UI, 'reglas-tablero.js');

const ctxBase = (extra = {}) => ({
  motivoSinMover: () => null, alcanza: () => true, motivoRemoto: () => 'Sin permiso desde acá.',
  hijasDe: () => [], partiendo: () => null, hayOcultasEnHacer: () => false, ...extra
});
const tarjeta = (estado, extra = {}) => ({
  id: `t_${estado}`, estado, titulo: estado, motivo: 'mensaje', carril: null,
  sujeto: { tipo: 'alma', clave: 'alya' }, workspaceId: 'ws1', ...extra
});
const ESTADOS = ['por_hacer', 'en_cola', 'en_curso', 'ok', 'error', 'cancelada', 'interrumpida'];

(async () => {
  const R = await import(pathToFileURL(RUTA).href);
  const ids = R.COLUMNAS.map((c) => c.id);

  await group('El módulo es puro', () => {
    const fuente = fs.readFileSync(RUTA, 'utf8');
    check('no importa nada', !/^\s*import\s/m.test(fuente));
    check('210 líneas o menos, como Tuberías', fuente.split('\n').length <= 210, String(fuente.split('\n').length));
  });

  await group('T1 — la matriz estado × destino', () => {
    const permitidas = new Set(['hacer→cola', 'cola→mal', 'curso→mal', 'mal→hacer', 'mal→cola', 'hacer→hacer']);
    const mal = [];
    for (const estado of ESTADOS) {
      const t = tarjeta(estado);
      const desde = R.columnaDeEstado(estado);
      for (const hasta of ids) {
        const m = R.validarDestino(t, desde, hasta, ctxBase());
        const clave = `${desde}→${hasta}`;
        const esperado = permitidas.has(clave) ? null : desde === hasta ? '' : 'motivo';
        const obtenido = m === null ? null : m === '' ? '' : 'motivo';
        if (esperado !== obtenido) mal.push(`${estado} ${clave}: ${JSON.stringify(m)}`);
      }
    }
    check('solo las cinco transiciones y el reordenar de Por hacer quedan habilitadas', !mal.length, mal.join(' | '));
    check('las cinco decididas por el usuario, con su confirmación y nivel', JSON.stringify(Object.entries(R.TRANSICIONES).map(([k, v]) => `${k}:${v.accion}:${v.confirmar}:${v.nivel}`)) === JSON.stringify([
      'hacer→cola:lanzar:true:ejecutar', 'cola→mal:cancelar:true:operar', 'curso→mal:cancelar:true:operar',
      'mal→hacer:devolver:false:operar', 'mal→cola:reintentar:false:ejecutar'
    ]));
    check('nunca se suelta en Trabajando ni Terminado', !Object.keys(R.TRANSICIONES).some((k) => /→(curso|ok)$/.test(k)));
    check('Trabajando y Terminado dicen por qué', R.validarDestino(tarjeta('por_hacer'), 'hacer', 'curso', ctxBase()) === 'Trabajando lo decide el ejecutor.'
      && R.validarDestino(tarjeta('en_curso'), 'curso', 'ok', ctxBase()) === 'Terminado lo marca un resultado real.');
    check('con filtros no se reordena', /filtro/.test(R.validarDestino(tarjeta('por_hacer'), 'hacer', 'hacer', ctxBase({ hayOcultasEnHacer: () => true }))));
    const menu = R.destinosDe(tarjeta('error'), ctxBase()).map((d) => `${d.desde}→${d.hasta}:${d.motivo}`);
    check('destinosDe de Con error: Por hacer y En cola, sin motivo, con su origen', JSON.stringify(menu) === JSON.stringify(['mal→hacer:null', 'mal→cola:null']), menu.join(' '));
  });

  await group('T6-T8 — quién puede', () => {
    const lanzar = R.TRANSICIONES['hacer→cola'];
    const cancelar = R.TRANSICIONES['cola→mal'];
    const reintentar = R.TRANSICIONES['mal→cola'];
    const devolver = R.TRANSICIONES['mal→hacer'];
    check('el carril principal no se cancela', /Telegram/.test(R.motivoTransicion(tarjeta('en_cola', { carril: 'principal' }), cancelar, ctxBase())));
    check('el carril principal no vuelve a Por hacer', R.motivoTransicion(tarjeta('error', { carril: 'principal' }), devolver, ctxBase()) !== null);
    for (const motivo of ['reaccion', 'orquestar']) {
      check(`${motivo}: no se reintenta ni se devuelve`, R.motivoTransicion(tarjeta('error', { motivo }), reintentar, ctxBase()) !== null
        && R.motivoTransicion(tarjeta('error', { motivo }), devolver, ctxBase()) !== null);
    }
    check('un agente sin proyecto no se reintenta', !R.reintentable(tarjeta('error', { sujeto: { tipo: 'agente', nombre: 'x' }, workspaceId: null })));
    const todos = ctxBase({ motivoSinMover: () => 'Elegí un nodo.' });
    check('en «Todos» nada se mueve', ESTADOS.every((e) => R.destinosDe(tarjeta(e), todos).every((d) => d.motivo === 'Elegí un nodo.'))
      && R.validarDestino(tarjeta('por_hacer'), 'hacer', 'hacer', todos) === 'Elegí un nodo.');
    check('sin nivel, el motivo remoto antes que cualquier otro', R.motivoTransicion(tarjeta('por_hacer', { sujeto: null }), lanzar, ctxBase({ alcanza: () => false })) === 'Sin permiso desde acá.');
    check('sin sujeto no se lanza', /Asignala/.test(R.motivoTransicion(tarjeta('por_hacer', { sujeto: null }), lanzar, ctxBase())));
    check('un agente sin proyecto no se lanza', /proyecto/.test(R.motivoTransicion(tarjeta('por_hacer', { sujeto: { tipo: 'agente', nombre: 'x' }, workspaceId: null }), lanzar, ctxBase())));
    check('una tarjeta de un lote no se lanza', /batch l1/.test(R.motivoTransicion(tarjeta('por_hacer', { loteId: 'l1' }), lanzar, ctxBase())));
    const madre = ctxBase({ hijasDe: () => [{ estado: 'en_cola' }, { estado: 'ok' }] });
    check('una madre con hijas vivas no se lanza (BE-105)', /madre de 1 hija/.test(R.motivoNoLanzable(tarjeta('por_hacer'), madre)));
    check('una madre partiéndose tampoco', /partiendo/.test(R.motivoMadre('t_x', ctxBase({ partiendo: () => ({ id: 'o' }) }))));
    check('una madre con todas las hijas terminadas sí', R.motivoMadre('t_x', ctxBase({ hijasDe: () => [{ estado: 'ok' }] })) === null);
  });

  await group('C1-C5 — lanzar y cancelar confirman, devolver y reintentar no', () => {
    const d = (desde, hasta) => R.decidirSoltar(desde, hasta, 'a', 'b');
    check('soltar en En cola desde Por hacer pide confirmación (lanzar)', d('hacer', 'cola').tipo === 'confirmar' && d('hacer', 'cola').tr.accion === 'lanzar');
    check('soltar en Con error desde En cola o Trabajando pide confirmación (cancelar)', ['cola', 'curso'].every((x) => d(x, 'mal').tipo === 'confirmar' && d(x, 'mal').tr.accion === 'cancelar'));
    check('devolver y reintentar se ejecutan en el acto', d('mal', 'hacer').tipo === 'ejecutar' && d('mal', 'cola').tipo === 'ejecutar');
    check('dentro de Por hacer reordena con las vecinas', JSON.stringify(d('hacer', 'hacer')) === JSON.stringify({ tipo: 'mover', antes: 'a', despues: 'b' }));
    check('otra misma columna o un destino sin transición: nada', d('ok', 'ok').tipo === 'nada' && d('hacer', 'curso').tipo === 'nada');
    check('toda transición que confirma sale como «confirmar»', Object.entries(R.TRANSICIONES).every(([k, tr]) => d(...k.split('→')).tipo === (tr.confirmar ? 'confirmar' : 'ejecutar')));
  });

  await group('C6 — revalidar al confirmar', () => {
    const tr = R.TRANSICIONES['cola→mal'];
    const c = { t: tarjeta('en_cola'), tr, desde: 'cola' };
    check('sigue igual: se ejecuta', R.revalidar(c, tarjeta('en_cola'), ctxBase()) === null);
    check('ya no está: no', /ya no está/.test(R.revalidar(c, null, ctxBase())));
    check('arrancó mientras se confirmaba «Quitar de la cola»: avisa, no la cancela', /Ya arrancó/.test(R.revalidar(c, tarjeta('en_curso'), ctxBase())));
    check('terminó mientras se confirmaba: no', /cambió de columna/.test(R.revalidar(c, tarjeta('ok'), ctxBase())));
    // Auditoría r1 (MAJOR) — El menú confirma con el destino elegido, que guarda su origen: si la
    // tarjeta arrancó en el medio, el origen sigue siendo En cola y la cancelación no pasa.
    const elegido = R.destinosDe(tarjeta('en_cola'), ctxBase()).find((x) => x.accion === 'cancelar');
    check('el menú: elegir en cola y confirmar con la tarea ya trabajando avisa', /Ya arrancó/.test(R.revalidar({ t: tarjeta('en_curso'), tr: elegido, desde: elegido.desde }, tarjeta('en_curso'), ctxBase())));
    const vista = fs.readFileSync(path.join(UI, 'vista-tablero.js'), 'utf8');
    check('el botón de confirmar del menú usa el origen del destino elegido, no el de ahora', vista.includes('confirmarYEjecutar({ t, tr: d, desde: d.desde });')
      && !/confirmarYEjecutar\(\{[^}]*desde: columnaDeEstado\(t\.estado\)/.test(vista));
    const lanzar = { t: tarjeta('por_hacer'), tr: R.TRANSICIONES['hacer→cola'], desde: 'hacer' };
    check('ganó un motivo (le sacaron el sujeto): no se lanza', /Asignala/.test(R.revalidar(lanzar, tarjeta('por_hacer', { sujeto: null }), ctxBase())));
  });

  await group('O1 — el orden de Por hacer es el mismo en el cliente y en el servidor', async () => {
    const tareas = await import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'tareas.js')).href);
    const xs = [
      { id: 'a', posicion: 2, actualizada: '2026-10-01' }, { id: 'b', posicion: 1, actualizada: '2026-10-02' },
      { id: 'c', actualizada: '2026-10-05' }, { id: 'd', posicion: 2, actualizada: '2026-10-03' },
      { id: 'e', creada: '2026-10-04' }, { id: 'f', posicion: 0 }
    ];
    const orden = (fn) => [...xs].sort(fn).map((x) => x.id).join('');
    check('mismo resultado con empates y posicion ausente', orden(R.porPosicion) === orden(tareas.porPosicion), `${orden(R.porPosicion)} vs ${orden(tareas.porPosicion)}`);
    check('a igual posición, la más reciente primero', orden(R.porPosicion).indexOf('d') < orden(R.porPosicion).indexOf('a'));
  });

  await group('O3 — Subir, Bajar y Arriba de todo en los bordes', () => {
    const fallas = [];
    for (const n of [1, 2, 3, 5]) {
      const col = Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
      for (let i = 0; i < n; i++) {
        const m = Object.fromEntries(R.movidas(col, `t${i}`).map((x) => [x.texto, x]));
        const id = (k) => (k >= 0 && k < n ? `t${k}` : null);
        const esperado = {
          'Arriba de todo': { antes: null, despues: 't0', no: i === 0 },
          Subir: { antes: i >= 2 ? id(i - 2) : null, despues: id(i - 1), no: i === 0 },
          Bajar: { antes: id(i + 1), despues: id(i + 2), no: i === n - 1 }
        };
        for (const [k, v] of Object.entries(esperado)) {
          const o = m[k];
          if (!o || o.antes !== v.antes || o.despues !== v.despues || o.no !== v.no) fallas.push(`n=${n} i=${i} ${k}: ${JSON.stringify(o)}`);
        }
        // Lo que queda habilitado mueve exactamente un lugar: la tarjeta termina entre `antes` y `despues`.
        for (const [k, o] of Object.entries(m)) {
          if (o.no) continue;
          const resto = col.filter((x) => x.id !== `t${i}`).map((x) => x.id);
          const pos = o.antes === null ? 0 : resto.indexOf(o.antes) + 1;
          if (o.despues !== null && resto[pos] !== o.despues) fallas.push(`n=${n} i=${i} ${k}: vecinas no contiguas`);
          const nueva = pos;
          const objetivo = k === 'Arriba de todo' ? 0 : k === 'Subir' ? i - 1 : i + 1;
          if (nueva !== objetivo) fallas.push(`n=${n} i=${i} ${k}: queda en ${nueva}, se esperaba ${objetivo}`);
        }
      }
    }
    check('vecinas correctas y un solo paso, con n = 1, 2, 3 y 5', !fallas.length, fallas.join(' | '));
    check('una tarjeta que no está: sin movidas', R.movidas([{ id: 'x' }], 'y').length === 0);
  });

  report();
})();
