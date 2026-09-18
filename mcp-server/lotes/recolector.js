/**
 * Recolector de restos de lotes (FEAT-061 fase 2, §4.6 del plan).
 *
 * QUÉ PODA, Y QUÉ NO TOCA NUNCA
 * -----------------------------
 * Poda contenedores, redes y volúmenes ETIQUETADOS `lagrange.lote` cuyo lote ya
 * no está corriendo, o cuya etiqueta `lagrange.expira` quedó en el pasado.
 * También borra las copias planas en disco de lotes que no corren.
 *
 * NO toca worktrees ni ramas, y no llama a git ni una vez. Ese límite no es
 * estético: el trabajo del agente vive en una rama, y un recolector que pueda
 * borrar ramas es un recolector que puede borrar el trabajo que el humano
 * todavía no revisó. Limpiar ramas es `descartar`, que lo escribe una persona
 * (§4.7) — acá se limpia infraestructura, no resultados.
 */
const fs = require('node:fs');
const path = require('node:path');
const { argvListarPorEtiqueta, argvRmForzado, argvBorrarRed, argvBorrarVolumen } = require('./docker.js');

function parsearFilas(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [nombre, lote, expira] = l.split('\t');
      return { nombre, lote: lote || '', expira: Number(expira || 0) };
    })
    .filter(f => f.nombre);
}

/**
 * @param {Function} docker          El `docker(args)` de docker.js.
 * @param {Function} lotesCorriendo  Devuelve el Set de ids de lotes en `corriendo`.
 * @param {string}   raizCopias      `%LOCALAPPDATA%\lagrange\lotes`.
 */
async function recolectar({ docker, lotesCorriendo, raizCopias, ahora = () => Date.now() }) {
  const vivos = new Set(lotesCorriendo || []);
  const podados = { contenedores: [], redes: [], volumenes: [], copias: [] };

  const vencido = (fila) => {
    if (!vivos.has(fila.lote)) return true;
    return fila.expira > 0 && fila.expira * 1000 < ahora();
  };

  for (const fila of parsearFilas((await docker(argvListarPorEtiqueta('contenedores'), { permitirFallo: true })).stdout)) {
    if (!vencido(fila)) continue;
    await docker(argvRmForzado(fila.nombre), { permitirFallo: true });
    podados.contenedores.push(fila.nombre);
  }

  // Después de los contenedores: una red con un endpoint activo no se borra.
  for (const fila of parsearFilas((await docker(argvListarPorEtiqueta('redes'), { permitirFallo: true })).stdout)) {
    if (!vencido(fila)) continue;
    await docker(argvBorrarRed(fila.nombre), { permitirFallo: true });
    podados.redes.push(fila.nombre);
  }

  for (const fila of parsearFilas((await docker(argvListarPorEtiqueta('volumenes'), { permitirFallo: true })).stdout)) {
    if (!vencido(fila)) continue;
    await docker(argvBorrarVolumen(fila.nombre), { permitirFallo: true });
    podados.volumenes.push(fila.nombre);
  }

  // Copias planas en disco: una por lote, con el id como nombre de carpeta.
  let carpetas = [];
  try {
    carpetas = fs.readdirSync(raizCopias, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    carpetas = [];
  }
  for (const nombre of carpetas) {
    if (vivos.has(nombre)) continue;
    try {
      fs.rmSync(path.join(raizCopias, nombre), { recursive: true, force: true });
      podados.copias.push(nombre);
    } catch {
      // Windows puede retener la carpeta; el próximo barrido la agarra.
    }
  }

  return podados;
}

module.exports = { parsearFilas, recolectar };
