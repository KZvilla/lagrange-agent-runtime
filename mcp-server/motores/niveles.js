/**
 * BE-041 — Qué niveles de esfuerzo admite cada modelo, por motor. La fuente
 * única: la usan `lib/cli-compat.js` (agy), `motores/claude.js` y
 * `motores/roles.js`, y la va a consultar la consola web (FEAT-075) para
 * ofrecer solo combinaciones válidas.
 *
 * Sin dependencias, para que `lib/config.js` la cargue (vía `roles.js`) sin
 * traer los motores.
 *
 *   nivelesPara(motor, modelo) → { admite, niveles, implicito, conocido }
 *
 * agy (medido con `agy models`, 1.3.4): un Gemini de nombre corto EXIGE
 * `--effort` (Flash: low/medium/high; Pro, ya retirado: low/high); un id
 * sufijado (`-high`), Claude y GPT-OSS lo rechazan; sin modelo, agy elige el
 * de su settings.json y el esfuerzo no se puede saber (BE-015).
 *
 * claude (doc de Claude Code, model-config): Haiku 4.5 no admite esfuerzo (el
 * CLI lo ignora); BE-120 — Haiku 5.5 sí, de low a max con default `medium`, y
 * es a lo que resuelve el alias `haiku` en la API de Anthropic (doc consultada
 * el 2026-10-07; pide Claude Code 2.1.293 o más). Un Haiku fijado anterior a
 * la 5.5 sigue sin esfuerzo; Opus/Sonnet 4.6 van de low a max sin xhigh; el resto, de low
 * a max. El implícito es `null`: sin pedido rige el default del modelo. Un
 * modelo desconocido se trata como el conjunto completo: el CLI baja solo al
 * nivel admitido más alto.
 *
 * BE-045 (doc consultada el 2026-09-25): Opus 5.5 tiene default `medium`, y
 * `opus` resuelve a Opus 5.5 en la API de Anthropic y en las suscripciones (en
 * Foundry, a 4.6; el motor claude no lo soporta). El implícito es informativo:
 * `claude.esfuerzo` no lo manda. Sonnet 4.5 y anteriores no admiten esfuerzo.
 * Fable (`fable`, `best`, `claude-fable-*`) queda fuera: factura créditos de
 * uso tras un consentimiento interactivo que en `claude -p` nadie responde, y
 * no hay sonda headless. Decisión del usuario; no es configurable.
 */

const COMPLETO = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_ADMITE = Object.freeze({ admite: false, niveles: [], implicito: null, conocido: true });

const RE_FABLE = /^(fable|best)(\[[^\]]*\])?$|^claude-fable-/i;
const MOTIVO_FABLE = 'Fable requiere créditos de uso y pide consentimiento interactivo; no tiene sonda headless (BE-045)';
const RE_OPUS_MEDIUM = /^opus(\[[^\]]*\])?$|^claude-opus-5-5(-|\[|$)/;
// BE-120 — Haiku 5.5 (y el alias, que resuelve a ella): completo, default `medium`.
const RE_HAIKU_5_5 = /^haiku(\[[^\]]*\])?$|^claude-haiku-5-5(-|\[|$)/;
const RE_SIN_ESFUERZO = /^claude-sonnet-4-5(-|\[|$)|^claude-sonnet-4(-\d{8})?$|^claude-3/;

/** FEAT-166 — DeepSeek actualiza el mismo modelo con versiones internas y hoy reenruta Pro a Flash: solo Flash. */
const MODELO_DEEPSEEK = 'deepseek-flash';
/** FEAT-173 — El único modelo de OpenCode Go que se ofrece (decisión del usuario): el id de Go tal cual. */
const MODELO_OPENCODE_GO = 'deepseek-v4.1-flash';

/** `null`, o por qué este modelo no se puede usar en este motor. */
function modeloBloqueado(motor, modelo) {
  if (!modelo || typeof modelo !== 'string') return null;
  if (motor === 'deepseek') return modelo === MODELO_DEEPSEEK ? null : `el motor deepseek solo usa ${MODELO_DEEPSEEK}`;
  if (motor === 'opencode-go') return modelo === MODELO_OPENCODE_GO ? null : `el motor opencode-go solo usa ${MODELO_OPENCODE_GO}`;
  if (motor !== 'claude') return null;
  return RE_FABLE.test(modelo) ? MOTIVO_FABLE : null;
}

function admite(niveles, implicito, conocido = true) {
  return { admite: true, niveles, implicito, conocido };
}

function nivelesAgy(modelo) {
  if (!modelo || typeof modelo !== 'string') return NO_ADMITE;
  const m = modelo.toLowerCase();
  if (/-(low|medium|high)$/.test(m)) return NO_ADMITE;
  // BE-138 — agy solo publica Argon con el esfuerzo en el id: el nombre corto no se completa con uno.
  if (!m.startsWith('gemini') || m.includes('argon')) return NO_ADMITE;
  if (/pro/.test(m)) return admite(['low', 'high'], 'low');
  return admite(['low', 'medium', 'high'], 'medium');
}

function nivelesClaude(modelo) {
  if (!modelo || typeof modelo !== 'string') return NO_ADMITE;
  const m = modelo.toLowerCase();
  if (modeloBloqueado('claude', m)) return NO_ADMITE;
  if (RE_HAIKU_5_5.test(m)) return admite(COMPLETO, 'medium');
  if (/haiku/.test(m) || RE_SIN_ESFUERZO.test(m)) return NO_ADMITE;
  if (/(opus|sonnet)-4-6/.test(m)) return admite(['low', 'medium', 'high', 'max'], null);
  if (RE_OPUS_MEDIUM.test(m)) return admite(COMPLETO, 'medium');
  const conocido = /^(sonnet|opus)(\[[^\]]*\])?$/.test(m) || /^claude-(opus|sonnet)-/.test(m);
  return admite(COMPLETO, null, conocido);
}

/**
 * FEAT-166 — `reasoning_effort` de DeepSeek: low, high y max. La API acepta
 * medium y lo trata como high; acá no se ofrece para no prometer un nivel que
 * no existe. Implícito low: el más rápido que emite el bloque del alma.
 */
function nivelesDeepseek(modelo) {
  return modelo === MODELO_DEEPSEEK ? admite(['low', 'high', 'max'], 'low') : NO_ADMITE;
}

/** FEAT-173 — low y high medidos; FEAT-176 — max también (sonda 2026-10-21, como el CLI de opencode). */
function nivelesOpencodeGo(modelo) {
  return modelo === MODELO_OPENCODE_GO ? admite(['low', 'high', 'max'], 'low') : NO_ADMITE;
}

function nivelesPara(motor, modelo) {
  if (motor === 'claude') return nivelesClaude(modelo);
  if (motor === 'antigravity') return nivelesAgy(modelo);
  if (motor === 'deepseek') return nivelesDeepseek(modelo);
  if (motor === 'opencode-go') return nivelesOpencodeGo(modelo);
  return NO_ADMITE;
}

/** ¿`esfuerzo` es un nivel que este modelo admite? Sin distinguir mayúsculas. */
function admiteNivel(motor, modelo, esfuerzo) {
  const n = nivelesPara(motor, modelo);
  return Boolean(n.admite && esfuerzo && n.niveles.includes(String(esfuerzo).toLowerCase()));
}

/**
 * FEAT-075 — Los modelos que la consola web ofrece por motor, en orden de
 * recomendación. `null` en agy es "el de agy": sin `--model`, hereda el
 * `/model` global (BE-015). En claude va Sonnet primero: medido en vivo, Haiku
 * rinde claramente por debajo de Gemini para un alma.
 *
 * FEAT-086 — Después de los alias, IDs completos para fijar la versión: un alias
 * sigue al modelo nuevo cuando sale; un ID, no. Todos aceptados por `--model`
 * según code.claude.com/docs/en/model-config (2026-09-25); `claude-opus-5-5`
 * pide Claude Code 2.1.280 o más. Fable no se ofrece (BE-045).
 */
const MODELOS = Object.freeze({
  // BE-127 — Sin Gemini Pro desde 2026-10-12; un Pro ya guardado se sigue viendo por `extras`.
  // FEAT-158 — Los Claude y GPT-OSS de agy (agy 1.3.4), sufijados: el esfuerzo va en el id.
  // BE-138 — Gemini 4 Argon (agy 1.3.6), sufijado y con cuota semanal propia y escasa: se elige a mano.
  antigravity: Object.freeze([null, 'gemini-3.8-flash',
    'gemini-4-argon-medium', 'gemini-4-argon-low', 'gemini-4-argon-high',
    'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low', 'claude-sonnet-5-5-high',
    'claude-opus-5-5-medium', 'claude-opus-5-5-low', 'claude-opus-5-5-high', 'gpt-oss-120b-medium']),
  claude: Object.freeze([
    'sonnet', 'opus', 'haiku',
    'claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-haiku-5-5', 'claude-haiku-4-5'
  ]),
  // FEAT-166 — Solo para `alma*` y `consolidar*` (lo valida `roles.js`).
  deepseek: Object.freeze([MODELO_DEEPSEEK]),
  // FEAT-173/175 — Solo para `alma*` y `consolidar*` (lo valida `roles.js`).
  'opencode-go': Object.freeze([MODELO_OPENCODE_GO])
});

/**
 * `[{ motor, modelos: [{ modelo, admite, niveles, implicito, conocido }] }]`.
 * `extras` (`[{ motor, modelo }]`, p. ej. los que ya están guardados) se suman
 * al final de su motor si no están: un modelo escrito a mano se sigue viendo.
 */
function catalogo(extras = []) {
  return Object.entries(MODELOS).map(([motor, sugeridos]) => {
    const modelos = [...sugeridos];
    for (const e of extras) {
      if (e && e.motor === motor && e.modelo && !modelos.includes(e.modelo)) modelos.push(e.modelo);
    }
    return { motor, modelos: modelos.map((modelo) => ({ modelo, ...nivelesPara(motor, modelo) })) };
  });
}

module.exports = { COMPLETO, MODELOS, MODELO_DEEPSEEK, MODELO_OPENCODE_GO, nivelesPara, admiteNivel, catalogo, modeloBloqueado };
