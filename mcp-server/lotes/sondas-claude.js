/**
 * FEAT-131 — Las sondas del perfil `edicion` de Claude en el contenedor del
 * lote, y su registro por cuenta.
 *
 * Corren el camino de PRODUCCIÓN, no una imitación: el refrescador de verdad
 * (`crearCredenciales` con motor `claude`, que además verifica el señuelo: sin
 * `refreshToken` y sin el token real) y una tarea con `crearEjecutorContenedor`
 * sobre un repo descartable. Deciden por evidencia, nunca por lo que diga el
 * modelo:
 *   E1  el `init` de Claude: exactamente las tools del perfil, 0 servidores MCP,
 *       `apiKeySource: "none"` y `permissionMode: "acceptEdits"`;
 *   E2  el canario: el archivo pedido quedó commiteado en el repo descartable
 *       con el contenido exacto (la escritura pasó por la copia y la
 *       sincronización, no por el disco del host).
 *
 * La huella es la versión de Claude Code de la imagen más la de Lagrange: si
 * cambia cualquiera, las sondas dejan de valer (como SEC-018) y el servicio no
 * acepta el motor hasta volver a sondear.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { IMAGEN_CLAUDE, TOOLS_EDICION_CLAUDE, RE_CUENTA_LOTE } = require('./docker.js');
const { crearCredenciales } = require('./credenciales.js');
const { crearEjecutorContenedor } = require('./ejecutor.js');

const ARCHIVO = 'lotes-sondas-claude.json';
const CANARIO = 'sonda-lagrange.txt';
const TEXTO_CANARIO = 'LAGRANGE-SONDA-EDICION';

function rutaSondas(dirDatos) {
  return path.join(dirDatos, ARCHIVO);
}

function versionLagrange() {
  try { return require('../../package.json').version || null; } catch { return null; }
}

/** `claude --version` de la imagen, sin red. `null` si la imagen no está. */
async function versionDeLaImagen(docker) {
  const r = await docker(['run', '--rm', '--network', 'none', IMAGEN_CLAUDE, 'claude', '--version'], { permitirFallo: true, timeoutMs: 60000 });
  if (r.code !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(String(r.stdout || ''));
  return m ? m[1] : null;
}

async function huellaActual(docker) {
  const claude = await versionDeLaImagen(docker);
  const lagrange = versionLagrange();
  return claude && lagrange ? `claude ${claude} · lagrange ${lagrange}` : null;
}

function leerSondas(ruta) {
  try {
    const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    return datos && typeof datos === 'object' && datos.cuentas && typeof datos.cuentas === 'object' ? datos : { cuentas: {} };
  } catch {
    return { cuentas: {} };
  }
}

function guardarSondas(ruta, cuenta, resultado) {
  const datos = leerSondas(ruta);
  datos.cuentas[cuenta] = resultado;
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, ruta);
}

/** `{ ok, motivo }`: la cuenta tiene sondas en verde con ESTA huella. */
function sondasVigentes(ruta, cuenta, huella) {
  const e = leerSondas(ruta).cuentas[cuenta];
  if (!e) return { ok: false, motivo: `la cuenta ${cuenta} no tiene sondas del lote: corré npm run lotes -- sondar-claude ${cuenta}` };
  if (!e.ok) return { ok: false, motivo: `las sondas de ${cuenta} fallaron (${(e.detalle || []).filter((d) => !d.ok).map((d) => d.id).join(', ') || 'sin detalle'})` };
  if (!huella || e.huella !== huella) return { ok: false, motivo: `las sondas de ${cuenta} son de otra versión (${e.huella || '?'}; ahora ${huella || '?'}): volvé a sondear` };
  return { ok: true, motivo: null };
}

/** E1 sobre el evento `init` de Claude. */
function evaluarInit(init) {
  if (!init) return { id: 'E1', ok: false, detalle: 'no hubo evento init' };
  const tools = Array.isArray(init.tools) ? [...init.tools].sort() : [];
  const esperadas = [...TOOLS_EDICION_CLAUDE].sort();
  const problemas = [];
  if (tools.join(',') !== esperadas.join(',')) problemas.push(`tools ${tools.join(',')}`);
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length) problemas.push('hay servidores MCP');
  if (init.apiKeySource !== 'none') problemas.push(`apiKeySource ${init.apiKeySource}`);
  if (init.permissionMode !== 'acceptEdits') problemas.push(`permissionMode ${init.permissionMode}`);
  return { id: 'E1', ok: !problemas.length, detalle: problemas.join('; ') || 'tools del perfil, sin MCP, login en disco' };
}

function repoDescartable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-sonda-lote-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', windowsHide: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'sonda@lagrange.local']);
  git(['config', 'user.name', 'Sonda Lagrange']);
  fs.writeFileSync(path.join(dir, 'LEEME.md'), 'Repo descartable de las sondas de FEAT-131.\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'sonda']);
  return dir;
}

/**
 * Corre E1 y E2 para `cuenta` y guarda el resultado. Todo lo que crea (volúmenes
 * del refrescador, red, proxy, copia, repo) se borra al terminar.
 */
async function correrSondas({ docker, aWsl, ejecutarStream, terminarCliente, cuenta, dirDatos, raizCopias, ahora = () => new Date() }) {
  if (!RE_CUENTA_LOTE.test(String(cuenta || ''))) throw new Error(`cuenta inválida: ${cuenta}`);
  const huella = await huellaActual(docker);
  if (!huella) throw new Error(`falta la imagen ${IMAGEN_CLAUDE}: construila con npm run lotes -- imagenes-claude`);
  const idLote = `sonda-${cuenta}-${Date.now().toString(36)}`.slice(0, 60);
  const expiraEpoch = Math.floor(Date.now() / 1000) + 3600;
  const detalle = [];
  const credenciales = crearCredenciales({ docker, idLote, expiraEpoch, motor: 'claude', cuenta });
  let repo = null;
  try {
    try {
      await credenciales.asegurarVida(10);
      detalle.push({ id: 'refresco', ok: true, detalle: 'renovó y exportó el señuelo sin refreshToken ni token real' });
    } catch (err) {
      detalle.push({ id: 'refresco', ok: false, detalle: err.message.slice(0, 300) });
      throw err;
    }
    repo = repoDescartable();
    let init = null;
    const ejecutar = crearEjecutorContenedor({
      docker, ejecutarStream, credenciales, idLote, raizCopias, expiraEpoch, aWsl, terminarCliente, motor: 'claude',
      timeoutMinutesPorDefecto: 10,
      onLine: (linea) => {
        if (init) return;
        try { const ev = JSON.parse(linea); if (ev && ev.type === 'system' && ev.subtype === 'init') init = ev; } catch {}
      }
    });
    const r = await ejecutar({
      taskId: 'sonda',
      cwd: repo,
      model: 'claude-haiku-5-5',
      archivos: [CANARIO],
      timeout_minutes: 10,
      prompt: `Creá el archivo ${CANARIO} en el directorio actual con exactamente este contenido, sin nada más: ${TEXTO_CANARIO}\nDespués respondé solo OK.`
    });
    detalle.push(evaluarInit(init));
    let contenido = null;
    try { contenido = execFileSync('git', ['show', `HEAD:${CANARIO}`], { cwd: repo, stdio: 'pipe', encoding: 'utf8', windowsHide: true }); } catch {}
    const e2 = r.success && r.commit && contenido !== null && contenido.trim() === TEXTO_CANARIO;
    detalle.push({ id: 'E2', ok: Boolean(e2), detalle: e2 ? 'el canario quedó commiteado por la sincronización' : `tarea ${r.success ? 'ok' : `falló: ${String(r.error || '').slice(0, 200)}`}, commit ${r.commit || 'ninguno'}, canario ${contenido === null ? 'ausente' : 'con otro contenido'}` });
  } catch (err) {
    if (!detalle.some((d) => !d.ok)) detalle.push({ id: 'ejecucion', ok: false, detalle: String(err.message || err).slice(0, 300) });
  } finally {
    try { await credenciales.destruir(); } catch {}
    if (repo) { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} }
  }
  const resultado = { ok: detalle.length > 0 && detalle.every((d) => d.ok), huella, en: ahora().toISOString(), detalle };
  guardarSondas(rutaSondas(dirDatos), cuenta, resultado);
  return resultado;
}

module.exports = {
  ARCHIVO, CANARIO, TEXTO_CANARIO, rutaSondas, versionDeLaImagen, huellaActual, leerSondas, guardarSondas,
  sondasVigentes, evaluarInit, correrSondas
};
