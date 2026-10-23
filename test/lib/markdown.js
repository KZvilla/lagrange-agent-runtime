'use strict';

const { slug } = require('./slug');

// Un archivo Markdown se lee siempre igual: sin CR y con las líneas separadas.
function normalizar(texto) {
  return String(texto).replace(/\r\n/g, '\n');
}

function lineas(texto) {
  return normalizar(texto).split('\n');
}

// Las líneas de una sección: desde el encabezado que cumple `inicio` hasta el
// próximo encabezado de nivel igual o mayor.
function seccion(lineasDelArchivo, inicio) {
  const i = lineasDelArchivo.findIndex((l) => /^#{2,4} /.test(l) && inicio.test(l));
  if (i < 0) return null;
  const nivel = lineasDelArchivo[i].match(/^#+/)[0].length;
  const fin = lineasDelArchivo.findIndex(
    (l, j) => j > i && new RegExp(`^#{1,${nivel}} `).test(l)
  );
  return lineasDelArchivo.slice(i + 1, fin < 0 ? undefined : fin);
}

// Encabezados fuera de bloques de código, con su ancla de GitHub.
function encabezados(lineasDelArchivo) {
  const salida = [];
  let enBloque = false;
  for (let i = 0; i < lineasDelArchivo.length; i += 1) {
    const l = lineasDelArchivo[i];
    if (/^```/.test(l)) {
      enBloque = !enBloque;
      continue;
    }
    if (enBloque) continue;
    const m = l.match(/^(#{1,6}) (.+)$/);
    if (!m) continue;
    salida.push({
      linea: i + 1,
      nivel: m[1].length,
      texto: m[2],
      slug: slug(m[2].replace(/`/g, ''))
    });
  }
  return salida;
}

// Enlaces markdown con su línea, sin las imágenes ni los bloques de código.
function enlaces(lineasDelArchivo) {
  const salida = [];
  let enBloque = false;
  for (let i = 0; i < lineasDelArchivo.length; i += 1) {
    const l = lineasDelArchivo[i];
    if (/^```/.test(l)) {
      enBloque = !enBloque;
      continue;
    }
    if (enBloque) continue;
    for (const m of l.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
      salida.push({ linea: i + 1, destino: m[1].trim(), texto: m[0] });
    }
  }
  return salida;
}

module.exports = { normalizar, lineas, seccion, encabezados, enlaces };
