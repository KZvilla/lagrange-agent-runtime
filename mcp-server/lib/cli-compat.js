/**
 * BE-015 — Reglas de compatibilidad entre `--model` y `--effort` del CLI de agy.
 *
 * Son reglas del CLI, no de ningun subsistema: las usan el servidor MCP, el
 * cast de agentes persistidos y el bot de Telegram. Un solo lugar para que el
 * proximo endurecimiento de agy se corrija una vez.
 *
 * El incidente del 2026-09-11: agy empezo a abortar con "--effort is not
 * supported for the current model" cuando recibia `--effort` sin `--model` y su
 * settings.json resolvia Claude Opus.
 *
 * BE-041 — Los niveles por modelo viven en `motores/niveles.js`, la fuente
 * unica de los dos motores (y de la consola web, FEAT-075). agy 1.2.9 exige
 * `--effort` con un Gemini de nombre corto: sin pedido ni valor por defecto
 * valido, se manda el implicito de la familia.
 */

const { nivelesPara } = require('../motores/niveles.js');

/**
 * ¿Se le puede mandar `--effort` a este modelo sin que agy aborte?
 *
 * Lista blanca y no negra: solo la familia Gemini sin sufijo admite el flag.
 * Claude y GPT-OSS lo rechazan, y un id sufijado (`-high`) ya fija el
 * esfuerzo. Una familia nueva cae del lado seguro: sin flag.
 *
 * Sin modelo devuelve `false`: agy elige entonces el de su `settings.json`, que
 * puede ser Opus, y ese fue exactamente el incidente (`--model ""`).
 */
function modeloAdmiteEsfuerzo(modelo) {
  return nivelesPara('antigravity', modelo).admite;
}

/**
 * Esfuerzo a pasar como `--effort`, o `null` para no pasar el flag.
 *
 * Un pedido explicito se respeta siempre: si no encaja con el modelo, lo
 * rechaza `validarModeloEsfuerzo` antes del spawn con un mensaje claro, en vez
 * de descartarlo en silencio. Un valor por defecto (config, entorno, el `low`
 * de la narracion) solo se aplica cuando el modelo lo admite con certeza y el
 * nivel es de su familia.
 *
 * BE-041 — Con un Gemini de nombre corto, sin pedido ni defecto valido, el
 * implicito de la familia (Flash `medium`, Pro `low`): agy 1.2.9 aborta sin
 * `--effort`. Sin modelo sigue sin flag: agy elige el suyo (BE-015).
 */
function esfuerzoParaCli({ modelo, pedido, porDefecto }) {
  if (pedido) return pedido;
  const n = nivelesPara('antigravity', modelo);
  if (!n.admite) return null;
  const defecto = porDefecto ? String(porDefecto).toLowerCase() : null;
  if (defecto && n.niveles.includes(defecto)) return defecto;
  return n.implicito;
}

// Los modelos de agy no aceptan cualquier esfuerzo (`motores/niveles.js`):
// `--model gemini-3.1-pro --effort medium` es un error que solo aparece tras
// arrancar el proceso, con un mensaje que llega envuelto en JSON.

/**
 * Valida los `cliArgs` ya armados antes del spawn. Devuelve el mensaje de error
 * o `null`.
 *
 * Los valores por defecto ya no llegan aca en combinaciones invalidas (los
 * filtra `esfuerzoParaCli`): lo que se valida es un pedido explicito.
 *
 * Limite conocido: un `--effort` explicito SIN `--model` no se puede validar,
 * porque el modelo lo resuelve agy desde su propio settings.json. Rechazarlo
 * romperia el caso legitimo (agy con Gemini por defecto), asi que pasa y, si
 * no encaja, el error lo da agy.
 */
function validarModeloEsfuerzo(cliArgs) {
  const i = cliArgs.indexOf('--model');
  const j = cliArgs.indexOf('--effort');
  if (i === -1 || j === -1) return null;
  const modelo = cliArgs[i + 1];
  const esfuerzo = cliArgs[j + 1];
  if (typeof modelo !== 'string' || typeof esfuerzo !== 'string') return null;

  if (/^(claude|gpt-oss)/i.test(modelo)) {
    return `El modelo "${modelo}" no admite effort ("${esfuerzo}" pedido). `
      + 'Quita `effort` de la llamada o usa un modelo Gemini sin sufijo.';
  }

  if (/-(low|medium|high)$/i.test(modelo)) {
    return `El modelo "${modelo}" ya fija el esfuerzo en su nombre y choca con effort "${esfuerzo}". `
      + 'Quita `effort` o pasa el nombre corto del modelo.';
  }

  const n = nivelesPara('antigravity', modelo);
  if (n.admite && !n.niveles.includes(esfuerzo.toLowerCase())) {
    return `El modelo "${modelo}" no admite effort "${esfuerzo}". `
      + `Disponibles para esa familia: ${n.niveles.join(', ')}. `
      + `Ejecuta \`agy models\` para ver la lista completa.`;
  }
  return null;
}

module.exports = { modeloAdmiteEsfuerzo, esfuerzoParaCli, validarModeloEsfuerzo };
