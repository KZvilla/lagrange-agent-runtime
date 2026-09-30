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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
