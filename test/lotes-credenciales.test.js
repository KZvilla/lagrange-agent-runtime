/**
 * FEAT-061 fase 2 — El token que ve el agente.
 *
 * Lo que se prueba acá es la coreografía (cuándo se refresca, cuántas veces, y
 * que el volumen se borre siempre) con un `docker` falso, más el filtro de `jq`
 * ejercitado de verdad cuando hay WSL: el borrado del `refresh_token` es la
 * mitigación central del diseño, y un `del(.refresh_token)` plano dejaría
 * pasar el campo anidado dentro de `token`.
 */
const { check, group, report } = require('./lib/assert.js');
const { spawnSync } = require('node:child_process');
const { crearCredenciales, guionRefresco, parsearVencimiento, MARGEN_MINUTOS } = require('../mcp-server/lotes/credenciales.js');

function dockerFalso({ vencimientos = [], fallar = false } = {}) {
  const llamadas = [];
  let refrescos = 0;
  const docker = async (args) => {
    llamadas.push(args.join(' '));
    // `levantarProxy` confirma que el proxy quedó corriendo antes de seguir.
    if (args[0] === 'inspect') return { code: 0, stdout: 'true\n', stderr: '' };
    const esRefrescador = args.includes('bash') && args.join(' ').includes('lote-l1-refrescador');
    if (!esRefrescador) return { code: 0, stdout: '', stderr: '' };
    refrescos++;
    if (fallar) return { code: 5, stdout: '', stderr: 'REFRESCO_FALLIDO: agy no pudo renovar el token' };
    const venc = vencimientos.shift() || new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return { code: 0, stdout: `${venc}\n`, stderr: '' };
  };
  return { docker, llamadas, refrescos: () => refrescos };
}

async function main() {
await group('el guion del refrescador', () => {
  const g = guionRefresco();
  // El campo que agy mira es el ANIDADO: tocar solo el `expiry` de arriba no
  // refresca nada (medido en la primera corrida real del lote).
  check('fuerza el refresco sobre el expiry anidado', /\.token\.expiry\s*=\s*"1970/.test(g));
  check('y vacia el access_token anidado', /\.token\.access_token\s*=\s*""/.test(g));
  check('tambien sincroniza el expiry de arriba', /\| \.expiry = "1970/.test(g));
  check('borra refresh_token e id_token en cualquier nivel', /del\(\.refresh_token,\.id_token\)/.test(g));
  check('verifica recursivamente que no quedaron sensibles', /has\("refresh_token"\) or has\("id_token"\)/.test(g));
  check('extrae el access token real sin newline', /jq -erj/.test(g) && /access-token\.tmp/.test(g));
  check('genera y verifica un token señuelo', /\/dev\/urandom/.test(g) && /TOKEN_SENUELO_INVALIDO/.test(g));
  check('avisa si no hay token en el volumen', /SIN_TOKEN/.test(g));
  check('el token exportado queda 600', /chmod 600/.test(g));
  check('la última línea es el vencimiento anidado', g.trim().split('\n').pop().includes('(.token.expiry // .expiry)'));
});

await group('parseo del vencimiento', () => {
  check('toma la última línea', parsearVencimiento('ruido\n2026-09-18T19:41:03Z\n') === Date.parse('2026-09-18T19:41:03Z'));
  check('una salida sin fecha da null', parsearVencimiento('sin fecha') === null);
  check('vacío da null', parsearVencimiento('') === null);
});

await group('cuándo se refresca', () => {
  const ahora = Date.parse('2026-09-18T12:00:00Z');
  const { docker, refrescos } = dockerFalso({
    vencimientos: ['2026-09-18T12:30:00Z', '2026-09-18T13:30:00Z']
  });
  const cred = crearCredenciales({ docker, idLote: 'l1', ahora: () => ahora });

  return cred.asegurarVida(20).then(async () => {
    check('la primera tarea dispara un refresco', refrescos() === 1);
    check('el volumen del token es el del lote', cred.volumenToken === 'lote-l1-token');
    check('el volumen secreto es distinto', cred.volumenSecretoProxy === 'lote-l1-proxy-secreto');

    // Quedan 30 min y la tarea pide 20 + 3 de margen: alcanza.
    await cred.asegurarVida(20);
    check('una tarea que entra en la vida restante NO refresca', refrescos() === 1);

    // Ahora pide 45: 45 + 3 > 30, hay que refrescar.
    await cred.asegurarVida(45);
    check('una tarea que no entra dispara otro refresco', refrescos() === 2);
    check(`el margen es de ${MARGEN_MINUTOS} minutos`, MARGEN_MINUTOS === 3);
  });
});

await group('refrescos concurrentes', () => {
  const ahora = Date.parse('2026-09-18T12:00:00Z');
  const { docker, refrescos } = dockerFalso({ vencimientos: ['2026-09-18T13:00:00Z'] });
  const cred = crearCredenciales({ docker, idLote: 'l1', ahora: () => ahora });

  return Promise.all([cred.asegurarVida(30), cred.asegurarVida(30), cred.asegurarVida(30)]).then(() => {
    check('tres tareas a la vez producen UN refresco', refrescos() === 1);
  });
});

await group('fallos y limpieza', () => {
  const { docker, llamadas } = dockerFalso({ fallar: true });
  const cred = crearCredenciales({ docker, idLote: 'l1' });

  return cred.asegurarVida(10).then(
    () => check('un refrescador que falla tiene que propagar el error', false),
    (err) => {
      check('un refrescador que falla aborta el lote', /no se pudo preparar el token/.test(err.message));
      check('el mensaje trae el motivo del contenedor', /REFRESCO_FALLIDO/.test(err.message));
      check('la red del refrescador se baja igual', llamadas.some(l => l.startsWith('network rm lote-l1-refresco-red')));
      check('el proxy del refrescador se baja igual', llamadas.some(l => l.includes('rm -f lote-l1-refresco-proxy')));
      return cred.destruir().then(() => {
        check('destruir borra el volumen del token', llamadas.some(l => l === 'volume rm -f lote-l1-token'));
        check('destruir borra el volumen secreto', llamadas.some(l => l === 'volume rm -f lote-l1-proxy-secreto'));
      });
    }
  );
});

await group('el filtro de jq, ejercitado de verdad', () => {
  const entrada = JSON.stringify({
    access_token: 'a',
    refresh_token: 'SECRETO',
    token: { access_token: 'b', refresh_token: 'SECRETO-ANIDADO' },
    expiry: '2026-09-18T19:41:03Z'
  });

  const jq = (filtro, texto) => spawnSync('wsl', ['-e', 'jq', filtro], { input: texto, encoding: 'utf8', windowsHide: true });
  const prueba = jq('.', '{}');
  if (prueba.status !== 0) {
    check('(sin jq en WSL: el filtro no se pudo ejercitar acá)', true);
    return;
  }

  const recortado = jq('walk(if type == "object" then del(.refresh_token) else . end)', entrada);
  check('el filtro corre', recortado.status === 0, recortado.stderr);
  check('borra el refresh_token de arriba', !/\"refresh_token\"/.test(recortado.stdout));
  check('borra también el anidado', !/SECRETO-ANIDADO/.test(recortado.stdout));
  check('conserva el access_token', /\"access_token\"/.test(recortado.stdout));
  check('conserva el expiry', /2026-09-18T19:41:03Z/.test(recortado.stdout));

  const verifLimpio = jq('-e', recortado.stdout);
  check('el token recortado sigue siendo JSON válido', verifLimpio.status === 0);

  const verifSucio = spawnSync('wsl', ['-e', 'jq', '-e', '[.. | objects | has("refresh_token")] | any'],
    { input: entrada, encoding: 'utf8', windowsHide: true });
  check('la verificación detecta un refresh_token anidado', verifSucio.status === 0 && /true/.test(verifSucio.stdout));

  const verifOk = spawnSync('wsl', ['-e', 'jq', '-e', '[.. | objects | has("refresh_token")] | any'],
    { input: recortado.stdout, encoding: 'utf8', windowsHide: true });
  check('y no se dispara con el token ya recortado', verifOk.status !== 0);
});

  report();
}

main();
