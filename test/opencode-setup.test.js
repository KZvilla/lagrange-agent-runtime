#!/usr/bin/env node
/**
 * FEAT-177 (F1) — `scripts/opencode-setup.mjs --diagnose`: dónde está parado el
 * usuario y qué falta para el opencode nativo, sin escribir nada.
 *
 * No necesita un opencode real: `resolveBin`/`version` se inyectan, y el CLI se
 * prueba con `OPENCODE_BIN` apuntando a un archivo que no existe. La fuente
 * (la raíz del plugin que ejecuta el script) se arma en un temporal con
 * `sourceRoot`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'opencode-setup.mjs');
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-opencode-setup-'));
let n = 0;
const nuevoDir = (nombre) => {
  const dir = path.join(raiz, `${nombre}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Una raíz de plugin mínima: package.json, el MCP y el plugin de opencode. */
function armarFuente(version = '1.55.0', plugin = '// plugin') {
  const dir = nuevoDir('fuente');
  fs.mkdirSync(path.join(dir, 'mcp-server'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.opencode', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'lagrange', version }));
  fs.writeFileSync(path.join(dir, 'mcp-server', 'index.js'), '// mcp');
  fs.writeFileSync(path.join(dir, '.opencode', 'plugins', 'lagrange.js'), plugin);
  return dir;
}

/** Un `home` aislado: ahí caen la config global de opencode y la caché de Claude Code. */
function armarHome() {
  const home = nuevoDir('home');
  return { home, configDir: path.join(home, '.config', 'opencode') };
}

function escribir(archivo, contenido) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2));
}

const opencodeOk = {
  resolveBin: () => 'C:\\opencode\\opencode.exe',
  version: async () => '2.1.3',
  spawn: () => { throw new Error('el diagnóstico sin --probe no debe lanzar procesos'); }
};

const ids = (r) => r.actions.map((a) => a.id);
const entrada = (fuente, extra = {}) => ({
  type: 'local',
  command: ['node', path.join(fuente, 'mcp-server', 'index.js')],
  environment: { LAGRANGE_HOST: 'opencode' },
  timeout: { startup: 10000, catalog: 10000, execution: 1800000 },
  ...extra
});

function arbol(dir) {
  const salida = [];
  const ir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      salida.push(p);
      if (e.isDirectory()) ir(p);
    }
  };
  ir(dir);
  return salida.sort();
}

async function main() {
  const { diagnose, parsearSemver, compararSemver } = await import(pathToFileURL(SCRIPT).href);
  const base = (extra = {}) => {
    const fuente = extra.fuente ?? armarFuente();
    const { home, configDir } = armarHome();
    return { fuente, home, configDir, opts: { env: {}, cwd: nuevoDir('cwd'), home, sourceRoot: fuente, ...opencodeOk, ...extra.opts } };
  };

  await group('semver completo (V12)', () => {
    const orden = ['0.67.11', '1.6.0', '1.55.0', '1.56.0-beta.1', '1.56.0-beta.2', '1.56.0'];
    const barajado = [orden[3], orden[0], orden[5], orden[2], orden[4], orden[1]];
    const ordenado = barajado.sort(compararSemver);
    check('0.67.11 < 1.6.0 < 1.55.0 < 1.56.0-beta.1 < beta.2 < 1.56.0', ordenado.join() === orden.join(), ordenado.join());
    check('una prerelease es anterior a su versión estable', compararSemver('1.56.0-beta.1', '1.56.0') < 0);
    check('1.55.0 > 1.6.0 (no es orden de texto)', compararSemver('1.55.0', '1.6.0') > 0);
    check('un texto que no es semver no se parsea', parsearSemver('latest') === null && parsearSemver('1.2') === null);
  });

  await group('la fuente es la raíz del plugin que ejecuta el script (D9)', async () => {
    const { opts, fuente } = base();
    const r = await diagnose(opts);
    check('source.root y version salen de la raíz', r.source?.root === fuente && r.source?.version === '1.55.0');
    check('source apunta al plugin y al MCP', r.source?.plugin === path.join(fuente, '.opencode', 'plugins', 'lagrange.js')
      && r.source?.mcpServer === path.join(fuente, 'mcp-server', 'index.js'));

    const huerfano = nuevoDir('huerfano');
    fs.writeFileSync(path.join(huerfano, 'package.json'), JSON.stringify({ version: '1.55.0' }));
    const sinFuente = await diagnose({ ...opts, sourceRoot: huerfano });
    check('V10: sin mcp-server ni plugin, source es null', sinFuente.source === null);
    check('V10: la única acción es no-source', ids(sinFuente).join() === 'no-source', ids(sinFuente).join());
  });

  await group('insideClone se mide sobre el cwd del usuario (D12, V3)', async () => {
    const { opts } = base();
    const clon = armarFuente();
    fs.mkdirSync(path.join(clon, '.git'));
    const dentro = await diagnose({ ...opts, cwd: path.join(clon, 'mcp-server') });
    check('cwd dentro de un clon con .git y los dos archivos: true', dentro.insideClone === true);
    const fuera = await diagnose(opts);
    check('cwd en un temporal cualquiera: false', fuera.insideClone === false);
    const sinGit = armarFuente();
    const dentroSinGit = await diagnose({ ...opts, cwd: sinGit });
    check('archivos de Lagrange sin .git no es un clon', dentroSinGit.insideClone === false);
    check('source.root queda aparte: la fuente no es el cwd', dentro.source.root !== dentro.cwd);
  });

  await group('precedencia del directorio de config (§5.1)', async () => {
    const { opts, home } = base();
    const cwd = opts.cwd;
    const a = nuevoDir('a');
    const r1 = await diagnose({ ...opts, configDir: a, env: { OPENCODE_CONFIG_DIR: 'x', XDG_CONFIG_HOME: 'y' } });
    check('--config-dir gana sobre todo', r1.config.dir === a);
    const r2 = await diagnose({ ...opts, env: { OPENCODE_CONFIG_DIR: 'rel', XDG_CONFIG_HOME: path.join(raiz, 'xdg') } });
    check('OPENCODE_CONFIG_DIR relativo se resuelve contra --cwd', r2.config.dir === path.join(cwd, 'rel'), r2.config.dir);
    const xdg = path.join(raiz, 'xdg');
    const r3 = await diagnose({ ...opts, env: { XDG_CONFIG_HOME: xdg } });
    check('XDG_CONFIG_HOME/opencode va antes que --home', r3.config.dir === path.join(xdg, 'opencode'));
    const r4 = await diagnose(opts);
    check('--home + .config/opencode', r4.config.dir === path.join(home, '.config', 'opencode'));
    check('el plugin global vive en <configDir>/plugins', r4.globalPlugin.path === path.join(r4.config.dir, 'plugins', 'lagrange.js'));
  });

  await group('sin config ni plugin: se crea todo', async () => {
    const { opts, configDir } = base();
    const r = await diagnose(opts);
    check('config.format none, sin archivo', r.config.format === 'none' && r.config.file === null && r.config.shape === 'none');
    check('acciones: copy-plugin, merge-config y el consejo restart-opencode', ids(r).join() === 'copy-plugin,merge-config,restart-opencode', ids(r).join());
    check('el diagnóstico no creó el configDir', !fs.existsSync(configDir));
  });

  await group('config .json al día: nada que hacer', async () => {
    const { opts, fuente, configDir } = base();
    escribir(path.join(configDir, 'opencode.json'), { $schema: 'x', mcp: { servers: { lagrange: entrada(fuente) } } });
    fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
    fs.copyFileSync(path.join(fuente, '.opencode', 'plugins', 'lagrange.js'), path.join(configDir, 'plugins', 'lagrange.js'));
    const r = await diagnose(opts);
    check('shape servers, command absoluto, host y timeout leídos', r.config.shape === 'servers' && r.config.absolute === true
      && r.config.hostMarker === 'opencode' && r.config.timeout === 1800000);
    check('plugin igual a la fuente: no stale', r.globalPlugin.exists && !r.globalPlugin.stale);
    check('sin acciones ni avisos', r.actions.length === 0 && r.warnings.length === 0, JSON.stringify([r.actions, r.warnings]));
  });

  await group('config .json desactualizada: merge-config con motivos', async () => {
    const { opts, configDir } = base();
    escribir(path.join(configDir, 'opencode.json'), { mcp: { lagrange: { type: 'local', command: ['node', 'mcp-server/index.js'], timeout: 60000 } } });
    const r = await diagnose(opts);
    const merge = r.actions.find((a) => a.id === 'merge-config');
    check('shape legacy y command relativo', r.config.shape === 'legacy' && r.config.absolute === false);
    check('merge-config nombra command, host marker y timeout',
      Boolean(merge) && /update-command/.test(merge.reason) && /add-host-marker/.test(merge.reason) && /update-timeout/.test(merge.reason), merge?.reason);

    const otro = base();
    escribir(path.join(otro.configDir, 'opencode.json'), { mcp: { servers: { lagrange: entrada(otro.fuente, { timeout: 60000 }) } } });
    const r2 = await diagnose(otro.opts);
    check('un timeout legacy menor se corrige', /update-timeout/.test(r2.actions.find((a) => a.id === 'merge-config')?.reason ?? ''));
  });

  await group('commandVersion sale de la ruta absoluta (también en Windows)', async () => {
    const { opts, configDir } = base();
    escribir(path.join(configDir, 'opencode.json'), { mcp: { servers: { lagrange: {
      type: 'local', command: ['node', 'C:\\Users\\x\\.claude\\plugins\\cache\\m\\lagrange\\1.54.1\\mcp-server\\index.js']
    } } } });
    const r = await diagnose(opts);
    check('1.54.1', r.config.commandVersion === '1.54.1' && r.config.absolute === true, String(r.config.commandVersion));
    const rel = base();
    escribir(path.join(rel.configDir, 'opencode.json'), { mcp: { servers: { lagrange: { type: 'local', command: ['node', 'mcp-server/index.js'] } } } });
    check('una ruta relativa no tiene commandVersion', (await diagnose(rel.opts)).config.commandVersion === null);
  });

  await group('casos que piden manual-merge (V13, V17, V18)', async () => {
    const casos = [
      ['shape both (servers y legacy)', { mcp: { servers: { lagrange: { type: 'local' } }, lagrange: { type: 'local' } } }, (r) => r.config.shape === 'both'],
      ['entrada remote', { mcp: { servers: { lagrange: { type: 'remote', url: 'https://x' } } } }, (r) => r.config.entryType === 'remote'],
      ['mcp no es objeto', { mcp: [] }, (r) => r.config.problem === 'mcp-not-object'],
      ['mcp.servers no es objeto', { mcp: { servers: 'x' } }, (r) => r.config.problem === 'servers-not-object']
    ];
    for (const [nombre, contenido, extra] of casos) {
      const { opts, configDir } = base();
      escribir(path.join(configDir, 'opencode.json'), contenido);
      const r = await diagnose(opts);
      check(`${nombre}: manual-merge y ningún merge-config`, ids(r).includes('manual-merge') && !ids(r).includes('merge-config') && extra(r), ids(r).join());
    }
    const { opts, configDir } = base();
    escribir(path.join(configDir, 'opencode.json'), '{ esto no es json');
    const r = await diagnose(opts);
    check('V17: .json ilegible → format invalid, manual-merge y aviso', r.config.format === 'invalid' && ids(r).includes('manual-merge')
      && r.warnings.some((w) => w.startsWith('config-invalid')));
  });

  await group('config .jsonc: no se reescribe (D5, V5, V11, V15)', async () => {
    const { opts, configDir, fuente } = base();
    escribir(path.join(configDir, 'opencode.jsonc'), '{\n  // comentario con "lagrange": falso\n  "mcp": { "servers": {} }\n}\n');
    const r = await diagnose(opts);
    check('format jsonc, forma none (los comentarios no cuentan), manual-jsonc', r.config.format === 'jsonc' && r.config.shape === 'none' && ids(r).includes('manual-jsonc'));
    check('el .jsonc no genera merge-config', !ids(r).includes('merge-config'));

    escribir(path.join(configDir, 'opencode.json'), { mcp: { servers: { lagrange: entrada(fuente) } } });
    const tapado = await diagnose(opts);
    check('V11: con .json y .jsonc gana el .jsonc y shadowed es true', tapado.config.file === 'opencode.jsonc' && tapado.config.shadowed === true);
    check('V11: shadowed avisa, no aborta ni toca el .json', tapado.warnings.some((w) => w.startsWith('shadowed')) && !ids(tapado).includes('merge-config'));

    const ambiguo = base();
    escribir(path.join(ambiguo.configDir, 'opencode.jsonc'), '{ "mcp": { "servers": { "lagrange": {} }, "lagrange": {} } }');
    const rA = await diagnose(ambiguo.opts);
    check('V15: dos «lagrange» en un .jsonc → manual-merge', rA.config.ambiguous === true && ids(rA).includes('manual-merge'));

    const listo = base();
    const texto = `{\n  // ya está\n  "mcp": { "servers": { "lagrange": { "type": "local", "command": ["node", "${listo.fuente.replace(/\\/g, '/')}/mcp-server/index.js"], "environment": { "LAGRANGE_HOST": "opencode" } } } }\n}`;
    escribir(path.join(listo.configDir, 'opencode.jsonc'), texto);
    check('un .jsonc que ya apunta a esta copia no pide fragmento', !ids(await diagnose(listo.opts)).includes('manual-jsonc'));
  });

  await group('plugin global viejo y caché (V12, V14)', async () => {
    const { opts, configDir, fuente } = base();
    fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'plugins', 'lagrange.js'), '// versión vieja');
    escribir(path.join(configDir, 'opencode.json'), { mcp: { servers: { lagrange: entrada(fuente) } } });
    const r = await diagnose(opts);
    check('plugin distinto: stale y copy-plugin', r.globalPlugin.stale === true && ids(r).includes('copy-plugin'));

    for (const v of ['0.67.11', '1.6.0', '1.55.0', '1.56.0-beta.1']) {
      fs.mkdirSync(path.join(opts.home, '.claude', 'plugins', 'cache', 'mkt', 'lagrange', v), { recursive: true });
    }
    const conCache = await diagnose(opts);
    check('la caché ordena por semver y el último estable es 1.55.0',
      conCache.cache.versions.join() === '1.56.0-beta.1,1.55.0,1.6.0,0.67.11' && conCache.cache.latest === '1.55.0', conCache.cache.versions.join());
    check('fuente igual a la última estable: sin aviso de copia vieja', !conCache.warnings.some((w) => w.startsWith('copia-vieja')));

    fs.mkdirSync(path.join(opts.home, '.claude', 'plugins', 'cache', 'mkt', 'lagrange', '1.60.0'), { recursive: true });
    const vieja = await diagnose(opts);
    check('caché con 1.60.0 y fuente 1.55.0: avisa copia-vieja', vieja.warnings.some((w) => w.startsWith('copia-vieja')), vieja.warnings.join());
  });

  await group('opencode ausente, shim o 1.x no rompen el diagnóstico (D3, V7)', async () => {
    const ausente = base({ opts: { resolveBin: () => { throw new Error('opencode is not installed or not on PATH.'); } } });
    const r = await diagnose(ausente.opts);
    check('ok:false, version null y error con el motivo', r.opencode.ok === false && r.opencode.version === null && /not installed/.test(r.opencode.error));
    check('aviso install-opencode (es un warning, no una acción)', r.warnings.some((w) => w.startsWith('install-opencode')) && !ids(r).includes('install-opencode'));
    check('el resto del informe sigue ahí', r.source !== null && ids(r).includes('merge-config'));

    const vieja = base({ opts: { version: async () => { throw new Error('opencode >= 2 required (found 1.9.0)'); } } });
    const r1 = await diagnose(vieja.opts);
    check('1.x: ok:false pero se reporta la versión hallada', r1.opencode.ok === false && r1.opencode.version === '1.9.0' && r1.warnings.some((w) => w.startsWith('upgrade-opencode')));

    check('sin --probe: probed false y mcpList/pluginList null', r.opencode.probed === false && r.opencode.mcpList === null && r.opencode.pluginList === null);
    const bueno = await diagnose(base().opts);
    check('con opencode 2.x: ok:true y la versión', bueno.opencode.ok === true && bueno.opencode.version === '2.1.3');
  });

  await group('el diagnóstico es read-only (D3)', async () => {
    const { opts, home, configDir, fuente } = base();
    escribir(path.join(configDir, 'opencode.json'), { mcp: { servers: { lagrange: entrada(fuente, { timeout: 1 }) } } });
    const antes = arbol(home);
    const contenido = fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8');
    await diagnose(opts);
    check('no se crea ni se borra ningún archivo', arbol(home).join('\n') === antes.join('\n'));
    check('la config no cambia', fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8') === contenido);
  });

  await group('host informativo', async () => {
    const { opts } = base();
    check('OPENCODE=1 → opencode', (await diagnose({ ...opts, env: { OPENCODE: '1' } })).host.detected === 'opencode');
    check('CLAUDE_CODE_* → claude', (await diagnose({ ...opts, env: { CLAUDE_CODE_SESSION_ID: 'x' } })).host.detected === 'claude');
    check('nada → unknown', (await diagnose(opts)).host.detected === 'unknown');
  });

  await group('CLI', () => {
    const { home } = armarHome();
    const cwd = nuevoDir('cli-cwd');
    const correr = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, OPENCODE_BIN: path.join(raiz, 'no-existe.exe'), ...env }
    });
    const json = correr(['--diagnose', '--json', '--home', home, '--cwd', cwd]);
    let datos = null;
    try { datos = JSON.parse(json.stdout); } catch { /* se verifica abajo */ }
    check('--diagnose --json: exit 0 y JSON con las secciones de §5.2', json.status === 0 && datos
      && ['host', 'cwd', 'insideClone', 'source', 'config', 'globalPlugin', 'cache', 'opencode', 'actions', 'warnings'].every((k) => k in datos), json.stderr);
    check('sin un opencode real: ok:false sin excepción', datos?.opencode.ok === false && /OPENCODE_BIN does not exist/.test(datos.opencode.error ?? ''));
    check('el home pasado por --home define el configDir', datos?.config.dir === path.join(home, '.config', 'opencode'));
    const texto = correr(['--diagnose', '--home', home, '--cwd', cwd]);
    check('informe legible: exit 0 y menciona las acciones', texto.status === 0 && /Acciones:/.test(texto.stdout) && /copy-plugin/.test(texto.stdout));
    const sinModo = correr([]);
    check('sin --diagnose: exit 2 y uso', sinModo.status === 2 && /--diagnose/.test(sinModo.stderr));
    const raro = correr(['--diagnose', '--nada']);
    check('argumento desconocido: exit 2', raro.status === 2 && /desconocido/.test(raro.stderr));
    const sinValor = correr(['--diagnose', '--home']);
    check('--home sin valor: exit 2', sinValor.status === 2 && /necesita un valor/.test(sinValor.stderr));
  });
}

main()
  .catch((e) => { check('la suite no lanzó una excepción', false, e && e.stack ? e.stack : String(e)); })
  .finally(() => {
    try { fs.rmSync(raiz, { recursive: true, force: true }); } catch { /* temporal */ }
    report();
  });
