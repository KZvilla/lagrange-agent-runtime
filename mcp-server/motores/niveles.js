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
 * agy (medido con `agy models`, 1.2.9): un Gemini de nombre corto EXIGE
 * `--effort` (Flash: low/medium/high; Pro: low/high); un id sufijado
 * (`-high`), Claude y GPT-OSS lo rechazan; sin modelo, agy elige el de su
 * settings.json y el esfuerzo no se puede saber (BE-015).
 *
 * claude (doc de Claude Code, model-config): Haiku 4.5 no admite esfuerzo (el
 * CLI lo ignora); Opus/Sonnet 4.6 van de low a max sin xhigh; el resto, de low
 * a max. El implícito es `null`: sin pedido rige el default del modelo. Un
 * modelo desconocido se trata como el conjunto completo: el CLI baja solo al
 * nivel admitido más alto.
 */

const COMPLETO = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_ADMITE = Object.freeze({ admite: false, niveles: [], implicito: null, conocido: true });

function admite(niveles, implicito, conocido = true) {
  return { admite: true, niveles, implicito, conocido };
}

function nivelesAgy(modelo) {
  if (!modelo || typeof modelo !== 'string') return NO_ADMITE;
  const m = modelo.toLowerCase();
  if (/-(low|medium|high)$/.test(m)) return NO_ADMITE;
  if (!m.startsWith('gemini')) return NO_ADMITE;
  if (/pro/.test(m)) return admite(['low', 'high'], 'low');
  return admite(['low', 'medium', 'high'], 'medium');
}

function nivelesClaude(modelo) {
  if (!modelo || typeof modelo !== 'string') return NO_ADMITE;
  const m = modelo.toLowerCase();
  if (/haiku/.test(m)) return NO_ADMITE;
  if (/(opus|sonnet)-4-6/.test(m)) return admite(['low', 'medium', 'high', 'max'], null);
  const conocido = /^(sonnet|opus|fable)$/.test(m) || /^claude-(opus|sonnet|fable)-/.test(m);
  return admite(COMPLETO, null, conocido);
}

function nivelesPara(motor, modelo) {
  if (motor === 'claude') return nivelesClaude(modelo);
  if (motor === 'antigravity') return nivelesAgy(modelo);
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
 */
const MODELOS = Object.freeze({
  antigravity: Object.freeze([null, 'gemini-3.8-flash', 'gemini-3.1-pro']),
  claude: Object.freeze(['sonnet', 'opus', 'haiku'])
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

module.exports = { COMPLETO, MODELOS, nivelesPara, admiteNivel, catalogo };
