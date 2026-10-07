/**
 * FEAT-137 — Lo que la tarjeta de Claude Code en Proveedores lee del equipo:
 * la versión del binario que usa Lagrange, la que fija la imagen de lotes y
 * el resultado de las sondas de lotes por cuenta. Solo lectura; los errores
 * dan `null` (la tarjeta muestra «no se pudo consultar»).
 */
const fs = require('node:fs');
const path = require('node:path');

const DOCKERFILE = path.join(__dirname, '..', 'lotes', 'imagenes', 'Dockerfile.claude');

/** La versión del `ARG CLAUDE_CODE_VERSION=` del Dockerfile de la imagen, o null. */
function versionImagenClaude(ruta = DOCKERFILE) {
  try {
    const m = /^ARG\s+CLAUDE_CODE_VERSION=(\d+\.\d+\.\d+)\s*$/m.exec(fs.readFileSync(ruta, 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Las dependencias de `crearProveedores` para Claude Code.
 * @param {object} o
 * @param {Function} o.cargarConfig  () => config de Lagrange (para `motores.claude.bin`), o null
 * @param {string}   o.dataDir       directorio de datos del bridge (las sondas de lotes viven ahí)
 */
function depsDeClaude({ cargarConfig = () => null, dataDir } = {}) {
  const { resolverBinario, versionClaude } = require('../motores/claude-ejecutar.js');
  const sondas = require('../lotes/sondas-claude.js');
  return {
    versionClaude: () => {
      let config = null;
      try { config = cargarConfig(); } catch {}
      const b = resolverBinario(config);
      return b.ok ? (versionClaude(b.bin) || '') : '';
    },
    imagenClaude: () => versionImagenClaude(),
    sondasClaude: () => (dataDir ? sondas.leerSondas(sondas.rutaSondas(dataDir)) : null)
  };
}

module.exports = { versionImagenClaude, depsDeClaude, DOCKERFILE };
