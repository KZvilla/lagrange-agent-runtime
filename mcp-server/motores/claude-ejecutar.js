/**
 * FEAT-072 — El ciclo de vida de un hijo `claude -p` y la resolución de su
 * binario.
 *
 * `ejecutarClaude(spec, opciones)` es el ejecutor que declara el motor
 * `claude` (`motor.ejecutor`). Lo inyecta quien llama (el bot, con su
 * cancelación previa al spawn; el MCP en el cast; la consolidación), igual que
 * `ejecutar` para agy: una superficie nunca lanza Claude por su cuenta.
 *
 *   spec     = { bin, argv, stdin, env }
 *   opciones = { cwd, timeoutMinutes, signal, onSpawn, onTexto, onActividad }
 *   →          { success, cancelled, lanzado, stdout, eventos, error, codigo }
 *
 * `lanzado` es `true` solo si el proceso llegó a arrancar (hubo pid): con eso
 * la superficie decide si registra el hilo previsto de un turno cortado.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { terminateTree } = require('../lib/process-tree.js');
const { parsearLinea, interpretarEvento } = require('./claude.js');

// ---------------------------------------------------------------------------
// Binario (§3.6)
// ---------------------------------------------------------------------------

const esShim = (ruta) => /\.(cmd|bat)$/i.test(String(ruta || ''));
const MOTIVO_SHIM = 'es un shim de npm (.cmd/.bat), que no se puede lanzar sin shell; configurá `motores.claude.bin` con la ruta de claude.exe';

function buscarEnPath({ plataforma = process.platform, ejecutar = execFileSync } = {}) {
  try {
    const salida = ejecutar(plataforma === 'win32' ? 'where.exe' : 'which', ['claude'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    });
    return String(salida || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `{ ok: true, bin }` o `{ ok: false, motivo }`. Orden: `motores.claude.bin`,
 * `where`/`which`, y en Windows `%USERPROFILE%\.local\bin\claude.exe` (el
 * instalador nativo). Un `.cmd`/`.bat` se rechaza: con `shell:false` no
 * arranca, y habilitar la shell reabre la inyección por argumentos.
 */
function resolverBinario(config = null, {
  plataforma = process.platform, homeDir = os.homedir(), existe = fs.existsSync, buscar = buscarEnPath
} = {}) {
  const configurado = config && config.motores && config.motores.claude && config.motores.claude.bin;
  if (configurado) {
    if (esShim(configurado)) return { ok: false, motivo: `\`motores.claude.bin\` (${configurado}) ${MOTIVO_SHIM}` };
    if (!existe(configurado)) return { ok: false, motivo: `\`motores.claude.bin\` apunta a ${configurado}, que no existe` };
    return { ok: true, bin: configurado };
  }
  const candidatos = buscar({ plataforma });
  const lanzable = candidatos.find(c => !esShim(c) && existe(c));
  if (lanzable) return { ok: true, bin: lanzable };
  if (plataforma === 'win32') {
    const nativo = path.join(homeDir, '.local', 'bin', 'claude.exe');
    if (existe(nativo)) return { ok: true, bin: nativo };
  }
  if (candidatos.some(esShim)) return { ok: false, motivo: `el claude del PATH (${candidatos.find(esShim)}) ${MOTIVO_SHIM}` };
  return { ok: false, motivo: 'no se encontró claude en el PATH ni en ~/.local/bin; configurá `motores.claude.bin`' };
}

const cacheVersion = new Map();

/** `claude --version` → `"2.1.280"`, cacheado por tamaño y mtime del binario. `null` si no se pudo. */
function versionClaude(bin, { ejecutar = execFileSync } = {}) {
  let marca = null;
  try { const st = fs.statSync(bin); marca = `${st.size}:${st.mtimeMs}`; } catch {}
  const previa = cacheVersion.get(bin);
  if (previa && marca && previa.marca === marca) return previa.valor;
  try {
    const salida = ejecutar(bin, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' }
    });
    const m = String(salida || '').match(/\d+\.\d+\.\d+/);
    const valor = m ? m[0] : null;
    if (valor && marca) cacheVersion.set(bin, { marca, valor });
    return valor;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ejecutor
// ---------------------------------------------------------------------------

function ejecutarClaude(spec, {
  cwd, timeoutMinutes = 15, signal, onSpawn, onTexto, onActividad, lanzar = spawn
} = {}) {
  return new Promise((resolve) => {
    const { bin, argv = [], stdin = '', env } = spec || {};
    if (!bin) {
      resolve({ success: false, cancelled: false, lanzado: false, stdout: '', eventos: [], error: 'falta el binario de claude' });
      return;
    }
    if (signal && signal.aborted) {
      resolve({ success: false, cancelled: true, lanzado: false, stdout: '', eventos: [], error: 'Cancelado antes de lanzar claude.' });
      return;
    }

    let hijo;
    try {
      hijo = lanzar(bin, argv, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ success: false, cancelled: false, lanzado: false, stdout: '', eventos: [], error: `no se pudo lanzar claude: ${err.message}` });
      return;
    }

    const lanzado = Boolean(hijo && hijo.pid);
    let stdout = '';
    let stderr = '';
    let pendiente = '';
    const eventos = [];
    let terminado = false;
    let motivoCorte = null;

    const cortar = (motivo) => {
      if (terminado || motivoCorte) return;
      motivoCorte = motivo;
      terminateTree(hijo, 2000);
    };
    const reloj = setTimeout(() => cortar(`claude pasó los ${timeoutMinutes} minutos`), timeoutMinutes * 60 * 1000);
    const alAbortar = () => cortar('Cancelado.');
    if (signal) signal.addEventListener('abort', alAbortar, { once: true });
    if (typeof onSpawn === 'function') {
      try { onSpawn(() => { cortar('Cancelado.'); return true; }); } catch {}
    }

    const procesarLinea = (linea) => {
      const evento = parsearLinea(linea);
      if (!evento) return;
      eventos.push(evento);
      const i = interpretarEvento(evento);
      if (!i) return;
      try {
        if (i.tipo === 'prosa' && i.texto && typeof onTexto === 'function') onTexto(i.texto);
        if (i.tipo === 'tool' && typeof onActividad === 'function') onActividad(i.texto);
      } catch {}
    };

    const cerrar = (codigo, errorSpawn) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      if (signal) signal.removeEventListener('abort', alAbortar);
      if (pendiente) { procesarLinea(pendiente); pendiente = ''; }
      const cancelado = motivoCorte === 'Cancelado.';
      const error = errorSpawn
        || motivoCorte
        || (codigo !== 0 ? `claude salió con ${codigo}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}` : null);
      resolve({
        success: !error,
        cancelled: cancelado,
        lanzado,
        stdout,
        eventos,
        error,
        codigo
      });
    };

    hijo.stdout.on('data', (c) => {
      const t = c.toString('utf8');
      stdout += t;
      pendiente += t;
      const lineas = pendiente.split(/\r?\n/);
      pendiente = lineas.pop();
      for (const l of lineas) procesarLinea(l);
    });
    hijo.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    hijo.on('error', (err) => cerrar(null, `no se pudo lanzar claude: ${err.message}`));
    hijo.on('close', (codigo) => cerrar(codigo, null));

    // El prompt por stdin, y se cierra: sin EOF, `claude -p` espera.
    hijo.stdin.on('error', () => {});
    hijo.stdin.end(stdin, 'utf8');
  });
}

module.exports = { resolverBinario, versionClaude, ejecutarClaude, buscarEnPath, esShim };
