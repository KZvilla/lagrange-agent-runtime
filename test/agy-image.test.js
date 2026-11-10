/**
 * FEAT-189 — `agy_image` contra el servidor real, con agy stubeado.
 *
 * La tool no llama a `generate_image` por API: corre `agy -p` en un cwd
 * temporal vacío, pide el subagente `image-generator` y copia el artefacto.
 * El stub devuelve la ruta de un JPEG real como `response`, así que estos tests
 * cubren validación, prompt, parseo, copia y metadata sin gastar cuota.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const agyImage = require('../mcp-server/lib/agy-image.js');

// JPEG RGB de 2x3, generado con Pillow. Sirve para probar formato y dimensiones.
const WEBP_2X3 = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAYAAAAcQ0f/+ByKi/wEA', 'base64');

const JPEG_2X3 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy'
  + 'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIA'
  + 'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA'
  + 'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3'
  + 'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm'
  + 'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA'
  + 'AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx'
  + 'BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK'
  + 'U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3'
  + 'uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK'
  + '+ZP3E//Z',
  'base64'
);

const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);
const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);
const valorDe = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };

async function conServidor(env, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-'));
  const capture = path.join(cwd, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const server = startServer({ cwd, captureFile: capture, env });
  try {
    await server.initialize();
    await fn({ server, capture, cwd });
  } finally {
    await server.stop();
    removeFixture(cwd);
  }
}

function escribirJpeg(ruta) {
  fs.writeFileSync(ruta, JPEG_2X3);
  return ruta;
}

async function main() {
  await group('FEAT-189: helpers puros de imagen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-unit-'));
    try {
      const jpg = escribirJpeg(path.join(dir, 'x.jpg'));
      const info = agyImage.leerImagen(jpg);
      check('lee JPEG', info.ok && info.formato === 'jpeg', JSON.stringify(info));
      check('dimensiones 2x3', info.width === 2 && info.height === 3, JSON.stringify(info));
      const truncado = path.join(dir, 'truncado.jpg');
      fs.writeFileSync(truncado, Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
      const malo = agyImage.leerImagen(truncado, { requerirDimensiones: true });
      check('rechaza un JPEG sin dimensiones verificables', !malo.ok, JSON.stringify(malo));
      const webp = path.join(dir, 'x.webp');
      fs.writeFileSync(webp, WEBP_2X3);
      const infoWebp = agyImage.leerImagen(webp, { requerirDimensiones: true });
      check('lee WebP y sus dimensiones', infoWebp.ok && infoWebp.formato === 'webp' && infoWebp.width === 2 && infoWebp.height === 3, JSON.stringify(infoWebp));
      const ruta = agyImage.extraerRutaDeImagen(`Waiting for subagent notification.\n${jpg}\n`);
      check('extrae la ruta de una respuesta con texto', ruta === jpg, String(ruta));
      check('sin ruta devuelve null', agyImage.extraerRutaDeImagen('no hay imagen') === null);

      const home = path.join(dir, 'home');
      const prep = agyImage.prepararSolicitud({ prompt: 'Un cuadrado rojo' }, { baseDir: dir, homeDir: home, ahora: new Date('2026-11-10T13:39:44Z') });
      check('prepara una solicitud válida', prep.ok, JSON.stringify(prep));
      check('elige el directorio durable', prep.ok && prep.output.ruta.startsWith(path.join(home, '.claude', 'lagrange-images')), prep.ok ? prep.output.ruta : '');
      check('nombre con timestamp y slug', prep.ok && /2026-11-10-13-39-44-un-cuadrado-rojo\.jpg$/.test(prep.output.ruta), prep.ok ? prep.output.ruta : '');
    } finally {
      removeFixture(dir);
    }
  });

  await group('FEAT-189: genera, copia y devuelve metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-gen-'));
    try {
      const source = escribirJpeg(path.join(dir, 'source.jpg'));
      const output = path.join(dir, 'out.jpg');
      await conServidor({ STUB_RESPONSE: source }, async ({ server, capture }) => {
        const r = await server.callTool('agy_image', {
          prompt: 'Un cuadrado rojo liso',
          output_path: output,
          aspect_ratio: '16:9'
        });
        check('no es error', !esError(r), texto(r).slice(0, 500));
        check('devuelve la ruta durable', texto(r).includes(output), texto(r).slice(0, 500));
        check('devuelve formato y dimensiones', /jpeg/i.test(texto(r)) && /2×3/.test(texto(r)), texto(r).slice(0, 800));
        check('devuelve el aspecto', /16:9/.test(texto(r)), texto(r).slice(0, 800));
        check('copia el archivo', fs.existsSync(output) && fs.readFileSync(output).equals(JPEG_2X3), output);

        const calls = lanzamientos(capture);
        check('un solo lanzamiento', calls.length === 1, String(calls.length));
        const call = calls[0];
        check('--output-format json', valorDe(call.args, '--output-format') === 'json', JSON.stringify(call.args.slice(0, 8)));
        check('--mode plan', valorDe(call.args, '--mode') === 'plan', JSON.stringify(call.args.slice(0, 8)));
        check('--print-timeout 10m', valorDe(call.args, '--print-timeout') === '10m', JSON.stringify(call.args.slice(0, 8)));
        check('cwd temporal, no el repo', path.basename(call.cwd).startsWith('lagrange-image-') && call.cwd !== dir, String(call.cwd));
        check('el temporal se limpia', !fs.existsSync(call.cwd), String(call.cwd));
        const prompt = valorDe(call.args, '-p');
        check('prompt pide image-generator', /TypeName "image-generator"/.test(prompt), prompt.slice(0, 500));
        check('prompt pide aspecto', /Aspect ratio: 16:9/.test(prompt), prompt.slice(0, 700));
        check('prompt prohíbe generate_image directo', /Do NOT call `generate_image` yourself/.test(prompt), prompt.slice(0, 700));
        check('origen intacto', fs.existsSync(source), source);
      });
    } finally {
      removeFixture(dir);
    }
  });

  await group('FEAT-189: edición con ImagePaths en forward slashes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-edit-'));
    try {
      const source = escribirJpeg(path.join(dir, 'entrada.jpg'));
      const output = path.join(dir, 'salida.jpg');
      await conServidor({ STUB_RESPONSE: source }, async ({ server, capture }) => {
        const r = await server.callTool('agy_image', {
          prompt: 'Cambiá el cuadrado por un círculo azul',
          image_paths: [source],
          output_path: output
        });
        check('no es error', !esError(r), texto(r).slice(0, 500));
        const prompt = valorDe(lanzamientos(capture)[0].args, '-p');
        const esperada = source.replace(/\\/g, '/');
        check('incluye ImagePaths', prompt.includes('ImagePaths'), prompt.slice(0, 900));
        check('usa forward slashes', prompt.includes(esperada) && !prompt.includes(source.replace(/\//g, '\\')), prompt.slice(0, 900));
        check('copia el archivo', fs.existsSync(output), output);
      });
    } finally {
      removeFixture(dir);
    }
  });

  await group('FEAT-189: valida antes de lanzar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-val-'));
    try {
      const source = escribirJpeg(path.join(dir, 'source.jpg'));
      const existente = path.join(dir, 'existente.jpg');
      fs.writeFileSync(existente, JPEG_2X3);
      await conServidor({ STUB_RESPONSE: source }, async ({ server, capture }) => {
        const casos = [
          [{ prompt: '' }, /prompt/],
          [{ prompt: 'x', aspect_ratio: '7:3' }, /aspect_ratio/],
          [{ prompt: 'x', image_paths: [path.join(dir, 'no-existe.jpg')] }, /No encontré/],
          [{ prompt: 'x', output_path: path.join(dir, 'x.png') }, /extensión no soportada/],
          [{ prompt: 'x', timeout_minutes: 0 }, /timeout_minutes/],
          [{ prompt: 'x', output_path: existente }, /ya existe/]
        ];
        for (const [args, patron] of casos) {
          const r = await server.callTool('agy_image', args);
          check(`${JSON.stringify(args)} falla`, esError(r) && patron.test(texto(r)), texto(r).slice(0, 400));
        }
        check('ninguno lanzó agy', lanzamientos(capture).length === 0, JSON.stringify(lanzamientos(capture)));
      });
    } finally {
      removeFixture(dir);
    }
  });

  await group('FEAT-189: respuestas sin ruta y fallos de agy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-fail-'));
    try {
      const source = escribirJpeg(path.join(dir, 'source.jpg'));
      const output = path.join(dir, 'out.jpg');
      await conServidor({ STUB_RESPONSE: 'no path here' }, async ({ server }) => {
        const r = await server.callTool('agy_image', { prompt: 'x', output_path: output });
        check('sin ruta es error', esError(r), texto(r).slice(0, 500));
        check('explica que no hubo ruta', /no devolvió una ruta/.test(texto(r)), texto(r).slice(0, 700));
        check('no copia nada', !fs.existsSync(output), output);
      });
      await conServidor({ STUB_FAIL_STDERR: 'image generation quota exceeded' }, async ({ server }) => {
        const r = await server.callTool('agy_image', { prompt: 'x', output_path: output });
        check('fallo de agy es error', esError(r), texto(r).slice(0, 500));
        check('propaga el motivo', /quota exceeded/.test(texto(r)), texto(r).slice(0, 700));
        check('no copia nada', !fs.existsSync(output), output);
      });
      await conServidor({ STUB_PARTIAL_TIMEOUT_V15: 'silent', STUB_RESPONSE: source }, async ({ server }) => {
        const r = await server.callTool('agy_image', { prompt: 'x', output_path: output });
        check('timeout de agy es error', esError(r), texto(r).slice(0, 500));
        check('explica el timeout', /timeout|timed out|partial/i.test(texto(r)), texto(r).slice(0, 700));
        check('no copia nada tras el timeout', !fs.existsSync(output), output);
      });
    } finally {
      removeFixture(dir);
    }
  });

  await group('FEAT-189: structuredContent con MCP 2025-06-18', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-struct-'));
    try {
      const source = escribirJpeg(path.join(dir, 'source.jpg'));
      const output = path.join(dir, 'out.jpg');
      const cwd = dir;
      const capture = path.join(dir, 'capture.jsonl');
      fs.writeFileSync(capture, '');
      const server = startServer({ cwd, captureFile: capture, env: { STUB_RESPONSE: source, STUB_USAGE: '1' } });
      try {
        await server.initialize(undefined, '2025-06-18');
        const listado = await server.listTools();
        const tool = (((listado.result || {}).tools) || []).find((t) => t.name === 'agy_image');
        check('agy_image declares outputSchema', Boolean(tool && tool.outputSchema), JSON.stringify(tool && Object.keys(tool)));
        const r = await server.callTool('agy_image', { prompt: 'x', output_path: output });
        check('no es error', !esError(r), texto(r).slice(0, 500));
        const sc = (r.result || {}).structuredContent;
        check('structuredContent existe', Boolean(sc), JSON.stringify(r.result || {}).slice(0, 500));
        check('campos completos', sc && ['path', 'source_path', 'format', 'width', 'height', 'bytes', 'aspect_ratio', 'conversation_id', 'duration_seconds', 'usage', 'success', 'error'].every((k) => k in sc), JSON.stringify(sc));
        check('path correcto', sc && sc.path === output, sc && sc.path);
        check('formato y dimensiones', sc && sc.format === 'jpeg' && sc.width === 2 && sc.height === 3, JSON.stringify(sc));
        check('success true y error null', sc && sc.success === true && sc.error === null, JSON.stringify(sc));
        check('usage presente', sc && sc.usage && sc.usage.input_tokens === 10, JSON.stringify(sc && sc.usage));
      } finally {
        await server.stop();
      }
    } finally {
      removeFixture(dir);
    }
  });

  await group('FEAT-189: structuredContent en error con MCP 2025-06-18', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-image-struct-err-'));
    try {
      const output = path.join(dir, 'out.jpg');
      const capture = path.join(dir, 'capture.jsonl');
      fs.writeFileSync(capture, '');
      const server = startServer({ cwd: dir, captureFile: capture, env: { STUB_RESPONSE: 'no path here', STUB_USAGE: '1' } });
      try {
        await server.initialize(undefined, '2025-06-18');
        const r = await server.callTool('agy_image', { prompt: 'x', output_path: output });
        check('es error', esError(r), texto(r).slice(0, 500));
        const sc = (r.result || {}).structuredContent;
        check('structuredContent existe en error', Boolean(sc), JSON.stringify(r.result || {}).slice(0, 500));
        check('success false', sc && sc.success === false, JSON.stringify(sc));
        check('path null', sc && sc.path === null, JSON.stringify(sc));
        check('error string', sc && typeof sc.error === 'string' && sc.error.length > 0, JSON.stringify(sc));
        check('no copia nada', !fs.existsSync(output), output);

        const pre = await server.callTool('agy_image', { prompt: '', output_path: output });
        check('rechazo previo es error', esError(pre), texto(pre).slice(0, 400));
        const scPre = (pre.result || {}).structuredContent;
        check('rechazo previo también trae structuredContent', Boolean(scPre), JSON.stringify(pre.result || {}).slice(0, 400));
        check('rechazo previo success false y path null', scPre && scPre.success === false && scPre.path === null, JSON.stringify(scPre));
        check('rechazo previo explica prompt', scPre && /prompt/.test(scPre.error || ''), JSON.stringify(scPre));
      } finally {
        await server.stop();
      }
    } finally {
      removeFixture(dir);
    }
  });

  return report();
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((err) => {
  console.error(err);
  process.exit(1);
});
