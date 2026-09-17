/**
 * FEAT-064 — El barrido.
 *
 * Lo que importa probar acá no es que encuentre cosas, sino que **no haga
 * nada**: informa y no borra. Y que la regla de umbral no lo dispare en una
 * instalación nueva, donde un informe vacío solo enseña a ignorar los informes.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const MODULO = pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'barrido.js')).href;
const DIA = 24 * 60 * 60 * 1000;

async function main() {
  const b = await import(MODULO);
  const ahora = new Date('2026-09-17T12:00:00.000Z');
  const haceDias = (n) => new Date(ahora.getTime() - n * DIA).toISOString();

  await group('cuándo corre', () => {
    check('nunca corrió y el sistema es nuevo → no corre',
      b.deberiaCorrer({ ultimo: null, primeraVez: haceDias(1), ahora }) === false);
    check('nunca corrió pero el sistema tiene historia → corre',
      b.deberiaCorrer({ ultimo: null, primeraVez: haceDias(30), ahora }) === true);
    check('corrió ayer → no corre', b.deberiaCorrer({ ultimo: haceDias(1), ahora }) === false);
    check('corrió hace 8 días → corre', b.deberiaCorrer({ ultimo: haceDias(8), ahora }) === true);
    check('justo en el umbral → corre', b.deberiaCorrer({ ultimo: haceDias(7), ahora }) === true);
    check('sin nada de contexto → no corre', b.deberiaCorrer({ ahora }) === false);
    check('con una fecha rota de último barrido → corre igual', b.deberiaCorrer({ ultimo: 'ayer', ahora }) === true);
    check('con un ahora inválido → no corre', b.deberiaCorrer({ ultimo: haceDias(30), ahora: 'nunca' }) === false);
  });

  await group('etapas deterministas, sin modelo', () => {
    const tareas = [
      { id: 't1', estado: 'por_hacer', titulo: 'reciente', actualizada: haceDias(3) },
      { id: 't2', estado: 'por_hacer', titulo: 'rancia', actualizada: haceDias(20) },
      { id: 't3', estado: 'por_hacer', titulo: 'vieja', actualizada: haceDias(45) },
      { id: 't4', estado: 'ok', titulo: 'terminada hace mucho', actualizada: haceDias(90) }
    ];
    const r = b.analizar({ tareas }, ahora);
    const ids = r.hallazgos.porHacer.map((x) => x.id);
    check('lo reciente no se toca', !ids.includes('t1'));
    check('lo de 20 días aparece', ids.includes('t2'));
    check('lo de 45 días también', ids.includes('t3'));
    check('una tarea cerrada no es asunto del barrido', !ids.includes('t4'));
    check('etiqueta rancio a los 20 días', r.hallazgos.porHacer.find((x) => x.id === 't2').etapa === 'rancio');
    check('etiqueta archivable a los 45', r.hallazgos.porHacer.find((x) => x.id === 't3').etapa === 'archivable');
    check('cuenta los días', r.hallazgos.porHacer.find((x) => x.id === 't3').dias === 45);
  });

  await group('una propuesta no es lo mismo que una tarjeta tuya', () => {
    const tareas = [
      { id: 'p1', estado: 'por_hacer', titulo: 'la propuso un alma', actualizada: haceDias(20), propuesta: true, creadaPor: 'alma:alya' },
      { id: 'm1', estado: 'por_hacer', titulo: 'la escribí yo', actualizada: haceDias(20), propuesta: false }
    ];
    const r = b.analizar({ tareas }, ahora);
    check('la propuesta va aparte', r.hallazgos.propuestas.map((x) => x.id).join() === 'p1');
    check('y dice quién la propuso', r.hallazgos.propuestas[0].autor === 'alma:alya');
    check('la tuya va en Por hacer', r.hallazgos.porHacer.map((x) => x.id).join() === 'm1');
  });

  await group('el barrido no se reporta a sí mismo', () => {
    const tareas = [
      { id: 'b1', estado: 'por_hacer', titulo: `${b.PREFIJO_TARJETA} 3 agente(s) sin usar`, actualizada: haceDias(40) },
      { id: 'otra', estado: 'por_hacer', titulo: 'algo mío', actualizada: haceDias(40) }
    ];
    const r = b.analizar({ tareas }, ahora);
    check('su propia tarjeta no es un hallazgo', !r.hallazgos.porHacer.some((x) => x.id === 'b1'));
    check('pero las demás sí', r.hallazgos.porHacer.map((x) => x.id).join() === 'otra');
  });

  await group('almas y agentes', () => {
    const r = b.analizar({
      almas: [
        { clave: 'alya', ultimaActividad: haceDias(2) },
        { clave: 'priscilla', ultimaActividad: haceDias(40), recuerdos: 12 }
      ],
      agentes: [
        { nombre: 'usado', ultimoCast: haceDias(1), casts: 9 },
        { nombre: 'olvidado', ultimoCast: haceDias(60), casts: 3 },
        { nombre: 'nunca', ultimoCast: null, casts: 0 }
      ]
    }, ahora);
    check('un alma activa no aparece', !r.hallazgos.almas.some((x) => x.clave === 'alya'));
    check('una sin actividad sí', r.hallazgos.almas.some((x) => x.clave === 'priscilla'));
    check('con sus recuerdos', r.hallazgos.almas[0].recuerdos === 12);
    check('un agente usado no aparece', !r.hallazgos.agentes.some((x) => x.nombre === 'usado'));
    check('uno olvidado sí', r.hallazgos.agentes.some((x) => x.nombre === 'olvidado'));
    check('y uno que nunca se usó también', r.hallazgos.agentes.find((x) => x.nombre === 'nunca').etapa === 'sin usar');
  });

  await group('los worktrees se listan, no se prometen limpiar', () => {
    const r = b.analizar({
      worktrees: [{ ruta: '/w/agy-lote-a', rama: 'agy/lote-a', motivo: '3 commit(s) sin mergear hacia main' }]
    }, ahora);
    check('aparece', r.hallazgos.worktrees.length === 1);
    check('con su motivo', r.hallazgos.worktrees[0].motivo.includes('sin mergear'));
    const texto = b.informe(r);
    check('el informe dice que NO se pueden borrar solos', texto.includes('se niega a borrarlos'));
    check('y que hay que hacerlo a mano', texto.includes('a mano'));
  });

  await group('el informe', () => {
    const vacio = b.analizar({}, ahora);
    check('sin nada, el total es cero', vacio.total === 0);
    check('y el informe lo dice sin alarmar', b.informe(vacio).includes('Nada que reportar'));
    check('el resumen corto también', b.resumenCorto(vacio) === 'nada acumulándose');

    const lleno = b.analizar({
      tareas: [
        { id: 't2', estado: 'por_hacer', titulo: 'rancia', actualizada: haceDias(20) },
        { id: 'p1', estado: 'por_hacer', titulo: 'propuesta', actualizada: haceDias(20), propuesta: true, creadaPor: 'alma:alya' }
      ],
      almas: [{ clave: 'priscilla', ultimaActividad: haceDias(40) }],
      agentes: [{ nombre: 'nunca', ultimoCast: null }],
      worktrees: [{ ruta: '/w/x', motivo: 'sin integrar' }]
    }, ahora);
    check('cuenta todo junto', lleno.total === 5);
    const texto = b.informe(lleno);
    check('deja claro que no borró nada', texto.includes('Nada de esto se borró'));
    check('nombra cada sección', ['Por hacer', 'Propuestas', 'Almas', 'Agentes', 'Worktrees'].every((s) => texto.includes(s)));
    check('el resumen corto enumera', b.resumenCorto(lleno).includes('1 tarjeta(s) sin lanzar') && b.resumenCorto(lleno).includes('1 alma(s)'));
  });

  await group('entradas raras no rompen', () => {
    const r = b.analizar({
      tareas: [{ id: 'x', estado: 'por_hacer', actualizada: 'no es fecha' }],
      almas: [{ clave: 'sinfecha', ultimaActividad: null }]
    }, ahora);
    check('una fecha ilegible se ignora en vez de romper', r.total === 0);
    check('sin inventario tampoco rompe', b.analizar(undefined, ahora).total === 0);
    check('el informe de algo raro sigue siendo texto', typeof b.informe(r) === 'string');
  });

  report();
}

main();
