/**
 * FEAT-071 — El motor `antigravity`: traduce un pedido por intención al argv de
 * agy e interpreta lo que devuelve su ejecutor.
 *
 * Los llamadores (charla, consolidación, cast) piden un PERFIL, no flags. La
 * seguridad vive en la traducción de cada perfil, en un solo lugar: sin esto,
 * un segundo motor (FEAT-072) repetiría las decisiones de "sin tools, nunca
 * skip" con los flags de otro CLI, donde significan otra cosa.
 *
 * Lo que este módulo NO hace: lanzar procesos. El ciclo de vida (spawn,
 * watchdog, abort, streaming, descarga de prompts largos, `--print-timeout`)
 * sigue en el `ejecutar` que inyecta cada llamador, igual que antes.
 *
 * Contrato común a todo motor: `perfiles`, `preflight`, `armar`, `interpretar`.
 * Lo que devuelve `armar` es de cada motor (acá, el argv que espera
 * `ejecutar`), y por eso cada uno declara `ejecutor`.
 *
 * Pedido:
 *   { prompt, perfil: 'sin-tools'|'lectura'|'edicion', cast?, modelo?, esfuerzo?,
 *     hilo?: string|null, formato: 'json'|'stream', origen? }
 *
 * BE-039 — `origen` (usuario | programado | fondo | orquestador) lo fija quien
 * inicia el lanzamiento; sin él es `usuario`. Las políticas comunes (modelo
 * explícito, freno de cuota) viven en `politicas.js`.
 */

const os = require('node:os');
const agente = require('../almas/agente.js');
const registro = require('../agents/registry.js');
const { esfuerzoParaCli } = require('../lib/cli-compat.js');
const { verificarPoliticas } = require('./politicas.js');

const PERFILES = ['sin-tools', 'lectura', 'edicion'];

function formatoDeAgy(formato) {
  return formato === 'stream' ? 'stream-json' : 'json';
}

function validarPedido(pedido) {
  if (!pedido || typeof pedido !== 'object') throw new Error('motor antigravity: falta el pedido.');
  if (!PERFILES.includes(pedido.perfil)) throw new Error(`motor antigravity: perfil desconocido "${pedido.perfil}".`);
  if (pedido.perfil === 'sin-tools' && pedido.cast) {
    // El alma corre siempre como `lagrange-alma`: un cast acá cambiaría el agente
    // por uno con tools sin que nadie lo note.
    throw new Error('motor antigravity: el perfil sin-tools no admite `cast`.');
  }
  if (pedido.perfil !== 'sin-tools' && !pedido.cast) {
    throw new Error(`motor antigravity: el perfil ${pedido.perfil} necesita \`cast\`.`);
  }
}

/**
 * Lo único con I/O. Fail-closed: un pedido `sin-tools` a un motor que no lo
 * tiene `verificado` se rechaza antes del spawn, sin degradar a otro perfil.
 *
 * `contexto` es extensible (SEC-018 y FEAT-072 le suman campos): cada motor
 * lee lo que necesita. Acá, `agyBin` y `homeDir`, y para las políticas
 * comunes `config` y `leerCuota` (BE-039).
 *
 * Devuelve `{ ok: true }` o `{ ok: false, motivo, error? }`; `error` es el
 * mensaje crudo cuando falló la instalación del `agent.md`, para el llamador
 * que lo informa sin el envoltorio.
 */
async function preflight(pedido, contexto = {}) {
  const { agyBin, homeDir = os.homedir() } = contexto;
  try {
    validarPedido(pedido);
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
  const politicas = verificarPoliticas(module.exports, pedido, contexto);
  if (!politicas.ok) return politicas;

  if (pedido.perfil === 'sin-tools') {
    if (module.exports.perfiles['sin-tools'] !== 'verificado') {
      return { ok: false, motivo: 'el motor antigravity no tiene verificado el perfil sin-tools; no se lanza.' };
    }
    try {
      agente.asegurarAgente(homeDir);
    } catch (err) {
      return { ok: false, motivo: `no se pudo instalar su agent.md (${err.message})`, error: err.message };
    }
    return agente.verificar(agyBin);
  }

  return registro.verificarResuelve(pedido.cast, agyBin);
}

/** Pedido → argv de agy. Puro. Sin `--print-timeout` ni `--add-dir`: son del ejecutor. */
function armar(pedido) {
  validarPedido(pedido);
  const { prompt, perfil, cast, modelo, esfuerzo, hilo, formato } = pedido;

  if (perfil === 'sin-tools') {
    // Nunca skip: sin él, agy niega sola el roster MCP del usuario (SEC-010).
    return [
      ...agente.argsBase({ modelo, esfuerzo, formato: formatoDeAgy(formato) }),
      ...(hilo ? ['--conversation', hilo] : []),
      '-p', prompt
    ];
  }

  const args = ['--output-format', formatoDeAgy(formato), '--agent', cast, '--dangerously-skip-permissions'];
  // `plan` con skip corre comandos: es una segunda capa, no una barrera. Por eso
  // `lectura` queda `declarado` y ninguna superficie con memoria del alma lo pide.
  if (perfil === 'lectura') args.push('--mode', 'plan');
  const efectivo = esfuerzoParaCli({ modelo, pedido: esfuerzo });
  if (efectivo) args.push('--effort', efectivo);
  if (modelo) args.push('--model', modelo);
  if (hilo) args.push('--conversation', hilo);
  args.push('-p', prompt);
  return args;
}

/**
 * Lo que devuelve `ejecutar` (`{ success, data, rawOutput, cancelled, error }`)
 * → un resultado neutral. Puro: el parseo de stdout sigue en el ejecutor.
 * `hilo` es solo el que informó agy; el respaldo al hilo pedido es del llamador.
 *
 * BE-039 — `modeloReal`: agy no informa qué modelo corrió, así que se rotula lo
 * pedido y, sin pedido, `'(default de agy)'`. No se inventa un modelo. agy
 * tampoco da costo ni cuota.
 */
function interpretar(resultado, pedido = null) {
  const r = resultado || {};
  const datos = r.data || {};
  return {
    ok: Boolean(r.success),
    cancelado: Boolean(r.cancelled),
    texto: datos.response || r.rawOutput || '',
    hilo: datos.conversation_id || null,
    uso: datos.usage || null,
    error: r.error || null,
    modeloReal: (pedido && pedido.modelo) || '(default de agy)',
    costoUsd: null,
    cuota: null
  };
}

module.exports = {
  id: 'antigravity',
  // `lectura`/`edicion` no son barreras en agy (plan + skip corre comandos).
  perfiles: { 'sin-tools': 'verificado', lectura: 'declarado', edicion: 'declarado' },
  ejecutor: 'ejecutar',
  // BE-015 ya cubre el caso sin modelo en agy (sin `--effort`, agy elige).
  modeloObligatorio: false,
  preflight,
  armar,
  interpretar
};
