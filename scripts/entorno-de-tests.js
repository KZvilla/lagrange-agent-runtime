'use strict';
/**
 * BE-066 — El entorno de los hijos de los runners de tests (`scripts/gates.mjs`
 * y `test/run.js`).
 *
 * Corridos desde una sesión de Claude Code, los tests heredaban su
 * `CLAUDE_CODE_SESSION_ID` y el directorio de datos real: cada MCP que
 * levantaban encontraba el daemon vivo, se daba de alta con el id de la sesión
 * verdadera y, al cerrarse, la daba de baja. Después la sesión ya no podía
 * mandar ni recibir mensajes.
 *
 * Acá los hijos pierden las variables de sesión y usan un directorio de datos
 * temporal propio, así ningún test toca el daemon real. Si el runner ya corre
 * aislado (las puertas lanzan `test/run.js`), se reutiliza lo que armó el de
 * afuera.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const VARIABLES_DE_SESION = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID'];
const MARCA = 'LAGRANGE_TESTS_AISLADOS';

/** Si `env` ya es un entorno armado acá: la marca, un temporal de esta forma y sin variables de sesión. */
function yaAislado(env) {
  if (env[MARCA] !== '1') return false;
  if (Object.keys(env).some((k) => VARIABLES_DE_SESION.includes(k.toUpperCase()))) return false;
  const dir = String(env.TELEGRAM_BRIDGE_DATA_DIR || '');
  const raiz = path.dirname(dir);
  return path.basename(dir) === 'antigravity-telegram-bridge'
    && path.dirname(raiz) === path.resolve(os.tmpdir())
    && path.basename(raiz).startsWith('lagrange-tests-')
    && fs.existsSync(dir);
}

/**
 * `{ env, limpiar }`: el entorno para los hijos y cómo borrar lo temporal.
 * Con `respetarDataDir` (el helper de un test puntual), un
 * `TELEGRAM_BRIDGE_DATA_DIR` que ya viene fijado se conserva: lo eligió el test.
 * Las variables de sesión se sacan siempre.
 */
function entornoDeTests(env = process.env, { respetarDataDir = false } = {}) {
  if (yaAislado(env)) return { env: { ...env }, limpiar: () => {} };
  const propio = respetarDataDir ? String(env.TELEGRAM_BRIDGE_DATA_DIR || '').trim() : '';
  const hijo = {};
  for (const [clave, valor] of Object.entries(env)) {
    // En Windows las variables no distinguen mayúsculas.
    if (VARIABLES_DE_SESION.includes(clave.toUpperCase())) continue;
    if (clave.toUpperCase() === 'TELEGRAM_BRIDGE_DATA_DIR') continue;
    hijo[clave] = valor;
  }
  if (propio) {
    hijo.TELEGRAM_BRIDGE_DATA_DIR = propio;
    return { env: hijo, limpiar: () => {} };
  }
  // Con el mismo nombre final que el real: hay tests que lo muestran o lo buscan.
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-tests-'));
  const dir = path.join(raiz, 'antigravity-telegram-bridge');
  fs.mkdirSync(dir);
  hijo.TELEGRAM_BRIDGE_DATA_DIR = dir;
  // FEAT-129 — Un MCP de test que viva más de 10 s arma vistas: nunca en la base real.
  if (!String(env.LAGRANGE_CONOCIMIENTO_DIR || '').trim()) hijo.LAGRANGE_CONOCIMIENTO_DIR = path.join(raiz, 'lagrange-conocimiento');
  hijo[MARCA] = '1';
  return {
    env: hijo,
    limpiar: () => {
      try { fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  };
}

module.exports = { entornoDeTests, VARIABLES_DE_SESION };
