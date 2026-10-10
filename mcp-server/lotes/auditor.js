/** Auditoría adversarial confinada de FEAT-061 fase 3. */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { copiaPlana } = require('./copia.js');
const { sanearId, adaptarResultadoClaude, TIPOS_CLAUDE, MAX_EVENTOS_CLAUDE } = require('./ejecutor.js');
const niveles = require('../motores/niveles.js');
const { armarPromptAuditoriaImplementacion } = require('../adversarial-review.js');
const { armarPromptAdvisor, parsearDecision } = require('./advisor.js');
const { esfuerzoParaCli } = require('../lib/cli-compat.js');
const { esTransitorio, esperaEscalonada, REINTENTOS: REINTENTOS_CAIDA } = require('../lib/reintento.js');
const {
  nombres, argvCrearRed, argvBorrarRed, argvProxy, levantarProxy, argvConectarBridge,
  argvAuditor, argvStop, argvWait, argvRmForzado, verificarInvariantesAuditor,
  verificarInvariantesProxy, sanitizarSalida, argvAuditorClaude, verificarInvariantesAuditorClaude
} = require('./docker.js');

const MAX_DIFF = 256 * 1024;
const MAX_PROMPT = 384 * 1024;
const MAX_REPORTE = 64 * 1024;

/**
 * El modelo, para comparar escritor con auditor: sin el sufijo de esfuerzo. FEAT-153 — Un alias de
 * Claude Code (`sonnet`) y un id completo (`claude-sonnet-4-6`, `claude-3-5-sonnet`) cuentan como la
 * misma familia (`claude-sonnet`): el Juez en agy no puede ser el mismo modelo que un escritor Claude.
 */
function familiaModelo(modelo) {
  const m = String(modelo || '').replace(/-(?:high|medium|low)$/i, '').toLowerCase();
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-|$)/.exec(m) || /^claude-[0-9.-]*(opus|sonnet|haiku|fable)(?:-|$)/.exec(m);
  return claude ? `claude-${claude[1]}` : m;
}

/**
 * FEAT-148 G3 — El auditor siempre corre con agy (su imagen y sus credenciales):
 * un modelo explícito tiene que ser un id que agy entienda. Un alias de Claude
 * Code (`sonnet`, `opus`) pasaba la validación y el lote fallaba recién al auditar.
 */
const RE_MODELO_AGY = /^(gemini|claude|gpt-oss)-[a-z0-9.-]+$/i;

/** FEAT-155 — Un modelo de Claude Code (alias o id); el catálogo (`niveles.js`) lo valida al armar el lote. */
const RE_MODELO_CLAUDE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/**
 * El modelo del Juez (o del Advisor). Con agy, un id de agy; FEAT-155 — con `motor: 'claude'`, uno de Claude.
 * En los dos casos, de otra familia que quien escribe.
 */
function elegirModeloAuditor(modeloEscritor, override, { motor = 'antigravity' } = {}) {
  const escritor = familiaModelo(modeloEscritor || 'gemini-3.8-flash');
  if (motor === 'claude') {
    if (override && (!RE_MODELO_CLAUDE.test(String(override)) || /^(gemini|gpt-oss)/i.test(String(override)))) {
      throw new Error(`el modelo del Juez ${JSON.stringify(String(override).slice(0, 80))} no es un modelo de Claude`);
    }
    const modelo = override || (escritor === 'claude-sonnet' ? 'haiku' : 'sonnet');
    if (familiaModelo(modelo) === escritor) throw new Error(`el modelo auditor debe ser distinto del escritor (${escritor})`);
    return modelo;
  }
  if (override) {
    if (!RE_MODELO_AGY.test(String(override))) {
      throw new Error(`el modelo auditor ${JSON.stringify(String(override).slice(0, 80))} no es un modelo de agy (gemini-*, claude-*, gpt-oss-*): la auditoría siempre corre con agy`);
    }
    if (familiaModelo(override) === escritor) throw new Error(`el modelo auditor debe ser distinto del escritor (${escritor})`);
    return override;
  }
  return escritor.includes('flash') ? 'gemini-3.1-pro' : 'gemini-3.8-flash';
}

/** Solo si hubo: una auditoría sin reintentos queda igual que antes de BE-123. */
function marcaReintentos(reintentos, esperaReintentoMs) {
  return reintentos ? { reintentos, esperaReintentoMs } : {};
}

function elegirEsfuerzoAuditor(modelo, { motor = 'antigravity' } = {}) {
  // FEAT-155 — Con Claude, `high` si el modelo admite esfuerzo; si no, el implícito del modelo.
  if (motor === 'claude') return niveles.admiteNivel('claude', modelo, 'high') ? 'high' : null;
  return esfuerzoParaCli({ modelo, pedido: null, porDefecto: 'high' });
}

function parsearVeredicto(reporte) {
  const m = /^## Verdict:\s*(PASS WITH RESERVATIONS|PASS|FAIL)\s*$/mi.exec(String(reporte || ''));
  return m ? m[1].toUpperCase() : null;
}

/** BE-104 — Asíncrono: la auditoría del lote corre en el daemon. */
function git(repo, args) {
  return new Promise((resolve, reject) => {
    const hijo = execFile('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_DIFF + 4096 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    hijo.stdin?.end();
  });
}

async function evidenciaCommit({ worktree, commit, base = null }) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(commit || ''))) throw new Error('commit inválido para auditoría');
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  const exacto = (await git(worktree, ['rev-parse', commit])).trim();
  if (head !== exacto) throw new Error(`el HEAD del worktree cambió (${head.slice(0, 8)} != ${exacto.slice(0, 8)})`);
  // FEAT-149 F2 — Desde la vuelta 2: el diff acumulado desde la base de la tarea (todas sus vueltas), no solo el último commit.
  if (base != null && !/^[0-9a-f]{7,64}$/i.test(String(base))) throw new Error('base inválida para auditoría');
  const diff = base
    ? await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', base, exacto, '--'])
    : await git(worktree, ['show', '--no-ext-diff', '--no-textconv', '--format=', '--no-color', exacto, '--']);
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
  // FEAT-155 — El Juez de Claude corre como una tarea de Claude (stream de Claude, prompt desde /pedido).
  ejecutarStream = null,
  registrarLlamada = null,
  terminarCliente,
  dormir = ms => new Promise(r => setTimeout(r, ms)),
  azar = Math.random,
  log = () => {}
}) {
  // F4b — `rol: 'advisor'`: el mismo contenedor y la misma evidencia, con el pedido y el parser del Advisor.
  // FEAT-155 — `motor: 'claude'` (con su `cuenta`): la imagen de Claude, de solo lectura, con las credenciales de esa
  // cuenta. Las credenciales vigentes tienen que ser las de ese motor: si no, no corre (lo garantiza el turno).
  return async function auditar({ taskId, worktree, commit, promptTarea, archivos, prueba, modeloEscritor, modeloAuditor, criterio = null, base = null, rol = 'juez',
    motor = 'antigravity', cuenta = null }) {
    const advisor = rol === 'advisor';
    const esClaude = motor === 'claude';
    const id = sanearId(taskId);
    const n = nombres(idLote, id);
    const copia = path.join(raizCopias, idLote, `${id}-auditoria`);
    const dirPedido = `${copia}-pedido`;
    const inicio = Date.now();
    let ultimoError = null;
    // BE-123 — Reintentos por caída transitoria (503/UNAVAILABLE) y lo esperado
    // entre ellos: el reloj del lote no debe leerlos como trabajo del auditor.
    let reintentos = 0;
    let esperaReintentoMs = 0;
    try {
      const diff = await evidenciaCommit({ worktree, commit, base });
      const modelo = elegirModeloAuditor(modeloEscritor, modeloAuditor, { motor });
      const effort = elegirEsfuerzoAuditor(modelo, { motor });
      if (esClaude && typeof ejecutarStream !== 'function') throw new Error('el Juez de Claude necesita ejecutarStream');
      if ((credenciales.motor === 'claude') !== esClaude || (esClaude && credenciales.cuenta !== cuenta)) {
        throw new Error(`las credenciales vigentes (${credenciales.motor === 'claude' ? `claude@${credenciales.cuenta}` : 'agy'}) no son las del Juez (${esClaude ? `claude@${cuenta}` : 'agy'})`);
      }
      const delimitador = randomBytes(16).toString('hex');
      // FEAT-149 — El criterio de la receta es del usuario (confiable): va en el plan, no en un bloque de evidencia.
      const plan = `${String(promptTarea || '')}\n\nArchivos autorizados: ${(archivos || []).join(', ')}`
        + (criterio ? `\n\n## Additional review criteria (from the user's recipe)\n\n${String(criterio)}` : '');
      const prompt = (advisor ? armarPromptAdvisor : armarPromptAuditoriaImplementacion)({ plan, diff, resultadosPrueba: JSON.stringify(prueba || {}, null, 2), delimitador });
      if (Buffer.byteLength(prompt) > MAX_PROMPT) throw new Error(`el prompt de auditoría supera ${MAX_PROMPT} bytes`);

      let porCuota = 0;
      let porCaida = 0;
      for (let intento = 0; ; intento++) {
        const traceId = `lote:${idLote}:${advisor ? 'advisor' : 'audit'}:${id}:${intento + 1}`;
        fs.rmSync(copia, { recursive: true, force: true });
        await copiaPlana({ worktree, destino: copia, raizPermitida: raizCopias, fiel: true });
        const montaje = await aWsl(copia);
        await credenciales.asegurarVida(25);
        await docker(argvRmForzado(n.auditor), { permitirFallo: true });
        await docker(argvRmForzado(n.proxyAuditor), { permitirFallo: true });
        await docker(argvBorrarRed(n.redAuditor), { permitirFallo: true });
        await docker(argvCrearRed(n.redAuditor, idLote, expiraEpoch));
        const perfil = esClaude ? 'tarea-claude' : 'tarea';
        const proxy = argvProxy({ nombreProxy: n.proxyAuditor, nombreRed: n.redAuditor, perfil, volumenSecreto: credenciales.volumenSecretoProxy, idLote, expiraEpoch });
        const problemasProxy = verificarInvariantesProxy(proxy, perfil);
        if (problemasProxy.length) throw new Error(`invariantes proxy: ${problemasProxy.join('; ')}`);
        await levantarProxy(docker, proxy, n.proxyAuditor);
        await docker(argvConectarBridge(n.proxyAuditor));
        const terminate = child => {
          docker(argvStop(n.auditor, 10), { permitirFallo: true }).catch(() => {});
          if (terminarCliente) terminarCliente(child);
        };
        let res;
        if (esClaude) {
          fs.rmSync(dirPedido, { recursive: true, force: true });
          fs.mkdirSync(dirPedido, { recursive: true });
          fs.writeFileSync(path.join(dirPedido, 'PROMPT.md'), prompt, 'utf8');
          const argv = argvAuditorClaude({ nombres: n, rutaCopia: montaje, rutaPedido: await aWsl(dirPedido), modelo, effort, idLote, expiraEpoch });
          const problemas = verificarInvariantesAuditorClaude(argv);
          if (problemas.length) throw new Error(`invariantes del Juez de Claude: ${problemas.join('; ')}`);
          const eventos = [];
          const crudo = await ejecutarStream('wsl', ['-e', 'docker', ...argv], {
            cwd: worktree, timeoutMinutes: 25, agregarOutputFormat: false, terminate,
            onLine: (linea) => {
              if (eventos.length >= MAX_EVENTOS_CLAUDE) return;
              try { const ev = JSON.parse(linea); if (ev && TIPOS_CLAUDE.has(ev.type)) eventos.push(ev); } catch { /* no es JSON */ }
            }
          });
          res = adaptarResultadoClaude(crudo, eventos);
          if (typeof registrarLlamada === 'function') {
            const d = res.data || {};
            registrarLlamada({ tool: advisor ? 'lote-advisor' : 'lote-juez', motor: `claude@${cuenta}`, modelo, modeloReal: d.modelo_real || null, esfuerzo: effort,
              conversationId: d.conversation_id || null, duracion: d.duration_seconds || 0, usage: d.usage || null, error: res.success ? null : (res.error || 'falló'),
              costoUsd: d.costo_usd ?? null, cuota: d.cuota || null });
          }
        } else {
          const argv = argvAuditor({ nombres: n, rutaCopia: montaje, modelo, effort, idLote, expiraEpoch });
          const problemas = verificarInvariantesAuditor(argv);
          if (problemas.length) throw new Error(`invariantes auditor: ${problemas.join('; ')}`);
          res = await ejecutarStdin('wsl', prompt, ['-e', 'docker', ...argv], {
            cwd: worktree,
            timeoutMinutes: 25,
            agregarFormatos: false,
            traceId,
            log: (linea) => log(String(linea).trimEnd()),
            terminate
          });
        }
        await docker(argvWait(n.auditor), { permitirFallo: true });
        const reporte = String((res.data && res.data.response) || res.rawOutput || res.stdout || '');
        if (res.success && advisor) {
          const consejo = parsearDecision(reporte);
          if (!consejo) throw new Error('el Advisor no devolvió un encabezado de decisión válido');
          if (Buffer.byteLength(reporte) > MAX_REPORTE) throw new Error(`el reporte supera ${MAX_REPORTE} bytes`);
          return { estado: 'completa', ...consejo, modelo, motor, conversation_id: res.data && res.data.conversation_id || null, reporte, error: null, duracionMs: Date.now() - inicio, usage: res.data && res.data.usage, ...marcaReintentos(reintentos, esperaReintentoMs) };
        }
        if (res.success) {
          const veredicto = parsearVeredicto(reporte);
          if (!veredicto) throw new Error('la auditoría no devolvió un encabezado de veredicto válido');
          if (Buffer.byteLength(reporte) > MAX_REPORTE) throw new Error(`el reporte supera ${MAX_REPORTE} bytes`);
          return { estado: 'completa', veredicto, modelo, motor, conversation_id: res.data && res.data.conversation_id || null, reporte, error: null, duracionMs: Date.now() - inicio, usage: res.data && res.data.usage, ...marcaReintentos(reintentos, esperaReintentoMs) };
        }
        ultimoError = sanitizarSalida(res.error || 'auditoría sin respuesta');
        // BE-049 — Un corte por --print-timeout trae la respuesta parcial en el
        // error: si menciona "quota" no es una cuota, y reintentar no sirve.
        if (res.parcial || res.cancelled) break;
        let esperaMs;
        if (/\b429\b|quota|rate.?limit/i.test(ultimoError)) {
          if (porCuota >= 1) break;
          porCuota++;
          esperaMs = 20000;
        } else if (esTransitorio(ultimoError)) {
          // BE-123 — Retirada exponencial con jitter, como recomienda Google para el 503.
          if (porCaida >= REINTENTOS_CAIDA) break;
          esperaMs = esperaEscalonada(porCaida, { azar });
          porCaida++;
          log(`auditoría ${id}: caída transitoria de agy, reintento ${porCaida}/${REINTENTOS_CAIDA} en ${Math.round(esperaMs / 1000)} s`);
        } else break;
        reintentos++;
        esperaReintentoMs += esperaMs;
        await dormir(esperaMs);
      }
      return { estado: 'error', veredicto: null, modelo: elegirModeloAuditor(modeloEscritor, modeloAuditor, { motor }), motor, conversation_id: null, reporte: '', error: String(ultimoError || 'auditoría fallida').slice(0, 300), duracionMs: Date.now() - inicio, ...marcaReintentos(reintentos, esperaReintentoMs) };
    } catch (err) {
      return { estado: 'error', veredicto: null, modelo: null, conversation_id: null, reporte: '', error: sanitizarSalida(err.message).slice(0, 300), duracionMs: Date.now() - inicio, ...marcaReintentos(reintentos, esperaReintentoMs) };
    } finally {
      await docker(argvRmForzado(n.auditor), { permitirFallo: true });
      await docker(argvRmForzado(n.proxyAuditor), { permitirFallo: true });
      await docker(argvBorrarRed(n.redAuditor), { permitirFallo: true });
      try { fs.rmSync(copia, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dirPedido, { recursive: true, force: true }); } catch {}
      try { fs.rmdirSync(path.join(raizCopias, idLote)); } catch {}
    }
  };
}

module.exports = { MAX_DIFF, MAX_PROMPT, MAX_REPORTE, RE_MODELO_CLAUDE, familiaModelo, elegirModeloAuditor, elegirEsfuerzoAuditor, parsearVeredicto, evidenciaCommit, crearAuditor };
