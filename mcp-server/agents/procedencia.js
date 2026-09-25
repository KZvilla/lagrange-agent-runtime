/**
 * SEC-021 — De dónde salió cada aprendizaje de un agente.
 *
 * El criterio de un agente vive en mcp-memory, que solo guarda el `agent_id`:
 * sin este registro no hay forma de saber si una "decisión" la escribió un
 * cast que leyó una página, con qué motor, cuenta o modelo. Una línea por
 * escritura (directa a la memoria, retenida, promovida o descartada), con el
 * patrón de `lib/historia.js` (BE-028): un JSONL mensual, solo append, sin
 * reescribir ni rotar, bajo `~/.claude/lagrange-procedencia/historia/`
 * (estado de lagrange: lo comparten las dos cuentas).
 *
 * Las almas no pasan por acá: su diario ya es su registro de procedencia.
 *
 * Nunca lanza hacia el cast (regla de `historia.js`): un registro que no se
 * pudo escribir se informa y el turno sigue. La cuarentena sí es fail-closed;
 * esto es la bitácora.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const historia = require('../lib/historia.js');

const DESTINOS = new Set(['memoria', 'cuarentena', 'promovida', 'descartada']);
const MAX_TEXTO = 400;

function dirProcedencia(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'lagrange-procedencia');
}

/**
 * Anota una escritura de criterio. `{ ok }` o `{ ok: false, motivo }`.
 * `entrada`: `{ agente, destino, motor, cuenta, modeloReal, sesion, origen, red,
 * herramientasRed, textos, cuarentenaId, motivo }`.
 */
function anotar(entrada, { homeDir = os.homedir(), ahora = new Date() } = {}) {
  if (!entrada || !DESTINOS.has(entrada.destino)) return { ok: false, motivo: 'destino inválido' };
  const linea = {
    ts: ahora.toISOString(),
    agente: entrada.agente || null,
    destino: entrada.destino,
    motor: entrada.motor || null,
    cuenta: entrada.cuenta || null,
    modeloReal: entrada.modeloReal || null,
    sesion: entrada.sesion || null,
    origen: entrada.origen || null,
    red: entrada.red || null,
    herramientasRed: Array.isArray(entrada.herramientasRed) ? entrada.herramientasRed.slice(0, 20) : [],
    textos: Array.isArray(entrada.textos) ? entrada.textos.map((t) => String(t).slice(0, MAX_TEXTO)).slice(0, 12) : [],
    ...(entrada.cuarentenaId ? { cuarentenaId: entrada.cuarentenaId } : {}),
    ...(entrada.motivo ? { motivo: String(entrada.motivo).slice(0, 200) } : {})
  };
  const r = historia.archivar(dirProcedencia(homeDir), [linea], (e) => e.ts);
  return r.archivadas === 1 ? { ok: true } : { ok: false, motivo: 'no se pudo anexar (ver consola)' };
}

/** Las últimas `n` líneas de los dos meses más recientes (más nuevas al final), por agente si se pide. */
function leer({ agente = null, n = 50, homeDir = os.homedir() } = {}) {
  const dir = path.join(dirProcedencia(homeDir), 'historia');
  let archivos;
  try { archivos = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().slice(-2); } catch { return []; }
  const salida = [];
  for (const f of archivos) {
    let texto = '';
    try { texto = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const l of texto.split(/\r?\n/)) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        if (!agente || e.agente === agente) salida.push(e);
      } catch { /* una línea rota no tapa las demás */ }
    }
  }
  return salida.slice(-n);
}

module.exports = { DESTINOS, dirProcedencia, anotar, leer };
