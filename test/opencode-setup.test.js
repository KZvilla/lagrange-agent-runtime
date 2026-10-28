#!/usr/bin/env node
/**
 * FEAT-177 (F1, F2) — `scripts/opencode-setup.mjs`: `--diagnose` dice dónde
 * está parado el usuario y qué falta para el opencode nativo sin escribir nada,
 * y `--apply --yes` lo aplica (plugin global + config .json) con backups.
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
  const { diagnose, apply, parsearSemver, compararSemver } = await import(pathToFileURL(SCRIPT).href);
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

  // -------------------------------------------------------------------------
  // F2 — apply
  // -------------------------------------------------------------------------

  const leer = (archivo) => fs.readFileSync(archivo, 'utf8');
  const hash = (archivo) => require('node:crypto').createHash('sha256').update(fs.readFileSync(archivo)).digest('hex');
  const AHORA = { now: () => new Date('2030-01-01T00:00:00.000Z') };
  const aplicar = (b, extra = {}) => apply({ ...b.opts, ...AHORA, yes: true, ...extra });
  const rutaPlugin = (b) => path.join(b.configDir, 'plugins', 'lagrange.js');
  const rutaConfig = (b) => path.join(b.configDir, 'opencode.json');
  const backups = (b, ext) => (fs.existsSync(path.join(b.configDir, '.backups'))
    ? fs.readdirSync(path.join(b.configDir, '.backups')).filter((f) => f.endsWith(ext)).sort() : []);

  await group('apply exige yes:true (D4, D13)', async () => {
    const b = base();
    let error = null;
    try { await apply({ ...b.opts }); } catch (e) { error = e; }
    check('sin yes lanza', error !== null && /yes: true/.test(error.message));
    let error2 = null;
    try { await apply({ ...b.opts, yes: 'true' }); } catch (e) { error2 = e; }
    check('yes debe ser exactamente true', error2 !== null);
    check('no se escribió nada', !fs.existsSync(b.configDir));
  });

  await group('V4: fuera del clon sin config, se crea todo y la segunda pasada no hace nada', async () => {
    const b = base();
    const r = await aplicar(b);
    check('status applied con dos cambios (plugin y config)', r.status === 'applied' && r.changes.map((c) => c.what).join() === 'plugin,config', JSON.stringify(r.changes));
    check('el plugin quedó idéntico a la fuente', hash(rutaPlugin(b)) === hash(path.join(b.fuente, '.opencode', 'plugins', 'lagrange.js')));
    const cfg = JSON.parse(leer(rutaConfig(b)));
    const e = cfg.mcp.servers.lagrange;
    check('config nueva: $schema, type local, command absoluto, host y timeout de 30 min',
      cfg.$schema === 'https://opencode.ai/config.json' && e.type === 'local'
      && e.command.join() === ['node', path.join(b.fuente, 'mcp-server', 'index.js')].join()
      && e.environment.LAGRANGE_HOST === 'opencode' && e.timeout.execution === 1800000, JSON.stringify(e));
    check('avisa que hay que reiniciar y verificar después', r.notes.some((n) => /opencode reload/.test(n)));
    check('el diagnóstico posterior no pide nada', (await diagnose(b.opts)).actions.length === 0);

    const antes = [hash(rutaPlugin(b)), hash(rutaConfig(b)), arbol(b.home).join('\n')];
    const r2 = await aplicar(b);
    check('V4: segunda pasada: noop, sin cambios ni backups', r2.status === 'noop' && r2.changes.length === 0 && backups(b, '.json').length === 0);
    check('V4: los archivos no cambian', antes[0] === hash(rutaPlugin(b)) && antes[1] === hash(rutaConfig(b)) && antes[2] === arbol(b.home).join('\n'));
  });

  await group('merge en un .json existente: preserva todo y respalda', async () => {
    const b = base();
    const original = { theme: 'dark', mcp: { otro: { type: 'local', command: ['x'] }, lagrange: { type: 'local', command: ['node', 'mcp-server/index.js'], timeout: 3600000, extra: 1 } }, plugin: ['a'] };
    escribir(rutaConfig(b), original);
    const antes = leer(rutaConfig(b));
    const r = await aplicar(b);
    const cfg = JSON.parse(leer(rutaConfig(b)));
    check('actualiza la entrada legacy donde estaba (no la mueve a servers)', cfg.mcp.servers === undefined && cfg.mcp.lagrange.command[1] === path.join(b.fuente, 'mcp-server', 'index.js'));
    check('agrega LAGRANGE_HOST y conserva el timeout mayor del usuario', cfg.mcp.lagrange.environment.LAGRANGE_HOST === 'opencode' && cfg.mcp.lagrange.timeout === 3600000);
    check('preserva todo lo demás (theme, otro MCP, plugin, claves extra)', cfg.theme === 'dark' && cfg.mcp.otro.command[0] === 'x' && cfg.plugin[0] === 'a' && cfg.mcp.lagrange.extra === 1);
    check('no agrega $schema si no estaba', cfg.$schema === undefined);
    const bk = backups(b, '.json');
    check('backup opencode-<fecha>.json con el contenido original', bk.length === 1 && /^opencode-2030-01-01T00-00-00-000Z\.json$/.test(bk[0]) && leer(path.join(b.configDir, '.backups', bk[0])) === antes, bk.join());
    check('el cambio reporta el backup', r.changes.find((c) => c.what === 'config')?.backup?.endsWith(bk[0]));
    check('no quedan temporales', !arbol(b.configDir).some((f) => f.includes('.tmp-')));

    const timeoutBajo = base();
    escribir(rutaConfig(timeoutBajo), { mcp: { servers: { lagrange: entrada(timeoutBajo.fuente, { timeout: { execution: 1000 } }) } } });
    await aplicar(timeoutBajo);
    const t = JSON.parse(leer(rutaConfig(timeoutBajo))).mcp.servers.lagrange.timeout;
    check('un timeout.execution menor se sube a 30 min y conserva startup/catalog', t.execution === 1800000 && t.startup === 10000 && t.catalog === 10000);
  });

  await group('plugin global viejo: backup, reemplazo y rotación de 5 (V4)', async () => {
    const b = base();
    fs.mkdirSync(path.dirname(rutaPlugin(b)), { recursive: true });
    fs.writeFileSync(rutaPlugin(b), '// versión vieja');
    escribir(rutaConfig(b), { mcp: { servers: { lagrange: entrada(b.fuente) } } });
    const dirB = path.join(b.configDir, '.backups');
    fs.mkdirSync(dirB, { recursive: true });
    for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dirB, `lagrange-2020-01-0${i}T00-00-00-000Z.js`), `// ${i}`);
    fs.writeFileSync(path.join(dirB, 'notas-del-usuario.js'), '// no es mío');
    const r = await aplicar(b);
    const bk = backups(b, '.js');
    check('el plugin se reemplazó por el de la fuente', hash(rutaPlugin(b)) === hash(path.join(b.fuente, '.opencode', 'plugins', 'lagrange.js')));
    check('el backup nuevo guarda la versión vieja', bk.some((f) => f.startsWith('lagrange-2030') && leer(path.join(dirB, f)) === '// versión vieja'), bk.join());
    check('se rota a 5 backups propios, los más viejos primero', bk.filter((f) => f.startsWith('lagrange-')).length === 5 && !bk.includes('lagrange-2020-01-01T00-00-00-000Z.js') && !bk.includes('lagrange-2020-01-02T00-00-00-000Z.js'), bk.join());
    check('no borra archivos que no son sus backups', bk.includes('notas-del-usuario.js'));
    check('reporta el cambio de hash', r.changes[0].from && r.changes[0].to && r.changes[0].from !== r.changes[0].to);
  });

  await group('preflight: ningún aborto deja el plugin copiado (V13, V17, V18)', async () => {
    const casos = [
      ['V13 shape both', { mcp: { servers: { lagrange: { type: 'local' } }, lagrange: { type: 'local' } } }],
      ['V18 entrada remote', { mcp: { servers: { lagrange: { type: 'remote', url: 'https://x' } } } }],
      ['mcp no es objeto', { mcp: 5 }],
      ['mcp.servers no es objeto', { mcp: { servers: [] } }]
    ];
    for (const [nombre, contenido] of casos) {
      const b = base();
      escribir(rutaConfig(b), contenido);
      const antes = leer(rutaConfig(b));
      const r = await aplicar(b);
      check(`${nombre}: aborta con manual-merge`, r.status === 'aborted' && r.abort.id === 'manual-merge', JSON.stringify(r.abort));
      check(`${nombre}: no copió el plugin ni tocó la config ni hizo backups`, !fs.existsSync(rutaPlugin(b)) && leer(rutaConfig(b)) === antes && backups(b, '.json').length === 0);
    }
    const b = base();
    escribir(rutaConfig(b), '{ no es json');
    const r = await aplicar(b);
    check('V17: .json ilegible aborta sin escribir', r.status === 'aborted' && r.abort.id === 'manual-merge' && !fs.existsSync(rutaPlugin(b)) && leer(rutaConfig(b)) === '{ no es json');
  });

  await group('V14: downgrade', async () => {
    const b = base();
    fs.mkdirSync(path.join(b.home, '.claude', 'plugins', 'cache', 'mkt', 'lagrange', '1.60.0'), { recursive: true });
    const r = await aplicar(b);
    check('sin --force aborta pidiendo la última versión y no escribe', r.status === 'aborted' && r.abort.id === 'downgrade' && /1\.60\.0/.test(r.abort.reason) && !fs.existsSync(b.configDir));
    const f = await aplicar(b, { force: true });
    check('con --force aplica y lo advierte', f.status === 'applied' && f.notes.some((n) => /--force/.test(n)) && fs.existsSync(rutaPlugin(b)));
  });

  await group('V7 y D12: gate de versión, clon y fuente', async () => {
    const ausente = base({ opts: { resolveBin: () => { throw new Error('opencode is not installed or not on PATH.'); } } });
    const r = await aplicar(ausente);
    check('opencode ausente: aborta con install-opencode y no escribe', r.status === 'aborted' && r.abort.id === 'install-opencode' && !fs.existsSync(ausente.configDir));
    const vieja = base({ opts: { version: async () => { throw new Error('opencode >= 2 required (found 1.9.0)'); } } });
    const r1 = await aplicar(vieja);
    check('opencode 1.x (lanza): aborta con upgrade-opencode y no escribe', r1.abort?.id === 'upgrade-opencode' && /1\.9\.0/.test(r1.abort.reason) && !fs.existsSync(vieja.configDir));
    const silenciosa = base({ opts: { version: async () => '1.9.0' } });
    const r2 = await aplicar(silenciosa);
    check('una versión 1.x que no lanza igual aborta (el gate mira el reporte)', r2.abort?.id === 'upgrade-opencode' && !fs.existsSync(silenciosa.configDir));

    let llamadas = 0;
    const unaVez = base({ opts: { version: async () => { llamadas++; return '2.1.3'; } } });
    await aplicar(unaVez);
    check('no vuelve a llamar a versionOpencode: una sola vez por apply', llamadas === 1, String(llamadas));

    const clon = armarFuente();
    fs.mkdirSync(path.join(clon, '.git'));
    const dentro = base({ opts: { cwd: clon, resolveBin: () => { throw new Error('sin opencode'); } } });
    const r3 = await aplicar(dentro);
    check('D12: dentro del clon sale antes del gate de versión, aunque opencode no esté', r3.status === 'inside-clone' && r3.abort === null);
    check('V3: dentro del clon no escribe nada', !fs.existsSync(dentro.configDir) && r3.changes.length === 0);
    check('V19: el resumen del diagnóstico viaja en el resultado', r3.report.insideClone === true && r3.report.source !== null);

    const huerfano = nuevoDir('huerfano');
    const sinFuente = await aplicar(base({ opts: { sourceRoot: huerfano } }));
    check('V10: sin fuente aborta con no-source', sinFuente.status === 'aborted' && sinFuente.abort.id === 'no-source' && sinFuente.report.source === null);
  });

  await group('config .jsonc: se copia el plugin, el config no se toca y sale el fragmento (V5, V11, V15)', async () => {
    const casos = [
      ['sin mcp', '{\n  "theme": "dark"\n}', /agregá en la raíz/, /"mcp": \{\s+"servers"/],
      ['mcp sin servers', '{ "mcp": { "otro": {} } }', /dentro de «mcp»/, /"servers": \{\s+"lagrange"/],
      ['servers sin lagrange', '{ "mcp": { "servers": { "otro": {} } } }', /dentro de «mcp.servers»/, /^"lagrange": \{/],
      ['entrada legacy', '{ "mcp": { "lagrange": { "type": "local" } } }', /mcp\.lagrange/, /"timeout": 1800000/]
    ];
    for (const [nombre, texto, donde, forma] of casos) {
      const b = base();
      escribir(path.join(b.configDir, 'opencode.jsonc'), texto);
      const r = await aplicar(b);
      check(`${nombre}: no escribe el .jsonc`, leer(path.join(b.configDir, 'opencode.jsonc')) === texto && !fs.existsSync(rutaConfig(b)) && backups(b, '.jsonc').length === 0);
      check(`${nombre}: copia el plugin`, r.status === 'applied' && fs.existsSync(rutaPlugin(b)));
      check(`${nombre}: fragmento con "type": "local" en el punto de inserción`, r.fragment && donde.test(r.fragment.where) && forma.test(r.fragment.text) && /"type": "local"/.test(r.fragment.text), JSON.stringify(r.fragment));
    }
    const b = base();
    escribir(rutaConfig(b), { mcp: { servers: { lagrange: entrada(b.fuente) } } });
    escribir(path.join(b.configDir, 'opencode.jsonc'), '{ "theme": "dark" }');
    const json = leer(rutaConfig(b));
    const r = await aplicar(b);
    check('V11: shadowed no aborta: copia el plugin, no toca el .json y da el fragmento del .jsonc', r.status === 'applied' && leer(rutaConfig(b)) === json && Boolean(r.fragment) && r.report.config.shadowed === true);

    const amb = base();
    escribir(path.join(amb.configDir, 'opencode.jsonc'), '{ "mcp": { "servers": { "lagrange": {} }, "lagrange": {} } }');
    const rA = await aplicar(amb);
    check('V15: .jsonc ambiguo aborta con manual-merge, el bloque completo y sin copiar nada', rA.status === 'aborted' && rA.abort.id === 'manual-merge' && /"type": "local"/.test(rA.fragment?.text ?? '') && !fs.existsSync(rutaPlugin(amb)));
  });

  await group('un fallo de escritura se informa sin lanzar', async () => {
    const b = base();
    fs.mkdirSync(b.configDir, { recursive: true });
    fs.writeFileSync(path.join(b.configDir, 'plugins'), 'soy un archivo, no un directorio');
    const r = await aplicar(b);
    check('write-failed con el motivo y nada más escrito', r.status === 'aborted' && r.abort.id === 'write-failed' && !fs.existsSync(rutaConfig(b)), JSON.stringify(r.abort));
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

    const sinYes = correr(['--apply', '--home', home, '--cwd', cwd]);
    check('--apply sin --yes: exit 2, no escribe', sinYes.status === 2 && /--yes/.test(sinYes.stderr) && !fs.existsSync(path.join(home, '.config')));
    const ambos = correr(['--apply', '--diagnose', '--yes']);
    check('--apply y --diagnose juntos: exit 2', ambos.status === 2);
    const aborta = correr(['--apply', '--yes', '--home', home, '--cwd', cwd]);
    check('sin opencode real: exit 1, imprime el resumen y el motivo, no escribe',
      aborta.status === 1 && /Fuente:/.test(aborta.stdout) && /install-opencode/.test(aborta.stdout) && !fs.existsSync(path.join(home, '.config')), aborta.stdout.slice(-300));
    const clonCwd = armarFuente();
    fs.mkdirSync(path.join(clonCwd, '.git'));
    const enClon = correr(['--apply', '--yes', '--home', home, '--cwd', clonCwd]);
    check('V19: dentro del clon: exit 0, resumen del diagnóstico y aviso, sin escribir',
      enClon.status === 0 && /Host:/.test(enClon.stdout) && /dentro del clon/.test(enClon.stdout) && !fs.existsSync(path.join(home, '.config')), enClon.stdout.slice(-300));
    const enJson = correr(['--apply', '--yes', '--json', '--home', home, '--cwd', clonCwd]);
    let dj = null;
    try { dj = JSON.parse(enJson.stdout); } catch { /* se verifica abajo */ }
    check('--apply --json: status y report', dj?.status === 'inside-clone' && dj.report?.insideClone === true);
  });
}

main()
  .catch((e) => { check('la suite no lanzó una excepción', false, e && e.stack ? e.stack : String(e)); })
  .finally(() => {
    try { fs.rmSync(raiz, { recursive: true, force: true }); } catch { /* temporal */ }
    report();
  });
