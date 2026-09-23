/**
 * FEAT-074 — La cuota de agy, leída de su propio `/usage` interactivo.
 *
 * agy no informa cuota en modo `-p` (en print, `/usage` no se expande: va al
 * modelo como prompt). La interfaz oficial es el panel "Models & Quota" de la
 * sesión interactiva, con dos grupos (Gemini; Claude y GPT) y dos ventanas cada
 * uno (semanal y 5 h), en porcentaje RESTANTE.
 *
 * Dos caminos de entrada, un solo parser:
 *   - A, manual: el usuario pega el panel (`agy_usage quota_text`). Sin
 *     dependencias, siempre disponible.
 *   - B, captura: agy interactivo en una pseudo-terminal (ConPTY), volcado en
 *     un emulador de terminal (`@xterm/headless`) y leído de su pantalla. Los
 *     dos módulos son opcionales y viven fuera del plugin (`npm run
 *     pty:install`), como OmniVoice.
 *
 * Nunca por la red ni con los tokens de agy (Términos de Servicio). El texto
 * crudo no se guarda: solo lo parseado, con la cuenta enmascarada y su hash.
 *
 * Evidencia: `docs/future-implementations/evidencia-feat-074-2026-09-23/`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { terminateTree } = require('./process-tree.js');
const { opcionesDeAgy } = require('./opciones-agy.js');

const GRUPOS = Object.freeze({ 'GEMINI MODELS': 'gemini', 'CLAUDE AND GPT MODELS': 'claude_gpt' });
const VENTANAS = Object.freeze({ 'Weekly Limit Remaining': 'semanal', 'Five Hour Limit Remaining': 'cinco_horas' });
const VERSIONES_PTY = Object.freeze({ '@lydell/node-pty': '1.2.0-beta.15', '@xterm/headless': '6.0.0' });
const COLUMNAS = 120;
const FILAS = 60;
const CANDADO_VENCE_MS = 90 * 1000;

// ---------------------------------------------------------------------------
// Parser (puro)
// ---------------------------------------------------------------------------

/** "Refreshes in 164h 8m" → minutos; "Quota available" → null; otra cosa → undefined. */
function minutosDeReinicio(linea) {
  if (/^Quota available\b/i.test(linea)) return null;
  const m = linea.match(/^Refreshes in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?\s*$/i);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0);
}

/**
 * Texto de PANTALLA del panel → `{ cuenta, grupos: { gemini, claude_gpt }, desconocidos }`,
 * o `null` con `motivo` (`{ ok: false, motivo }`). Estricto: si falta una de las
 * cuatro ventanas conocidas o un porcentaje no parsea, no hay resultado. Nunca
 * se rellena con cero.
 */
function parsearUsage(texto) {
  const lineas = String(texto || '').split(/\r?\n/).map(l => l.replace(/[│└]/g, ' ').trim());
  if (!lineas.some(l => /Models & Quota/.test(l))) return { ok: false, motivo: 'no aparece el panel "Models & Quota"' };

  let cuenta = null;
  const grupos = {};
  const desconocidos = [];
  let actual = null;

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    const cuentaM = l.match(/^Account:\s*(\S+@\S+)/);
    if (cuentaM) { cuenta = cuentaM[1]; continue; }
    if (/^[A-Z][A-Z &-]* MODELS$/.test(l)) {
      const clave = GRUPOS[l];
      if (!clave) { desconocidos.push(l); actual = null; continue; }
      actual = { clave, datos: { modelos: [], semanal: null, cinco_horas: null } };
      grupos[clave] = actual.datos;
      continue;
    }
    if (!actual) continue;
    const modelosM = l.match(/^Models within this group:\s*(.+)$/);
    if (modelosM) { actual.datos.modelos = modelosM[1].split(',').map(s => s.trim()).filter(Boolean); continue; }
    const ventana = VENTANAS[l];
    if (!ventana) continue;
    const pct = (lineas[i + 1] || '').match(/(\d{1,3}(?:\.\d+)?)%\s*$/);
    if (!pct) return { ok: false, motivo: `${actual.clave}: el porcentaje de "${l}" no se pudo leer` };
    // Dos decimales de porcentaje, sin el error de coma flotante de dividir (94.02 / 100).
    const restante = Math.round(Number(pct[1]) * 100) / 10000;
    if (!(restante >= 0 && restante <= 1)) return { ok: false, motivo: `${actual.clave}: porcentaje fuera de rango en "${l}"` };
    const reinicia = minutosDeReinicio(lineas[i + 2] || '');
    if (reinicia === undefined) return { ok: false, motivo: `${actual.clave}: no se entiende el reinicio de "${l}"` };
    actual.datos[ventana] = { restante, reinicia_en_min: reinicia };
    i += 2;
  }

  for (const clave of Object.values(GRUPOS)) {
    const g = grupos[clave];
    if (!g) return { ok: false, motivo: `falta el grupo ${clave}` };
    for (const v of Object.values(VENTANAS)) {
      if (!g[v]) return { ok: false, motivo: `${clave}: falta la ventana ${v}` };
    }
  }
  return { ok: true, cuenta, grupos, desconocidos };
}

/**
 * Camino A: lo que pega el usuario. Se quitan solo los estilos SGR (`\x1b[…m`),
 * que no mueven el cursor; cualquier otra secuencia de escape se rechaza.
 */
function parsearPegado(texto) {
  const limpio = String(texto || '').replace(/\x1b\[[0-9;]*m/g, '');
  if (limpio.includes('\x1b')) {
    return { ok: false, motivo: 'el texto trae secuencias de terminal que mueven el cursor; copiá el panel ya renderizado' };
  }
  return parsearUsage(limpio);
}

// ---------------------------------------------------------------------------
// Normalización a la forma de BE-039 (`cuota.antigravity`)
// ---------------------------------------------------------------------------

function enmascararCuenta(correo) {
  if (!correo || typeof correo !== 'string' || !correo.includes('@')) return null;
  const [usuario, dominio] = correo.split('@');
  return `${usuario.slice(0, 1)}***@${dominio}`;
}

function hashCuenta(correo) {
  if (!correo || typeof correo !== 'string') return null;
  return crypto.createHash('sha256').update(correo.trim().toLowerCase()).digest('hex');
}

/**
 * Lo parseado → lo que se guarda. `ventana_* = 1 - restante` (la escala usada
 * de BE-039, como Claude); `resetea_*` = hora de la captura + la duración, al
 * minuto, o `null` si el panel no da hora.
 */
function cuotaDesdeUsage(parseado, { vistoEn = new Date(), fuente, versionAgy = null } = {}) {
  const base = vistoEn instanceof Date ? vistoEn : new Date(vistoEn);
  const reinicio = (min) => (min === null ? null : new Date(base.getTime() + min * 60000).toISOString());
  const usado = (r) => Math.round((1 - r) * 10000) / 10000;
  const grupos = {};
  for (const [clave, g] of Object.entries(parseado.grupos)) {
    grupos[clave] = {
      ventana_5h: usado(g.cinco_horas.restante),
      ventana_7d: usado(g.semanal.restante),
      resetea_5h: reinicio(g.cinco_horas.reinicia_en_min),
      resetea_7d: reinicio(g.semanal.reinicia_en_min),
      modelos: g.modelos
    };
  }
  return {
    grupos,
    cuenta: enmascararCuenta(parseado.cuenta),
    cuenta_hash: hashCuenta(parseado.cuenta),
    fuente,
    version_agy: versionAgy,
    visto_en: base.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Camino B: la captura
// ---------------------------------------------------------------------------

function dirPty(env = process.env) {
  if (env.LAGRANGE_PTY_DIR) return path.resolve(env.LAGRANGE_PTY_DIR);
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'lagrange-pty');
  }
  return path.join(os.homedir(), '.local', 'share', 'lagrange-pty');
}

/**
 * La carpeta desde la que se abre agy para capturar: fija, vacía y propia.
 * agy pide confiar en cada carpeta nueva ("Do you trust the contents of this
 * project?") y se queda esperando; la confía el usuario una sola vez, en
 * `pty:install`. Lagrange nunca contesta ese diálogo por él.
 */
function dirTrabajo(env = process.env) {
  return path.join(dirPty(env), 'workspace');
}

const DIALOGO_CONFIANZA = /Do you trust the contents of this project\?/;

/** `{ ok: true, pty, Terminal }` o `{ ok: false, motivo }`. Nunca lanza. */
function cargarPty({ dir = dirPty() } = {}) {
  try {
    const req = createRequire(path.join(dir, 'package.json'));
    const pty = req('@lydell/node-pty');
    const { Terminal } = req('@xterm/headless');
    return { ok: true, pty, Terminal };
  } catch {
    return { ok: false, motivo: 'la captura de /usage no está instalada: corré `npm run pty:install`' };
  }
}

function rutaCandado(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'antigravity-cuota.lock');
}

/** `true` si el candado es nuestro. Uno de más de 90 s se da por abandonado. */
function tomarCandado({ homeDir = os.homedir(), ahora = Date.now() } = {}) {
  const ruta = rutaCandado(homeDir);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  for (let intento = 0; intento < 2; intento++) {
    try {
      const fd = fs.openSync(ruta, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, desde: new Date(ahora).toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(err.code)) return false;
      let viejo = false;
      try { viejo = ahora - fs.statSync(ruta).mtimeMs > CANDADO_VENCE_MS; } catch { continue; }
      if (!viejo) return false;
      try { fs.unlinkSync(ruta); } catch {}
    }
  }
  return false;
}

/**
 * Solo si sigue siendo nuestro: tras una suspensión de más de 90 s, otro
 * proceso pudo haberlo tomado por vencido, y no se le borra.
 */
function soltarCandado(homeDir = os.homedir()) {
  const ruta = rutaCandado(homeDir);
  try {
    if (JSON.parse(fs.readFileSync(ruta, 'utf8')).pid !== process.pid) return;
  } catch {}
  try { fs.unlinkSync(ruta); } catch {}
}

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Abre agy interactivo, pide `/usage` y devuelve el texto de pantalla del
 * panel. `{ ok, texto, motivo, duracionMs }`. Nunca lanza.
 *
 * Las esperas miran la PANTALLA del emulador, no el flujo crudo (S7). No se
 * escribe nada hasta que la ConPTY tiene PID (llega a ~1 s, S8). El cierre es
 * `esc` + dos `ctrl+c`; si agy no sale, `terminateTree` sobre el PID real, que
 * en Windows se lleva los `npx` y los MCP del usuario (S6), y además se cierra
 * la pseudo-terminal, que es la dueña del `conhost --headless`.
 *
 * Si agy muestra el diálogo de confianza de la carpeta, no se contesta: se
 * sale y el motivo dice cómo confiarla.
 */
async function capturarUsage({
  agyBin,
  modulos = cargarPty(),
  cwd = dirTrabajo(),
  env = process.env,
  tiempos = {},
  terminar = terminateTree
} = {}) {
  const t = { topeMs: 45000, pidMs: 5000, listoMs: 30000, margenListoMs: 3000, silencioMs: 2000, salidaMs: 5000, pasoMs: 100, ...tiempos };
  if (!modulos || !modulos.ok) return { ok: false, motivo: (modulos && modulos.motivo) || 'sin pseudo-terminal' };
  const inicio = Date.now();
  const dir = cwd;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const pantallaDe = (term) => {
    const b = term.buffer.active;
    const lineas = [];
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i);
      if (l) lineas.push(l.translateToString(true));
    }
    return lineas.join('\n');
  };

  let proceso = null;
  let salida = null;
  let ultimoDato = Date.now();
  const term = new modulos.Terminal({ cols: COLUMNAS, rows: FILAS, allowProposedApi: true });
  const adaptador = {
    pid: 0,
    exitCode: null,
    signalCode: null,
    kill: (sig) => {
      try { proceso.kill(sig); } catch { try { process.kill(adaptador.pid, sig); } catch {} }
    }
  };
  const vencido = () => Date.now() - inicio > t.topeMs;
  const esperar = async (cond, limiteMs) => {
    const hasta = Date.now() + limiteMs;
    while (!cond()) {
      if (salida || vencido() || Date.now() > hasta) return false;
      await dormir(t.pasoMs);
    }
    return true;
  };
  // Matar agy no alcanza: el `conhost --headless` de la ConPTY es de la
  // pseudo-terminal, y sin cerrarla queda vivo. Aunque agy salga solo,
  // node-pty deja abiertos su socket y el worker de la ConPTY, que retienen al
  // proceso de node (medido): se cierra siempre.
  const cerrarPty = () => {
    try { proceso && proceso.kill(); } catch {}
    try { proceso && typeof proceso.destroy === 'function' && proceso.destroy(); } catch {}
  };
  const cerrar = async (motivo) => {
    if (!salida && proceso) {
      if (adaptador.pid > 0) terminar(adaptador, 2000);
      if (!(await esperar(() => salida, 3000))) cerrarPty();
    }
    return motivo;
  };

  try {
    // La pseudo-terminal no toma `windowsHide` ni `shell`: de `opcionesDeAgy`
    // importa el entorno, con el actualizador de agy apagado (BE-034).
    proceso = modulos.pty.spawn(agyBin, [], {
      name: 'xterm-256color', cols: COLUMNAS, rows: FILAS, cwd: dir, env: opcionesDeAgy({ env }).env
    });
    proceso.onData((d) => { ultimoDato = Date.now(); term.write(d); });
    proceso.onExit(({ exitCode, signal }) => {
      adaptador.exitCode = exitCode === undefined ? 0 : exitCode;
      adaptador.signalCode = signal || null;
      salida = { exitCode, signal };
    });

    // S8: el PID llega a ~1 s. Sin PID no se escribe ni se puede matar.
    if (!(await esperar(() => (adaptador.pid = proceso.pid || 0) > 0, t.pidMs))) {
      return { ok: false, motivo: await cerrar('la pseudo-terminal no informó el PID de agy'), duracionMs: Date.now() - inicio };
    }
    // S2/S3: las teclas enviadas antes de que la caja esté lista se pierden.
    const listo = await esperar(() => /for shortcuts/.test(pantallaDe(term)) || DIALOGO_CONFIANZA.test(pantallaDe(term)), t.listoMs);
    if (listo && DIALOGO_CONFIANZA.test(pantallaDe(term))) {
      proceso.write('\x03');
      return {
        ok: false,
        confianza: true,
        motivo: await cerrar(`agy todavía no confía en la carpeta de captura (${dir}). Confiala una vez: `
          + `corré \`npm run pty:install\` otra vez, o abrí una terminal en esa carpeta, corré \`agy\`, `
          + 'elegí "Yes, I trust this folder" y salí con ctrl+c'),
        duracionMs: Date.now() - inicio
      };
    }
    if (!listo) {
      return { ok: false, motivo: await cerrar('agy no llegó a mostrar su caja de entrada'), duracionMs: Date.now() - inicio };
    }
    await dormir(t.margenListoMs);
    proceso.write('/usage');
    await dormir(200);
    proceso.write('\r');

    const panelCompleto = () => (pantallaDe(term).match(/Five Hour Limit Remaining/g) || []).length >= 2;
    if (!(await esperar(() => panelCompleto() && Date.now() - ultimoDato >= t.silencioMs, t.topeMs))) {
      return { ok: false, motivo: await cerrar(vencido() ? 'la captura pasó los 45 s' : 'agy no mostró el panel de cuota'), duracionMs: Date.now() - inicio };
    }
    const texto = pantallaDe(term);

    proceso.write('\x1b');
    await dormir(300);
    proceso.write('\x03');
    await dormir(300);
    proceso.write('\x03');
    if (!(await esperar(() => salida, t.salidaMs))) await cerrar(null);
    return { ok: true, texto, duracionMs: Date.now() - inicio };
  } catch (err) {
    return { ok: false, motivo: await cerrar(`no se pudo abrir agy en la pseudo-terminal: ${err.message}`), duracionMs: Date.now() - inicio };
  } finally {
    cerrarPty();
    try { term.dispose(); } catch {}
  }
}

/**
 * Captura + parseo + normalización, con el candado entre procesos. Si otro
 * proceso está capturando, `{ ok: false, ocupado: true }`: quien llama muestra
 * la última cuota guardada.
 */
async function refrescarCuota({ agyBin, homeDir = os.homedir(), versionAgy = null, capturar = capturarUsage, ...opciones } = {}) {
  if (!tomarCandado({ homeDir })) return { ok: false, ocupado: true, motivo: 'otra captura de /usage está en curso' };
  try {
    const c = await capturar({ agyBin, ...opciones });
    if (!c.ok) return c;
    const p = parsearUsage(c.texto);
    if (!p.ok) return { ok: false, motivo: `el panel no se pudo leer: ${p.motivo}`, duracionMs: c.duracionMs };
    return { ok: true, cuota: cuotaDesdeUsage(p, { fuente: 'usage-pty', versionAgy }), desconocidos: p.desconocidos, duracionMs: c.duracionMs };
  } finally {
    soltarCandado(homeDir);
  }
}

module.exports = {
  GRUPOS,
  VERSIONES_PTY,
  CANDADO_VENCE_MS,
  parsearUsage,
  parsearPegado,
  minutosDeReinicio,
  enmascararCuenta,
  hashCuenta,
  cuotaDesdeUsage,
  dirPty,
  dirTrabajo,
  cargarPty,
  rutaCandado,
  tomarCandado,
  soltarCandado,
  capturarUsage,
  refrescarCuota
};
