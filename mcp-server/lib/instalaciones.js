/**
 * FEAT-095 — Qué versión de Lagrange hay instalada en cada cuenta de Claude Code.
 *
 * Con dos cuentas (`~/.claude` y una de `motores.cuentas`) cada una tiene su propia copia del
 * plugin, y nada avisaba cuando una quedaba atrás. Acá se lee, por cuenta, **solo**
 * `<dir>/plugins/installed_plugins.json` (el registro interno de Claude Code): nunca
 * `settings.json`, `.credentials.json` ni `.claude.json`. Es un formato que no controlamos
 * (medido en Claude Code 2.1.284), así que todo se trata como opcional y nada lanza.
 */

const fs = require('node:fs');
const path = require('node:path');
const { compararVersiones } = require('./proveedores.js');

/** El plugin de este repo: `<plugin>@<marketplace>`. */
const PLUGIN_EXACTO = 'lagrange@kzvilla-lagrange';
const REGISTRO = path.join('plugins', 'installed_plugins.json');
/** Los `--scope` de `claude plugin update`. */
const SCOPES = new Set(['user', 'project', 'local', 'managed']);

const normalizar = (p) => {
  const r = path.resolve(String(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// Todo lo que sale de `installed_plugins.json` acaba impreso en el diagnóstico y, con la clave y el
// scope, en un comando que el usuario pega: solo pasa lo que tiene la forma esperada.
const FORMA_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const FORMA_SHA = /^[0-9a-f]{7,40}$/i;
const FORMA_CLAVE = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,64}$/;
/** Una ruta que se pega entre comillas dobles en bash o PowerShell sin que la shell la interprete. */
const RUTA_SEGURA = /^[^"'`$\r\n\0]+$/;

function datosDe(registro) {
  const version = typeof registro.version === 'string' && FORMA_VERSION.test(registro.version) ? registro.version : null;
  const sha = typeof registro.gitCommitSha === 'string' && FORMA_SHA.test(registro.gitCommitSha) ? registro.gitCommitSha.slice(0, 7) : null;
  return { version, sha, scope: SCOPES.has(registro.scope) ? registro.scope : null };
}

/** De los registros de una clave, el de `scope: "user"` y, si no, el de versión mayor; `null` si ninguno trae versión. */
function elegirRegistro(valor) {
  const lista = (Array.isArray(valor) ? valor : [valor])
    .filter((r) => r && typeof r === 'object')
    .map(datosDe)
    .filter((d) => d.version);
  if (!lista.length) return null;
  const usuario = lista.find((d) => d.scope === 'user');
  if (usuario) return usuario;
  return lista.reduce((a, b) => ((compararVersiones(b.version, a.version) || 0) > 0 ? b : a));
}

function leerCuenta({ nombre, dir }, { leer, existe }) {
  const base = { cuenta: nombre, dir, version: null, sha: null };
  let texto;
  try {
    texto = leer(path.join(dir, REGISTRO));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ...base, estado: existe(dir) ? 'sin-plugin' : 'sin-carpeta' };
    return { ...base, estado: 'ilegible' };
  }
  let plugins;
  try {
    const datos = JSON.parse(String(texto));
    plugins = datos && typeof datos === 'object' ? datos.plugins : null;
  } catch {
    return { ...base, estado: 'ilegible' };
  }
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return { ...base, estado: 'ilegible' };

  const propias = (k) => Object.prototype.hasOwnProperty.call(plugins, k);
  const claves = propias(PLUGIN_EXACTO) ? [PLUGIN_EXACTO] : Object.keys(plugins).filter((k) => /^lagrange@/.test(k) && FORMA_CLAVE.test(k));
  if (!claves.length) return { ...base, estado: 'sin-plugin' };

  const filas = claves.map((clave) => ({ clave, ...(elegirRegistro(plugins[clave]) || { version: null, sha: null }) }));
  // Varias claves `lagrange@…` sin la del marketplace de este repo: no se elige una, se listan todas.
  if (filas.length > 1) return { ...base, estado: 'ambiguo', claves: filas };
  const [fila] = filas;
  if (!fila.version) return { ...base, estado: 'ilegible' };
  return { ...base, estado: 'instalado', version: fila.version, sha: fila.sha, clave: fila.clave, scope: fila.scope };
}

/**
 * `[{ cuenta, dir, estado, version, sha, propia }]`, una por cuenta de `todas` (`[{ nombre, dir }]`, de
 * `recall.fuentes().todas`). `actual` es la carpeta de la sesión, si hay: se agrega si no estaba y se
 * marca `propia`. `estado`: `instalado` | `sin-plugin` | `sin-carpeta` | `ilegible` | `ambiguo`. Nunca lanza.
 * `leer(ruta)` devuelve el texto o lanza; `existe(dir)` es `fs.existsSync`.
 */
function versionesInstaladas({ todas = [], actual = null, leer = (r) => fs.readFileSync(r, 'utf8'), existe = fs.existsSync } = {}) {
  const cuentas = [...todas];
  if (actual && !cuentas.some((c) => normalizar(c.dir) === normalizar(actual))) {
    cuentas.push({ nombre: 'sesión actual', dir: actual });
  }
  return cuentas.map((c) => {
    let fila;
    try {
      fila = leerCuenta(c, { leer, existe });
    } catch {
      fila = { cuenta: c.nombre, dir: c.dir, version: null, sha: null, estado: 'ilegible' };
    }
    return { ...fila, propia: Boolean(actual) && normalizar(c.dir) === normalizar(actual) };
  });
}

/**
 * ¿Es una versión que se puede comparar? `x.y.z` canónica: `compararVersiones` pasa cada componente por `Number`,
 * así que `00.67.4` daría igual a `0.67.4` y se afirmaría "sin deriva" entre dos cadenas distintas.
 */
const CANONICA = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const comparable = (v) => typeof v === 'string' && CANONICA.test(v) && compararVersiones(v, v) !== null;

/** La mayor versión x.y.z de las cuentas con el plugin instalado, o `null`. */
function versionMaxima(instalaciones) {
  let max = null;
  for (const i of instalaciones) {
    if (i.estado !== 'instalado' || !comparable(i.version)) continue;
    if (max === null || compararVersiones(i.version, max) > 0) max = i.version;
  }
  return max;
}

/**
 * El comando que actualiza la instalación encontrada: su clave (no el marketplace de este repo por
 * defecto) y su scope, porque sin `--scope` Claude Code actualiza el más específico. Otra cuenta se
 * elige con `CLAUDE_CONFIG_DIR`, con la sintaxis de la shell de la plataforma.
 */
function comandoDeActualizacion(i, plataforma) {
  const clave = i.clave || PLUGIN_EXACTO;
  // No se arma un comando con algo que no tenga la forma esperada; el aviso lo dice sin él.
  if (!FORMA_CLAVE.test(clave)) return null;
  // Sin un scope conocido, `claude plugin update` elige el más específico del proyecto actual y podría
  // tocar otra instalación: en ese caso no se ofrece un comando.
  if (!SCOPES.has(i.scope)) return null;
  const orden = `claude plugin update ${clave} --scope ${i.scope}`;
  if (i.propia) return orden;
  if (!RUTA_SEGURA.test(String(i.dir))) return null;
  // En bash, una `\` final dentro de comillas dobles escapa la comilla de cierre.
  if (plataforma !== 'win32' && /\\$/.test(String(i.dir))) return null;
  // PowerShell: el valor anterior de la variable se restaura (o se quita si no existía).
  return plataforma === 'win32'
    ? `$prev = $env:CLAUDE_CONFIG_DIR; try { $env:CLAUDE_CONFIG_DIR = "${i.dir}"; ${orden} } finally { if ($null -eq $prev) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:CLAUDE_CONFIG_DIR = $prev } }`
    : `CLAUDE_CONFIG_DIR="${i.dir}" ${orden}`;
}

/**
 * Avisos de deriva (`string[]`). `propia`: versión de este MCP (`package.json`); `daemon`: la del daemon local,
 * o `null`. Una versión que no es x.y.z no se compara. Solo informa: no ejecuta nada.
 */
function avisosDeDeriva({ propia = null, daemon = null, instalaciones = [], plataforma = process.platform } = {}) {
  const avisos = [];
  const max = versionMaxima(instalaciones);

  const suya = instalaciones.find((i) => i.propia && i.estado === 'instalado');
  if (suya && compararVersiones(suya.version, propia) > 0) {
    avisos.push(`Esta sesión corre ${propia}, pero la cuenta "${suya.cuenta}" ya tiene ${suya.version} instalada: reiniciá la sesión para usarla. `
      + '`/reload-plugins` puede no reiniciar el MCP (observado en escritorio el 2026-09-24; la documentación oficial dice que puede recargarlo en sesiones interactivas): esta misma herramienta dice cuál quedó.');
  }

  // Sin cuenta propia (Codex, opencode: no hay `CLAUDE_CONFIG_DIR`) igual se compara la sesión con lo instalado.
  if (!suya && max && compararVersiones(max, propia) > 0) {
    avisos.push(`Esta sesión corre ${propia}, pero hay ${max} instalada en alguna cuenta: reiniciá la sesión desde la cuenta actualizada para usarla.`);
  }

  if (max) {
    for (const i of instalaciones) {
      if (i.estado !== 'instalado' || compararVersiones(i.version, max) >= 0) continue;
      const comando = comandoDeActualizacion(i, plataforma);
      avisos.push(`La cuenta "${i.cuenta}" tiene ${i.version} y otra tiene ${max}: `
        + (comando ? `\`${comando}\` y reiniciar sus sesiones abiertas.` : 'no se pudo armar el comando de forma segura (clave, scope o carpeta ilegibles): revisá `claude plugin list` en esa cuenta y reiniciá sus sesiones abiertas.'));
    }
    if (daemon && compararVersiones(daemon, max) < 0) {
      avisos.push(`El daemon del bot corre ${daemon} y hay ${max} instalada: \`npm run bridge:daemon:update\` desde su copia.`);
    }
  }
  return avisos;
}

/**
 * ¿Se pudo comparar todo? Esta sesión, el daemon y cada cuenta con el plugin tienen que ser x.y.z, y tiene que
 * haber al menos una instalación. Solo entonces "sin avisos" quiere decir "sin deriva".
 */
function todoComparable({ propia = null, daemon = null, instalaciones = [] } = {}) {
  const instaladas = instalaciones.filter((i) => i.estado === 'instalado');
  if (!instaladas.length) return false;
  const ok = comparable;
  if (!ok(propia) || !ok(daemon)) return false;
  // Una cuenta ambigua o ilegible tampoco se pudo comparar.
  // `sin-plugin` es una respuesta (esa cuenta no lo tiene); `sin-carpeta` no: no se ve desde aquí, así que no se sabe.
  return instaladas.every((i) => ok(i.version)) && instalaciones.every((i) => i.estado === 'instalado' || i.estado === 'sin-plugin');
}

/**
 * "Sin deriva" solo si todo se pudo comparar y las versiones coinciden: esta sesión, el daemon y cada
 * cuenta con el plugin. Un daemon o una sesión ADELANTADOS no piden actualizar nada (no hay aviso),
 * pero tampoco están alineados.
 */
function sinDeriva({ propia = null, daemon = null, instalaciones = [] } = {}) {
  if (!todoComparable({ propia, daemon, instalaciones })) return false;
  return instalaciones.filter((i) => i.estado === 'instalado').every((i) => compararVersiones(i.version, propia) === 0)
    && compararVersiones(daemon, propia) === 0;
}

module.exports = { PLUGIN_EXACTO, REGISTRO, versionesInstaladas, versionMaxima, avisosDeDeriva, todoComparable, sinDeriva };
