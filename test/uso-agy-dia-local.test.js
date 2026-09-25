#!/usr/bin/env node
/**
 * FEAT-084 §2 — «Hoy» del uso es el día local, no el UTC. Todas las fechas se
 * arman con el constructor local, así el test da lo mismo en cualquier huso
 * (correrlo con TZ=UTC y con TZ=America/Argentina/Buenos_Aires).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { crearAlmacenUso, resumenUso, diaLocal } = require('../mcp-server/lib/uso-agy.js');

async function main() {
  await group('diaLocal', () => {
    check('23:30 locales siguen siendo ese día', diaLocal(new Date(2026, 8, 24, 23, 30)) === '2026-09-24');
    check('00:05 locales ya son el día siguiente', diaLocal(new Date(2026, 8, 25, 0, 5)) === '2026-09-25');
    check('rellena mes y día con cero', diaLocal(new Date(2026, 0, 3, 12, 0)) === '2026-01-03');
  });

  await group('el almacén y el resumen usan el mismo día local', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uso-dia-local-'));
    try {
      const ruta = path.join(dir, 'uso.json');
      const noche = new Date(2026, 8, 24, 22, 30);
      const almacen = crearAlmacenUso({ ruta, ahora: () => noche, stderr: { write() {} } });
      almacen.registrarLlamada({ tool: 'run', duracion: 1, usage: { total_tokens: 10 } });
      const d = almacen.leer();
      check('la llamada suma a today con la fecha local', d.today.date === '2026-09-24' && d.today.total_calls === 1, JSON.stringify(d.today));
      const r = resumenUso({ ruta, ahora: noche });
      check('resumenUso la cuenta como de hoy', r.hoy.llamadas === 1, JSON.stringify(r.hoy));
      const pasadaMedianoche = resumenUso({ ruta, ahora: new Date(2026, 8, 25, 0, 5) });
      check('pasada la medianoche local, hoy da 0', pasadaMedianoche.hoy.llamadas === 0, JSON.stringify(pasadaMedianoche.hoy));

      // Transición: un archivo que quedó con la fecha UTC de mañana se reinicia una vez.
      const escrito = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      escrito.today.date = '2026-09-25';
      fs.writeFileSync(ruta, JSON.stringify(escrito));
      check('un today con otra fecha se lee como cero', almacen.leer().today.total_calls === 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
