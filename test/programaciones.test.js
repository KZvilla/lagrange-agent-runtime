/**
 * FEAT-060 — Registro de programaciones.
 *
 * Lo que se prueba es la contención: que el modelo quede congelado, que los
 * topes de gasto frenen, que los disparos perdidos se cuenten sin recuperarse y
 * que una programación que falla siempre se pause sola en vez de seguir
 * gastando a las 3 de la mañana.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-'));
  process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');

  const prog = await import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'programaciones.js')).href);

  const alma = { tipo: 'alma', clave: 'priscilla', voz: 'Priscilla' };
  const agente = { tipo: 'agente', nombre: 'lagrange-architect' };
  const f = (y, mes, d, h = 0, min = 0) => new Date(y, mes - 1, d, h, min, 0, 0);
  const nueva = (extra = {}) => prog.crear({
    titulo: 'revisión', pedido: 'mirá el repo', sujeto: alma,
    horario: 'cada 2h', ahora: () => f(2026, 9, 17, 10, 0), ...extra
  });

  try {
    await group('alta: lo que se guarda y lo que se rechaza', () => {
      prog.reiniciarParaTests();
      const r = nueva({ modelo: 'gemini-3.8-flash', esfuerzo: 'high' });
      check('se crea', r.ok);
      check('el modelo queda congelado', r.programacion.modelo === 'gemini-3.8-flash');
      check('y el esfuerzo también', r.programacion.esfuerzo === 'high');
      check('la próxima sale del horario', r.programacion.proxima === f(2026, 9, 17, 12, 0).toISOString());
      check('nace activa', r.programacion.activa === true);
      check('con contadores en cero', r.programacion.disparos === 0 && r.programacion.perdidos === 0);

      check('sin pedido se rechaza', prog.crear({ sujeto: alma, horario: 'cada 2h' }).codigo === 400);
      check('sin sujeto se rechaza', nueva({ sujeto: null }).codigo === 400);
      check('el carril de trabajo no se programa', nueva({ sujeto: { tipo: 'trabajo' } }).codigo === 400);
      check('un horario inválido se rechaza', nueva({ horario: 'cuando quieras' }).codigo === 400);
      check('y el error se le puede mostrar al usuario', nueva({ horario: 'cuando quieras' }).error.includes('cada 2h'));

      const conAgente = nueva({ sujeto: agente, proyecto: 'repo', workspaceId: 'w1' });
      check('un agente conserva su proyecto', conAgente.programacion.proyecto === 'repo' && conAgente.programacion.workspaceId === 'w1');
      const almaConProyecto = nueva({ proyecto: 'repo', workspaceId: 'w1' });
      check('un alma no trabaja sobre un proyecto', almaConProyecto.programacion.proyecto === null);
    });

    await group('persiste entre cargas', () => {
      prog.reiniciarParaTests();
      const antes = prog.listar().length;
      check('lo creado sigue estando tras recargar', antes > 0);
      check('el archivo existe', fs.existsSync(prog.rutaProgramaciones()));
    });

    await group('vencidas y topes de gasto', () => {
      prog.reiniciarParaTests();
      for (const p of prog.listar()) prog.borrar(p.id);
      const { programacion } = nueva();

      check('antes de la hora no vence', prog.vencidas(f(2026, 9, 17, 11, 0)).length === 0);
      check('a la hora vence', prog.vencidas(f(2026, 9, 17, 12, 0)).length === 1);
      check('después también', prog.vencidas(f(2026, 9, 17, 23, 0)).length === 1);
      check('puede disparar', prog.puedeDisparar(programacion.id, f(2026, 9, 17, 12, 0)).ok);

      // Se agota el cupo diario.
      for (let i = 0; i < prog.TOPE_DISPAROS_DIA; i++) {
        prog.marcarDisparo(programacion.id, { ahora: () => f(2026, 9, 17, 12, 0) });
      }
      const frenada = prog.puedeDisparar(programacion.id, f(2026, 9, 17, 12, 0));
      check('con el cupo del día agotado no dispara', frenada.ok === false);
      check('y dice por qué', frenada.motivo.includes(String(prog.TOPE_DISPAROS_DIA)));
      check('al día siguiente vuelve', prog.puedeDisparar(programacion.id, f(2026, 9, 18, 12, 0)).ok);

      check('una pausada no vence', (prog.activar(programacion.id, false), prog.vencidas(f(2026, 9, 18)).length) === 0);
      check('y no puede disparar', prog.puedeDisparar(programacion.id, f(2026, 9, 18)).ok === false);
      check('una que no existe tampoco', prog.puedeDisparar('p_nada').ok === false);
    });

    await group('disparos perdidos: se cuentan, no se recuperan', () => {
      prog.reiniciarParaTests();
      for (const p of prog.listar()) prog.borrar(p.id);
      const { programacion } = nueva();

      // El daemon estuvo apagado ocho horas. Prevista a las 12, vuelve a las 20.
      const despues = prog.marcarDisparo(programacion.id, { ahora: () => f(2026, 9, 17, 20, 0) });
      check('dispara UNA vez', despues.disparos === 1);
      check('cuenta los que se perdieron', despues.perdidos === 4, String(despues.perdidos));
      check('la próxima es futura', new Date(despues.proxima) > f(2026, 9, 17, 20, 0), despues.proxima);
      check('y sigue anclada a la base, no al disparo', new Date(despues.proxima).getMinutes() === 0);
    });

    await group('una sola vez se desactiva al disparar', () => {
      prog.reiniciarParaTests();
      for (const p of prog.listar()) prog.borrar(p.id);
      const { programacion } = nueva({ horario: 'en 30m' });
      check('la próxima es media hora después', programacion.proxima === f(2026, 9, 17, 10, 30).toISOString());
      const despues = prog.marcarDisparo(programacion.id, { ahora: () => f(2026, 9, 17, 10, 30) });
      check('queda inactiva', despues.activa === false);
      check('sin próxima', despues.proxima === null);
      check('pero no se borra: el usuario ve que pasó', prog.obtener(programacion.id) !== null);
    });

    await group('se pausa sola tras fallar seguido', () => {
      prog.reiniciarParaTests();
      for (const p of prog.listar()) prog.borrar(p.id);
      const { programacion } = nueva();

      // El disparo solo dice que SALIÓ; cómo terminó lo dice marcarResultado.
      let ultima;
      for (let i = 0; i < prog.TOPE_FALLOS; i++) {
        prog.marcarDisparo(programacion.id, { ahora: () => f(2026, 9, 17, 12 + i, 0) });
        ultima = prog.marcarResultado(programacion.id, { ok: false, detalle: 'el alma no existe' });
      }
      check('se pausó sola', ultima.activa === false);
      check('y deja dicho por qué', ultima.ultimoDetalle.includes('fallos seguidos'));
      check('sin próxima, para que no vuelva sola', ultima.proxima === null);

      // Un éxito en el medio reinicia la cuenta.
      prog.activar(programacion.id, true, { ahora: () => f(2026, 9, 18, 10, 0) });
      prog.marcarResultado(programacion.id, { ok: false });
      const buena = prog.marcarResultado(programacion.id, { ok: true });
      check('un éxito limpia la cuenta de fallos', buena.fallosSeguidos === 0);
      check('y sigue activa', buena.activa === true);
      check('marcarResultado de lo que no existe no rompe', prog.marcarResultado('p_nada', { ok: false }) === null);
    });

    await group('posponer: un tope no gasta cupo ni mata una cita única', () => {
      prog.reiniciarParaTests();
      for (const p of prog.listar()) prog.borrar(p.id);

      const rec = nueva().programacion;
      const antes = prog.obtener(rec.id);
      const pospuesta = prog.posponer(rec.id, { ahora: () => f(2026, 9, 17, 12, 0), motivo: 'tope diario' });
      check('no cuenta como disparo', pospuesta.disparos === antes.disparos);
      check('no gasta cupo del día', (pospuesta.disparosHoy || 0) === (antes.disparosHoy || 0));
      check('sigue activa', pospuesta.activa === true);
      check('deja dicho por qué se saltó', pospuesta.ultimoDetalle.includes('tope diario'));
      check('y corre la próxima hacia adelante', new Date(pospuesta.proxima) > f(2026, 9, 17, 12, 0));

      // El caso que importa: una cita única a la que un tope le negó el turno
      // NO puede destruirse sin haber corrido nunca.
      const unica = nueva({ horario: 'en 30m' }).programacion;
      const despues = prog.posponer(unica.id, { ahora: () => f(2026, 9, 17, 10, 30), motivo: 'tope' });
      check('una cita única sobrevive al tope', despues.activa === true);
      check('y conserva una próxima', despues.proxima !== null);
      check('que es futura', new Date(despues.proxima) > f(2026, 9, 17, 10, 30));
      check('posponer lo que no existe no rompe', prog.posponer('p_nada') === null);
    });

    await group('borrar y describir', () => {
      prog.reiniciarParaTests();
      for (const p of prog.listar()) prog.borrar(p.id);
      const { programacion } = nueva();
      check('describe en una línea', prog.describir(programacion).includes('cada 2h') && prog.describir(programacion).includes('priscilla'));
      // Con el locale del sistema (es-AR) salía «11:02:50» sin a. m./p. m. para
      // una cita de las 23:02: la de la noche se leía como de la mañana.
      const noche = prog.describir({ ...programacion, proxima: f(2026, 9, 17, 23, 2).toISOString() });
      check('la hora sale en 24 h', noche.includes('23:02') && !noche.includes('11:02'), noche);
      check('borra', prog.borrar(programacion.id).ok);
      check('y ya no está', prog.obtener(programacion.id) === null);
      check('borrar lo que no existe da 404', prog.borrar('p_nada').codigo === 404);
      check('activar lo que no existe da 404', prog.activar('p_nada', true).codigo === 404);
    });

    await group('tope de programaciones', () => {
      prog.reiniciarParaTests();
      for (const p of prog.listar()) prog.borrar(p.id);
      for (let i = 0; i < prog.TOPE_PROGRAMACIONES; i++) nueva({ titulo: `p${i}` });
      const r = nueva({ titulo: 'una más' });
      check('con el tope lleno se rechaza', r.codigo === 409);
      check('y dice cuántas hay', r.error.includes(String(prog.TOPE_PROGRAMACIONES)));
    });
  } finally {
    borrar(raiz);
  }

  report();
}

main();
