/**
 * FEAT-201 F0 S1 — El contrato v2 (`telegram-bridge/web/contrato-v2.json`) y su
 * validador propio (`telegram-bridge/web/v2/esquema.js`).
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);

const TURNO = {
  tareaId: 't-abc', estado: 'ok', origen: 'terminal', sujeto: { tipo: 'alma', id: 'alya' },
  pedido: 'hola', resultado: 'buen día', resultadoTruncado: false, adjunto: false,
  idCliente: '0c1d8b1e-4b8a-4a2f-9a0e-1f2e3d4c5b6a', creada: '2026-11-17T09:00:00.000Z',
  iniciada: '2026-11-17T09:00:01.000Z', terminada: '2026-11-17T09:00:06.000Z'
};

async function main() {
  const esq = await importar('telegram-bridge/web/v2/esquema.js');
  const tareas = await importar('telegram-bridge/tareas.js');

  let contrato = null;
  await group('S1 · el contrato carga y es coherente', () => {
    let error = null;
    try { contrato = esq.cargarContrato(); } catch (err) { error = err; }
    check('contrato-v2.json carga sin problemas', contrato && !error, error && error.message);
    check('versión 2.x', contrato && /^2\.\d+$/.test(contrato.version));
    const tipos = contrato.agregados.evento.properties.tipo.enum;
    check('cada tipo de evento tiene su esquema de datos', tipos.every((t) => contrato.eventos[t]));
    check('turno.en_curso existe (F0, refinamiento 1)', tipos.includes('turno.en_curso'));
  });

  await group('S1 · el esquema sigue al registro de tareas', () => {
    const turno = contrato.agregados.turno.properties;
    check('los estados del turno son los del registro (tareas.js ESTADOS)',
      JSON.stringify([...turno.estado.enum].sort()) === JSON.stringify([...tareas.ESTADOS].sort()),
      `${turno.estado.enum} vs ${tareas.ESTADOS}`);
    check('resultado.maxLength = TOPE_TEXTO (v2 quita el sufijo de recorte)', turno.resultado.maxLength === tareas.TOPE_TEXTO);
    check('pedido.maxLength = TOPE_TEXTO', turno.pedido.maxLength === tareas.TOPE_TEXTO);
    check('origen admite terminal', turno.origen.enum.includes('terminal'));
    check('tid, idCliente y reintentoDe son opcionales', !contrato.agregados.turno.required.some((k) => ['tid', 'idCliente', 'reintentoDe'].includes(k)));
  });

  await group('S1 · el validador', () => {
    check('un turno válido pasa', esq.validar(contrato, 'turno', TURNO).length === 0, esq.validar(contrato, 'turno', TURNO).join('; '));
    check('un evento turno.fin válido pasa ($ref)', esq.validar(contrato, 'evento:turno.fin', TURNO).length === 0);
    const sinCampo = { ...TURNO }; delete sinCampo.estado;
    check('required: falta estado', esq.validar(contrato, 'turno', sinCampo).some((e) => e.includes('estado: falta')));
    check('additionalProperties: false', esq.validar(contrato, 'turno', { ...TURNO, extra: 1 }).some((e) => e.includes('campo no permitido')));
    check('enum', esq.validar(contrato, 'turno', { ...TURNO, origen: 'fax' }).some((e) => e.includes('fuera de la lista')));
    check('type', esq.validar(contrato, 'turno', { ...TURNO, adjunto: 'no' }).some((e) => e.includes('se esperaba boolean')));
    check('maxLength', esq.validar(contrato, 'turno', { ...TURNO, resultado: 'x'.repeat(tareas.TOPE_TEXTO + 1) }).some((e) => e.includes('más largo')));
    check('resultado al tope exacto pasa', esq.validar(contrato, 'turno', { ...TURNO, resultado: 'x'.repeat(tareas.TOPE_TEXTO) }).length === 0);
    check('nullable', esq.validar(contrato, 'turno', { ...TURNO, resultado: null }).length === 0);
    check('null sin nullable falla', esq.validar(contrato, 'turno', { ...TURNO, pedido: null }).length > 0);
    check('minimum y maximum', esq.validar(contrato, 'error', { ok: false, error: 'x', codigo: 200 }).some((e) => e.includes('menor que 400')));
    check('integer: 1.5 no es entero', esq.validar(contrato, 'carril', { carril: 'alma', enCurso: null, enCola: 1.5 }).length > 0);
    check('number acepta un entero', esq.validar(contrato, 'salud', {
      pid: 4, arranque: 'u', arribaSegundos: 3, memoria: { rss: 1, heapUsed: 1 }, eventLoop: { utilizacion: 1, muestras: 2 }
    }).length === 0);
    check('items: un elemento malo en la lista', esq.validar(contrato, 'evento:carriles', { carriles: [{ carril: 'alma' }] }).length > 0);
    check('un nombre que no existe', esq.validar(contrato, 'nada', {}).length === 1);
  });

  await group('S1 · cargar rechaza lo que el validador no implementa', () => {
    const base = () => JSON.parse(JSON.stringify(contrato));
    const falla = (c, texto) => { try { esq.revisarContrato(c); return false; } catch (err) { return err.message.includes(texto); } };
    const c1 = base(); c1.agregados.turno.properties.pedido.pattern = '^x';
    check('pattern no implementado → rechazado', falla(c1, 'palabra clave no implementada «pattern»'));
    const c2 = base(); c2.agregados.turno.oneOf = [];
    check('oneOf no implementado → rechazado', falla(c2, '«oneOf»'));
    const c3 = base(); c3.eventos['turno.fin'] = { $ref: '#/agregados/nada' };
    check('$ref roto → rechazado', falla(c3, '$ref roto'));
    const c4 = base(); c4.agregados.turno.required.push('fantasma');
    check('required sin propiedad → rechazado', falla(c4, '«fantasma» es obligatorio'));
    const c5 = base(); c5.agregados.evento.properties.tipo.enum.push('turno.nuevo');
    check('tipo de evento sin esquema → rechazado', falla(c5, 'falta el esquema de «turno.nuevo»'));
    const c6 = base(); c6.version = '3.0';
    check('versión fuera de 2.x → rechazada', falla(c6, 'version'));
    const c7 = base(); c7.agregados.turno.additionalProperties = {};
    check('additionalProperties como esquema → rechazado', falla(c7, 'solo se implementa como booleano'));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
