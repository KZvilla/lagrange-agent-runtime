/** Auditoría adversarial confinada de FEAT-061 fase 3. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { copiaPlana } = require('./copia.js');
const { sanearId } = require('./ejecutor.js');
const { armarPromptAuditoriaImplementacion } = require('../adversarial-review.js');
const { esfuerzoParaCli } = require('../lib/cli-compat.js');
const {
  nombres, argvCrearRed, argvBorrarRed, argvProxy, levantarProxy, argvConectarBridge,
  argvAuditor, argvStop, argvWait, argvRmForzado, verificarInvariantesAuditor,
  verificarInvariantesProxy, sanitizarSalida
} = require('./docker.js');

const MAX_DIFF = 256 * 1024;
const MAX_PROMPT = 384 * 1024;
const MAX_REPORTE = 64 * 1024;

function familiaModelo(modelo) {
  return String(modelo || '').replace(/-(?:high|medium|low)$/i, '').toLowerCase();
}

function elegirModeloAuditor(modeloEscritor, override) {
  const escritor = familiaModelo(modeloEscritor || 'gemini-3.8-flash');
  if (override) {
    if (familiaModelo(override) === escritor) throw new Error(`el modelo auditor debe ser distinto del escritor (${escritor})`);
    return override;
  }
  return escritor.includes('flash') ? 'gemini-3.1-pro' : 'gemini-3.8-flash';
}

function elegirEsfuerzoAuditor(modelo) {
  return esfuerzoParaCli({ modelo, pedido: null, porDefecto: 'high' });
}

function parsearVeredicto(reporte) {
  const m = /^## Verdict:\s*(PASS WITH RESERVATIONS|PASS|FAIL)\s*$/mi.exec(String(reporte || ''));
  return m ? m[1].toUpperCase() : null;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_DIFF + 4096 });
}

function evidenciaCommit({ worktree, commit }) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(commit || ''))) throw new Error('commit inválido para auditoría');
  const head = git(worktree, ['rev-parse', 'HEAD']).trim();
  const exacto = git(worktree, ['rev-parse', commit]).trim();
  if (head !== exacto) throw new Error(`el HEAD del worktree cambió (${head.slice(0, 8)} != ${exacto.slice(0, 8)})`);
  const diff = git(worktree, ['show', '--no-ext-diff', '--no-textconv', '--format=', '--no-color', exacto, '--']);
  if (Buffer.byteLength(diff) > MAX_DIFF) throw new Error(`el diff supera ${MAX_DIFF} bytes`);
  return diff;
}

function crearAuditor({
  docker,
  aWsl,
  raizCopias,
  idLote,
  expiraEpoch,
  credenciales,
  ejecutarStdin,
  terminarCliente,
  dormir = ms => new Promise(r => setTimeout(r, ms)),
  log = () => {}
}) {
  return async function auditar({ taskId, worktree, commit, promptTarea, archivos, prueba, modeloEscritor, modeloAuditor }) {
    const id = sanearId(taskId);
    const n = nombres(idLote, id);
    const copia = path.join(raizCopias, idLote, `${id}-auditoria`);
    const inicio = Date.now();
    let ultimoError = null;
    try {
      const diff = evidenciaCommit({ worktree, commit });
      const modelo = elegirModeloAuditor(modeloEscritor, modeloAuditor);
      const effort = elegirEsfuerzoAuditor(modelo);
      const delimitador = randomBytes(16).toString('hex');
      const plan = `${String(promptTarea || '')}\n\nArchivos autorizados: ${(archivos || []).join(', ')}`;
      const prompt = armarPromptAuditoriaImplementacion({ plan, diff, resultadosPrueba: JSON.stringify(prueba || {}, null, 2), delimitador });
      if (Buffer.byteLength(prompt) > MAX_PROMPT) throw new Error(`el prompt de auditoría supera ${MAX_PROMPT} bytes`);

      for (let intento = 0; intento < 2; intento++) {
        const traceId = `lote:${idLote}:audit:${id}:${intento + 1}`;
        fs.rmSync(copia, { recursive: true, force: true });
        copiaPlana({ worktree, destino: copia, raizPermitida: raizCopias });
        const montaje = await aWsl(copia);
        await credenciales.asegurarVida(25);
        await docker(argvRmForzado(n.auditor), { permitirFallo: true });
        await docker(argvRmForzado(n.proxyAuditor), { permitirFallo: true });
        await docker(argvBorrarRed(n.redAuditor), { permitirFallo: true });
        await docker(argvCrearRed(n.redAuditor, idLote, expiraEpoch));
        const proxy = argvProxy({ nombreProxy: n.proxyAuditor, nombreRed: n.redAuditor, perfil: 'tarea', volumenSecreto: credenciales.volumenSecretoProxy, idLote, expiraEpoch });
        const problemasProxy = verificarInvariantesProxy(proxy, 'tarea');
        if (problemasProxy.length) throw new Error(`invariantes proxy: ${problemasProxy.join('; ')}`);
        await levantarProxy(docker, proxy, n.proxyAuditor);
        await docker(argvConectarBridge(n.proxyAuditor));
        const argv = argvAuditor({ nombres: n, rutaCopia: montaje, modelo, effort, idLote, expiraEpoch });
        const problemas = verificarInvariantesAuditor(argv);
        if (problemas.length) throw new Error(`invariantes auditor: ${problemas.join('; ')}`);
        const res = await ejecutarStdin('wsl', prompt, ['-e', 'docker', ...argv], {
          cwd: worktree,
          timeoutMinutes: 25,
          agregarFormatos: false,
          traceId,
          log: (linea) => log(String(linea).trimEnd()),
          terminate: child => {
            docker(argvStop(n.auditor, 10), { permitirFallo: true }).catch(() => {});
            if (terminarCliente) terminarCliente(child);
          }
        });
        await docker(argvWait(n.auditor), { permitirFallo: true });
        const reporte = String((res.data && res.data.response) || res.rawOutput || res.stdout || '');
        if (res.success) {
          const veredicto = parsearVeredicto(reporte);
          if (!veredicto) throw new Error('la auditoría no devolvió un encabezado de veredicto válido');
          if (Buffer.byteLength(reporte) > MAX_REPORTE) throw new Error(`el reporte supera ${MAX_REPORTE} bytes`);
          return { estado: 'completa', veredicto, modelo, conversation_id: res.data && res.data.conversation_id || null, reporte, error: null, duracionMs: Date.now() - inicio, usage: res.data && res.data.usage };
        }
        ultimoError = sanitizarSalida(res.error || 'auditoría sin respuesta');
        if (!/\b429\b|quota|rate.?limit/i.test(ultimoError) || intento === 1) break;
        await dormir(20000);
      }
      return { estado: 'error', veredicto: null, modelo: elegirModeloAuditor(modeloEscritor, modeloAuditor), conversation_id: null, reporte: '', error: String(ultimoError || 'auditoría fallida').slice(0, 300), duracionMs: Date.now() - inicio };
    } catch (err) {
      return { estado: 'error', veredicto: null, modelo: null, conversation_id: null, reporte: '', error: sanitizarSalida(err.message).slice(0, 300), duracionMs: Date.now() - inicio };
    } finally {
      await docker(argvRmForzado(n.auditor), { permitirFallo: true });
      await docker(argvRmForzado(n.proxyAuditor), { permitirFallo: true });
      await docker(argvBorrarRed(n.redAuditor), { permitirFallo: true });
      try { fs.rmSync(copia, { recursive: true, force: true }); } catch {}
      try { fs.rmdirSync(path.join(raizCopias, idLote)); } catch {}
    }
  };
}

module.exports = { MAX_DIFF, MAX_PROMPT, MAX_REPORTE, familiaModelo, elegirModeloAuditor, elegirEsfuerzoAuditor, parsearVeredicto, evidenciaCommit, crearAuditor };
