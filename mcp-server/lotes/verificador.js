/** Verificación mecánica confinada de FEAT-061 fase 3. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { copiaPlana } = require('./copia.js');
const { sanearId } = require('./ejecutor.js');
const {
  nombres, argvVerificador, verificarInvariantesVerificador,
  argvRmForzado, argvStop, argvWait, sanitizarSalida, validarArgvPrueba
} = require('./docker.js');

const comandosRepo = require('./comandos-repo.js');

const MAX_SALIDA = 16 * 1024;

function ejecutarAcotado(bin, args, { timeoutMs, alTimeout } = {}) {
  return new Promise((resolve) => {
    let child;
    let salida = '';
    let truncada = false;
    let terminado = false;
    const agregar = (chunk) => {
      salida += chunk.toString('utf8');
      if (salida.length > MAX_SALIDA) {
        salida = salida.slice(-MAX_SALIDA);
        truncada = true;
      }
    };
    try {
      child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: null, error: err.message, salida: '', salidaTruncada: false, timeout: false });
    }
    child.stdout.on('data', agregar);
    child.stderr.on('data', agregar);
    child.on('error', err => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      resolve({ code: null, error: err.message, salida, salidaTruncada: truncada, timeout: false });
    });
    child.on('close', code => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      resolve({ code, error: null, salida, salidaTruncada: truncada, timeout: false });
    });
    const timer = setTimeout(() => {
      if (terminado) return;
      terminado = true;
      try { if (alTimeout) alTimeout(child); } catch {}
      try { child.kill('SIGKILL'); } catch {}
      resolve({ code: null, error: 'timeout', salida, salidaTruncada: truncada, timeout: true });
    }, timeoutMs);
  });
}

function validarPrueba(prueba) {
  if (prueba == null) return null;
  if (!prueba || typeof prueba !== 'object') throw new Error('prueba debe ser un objeto');
  const argv = validarArgvPrueba(prueba.argv);
  const timeout = prueba.timeout_minutes == null ? 10 : Number(prueba.timeout_minutes);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 15) throw new Error('prueba.timeout_minutes debe estar entre 0 y 15');
  return { argv, timeout_minutes: timeout };
}

function crearVerificador({ docker, aWsl, raizCopias, idLote, expiraEpoch, ejecutarProceso = ejecutarAcotado, comandos: libComandos = comandosRepo }) {
  /** Un paso en el contenedor del verificador (sin red), sobre la copia ya montada. */
  async function correrPaso(n, montaje, argvPaso, minutos) {
    const inicio = Date.now();
    const argv = argvVerificador({ nombre: n.verificador, rutaCopia: montaje, argv: argvPaso, idLote, expiraEpoch });
    const problemas = verificarInvariantesVerificador(argv);
    if (problemas.length) throw new Error(`invariantes: ${problemas.join('; ')}`);
    await docker(argvRmForzado(n.verificador), { permitirFallo: true });
    const r = await ejecutarProceso('wsl', ['-e', 'docker', ...argv], {
      timeoutMs: minutos * 60 * 1000,
      alTimeout: (child) => {
        docker(argvStop(n.verificador, 10), { permitirFallo: true }).catch(() => {});
        try { child.kill('SIGKILL'); } catch {}
      }
    });
    await docker(argvWait(n.verificador), { permitirFallo: true });
    await docker(argvRmForzado(n.verificador), { permitirFallo: true });
    return {
      estado: r.timeout ? 'timeout' : (r.error ? 'error' : (r.code === 0 ? 'paso' : 'fallo')),
      argv: argvPaso,
      exitCode: r.code,
      duracionMs: Date.now() - inicio,
      salida: sanitizarSalida(r.salida).slice(-MAX_SALIDA),
      salidaTruncada: !!r.salidaTruncada,
      ...(r.error && !r.timeout ? { error: sanitizarSalida(r.error).slice(0, 300) } : {})
    };
  }

  /**
   * FEAT-149 — Prueba de la tarea + comandos del repo, en ese orden, cortando en
   * el primero que falla. Los comandos se leen del commit del que nació el
   * worktree (nunca del commit de la tarea). La raíz es la que lee
   * `evaluarIntegrable`: sin prueba de la tarea queda «no configurada» aunque
   * los comandos pasen; si no, el primer paso que no pasó, o la prueba.
   */
  async function verificarConPasos({ taskId, worktree, declarada, comandos, commit, ramaBase, repo }) {
    const id = sanearId(taskId);
    const n = nombres(idLote, id);
    const copia = path.join(raizCopias, idLote, `${id}-verificacion`);
    const inicio = Date.now();
    const pasos = [];
    try {
      let lista;
      try {
        const base = await libComandos.baseDeTarea(repo, commit, ramaBase);
        lista = libComandos.resolverComandos(await libComandos.leerComandosRepo(repo, base), comandos).map((c) => ({ ...c, base }));
      } catch (err) {
        pasos.push({ origen: 'repo', nombre: 'comandos', estado: 'error', argv: null, exitCode: null, duracionMs: 0, salida: '', salidaTruncada: false, error: sanitizarSalida(err.message).slice(0, 300) });
        lista = null;
      }
      const plan = [
        ...(declarada ? [{ origen: 'tarea', nombre: 'prueba', argv: declarada.argv, timeout_minutes: declarada.timeout_minutes }] : []),
        ...(lista || []).map((c) => ({ origen: 'repo', nombre: c.nombre, argv: c.argv, timeout_minutes: c.timeout_minutes, base: c.base }))
      ];
      if (lista) {
        await copiaPlana({ worktree, destino: copia, raizPermitida: raizCopias, fiel: true });
        const montaje = await aWsl(copia);
        let corto = false;
        for (const p of plan) {
          if (corto) { pasos.push({ origen: p.origen, nombre: p.nombre, estado: 'omitida', argv: p.argv, exitCode: null, duracionMs: 0, salida: '', salidaTruncada: false }); continue; }
          let r;
          try { r = await correrPaso(n, montaje, p.argv, p.timeout_minutes); }
          catch (err) { r = { estado: 'error', argv: p.argv, exitCode: null, duracionMs: 0, salida: '', salidaTruncada: false, error: sanitizarSalida(err.message).slice(0, 300) }; }
          pasos.push({ origen: p.origen, nombre: p.nombre, ...(p.base ? { base: p.base } : {}), ...r });
          if (r.estado !== 'paso') corto = true;
        }
      }
    } catch (err) {
      // Como el camino de siempre: un fallo de infraestructura (copia, montaje) es un resultado, no una excepción.
      pasos.push({ origen: 'tarea', nombre: 'preparar', estado: 'error', argv: declarada ? declarada.argv : null, exitCode: null, duracionMs: 0, salida: '', salidaTruncada: false, error: sanitizarSalida(err.message).slice(0, 300) });
    } finally {
      await docker(argvRmForzado(n.verificador), { permitirFallo: true });
      try { fs.rmSync(copia, { recursive: true, force: true }); } catch {}
      try { fs.rmdirSync(path.join(raizCopias, idLote)); } catch {}
    }
    const duracionMs = Date.now() - inicio;
    if (!declarada) return { estado: 'no configurada', argv: null, exitCode: null, duracionMs, salida: '', salidaTruncada: false, pasos };
    const decide = pasos.find((p) => p.estado !== 'paso' && p.estado !== 'omitida') || pasos.find((p) => p.origen === 'tarea');
    const { origen: _o, nombre: _n, base: _b, ...raiz } = decide;
    return { ...raiz, duracionMs, pasos };
  }

  return async function verificar({ taskId, worktree, prueba, comandos = null, commit = null, ramaBase = null, repo = null }) {
    const declarada = validarPrueba(prueba);
    if (comandos && comandos.length) return verificarConPasos({ taskId, worktree, declarada, comandos, commit, ramaBase, repo });
    if (!declarada) return { estado: 'no configurada', argv: null, exitCode: null, duracionMs: 0, salida: '', salidaTruncada: false };
    const id = sanearId(taskId);
    const n = nombres(idLote, id);
    const copia = path.join(raizCopias, idLote, `${id}-verificacion`);
    const inicio = Date.now();
    try {
      await copiaPlana({ worktree, destino: copia, raizPermitida: raizCopias, fiel: true });
      const montaje = await aWsl(copia);
      const argv = argvVerificador({ nombre: n.verificador, rutaCopia: montaje, argv: declarada.argv, idLote, expiraEpoch });
      const problemas = verificarInvariantesVerificador(argv);
      if (problemas.length) throw new Error(`invariantes: ${problemas.join('; ')}`);
      await docker(argvRmForzado(n.verificador), { permitirFallo: true });
      const r = await ejecutarProceso('wsl', ['-e', 'docker', ...argv], {
        timeoutMs: declarada.timeout_minutes * 60 * 1000,
        alTimeout: (child) => {
          docker(argvStop(n.verificador, 10), { permitirFallo: true }).catch(() => {});
          try { child.kill('SIGKILL'); } catch {}
        }
      });
      await docker(argvWait(n.verificador), { permitirFallo: true });
      await docker(argvRmForzado(n.verificador), { permitirFallo: true });
      return {
        estado: r.timeout ? 'timeout' : (r.error ? 'error' : (r.code === 0 ? 'paso' : 'fallo')),
        argv: declarada.argv,
        exitCode: r.code,
        duracionMs: Date.now() - inicio,
        salida: sanitizarSalida(r.salida).slice(-MAX_SALIDA),
        salidaTruncada: !!r.salidaTruncada,
        ...(r.error && !r.timeout ? { error: sanitizarSalida(r.error).slice(0, 300) } : {})
      };
    } catch (err) {
      return { estado: 'error', argv: declarada.argv, exitCode: null, duracionMs: Date.now() - inicio, salida: '', salidaTruncada: false, error: sanitizarSalida(err.message).slice(0, 300) };
    } finally {
      await docker(argvRmForzado(n.verificador), { permitirFallo: true });
      try { fs.rmSync(copia, { recursive: true, force: true }); } catch {}
      try { fs.rmdirSync(path.join(raizCopias, idLote)); } catch {}
    }
  };
}

module.exports = { MAX_SALIDA, ejecutarAcotado, validarPrueba, crearVerificador };
