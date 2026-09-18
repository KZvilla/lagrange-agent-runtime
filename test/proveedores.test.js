/**
 * FEAT-069 — La vista Proveedores informa y nunca actualiza.
 *
 * Lo que importa probar acá es lo que sale a la red y lo que entra de ella:
 * URL fija, sin redirecciones, con User-Agent (GitHub responde 403 sin él),
 * con tope de tamaño que corta la descarga, y un caché que no reintenta en
 * cada recarga (60 pedidos por hora sin autenticar). Y del uso, que la
 * proyección nunca lleve la ruta del archivo ni cuente como «hoy» un día viejo.
 */
const { check, group, report } = require('./lib/assert');
const p = require('../mcp-server/lib/proveedores.js');
const { resumenUso, rutaUso } = require('../mcp-server/lib/uso-agy.js');

const manifiesto = (version) => JSON.stringify({ version, url: 'https://ejemplo/binario.exe', sha512: 'x' });
const release = (tag, body, extra = {}) => ({ tag_name: tag, published_at: '2026-09-18T04:21:05Z', body, ...extra });

/** fetch falso: responde según la URL y anota cada pedido. */
function redFalsa(respuestas) {
  const pedidos = [];
  const pedir = async (url, opciones) => {
    pedidos.push({ url, opciones });
    const r = typeof respuestas === 'function' ? respuestas(url) : respuestas[url.includes('api.github.com') ? 'github' : 'manifiesto'];
    if (r instanceof Error) throw r;
    return new Response(r.cuerpo, { status: r.status || 200 });
  };
  return { pedir, pedidos };
}

async function main() {
  await group('plataforma, versiones y notas', () => {
    check('win32/x64 → windows_amd64', p.nombrePlataforma('win32', 'x64') === 'windows_amd64');
    check('darwin/arm64 → darwin_arm64', p.nombrePlataforma('darwin', 'arm64') === 'darwin_arm64');
    check('una plataforma sin build → null', p.nombrePlataforma('aix', 'ppc64') === null);
    check('extrae la versión de la salida de agy', p.extraerVersion('1.2.6\n') === '1.2.6' && p.extraerVersion('Desconocida (no se pudo consultar el binario)') === null);
    check('1.2.10 es mayor que 1.2.9', p.compararVersiones('1.2.10', '1.2.9') > 0);
    check('iguales dan 0', p.compararVersiones('1.2.6', '1.2.6') === 0);
    check('una versión inválida no compara', p.compararVersiones('1.2', '1.2.6') === null);
    let rechazo = false;
    try { p.versionDeManifiesto(manifiesto('1.2.6; rm -rf')); } catch { rechazo = true; }
    check('una versión rara del manifiesto se rechaza', rechazo);

    const notas = p.notasEntre(JSON.stringify([
      release('1.2.7', '- con guion\n* con asterisco\ntexto suelto\n- con <b>HTML</b>'),
      release('1.2.6', '- de la seis'),
      release('1.2.5', '- ya instalada'),
      release('1.2.8', '- borrador', { draft: true }),
      release('1.2.9', '- más nueva que la última')
    ]), '1.2.5', '1.2.7');
    check('solo las versiones entre la instalada y la última', notas.map((n) => n.version).join(',') === '1.2.7,1.2.6');
    check('viñetas con - y con *, sin el texto suelto', notas[0].cambios.length === 3 && notas[0].cambios[1] === 'con asterisco');
    check('sin HTML', notas[0].cambios[2] === 'con HTML');
    check('el enlace es al repo oficial', notas[0].enlace === 'https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.7');
  });

  await group('pedidos a la red', async () => {
    const { pedir, pedidos } = redFalsa({ manifiesto: { cuerpo: manifiesto('1.2.6') } });
    const texto = await p.pedirAcotado('https://ejemplo/m.json', { pedir, tope: 1024 });
    check('devuelve el cuerpo', JSON.parse(texto).version === '1.2.6');
    check('no sigue redirecciones', pedidos[0].opciones.redirect === 'error');
    check('manda User-Agent', pedidos[0].opciones.headers['User-Agent'] === 'lagrange-agent-runtime');
    check('con señal de corte', pedidos[0].opciones.signal instanceof AbortSignal);

    let grande = null;
    try {
      await p.pedirAcotado('https://ejemplo/m.json', { pedir: redFalsa({ manifiesto: { cuerpo: 'x'.repeat(5000) } }).pedir, tope: 1024 });
    } catch (err) { grande = err.message; }
    check('un cuerpo más grande que el tope falla', /más de 1024 bytes/.test(grande || ''), grande);

    let http = null;
    try { await p.pedirAcotado('https://ejemplo/m.json', { pedir: redFalsa({ manifiesto: { cuerpo: '', status: 403 } }).pedir, tope: 1024 }); } catch (err) { http = err.message; }
    check('un 403 falla', http === 'HTTP 403');

    let lento = null;
    const colgado = (url, { signal }) => new Promise((_, rechazar) => signal.addEventListener('abort', () => rechazar(new Error('abortado'))));
    try { await p.pedirAcotado('https://ejemplo/m.json', { pedir: colgado, tope: 1024, timeoutMs: 20 }); } catch (err) { lento = err.message; }
    check('el timeout corta', lento === 'abortado');
  });

  await group('estado del proveedor', async () => {
    let t = 0;
    const ahora = () => t;
    const fuente = { manifiesto: { cuerpo: manifiesto('1.2.6') }, github: { cuerpo: JSON.stringify([release('1.2.6', '- nuevo')]) } };
    const red = redFalsa(fuente);
    const uso = () => ({ llamadas: 1 });
    const alDia = await p.crearProveedores({ versionInstalada: () => '1.2.6', pedir: red.pedir, ahora, uso, plataforma: 'windows_amd64' }).lista();
    check('al día', alDia[0].estado === 'al-dia' && alDia[0].notas.length === 0);
    check('al día no pide notas a GitHub', red.pedidos.every((x) => !x.url.includes('api.github.com')));
    check('pide el manifiesto de esta plataforma', red.pedidos[0].url.endsWith('/manifests/windows_amd64.json'));
    check('nunca lleva el comando a ejecutar, solo el texto', alDia[0].comando === 'agy update');

    const red2 = redFalsa(fuente);
    const prov = p.crearProveedores({ versionInstalada: () => '1.2.5', pedir: red2.pedir, ahora, uso, plataforma: 'windows_amd64' });
    const [d] = await prov.lista();
    check('disponible, con las notas', d.estado === 'disponible' && d.ultima === '1.2.6' && d.notas[0].cambios[0] === 'nuevo');
    check('GitHub con su Accept', red2.pedidos.find((x) => x.url.includes('api.github.com')).opciones.headers.Accept === 'application/vnd.github+json');
    await prov.lista();
    t = p.VALIDEZ_FALLO_MS + 1;
    await prov.lista();
    check('dentro de las 6 h no vuelve a pedir', red2.pedidos.length === 2);
    t = p.VALIDEZ_MS + 1;
    await prov.lista();
    check('pasadas las 6 h, sí', red2.pedidos.length === 4);

    t = 0;
    let caido = true;
    const red3 = redFalsa((url) => (caido ? new Error('sin red') : (url.includes('api.github.com') ? fuente.github : fuente.manifiesto)));
    const prov3 = p.crearProveedores({ versionInstalada: () => '1.2.5', pedir: red3.pedir, ahora, uso, plataforma: 'windows_amd64' });
    const [sinRed] = await prov3.lista();
    check('sin red: desconocido y sin conexión', sinRed.estado === 'desconocido' && sinRed.sinConexion === true && sinRed.ultima === null);
    await prov3.lista();
    check('un fallo no se reintenta en cada recarga', red3.pedidos.length === 1);
    caido = false;
    t = p.VALIDEZ_FALLO_MS + 1;
    const [volvio] = await prov3.lista();
    check('a los 10 min se reintenta', volvio.estado === 'disponible' && red3.pedidos.length === 3);
    caido = true;
    t += p.VALIDEZ_MS + 1;
    const [otraVez] = await prov3.lista();
    check('con la red caída de nuevo, usa el último dato bueno', otraVez.ultima === '1.2.6' && otraVez.sinConexion === true && otraVez.estado === 'disponible');

    const sinBinario = await p.crearProveedores({ versionInstalada: () => 'Desconocida (no se pudo consultar el binario)', pedir: red.pedir, ahora, uso, plataforma: 'windows_amd64' }).lista();
    check('sin versión instalada: desconocido', sinBinario[0].estado === 'desconocido' && sinBinario[0].instalada === null);

    const [sinNotas] = await p.crearProveedores({
      versionInstalada: () => '1.2.5', ahora, uso, plataforma: 'windows_amd64',
      pedir: redFalsa({ manifiesto: fuente.manifiesto, github: { cuerpo: '', status: 403 } }).pedir
    }).lista();
    check('GitHub caído: el aviso sale igual, sin notas', sinNotas.estado === 'disponible' && sinNotas.notas.length === 0 && sinNotas.notasError === 'HTTP 403');
  });

  await group('resumen del uso', () => {
    const ahora = new Date('2026-09-18T12:00:00Z');
    const archivo = JSON.stringify({
      session_started_at: '2026-08-27T06:14:47.318Z',
      session: { total_calls: 10, total_tokens: 500, input_tokens: 400, calls_by_tool: { run: 7, audit: 3, 'raro<script>': 9 } },
      today: { date: '2026-09-18', total_calls: 2, total_tokens: 50 },
      last_call: { prompt: 'no debería salir' },
      quota_status: 'HEALTHY',
      usageFile: 'C:\\Users\\alguien\\.claude\\antigravity-usage.json'
    });
    const r = resumenUso({ ruta: 'C:\Users\alguien\.claude\antigravity-usage.json', leer: () => archivo, ahora });
    check('totales y hoy', r.llamadas === 10 && r.tokens === 500 && r.hoy.llamadas === 2 && r.hoy.tokens === 50);
    check('desde cuándo cuentan', r.desde === '2026-08-27T06:14:47.318Z');
    check('herramientas con nombre válido', JSON.stringify(r.porHerramienta) === '{"run":7,"audit":3}');
    const plano = JSON.stringify(r);
    check('ni la ruta ni el último pedido', !plano.includes('Users') && !plano.includes('debería') && !('input_tokens' in r));
    check('solo los campos que se muestran', Object.keys(r).sort().join(',') === 'cuota,desde,hoy,llamadas,porHerramienta,tokens');
    const viejo = resumenUso({ ruta: 'x', leer: () => archivo, ahora: new Date('2026-09-19T01:00:00Z') });
    check('un día viejo cuenta como cero', viejo.hoy.llamadas === 0 && viejo.hoy.tokens === 0);
    check('archivo roto → null', resumenUso({ ruta: 'x', leer: () => '{roto' }) === null);
    check('sin archivo → null', resumenUso({ ruta: 'x', leer: () => { throw new Error('ENOENT'); } }) === null);
    check('la ruta es la de siempre', rutaUso({ USERPROFILE: 'C:\\u' }).replace(/\\/g, '/') === 'C:/u/.claude/antigravity-usage.json');
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
