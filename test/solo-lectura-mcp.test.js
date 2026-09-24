/**
 * SEC-020 fase 2 — Cómo deciden agy_plan / agy_review / agy_audit dónde correr,
 * vistos desde el servidor MCP real, con agy stubbeado y un "WSL" que no existe
 * (LAGRANGE_WSL_BIN): ningún Docker real se toca, y la marca vive en un
 * directorio temporal (LAGRANGE_SOLO_LECTURA_DIR), nunca en la del usuario.
 *
 *   - container sin infraestructura → error y agy NO se lanza (fail-closed);
 *   - auto, sin marca y sin infraestructura → host, con el aviso arriba;
 *   - auto CON marca y sin infraestructura → error: no se degrada al host;
 *   - isolation "host" con la config en container → rechazo, nada lanzado;
 *   - host explícito → corre en el host y el pie lo dice.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const texto = (r) => (((r.result || {}).content || [])[0] || {}).text || '';
const esError = (r) => Boolean(r.result && r.result.isError);
const lanzamientos = (capture) => fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((c) => c.args && !c.event);

async function conServidor(env, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mcp-cwd-'));
  const capture = path.join(cwd, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const previo = {};
  for (const [k, v] of Object.entries(env)) { previo[k] = process.env[k]; process.env[k] = v; }
  const server = startServer({ cwd, captureFile: capture });
  try {
    await server.initialize();
    await fn(server, capture, cwd);
  } finally {
    await server.stop();
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    removeFixture(cwd);
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mcp-estado-'));
  const sinWsl = path.join(os.tmpdir(), 'no-existe-wsl-lagrange.exe');
  const base = { LAGRANGE_WSL_BIN: sinWsl, LAGRANGE_SOLO_LECTURA_DIR: dir };
  try {
    await group('container sin infraestructura: fail-closed', async () => {
      await conServidor({ ...base, LAGRANGE_SOLO_LECTURA: 'container' }, async (server, capture) => {
        const r = await server.callTool('agy_audit', { target: 'git diff' });
        check('error', esError(r) && /No se lanzó nada/.test(texto(r)), texto(r).slice(0, 300));
        check('agy no se lanzó', lanzamientos(capture).length === 0);
        check('el pie dice que no hubo aislamiento', texto(r).includes('Isolation: none'));
      });
    });

    await group('auto sin marca y sin infraestructura: host con aviso', async () => {
      await conServidor({ ...base, LAGRANGE_SOLO_LECTURA: 'auto' }, async (server, capture) => {
        const r = await server.callTool('agy_plan', { task: 'x' });
        const t = texto(r);
        check('corre (en el host, stub)', !esError(r) && lanzamientos(capture).length === 1, t.slice(0, 300));
        check('el aviso va arriba', t.startsWith('⚠️ Corrió en el host, sin contención'), t.slice(0, 200));
        check('y el pie lo repite', t.includes('Isolation: host'));
        check('el modo no se presenta como contenido', t.includes('(no edits requested, not enforced)'));
      });
    });

    await group('auto CON marca y sin infraestructura: no degrada', async () => {
      fs.writeFileSync(path.join(dir, 'contenedor-verificado.json'), '{"verificado":"2026-09-24T00:00:00Z"}');
      await conServidor({ ...base, LAGRANGE_SOLO_LECTURA: 'auto' }, async (server, capture) => {
        const r = await server.callTool('agy_review', { review_target: 'git diff' });
        check('error', esError(r) && /no se degrada al host/.test(texto(r)), texto(r).slice(0, 300));
        check('agy no se lanzó', lanzamientos(capture).length === 0);
      });
    });

    await group('isolation "host" pedido', async () => {
      await conServidor({ ...base, LAGRANGE_SOLO_LECTURA: 'container' }, async (server, capture) => {
        const r = await server.callTool('agy_plan', { task: 'x', isolation: 'host' });
        check('con config container: rechazo', esError(r) && /rechazado/.test(texto(r)));
        check('nada lanzado', lanzamientos(capture).length === 0);
      });
      await conServidor({ ...base, LAGRANGE_SOLO_LECTURA: 'auto' }, async (server, capture) => {
        const r = await server.callTool('agy_audit', { target: 'git diff', isolation: 'host' });
        check('con auto (aun con marca): corre en el host', !esError(r) && lanzamientos(capture).length === 1, texto(r).slice(0, 300));
        check('y lo dice', texto(r).includes('Isolation: host') && texto(r).includes('isolation "host"'));
      });
    });

    await group('el catálogo expone isolation en las tres', async () => {
      await conServidor(base, async (server) => {
        const tools = (((await server.listTools()).result || {}).tools || []);
        for (const nombre of ['agy_plan', 'agy_review', 'agy_audit']) {
          const t = tools.find((x) => x.name === nombre);
          const p = t && t.inputSchema.properties.isolation;
          check(`${nombre}: isolation container|host`, p && JSON.stringify(p.enum) === '["container","host"]');
        }
        check('research no lo ofrece (sigue en el host)', !tools.find((x) => x.name === 'agy_research').inputSchema.properties.isolation);
      });
    });

    await group('en el contenedor, el agente trabaja en /trabajo', () => {
      // Medido en el canario (2026-09-24): sin el encuadre, run_command corría en
      // ~/.gemini/antigravity-cli/scratch y el agente no encontraba el proyecto.
      const fuente = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8');
      const i = fuente.indexOf('async function ejecutarSoloLectura(');
      const helper = fuente.slice(i, fuente.indexOf('\n}\n', i));
      check('el prompt del contenedor lleva /trabajo como Cwd de run_command',
        helper.includes("PREFIJO_ENTORNO_AISLADO + frameTaskWithWorkingDirectory(prompt, '/trabajo')"));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
