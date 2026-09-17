/**
 * FEAT-060 — Motor de horarios.
 *
 * Es el pedazo donde un error no se ve: un horario mal calculado no avisa,
 * dispara (o no dispara) cuando no hay nadie mirando. Se prueba con fechas
 * fijas, nunca con el reloj de la máquina.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const MODULO = pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'horarios.js')).href;

// Hora local a propósito: es la que el usuario tiene en la cabeza al escribir
// «9 de la mañana», y es en la que trabaja el módulo.
const f = (y, mes, d, h = 0, min = 0) => new Date(y, mes - 1, d, h, min, 0, 0);
const iso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : String(d));

async function main() {
  const h = await import(MODULO);

  await group('formas relativas', () => {
    const enMedia = h.parsearHorario('en 30m');
    check('«en 30m» es de una sola vez', enMedia.ok && enMedia.horario.tipo === 'una_vez' && enMedia.horario.ms === 1800000);
    const cadaDos = h.parsearHorario('cada 2h');
    check('«cada 2h» es recurrente', cadaDos.ok && cadaDos.horario.tipo === 'cada' && cadaDos.horario.ms === 7200000);
    check('«CADA 1D» no depende de mayúsculas ni espacios', h.parsearHorario('  CADA  1D ').horario.ms === 86400000);
    check('menos de un minuto se rechaza', h.parsearHorario('cada 0m').ok === false);
    check('más de un año se rechaza', h.parsearHorario('cada 400d').ok === false);
    check('una unidad que no existe se rechaza', h.parsearHorario('cada 5s').ok === false);
    check('vacío se rechaza con ayuda', h.parsearHorario('').error.includes('cada 2h'));
  });

  await group('cron: lo que acepta y lo que no', () => {
    check('cinco campos válidos', h.parsearHorario('0 9 * * 1').ok);
    check('listas y rangos', h.parsearHorario('0,30 9-17 * * 1-5').ok);
    check('pasos', h.parsearHorario('*/15 * * * *').ok);
    check('cuatro campos no es cron', h.parsearHorario('0 9 * *').ok === false);
    check('un minuto fuera de rango se rechaza', h.parsearHorario('60 9 * * 1').ok === false);
    check('una hora fuera de rango se rechaza', h.parsearHorario('0 24 * * 1').ok === false);
    check('un día de semana fuera de rango se rechaza', h.parsearHorario('0 9 * * 7').ok === false);
    check('un rango invertido se rechaza', h.parsearHorario('0 17-9 * * *').ok === false);
    check('un paso de cero se rechaza', h.parsearHorario('*/0 * * * *').ok === false);
    check('basura se rechaza', h.parsearHorario('0 9 * * lunes').ok === false);
    // El 30 de febrero no existe: el parser tiene que decirlo al crearlo, no
    // callarse y no disparar nunca.
    check('un cron imposible se rechaza al escribirlo', h.parsearHorario('0 9 30 2 *').ok === false);
    check('y explica que no cae nunca', h.parsearHorario('0 9 30 2 *').error.includes('año'));
  });

  await group('próximo disparo: intervalos', () => {
    const cada2h = h.parsearHorario('cada 2h').horario;
    const base = f(2026, 9, 17, 10, 0);
    check('desde la base, dos horas después', iso(h.proximaDesde(cada2h, base, base)) === '2026-09-17 12:00');

    // El daemon estuvo apagado ocho horas: se dispara UNA vez, no ocho.
    const despuesDeSiesta = h.proximaDesde(cada2h, f(2026, 9, 17, 18, 30), base);
    check('tras una caída larga, salta al siguiente futuro', iso(despuesDeSiesta) === '2026-09-17 20:00', iso(despuesDeSiesta));
    check('y siempre es estrictamente posterior', despuesDeSiesta > f(2026, 9, 17, 18, 30));

    // Justo en el borde: la próxima no puede ser «ahora».
    check('en el instante exacto avanza', iso(h.proximaDesde(cada2h, f(2026, 9, 17, 12, 0), base)) === '2026-09-17 14:00');

    const unaVez = h.parsearHorario('en 30m').horario;
    check('una cita única futura', iso(h.proximaDesde(unaVez, base, base)) === '2026-09-17 10:30');
    check('una cita única ya pasada no vuelve', h.proximaDesde(unaVez, f(2026, 9, 17, 11, 0), base) === null);
  });

  await group('próximo disparo: cron', () => {
    const lunes9 = h.parsearHorario('0 9 * * 1').horario;
    // 2026-09-17 es jueves; el lunes siguiente es el 21.
    check('el próximo lunes a las 9', iso(h.proximaDesde(lunes9, f(2026, 9, 17, 10, 0))) === '2026-09-21 09:00');
    check('un lunes a las 8 es ese mismo día', iso(h.proximaDesde(lunes9, f(2026, 9, 21, 8, 0))) === '2026-09-21 09:00');
    check('un lunes a las 9 en punto salta a la semana siguiente', iso(h.proximaDesde(lunes9, f(2026, 9, 21, 9, 0))) === '2026-09-28 09:00');

    const cadaCuarto = h.parsearHorario('*/15 * * * *').horario;
    check('cada cuarto de hora', iso(h.proximaDesde(cadaCuarto, f(2026, 9, 17, 10, 7))) === '2026-09-17 10:15');
    check('en el borde avanza al siguiente', iso(h.proximaDesde(cadaCuarto, f(2026, 9, 17, 10, 15))) === '2026-09-17 10:30');
    check('cruza la hora', iso(h.proximaDesde(cadaCuarto, f(2026, 9, 17, 10, 47))) === '2026-09-17 11:00');

    const finDeMes = h.parsearHorario('0 0 1 * *').horario;
    check('cruza el mes', iso(h.proximaDesde(finDeMes, f(2026, 9, 17, 10, 0))) === '2026-10-01 00:00');
    const anio = h.parsearHorario('0 0 1 1 *').horario;
    check('cruza el año', iso(h.proximaDesde(anio, f(2026, 9, 17, 10, 0))) === '2027-01-01 00:00');

    // Regla clásica: con día del mes Y día de semana restringidos, alcanza uno.
    const oR = h.parsearHorario('0 9 13 * 5').horario;
    check('día del mes o día de semana', iso(h.proximaDesde(oR, f(2026, 9, 17, 10, 0))) === '2026-09-18 09:00');

    check('con una fecha inválida devuelve null', h.proximaDesde(lunes9, new Date('x')) === null);
    check('sin horario devuelve null', h.proximaDesde(null, f(2026, 9, 17)) === null);
    check('un tipo desconocido devuelve null', h.proximaDesde({ tipo: 'magia' }, f(2026, 9, 17)) === null);
  });

  await group('disparos perdidos: se cuentan, no se recuperan', () => {
    const cada2h = h.parsearHorario('cada 2h').horario;
    check('al día no hay perdidos', h.saltados(cada2h, f(2026, 9, 17, 12, 0), f(2026, 9, 17, 12, 0)) === 0);
    check('ocho horas tarde son cuatro perdidos', h.saltados(cada2h, f(2026, 9, 17, 12, 0), f(2026, 9, 17, 20, 0)) === 4);
    check('un rato tarde no cuenta ninguno', h.saltados(cada2h, f(2026, 9, 17, 12, 0), f(2026, 9, 17, 13, 0)) === 0);
    check('una cita única no cuenta perdidos', h.saltados(h.parsearHorario('en 30m').horario, f(2026, 9, 17, 12, 0), f(2026, 9, 18)) === 0);
  });

  await group('cómo se describe', () => {
    check('intervalo', h.describirHorario(h.parsearHorario('cada 2h').horario) === 'cada 2h');
    check('una vez', h.describirHorario(h.parsearHorario('en 30m').horario).startsWith('una vez'));
    check('cron', h.describirHorario(h.parsearHorario('0 9 * * 1').horario) === 'cron 0 9 * * 1');
    check('sin horario no rompe', h.describirHorario(null) === 'sin horario');
  });

  report();
}

main();
