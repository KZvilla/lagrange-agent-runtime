/**
 * FEAT-129 §3 — Las sesiones no se copian: los handoffs de
 * `<cuenta>/session-summaries/` siguen siendo la fuente. Acá solo se listan los
 * de este proyecto leyendo el comienzo de cada archivo (frontmatter y primer
 * `#`), para que las vistas los enlacen.
 *
 * Entran los `.md` cuyo nombre empieza con una fecha válida de los últimos 60
 * días y cuyo `project:` es este proyecto (`rutas.esDelProyecto`: sin fallback
 * al cwd). Los demás se ignoran sin error.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { leerFrontmatter } = require('./conceptos.js');
const { esDelProyecto } = require('./rutas.js');

const DIAS = 60;
const BYTES_CABECERA = 8 * 1024;
const RE_NOMBRE = /^(\d{4}-\d{2}-\d{2})-.*\.md$/i;

/** Los primeros bytes del archivo: alcanza para el frontmatter y el título. */
function cabecera(ruta) {
  let fd;
  try {
    fd = fs.openSync(ruta, 'r');
    const buf = Buffer.alloc(BYTES_CABECERA);
    const n = fs.readSync(fd, buf, 0, BYTES_CABECERA, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function tituloDe(cuerpo) {
  const m = /^#\s+(.+)$/m.exec(cuerpo || '');
  return m ? m[1].trim() : null;
}

/**
 * `[{ ruta, fecha, titulo, cuenta, sessionId, fin }]`, lo más nuevo primero.
 * `cuentas`: `[{ cuenta, dir }]` con la carpeta de cada cuenta de Claude.
 */
function listarHandoffs({ cuentas, raiz, ahora = new Date(), dias = DIAS }) {
  const desde = ahora.getTime() - dias * 24 * 3600 * 1000;
  const salida = [];
  for (const { cuenta, dir } of cuentas || []) {
    const carpeta = path.join(dir, 'session-summaries');
    let nombres;
    try { nombres = fs.readdirSync(carpeta); } catch { continue; }
    for (const nombre of nombres) {
      const m = RE_NOMBRE.exec(nombre);
      if (!m) continue;
      const fecha = Date.parse(m[1]);
      if (Number.isNaN(fecha) || fecha < desde) continue;
      const ruta = path.join(carpeta, nombre);
      const { datos, cuerpo, tiene } = leerFrontmatter(cabecera(ruta));
      if (!tiene || !esDelProyecto(datos.project, raiz)) continue;
      const fin = typeof datos.end_time === 'string' && !Number.isNaN(Date.parse(datos.end_time)) ? datos.end_time : null;
      salida.push({
        ruta,
        fecha: m[1],
        titulo: tituloDe(cuerpo) || nombre.replace(/\.md$/i, ''),
        cuenta,
        sessionId: typeof datos.session_id === 'string' ? datos.session_id : null,
        fin
      });
    }
  }
  return salida.sort((a, b) => (b.fin || b.fecha).localeCompare(a.fin || a.fecha));
}

/** `file:///` de una ruta absoluta, con espacios escapados (OKF §6: un link roto no invalida). */
function enlaceArchivo(ruta) {
  const r = path.resolve(ruta).replace(/\\/g, '/');
  return `file:///${r.replace(/^\/+/, '')}`.replace(/ /g, '%20');
}

module.exports = { listarHandoffs, enlaceArchivo, DIAS };
