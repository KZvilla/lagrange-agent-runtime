#!/usr/bin/env node
/**
 * BE-079 — agy informa `usage` y `duration_seconds` acumulados de todo el hilo
 * (medido con agy 1.2.13: entrada 9.724 → 20.449 → 32.175 en tres turnos). El
 * almacén de uso suma solo lo que agregó cada turno.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { crearAlmacenUso } = require('../mcp-server/lib/uso-agy.js');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-079-'));
  try {
    const nuevo = (nombre) => crearAlmacenUso({ ruta: path.join(dir, `${nombre}.json`), ahora: () => new Date(2026, 8, 30, 12, 0), stderr: { write() {} } });
    const u = (inp, out) => ({ input_tokens: inp, output_tokens: out, total_tokens: inp + out });

    await group('tokens: se suma el delta del hilo, no el acumulado', () => {
      const a = nuevo('tokens');
      a.registrar('cast', null, null, 'hilo-1', 4, u(9724, 1));
      a.registrar('cast', null, null, 'hilo-1', 12, u(20449, 2));
      a.registrar('cast', null, null, 'hilo-1', 19, u(32175, 4));
      const d = a.leer();
      check('la entrada suma lo que informó el último turno, no 62.348', d.session.input_tokens === 32175, String(d.session.input_tokens));
      check('la salida también', d.session.output_tokens === 4, String(d.session.output_tokens));
      check('y el total del día', d.today.total_tokens === 32179, String(d.today.total_tokens));
      check('last_call es el turno', d.last_call.usage.input_tokens === 32175 - 20449, JSON.stringify(d.last_call.usage));
      check('la duración de agy (acumulada) también va en delta', d.session.total_duration_seconds === 19, String(d.session.total_duration_seconds));
    });

    await group('hilos distintos y casos borde', () => {
      const a = nuevo('borde');
      a.registrar('run', null, null, 'hilo-a', 5, u(1000, 10));
      a.registrar('run', null, null, 'hilo-b', 5, u(2000, 20));
      check('cada hilo cuenta entero su primer turno', a.leer().session.input_tokens === 3000);
      a.registrar('run', null, null, 'hilo-a', 2, u(500, 5));
      check('un acumulado que baja se toma como hilo nuevo (cuenta entero)', a.leer().session.input_tokens === 3500, String(a.leer().session.input_tokens));
      a.registrar('run', null, null, '', 1, u(700, 7));
      check('sin hilo, cuenta entero', a.leer().session.input_tokens === 4200);
    });

    await group('reloj de pared y otros motores no se descuentan', () => {
      const a = nuevo('pared');
      a.registrarLlamada({ tool: 'charla', conversationId: 'hilo-c', duracion: 3, usage: u(100, 1) });
      a.registrarLlamada({ tool: 'charla', conversationId: 'hilo-c', duracion: 4, usage: u(250, 2) });
      const d = a.leer();
      check('los tokens de agy igual van en delta', d.session.input_tokens === 250, String(d.session.input_tokens));
      check('la duración medida con reloj de pared se suma entera', d.session.total_duration_seconds === 7, String(d.session.total_duration_seconds));
      a.registrarLlamada({ tool: 'cast', motor: 'claude', conversationId: 'hilo-c', duracion: 1, usage: u(900, 9) });
      a.registrarLlamada({ tool: 'cast', motor: 'claude', conversationId: 'hilo-c', duracion: 1, usage: u(900, 9) });
      check('claude informa por turno: suma entero', a.leer().session.input_tokens === 250 + 1800, String(a.leer().session.input_tokens));
    });

    await group('el mapa de hilos tiene tope', () => {
      const a = nuevo('tope');
      for (let i = 0; i < 305; i++) a.registrar('run', null, null, `h${i}`, 1, u(1, 1));
      check('guarda a lo sumo 300 hilos', Object.keys(a.leer().uso_por_hilo).length === 300);
    });

    await group('FEAT-180: el modelo del hilo', () => {
      let t = Date.UTC(2026, 9, 24, 12, 0);
      const a = crearAlmacenUso({ ruta: path.join(dir, 'hilos.json'), ahora: () => new Date(t += 1000), stderr: { write() {} } });
      a.registrar('audit', 'gemini-3.8-flash', 'high', 'hilo-m', 5, u(100, 1));
      const h1 = a.leerHilo('hilo-m');
      check('registrarLlamada anota modelo, esfuerzo, tool y visto_en', h1.modelo === 'gemini-3.8-flash' && h1.esfuerzo === 'high' && h1.herramienta === 'audit' && h1.visto_en, JSON.stringify(h1));
      a.registrar('audit', null, null, 'hilo-m', 9, u(200, 2));
      const h2 = a.leerHilo('hilo-m');
      check('el turno 2 sin modelo conserva modelo, esfuerzo y tool', h2.modelo === 'gemini-3.8-flash' && h2.esfuerzo === 'high' && h2.herramienta === 'audit' && h2.visto_en > h1.visto_en, JSON.stringify(h2));
      check('y los contadores siguen en delta', a.leer().session.input_tokens === 200, String(a.leer().session.input_tokens));
      a.registrarHilo({ conversationId: 'hilo-sin-uso', modelo: 'claude-sonnet-5-5-medium', herramienta: 'run' });
      const d = a.leer();
      check('registrarHilo crea la entrada con contadores en 0', d.uso_por_hilo['hilo-sin-uso'].total === 0 && a.leerHilo('hilo-sin-uso').modelo === 'claude-sonnet-5-5-medium');
      check('y no cuenta como llamada', d.session.total_calls === 2, String(d.session.total_calls));
      a.registrarHilo({ conversationId: 'hilo-m', herramienta: 'review' });
      check('registrarHilo sobre un hilo existente no toca contadores ni el modelo', a.leer().uso_por_hilo['hilo-m'].inp === 200 && a.leerHilo('hilo-m').modelo === 'gemini-3.8-flash' && a.leerHilo('hilo-m').herramienta === 'review');
      check('un hilo que nadie registró: null', a.leerHilo('otro') === null);
    });

    await group('FEAT-179/180: reiniciar conserva hilos, ventanas, cuota y resoluciones', () => {
      const ruta = path.join(dir, 'reinicio.json');
      fs.writeFileSync(ruta, JSON.stringify({
        session: { total_calls: 7, calls_by_tool: {} }, today: { date: '2000-01-01', total_calls: 7 },
        uso_por_hilo: { h: { modelo: 'gemini-3.8-flash', total: 5 } },
        fallback: { cuotaPorGrupo: { gemini: { hasta: '2099-01-01T00:00:00.000Z' } } },
        cuota: { antigravity: { visto_en: '2026-10-24T00:00:00.000Z' } },
        resoluciones: { 'alma:alya': { alias: 'haiku' } }
      }));
      const a = nuevo('reinicio');
      a.reiniciar();
      const d = a.leer();
      check('session en cero', d.session.total_calls === 0);
      check('uso_por_hilo intacto', d.uso_por_hilo.h.modelo === 'gemini-3.8-flash');
      check('fallback intacto', d.fallback.cuotaPorGrupo.gemini.hasta === '2099-01-01T00:00:00.000Z');
      check('cuota y resoluciones intactas', d.cuota.antigravity.visto_en === '2026-10-24T00:00:00.000Z' && d.resoluciones['alma:alya'].alias === 'haiku');
    });

    await group('FEAT-180: el tope expulsa el visto hace más tiempo', () => {
      let t = Date.UTC(2026, 9, 24, 12, 0);
      const a = crearAlmacenUso({ ruta: path.join(dir, 'tope2.json'), ahora: () => new Date(t += 1000), stderr: { write() {} } });
      for (let i = 0; i < 300; i++) a.registrar('run', 'gemini-3.8-flash', null, `h${i}`, 1, u(1, 1));
      a.registrarHilo({ conversationId: 'h0', herramienta: 'run' });
      a.registrar('run', 'gemini-3.8-flash', null, 'nuevo', 1, u(1, 1));
      const hilos = a.leer().uso_por_hilo;
      check('h0 se usó hace poco: queda', 'h0' in hilos);
      check('h1 era el más viejo: sale', !('h1' in hilos) && Object.keys(hilos).length === 300);
    });

    await group('FEAT-179: LAGRANGE_USAGE_FILE redirige el archivo', () => {
      const { rutaUso } = require('../mcp-server/lib/uso-agy.js');
      const propio = path.join(dir, 'propio.json');
      check('con la variable, esa ruta', rutaUso({ LAGRANGE_USAGE_FILE: propio, HOME: 'x' }) === path.resolve(propio));
      check('sin ella, HOME/.claude', rutaUso({ HOME: dir }) === path.join(dir, '.claude', 'antigravity-usage.json'));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
