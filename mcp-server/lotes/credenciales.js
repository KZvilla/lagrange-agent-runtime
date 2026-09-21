/**
 * El token que ve el agente (FEAT-061 fase 2b, §3 del plan).
 *
 * EL PROBLEMA
 * -----------
 * agy es un monolito: no se puede separar el cliente que habla con Google de
 * las herramientas que escriben archivos. Si el agente corre en el contenedor,
 * la credencial tiene que estar en el contenedor. Y la credencial del usuario
 * incluye un `refresh_token` con scope `cloud-platform`: quien lo tenga puede
 * fabricar tokens nuevos durante meses.
 *
 * LA SOLUCIÓN
 * -----------
 * El agente nunca ve ese archivo ni el access token real. Un REFRESCADOR monta
 * el OAuth persistente, fuerza la renovación y exporta dos artefactos: un JSON
 * con token señuelo para la tarea y el secreto real para iron-proxy. El proxy
 * termina TLS y reemplaza el señuelo solo en las rutas exactas de agy.
 *
 * Tres detalles que costaron auditorías:
 *  - el `refresh_token` se borra EN CUALQUIER NIVEL (`walk`), porque el campo
 *    `token` puede ser un objeto anidado, y después se VERIFICA igual de
 *    recursivamente: si la verificación lo encuentra, el lote no arranca;
 *  - el refresco se puede pedir varias veces por lote, no una sola: con una
 *    sola, un lote de dos tandas de 45 minutos no entra en la vida de un token;
 *  - los pedidos concurrentes comparten una promesa, así que dos tareas que lo
 *    necesitan a la vez producen UN refresco, no dos.
 */
const {
  nombres,
  argvRefrescador,
  argvProxy,
  levantarProxy,
  argvConectarBridge,
  argvCrearRed,
  argvBorrarRed,
  argvCrearVolumen,
  argvBorrarVolumen,
  argvPrepararVolumenCredencial,
  argvRmForzado,
  sanitizarSalida
} = require('./docker.js');

const RUTA_TOKEN = '.gemini/antigravity-cli/antigravity-oauth-token';

// Margen sobre el tope de una tarea: si el token no le alcanza para su timeout
// más esto, se refresca antes de arrancarla.
const MARGEN_MINUTOS = 3;

/**
 * El guion del refrescador, que corre dentro del contenedor.
 *
 * CÓMO SE FUERZA EL REFRESCO, Y POR QUÉ ASÍ
 * -----------------------------------------
 * El archivo tiene la credencial ANIDADA en `.token` (`access_token`, `expiry`,
 * `refresh_token`, `token_type`), y además un `expiry` suelto arriba que es una
 * copia. agy mira el de adentro: tocar solo el de arriba no hace nada, medido
 * en la primera corrida real del lote — agy contestaba tan campante con un
 * `expiry` de 1970 y no reescribía el archivo.
 *
 * Vaciando `.token.access_token` y poniendo `.token.expiry` en el pasado, agy
 * sí usa el `refresh_token` y escribe una credencial nueva (verificado: expiry
 * nuevo ~1 h por delante y `access_token` distinto). El `expiry` de arriba se
 * toca también, para no dejar el archivo diciendo dos cosas.
 */
function guionRefresco() {
  return [
    'set -e',
    `TOK="$HOME/${RUTA_TOKEN}"`,
    '[ -f "$TOK" ] || { echo "SIN_TOKEN: el volumen de credenciales no tiene el OAuth de agy" >&2; exit 4; }',
    // Forzar el refresco: el campo que agy mira es el ANIDADO.
    'jq \'.token.expiry = "1970-01-01T00:00:00Z" | .token.access_token = "" | .expiry = "1970-01-01T00:00:00Z"\' "$TOK" > /tmp/tok.json && cp /tmp/tok.json "$TOK"',
    // agy 1.2.6 exige effort cuando se selecciona una familia Gemini sin
    // sufijo. No dependemos del settings.json del usuario para esta sonda.
    'ERR=/tmp/agy-refresh.err',
    'agy -p "OK" --model gemini-3.8-flash --effort low > /dev/null 2>"$ERR" || { echo "REFRESCO_FALLIDO: agy no pudo renovar el token" >&2; sed -n "1,8p" "$ERR" >&2; exit 5; }',
    'rm -f "$ERR"',
    'mkdir -p /token/.gemini/antigravity-cli /proxy-secret',
    'chmod 700 /token /token/.gemini /token/.gemini/antigravity-cli /proxy-secret',
    // El archivo es exacto: jq -j evita el salto de línea que volvería inválido
    // el header Authorization al inyectarlo.
    `jq -erj '.token.access_token | select(type == "string" and length > 0)' "$TOK" > /proxy-secret/.access-token.tmp || { echo "ACCESS_TOKEN_AUSENTE" >&2; exit 6; }`,
    'FAKE="lagrange-falso-$(od -An -N24 -tx1 /dev/urandom | tr -d \' \\n\')"',
    'printf %s "$FAKE" > /proxy-secret/.proxy-token.tmp',
    // Todo access_token visible se reemplaza y todo token renovable/identidad
    // se elimina recursivamente antes de entregar el JSON a la tarea.
    `jq --arg fake "$FAKE" 'walk(if type == "object" then (if has("access_token") then .access_token = $fake else . end) | del(.refresh_token,.id_token) else . end)' "$TOK" > /token/${RUTA_TOKEN}.tmp`,
    `if jq -e '[.. | objects | has("refresh_token") or has("id_token")] | any' /token/${RUTA_TOKEN}.tmp > /dev/null; then echo "TOKEN_SENSIBLE_PRESENTE" >&2; exit 7; fi`,
    `jq -e --arg fake "$FAKE" '.token.access_token == $fake' /token/${RUTA_TOKEN}.tmp > /dev/null || { echo "TOKEN_SENUELO_INVALIDO" >&2; exit 8; }`,
    'REAL="$(cat /proxy-secret/.access-token.tmp)"; if grep -Fq -- "$REAL" /token/' + RUTA_TOKEN + '.tmp; then echo "ACCESS_TOKEN_REAL_PRESENTE" >&2; exit 9; fi',
    `chmod 600 /proxy-secret/.access-token.tmp /proxy-secret/.proxy-token.tmp /token/${RUTA_TOKEN}.tmp`,
    'mv /proxy-secret/.access-token.tmp /proxy-secret/access-token',
    'mv /proxy-secret/.proxy-token.tmp /proxy-secret/proxy-token',
    `mv /token/${RUTA_TOKEN}.tmp /token/${RUTA_TOKEN}`,
    // Última línea de stdout: el vencimiento del token exportado. Del campo
    // anidado, que es el que vale; el de arriba queda de respaldo.
    `jq -r '(.token.expiry // .expiry)' /token/${RUTA_TOKEN}`
  ].join('\n');
}

function parsearVencimiento(stdout) {
  const lineas = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const ultima = lineas[lineas.length - 1];
  const ms = Date.parse(ultima);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object} opciones
 * @param {Function} opciones.docker            El `docker(args)` de docker.js.
 * @param {string}   opciones.idLote
 * @param {Function} [opciones.ahora]           Reloj inyectable para los tests.
 */
function crearCredenciales({ docker, idLote, ahora = () => Date.now(), expiraEpoch = 0 }) {
  const n = nombres(idLote, 'refresco');
  const volumenToken = n.token;
  const volumenSecretoProxy = n.secretoProxy;
  let vencimientoMs = null;
  let enCurso = null;
  let preparado = false;

  async function correrRefrescador() {
    const nombreRed = `lote-${idLote}-refresco-red`;
    const nombreProxy = `lote-${idLote}-refresco-proxy`;
    const nombreContenedor = `lote-${idLote}-refrescador`;

    // Restos de un intento anterior: si quedaron, `docker run` falla por nombre
    // tomado y el lote no arranca por una razón que no es la real.
    await docker(argvRmForzado(nombreContenedor), { permitirFallo: true });
    await docker(argvRmForzado(nombreProxy), { permitirFallo: true });
    await docker(argvBorrarRed(nombreRed), { permitirFallo: true });

    await docker(argvCrearRed(nombreRed, idLote, expiraEpoch));
    try {
      await levantarProxy(docker, argvProxy({
        nombreProxy,
        nombreRed,
        perfil: 'refrescador',
        idLote,
        expiraEpoch
      }), nombreProxy);
      await docker(argvConectarBridge(nombreProxy));

      if (!preparado) {
        await docker(argvCrearVolumen(volumenToken, idLote, expiraEpoch), { permitirFallo: true });
        await docker(argvCrearVolumen(volumenSecretoProxy, idLote, expiraEpoch), { permitirFallo: true });
        await docker(argvPrepararVolumenCredencial(volumenToken, '/token'));
        await docker(argvPrepararVolumenCredencial(volumenSecretoProxy, '/proxy-secret'));
        preparado = true;
      }

      const r = await docker(argvRefrescador({
        nombreContenedor,
        nombreRed,
        nombreProxy,
        idLote,
        expiraEpoch,
        guion: guionRefresco()
      }), { permitirFallo: true, timeoutMs: 300000 });

      if (r.code !== 0) {
        throw new Error(`no se pudo preparar el token del lote: ${sanitizarSalida(r.stderr || r.stdout).trim().slice(0, 300)}`);
      }

      vencimientoMs = parsearVencimiento(r.stdout);
      if (!vencimientoMs) {
        throw new Error('el refrescador no devolvió un vencimiento legible para el token del lote');
      }
      return vencimientoMs;
    } finally {
      await docker(argvRmForzado(nombreProxy), { permitirFallo: true });
      await docker(argvBorrarRed(nombreRed), { permitirFallo: true });
    }
  }

  /**
   * Garantiza que el token alcance para una tarea de `topeMinutos`.
   *
   * Serializado en una promesa compartida: si dos tareas lo piden a la vez,
   * corre un solo refrescador y las dos esperan el mismo resultado. Las tareas
   * que ya están corriendo no se ven afectadas: copiaron el token a su tmpfs al
   * arrancar.
   */
  async function asegurarVida(topeMinutos) {
    const necesarioMs = (Number(topeMinutos || 0) + MARGEN_MINUTOS) * 60 * 1000;
    if (vencimientoMs && vencimientoMs - ahora() >= necesarioMs) return vencimientoMs;

    if (!enCurso) {
      enCurso = correrRefrescador().finally(() => { enCurso = null; });
    }
    return enCurso;
  }

  async function destruir() {
    await docker(argvBorrarVolumen(volumenToken), { permitirFallo: true });
    await docker(argvBorrarVolumen(volumenSecretoProxy), { permitirFallo: true });
    vencimientoMs = null;
    preparado = false;
  }

  return {
    volumenToken,
    volumenSecretoProxy,
    asegurarVida,
    destruir,
    vencimiento: () => vencimientoMs
  };
}

module.exports = { RUTA_TOKEN, MARGEN_MINUTOS, guionRefresco, parsearVencimiento, crearCredenciales };
