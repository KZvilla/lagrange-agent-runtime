/**
 * FEAT-199 — Aviso de "informe listo" para la sesión de opencode que pidió una auditoría.
 *
 * Claude se entera por su cursor (FEAT-194) y agy por su status line (FEAT-195 D8). opencode 2.x tiene un inbox
 * por sesión: `session.synthetic` deja ahí un mensaje. Con `resume: true` la despierta y recoge sola, como el buzón de
 * Claude; con `delivery: "queue"`, si estaba en medio de un turno, espera a que termine.
 * v1.78.1 (prueba en vivo de v1.78.0): con `resume: false` la TUI no mostraba la nota, que llegaba recién después del
 * próximo turno del usuario (cuando ya había recogido a mano) y gastaba ese turno igual. El usuario eligió despertar (P2).
 *
 * Se llama una sola vez por informe, desde `audit_queue submit`: `entregar` rechaza un segundo informe (`EAUDITADO`),
 * así que no hace falta cursor. Nunca lanza: el informe ya está entregado y un aviso fallido solo se informa.
 * El auditor no registra nada (I3 de FEAT-195): el aviso va a la sesión del `solicitante`, y a ninguna otra.
 */
const opencodeSession = require('../opencode-session.js');

const TIMEOUT_MS = 10_000;
const RE_SOLICITANTE = /^opencode:(.+)$/;
const RE_VEREDICTO = /^(PASS|PASS WITH RESERVATIONS|FAIL)$/;

/** El session id de opencode de un `solicitante`, o null si no es de opencode o no tiene la forma de `ses_…`. */
function sesionDeSolicitante(solicitante) {
  const m = RE_SOLICITANTE.exec(String(solicitante || ''));
  if (!m) return null;
  return opencodeSession.isOpencodeSessionId(m[1]) ? m[1] : null;
}

/** El texto de la nota. El nombre de la tool es el que ve opencode, con el prefijo `lagrange_`. */
function textoAviso({ id, veredicto }) {
  const v = RE_VEREDICTO.test(String(veredicto || '')) ? ` (Verdict: ${veredicto})` : '';
  return `📋 Lagrange: el informe de la auditoría ${id} está listo${v}. ` +
    `Recogelo con \`lagrange_audit_queue\` (\`action: "collect"\`, \`id: "${id}"\`, \`wait_seconds: 0\`).`;
}

function cuerpoAviso({ id, veredicto }) {
  return {
    text: textoAviso({ id, veredicto }),
    metadata: { lagrange: { feat: 'FEAT-199', id, veredicto: veredicto || null } },
    delivery: 'queue',
    resume: true
  };
}

/** Una línea legible del fallo de `opencode api`, sin el entorno ni el cuerpo enviado. */
function motivoDeSalida({ code, stdout, stderr }) {
  let motivo = '';
  try {
    const j = JSON.parse(String(stdout || '').trim());
    if (j && typeof j === 'object') motivo = [j._tag, j.message].filter(Boolean).join(': ');
  } catch { /* no era JSON */ }
  if (!motivo) motivo = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return una(motivo || `opencode api salió con ${code}`);
}

function una(texto) {
  return String(texto).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Deja la nota en el inbox de la sesión de opencode del solicitante.
 * @returns {Promise<{ avisado: boolean, motivo?: string } | null>} null si el solicitante no es de opencode.
 */
async function avisarOpencode({
  solicitante,
  id,
  veredicto,
  cwd,
  resolveBin = opencodeSession.resolveOpencodeBin,
  runProcess = opencodeSession.runProcess,
  spawnImpl,
  timeoutMs = TIMEOUT_MS
} = {}) {
  if (!RE_SOLICITANTE.test(String(solicitante || ''))) return null;
  const sesion = sesionDeSolicitante(solicitante);
  if (!sesion) return { avisado: false, motivo: 'el pedido no trae un session id de opencode válido' };
  let bin;
  try {
    bin = resolveBin();
  } catch (err) {
    return { avisado: false, motivo: una(`sin opencode: ${err.message}`) };
  }
  const args = ['api', 'session.synthetic', '--param', `sessionID=${sesion}`, '-d', JSON.stringify(cuerpoAviso({ id, veredicto }))];
  try {
    // `runProcess` sanea el entorno (sanitizedEnv: sin secretos ni marcas de host) y lanza con shell: false.
    const r = await runProcess(bin, args, { cwd, timeoutMs, ...(spawnImpl ? { spawnImpl } : {}) });
    if (r.code === 0) return { avisado: true };
    return { avisado: false, motivo: motivoDeSalida(r) };
  } catch (err) {
    return { avisado: false, motivo: una(err.message) };
  }
}

/** La línea que suma la respuesta de `submit`, o '' si el pedido no es de opencode. */
function lineaAviso(resultado) {
  if (!resultado) return '';
  if (resultado.avisado) return 'Aviso en el inbox de la sesión de opencode que lo pidió: la despierta para que lo recoja sola.';
  return `No se pudo avisar a opencode (${resultado.motivo}): que lo recoja a mano.`;
}

module.exports = { avisarOpencode, lineaAviso, textoAviso, cuerpoAviso, sesionDeSolicitante, motivoDeSalida };
