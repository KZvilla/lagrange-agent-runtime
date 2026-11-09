#!/usr/bin/env node
/**
 * FEAT-187 — Guardas y vista previa del daño en el plugin de opencode.
 *
 * La parte pura se compara contra `hooks/guardas.ts` y `hooks/vista-previa.ts`
 * (paridad host a host); el hook se prueba con un `ctx` mockeado y, para la
 * vista previa, con un repo git temporal real.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { REPO_ROOT } = require('./lib/mcp-client');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; process.stderr.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`); }
}

function tmpDir(prefijo) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
}

function escribirGuardas(dir, guardas, extra = {}) {
  const ruta = path.join(dir, 'antigravity.json');
  fs.writeFileSync(ruta, JSON.stringify({ guardas, ...extra }, null, 2));
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(ruta, t, t);
  return ruta;
}

function mockCtx({ guardasPath, location = '/repo', sesion = { location: { directory: '/repo' } }, sesionFalla = false, permissionThrows = false } = {}) {
  let hookCb = null;
  let transformCb = null;
  let permissionCb = null;
  let hookDisposed = false;
  let transformDisposed = false;
  let permissionDisposed = false;
  let sessionCalls = 0;
  const ctx = {
    location: { directory: location },
    options: guardasPath ? { guardasPath } : {},
    tool: {
      hook: async (name, cb) => {
        if (name !== 'execute.before') throw new Error(`unexpected hook ${name}`);
        hookCb = cb;
        return { dispose: async () => { hookDisposed = true; } };
      },
      transform: async (cb) => {
        transformCb = cb;
        return { dispose: async () => { transformDisposed = true; } };
      }
    },
    permission: {
      hook: async (name, cb) => {
        if (name !== 'evaluate') throw new Error(`unexpected hook ${name}`);
        if (permissionThrows) throw new Error('permission failed');
        permissionCb = cb;
        return { dispose: async () => { permissionDisposed = true; } };
      }
    },
    session: {
      get: async (input) => {
        sessionCalls += 1;
        if (!input || typeof input !== 'object' || typeof input.sessionID !== 'string') {
          throw new TypeError('session.get espera { sessionID }');
        }
        if (sesionFalla) throw new Error('sesión perdida');
        return sesion;
      }
    }
  };
  return {
    ctx,
    hook: () => hookCb,
    transform: () => transformCb,
    permission: () => permissionCb,
    hookDisposed: () => hookDisposed,
    transformDisposed: () => transformDisposed,
    permissionDisposed: () => permissionDisposed,
    sessionCalls: () => sessionCalls
  };
}

(async () => {
  const pluginPath = path.join(REPO_ROOT, '.opencode', 'lagrange-plugin.js');
  const source = fs.readFileSync(pluginPath, 'utf8');
  const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  const guardasTs = await import(pathToFileURL(path.join(REPO_ROOT, 'hooks', 'guardas.ts')).href);
  const vistaTs = await import(pathToFileURL(path.join(REPO_ROOT, 'hooks', 'vista-previa.ts')).href);

  console.log('\nplugin: imports y helpers');
  const importa = [...source.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  check('solo importa builtins node:', importa.length > 0 && importa.every((i) => i.startsWith('node:')), JSON.stringify(importa));
  check('exporta las funciones de guardas', ['validarGuardas', 'guardaQueFrena', 'palabrasDe', 'normalizarRaiz', 'motivoDeFreno', 'textoDeFreno', 'efectoDeGuardas'].every((n) => typeof mod[n] === 'function'));
  check('exporta las funciones de vista previa', ['reconocer', 'separar', 'motivoDe', 'medirCasos'].every((n) => typeof mod[n] === 'function'));

  console.log('\nparidad: validarGuardas');
  const corpusReglas = [
    { secuencia: ['git', 'switch', 'main'], motivo: 'P3', raiz: 'C:/repo' },
    { secuencia: ['stop-process', '*', 'node'], motivo: 'mata node' },
    { secuencia: ['git push'], motivo: 'push' },
    { secuencia: ['x'.repeat(81)], motivo: 'inválida' },
    { secuencia: [], motivo: 'inválida' },
    { secuencia: ['*'], motivo: 'inválida' },
    { secuencia: ['git'], motivo: 'm'.repeat(201) },
    { secuencia: ['git'], motivo: 'vence', vence: '2026-10-05T00:00:00Z' },
    { secuencia: ['rm'], motivo: 'raiz', raiz: 'C:\\Repo\\' },
    'no es objeto'
  ];
  const propias = mod.validarGuardas(corpusReglas);
  const ajenas = guardasTs.validarGuardas(corpusReglas);
  check('mismas reglas válidas y descartadas', JSON.stringify(propias) === JSON.stringify(ajenas), JSON.stringify({ propias, ajenas }));

  console.log('\nparidad: guardaQueFrena');
  const reglas = propias.guardas;
  const ahora = Date.parse('2026-10-05T00:00:00Z');
  const comandos = [
    'git switch main',
    'GIT Switch MAIN',
    'git switch main-nueva',
    'git stash push -m wip',
    'stop-process -name node',
    'Stop-Process -Id 123',
    'npm run format',
    'rm -rf src',
    'git push origin main',
    'git push --force',
    'echo "git push"'
  ];
  for (const raiz of ['C:/repo', 'C:/otro', '']) {
    const propios = comandos.map((comando) => mod.guardaQueFrena(reglas, { comando, raiz, ahora })?.motivo ?? null);
    const ajenos = comandos.map((comando) => guardasTs.guardaQueFrena(reglas, { comando, raiz, ahora })?.motivo ?? null);
    check(`mismo veredicto en raíz ${raiz || '(vacía)'}`, JSON.stringify(propios) === JSON.stringify(ajenos), JSON.stringify({ propios, ajenos }));
  }
  for (const g of reglas) {
    check(`mismo motivoDeFreno: ${g.motivo}`, mod.motivoDeFreno(g) === guardasTs.motivoDeFreno(g));
    check(`mismo textoDeFreno: ${g.motivo}`, mod.textoDeFreno(g) === guardasTs.textoDeFreno(g));
  }
  for (const valor of [undefined, 'ask', 'deny', 'otra']) {
    check(`mismo efectoDeGuardas: ${String(valor)}`, mod.efectoDeGuardas(valor) === guardasTs.efectoDeGuardas(valor));
  }

  console.log('\nparidad: reconocer (vista previa)');
  const comandosVista = [
    'rm -rf src',
    'Remove-Item -Recurse -Force .\\build',
    'git worktree remove --force ../wt',
    'git -C ../otro worktree remove -f ../wt',
    'git push --force origin main',
    'git push +main',
    'git push --force-with-lease',
    'Stop-Process -Name node',
    'Get-Process node | Stop-Process',
    'git status',
    'echo hola'
  ];
  for (const comando of comandosVista) {
    const propio = mod.reconocer(comando);
    const ajeno = vistaTs.reconocer(comando);
    check(`mismos casos: ${comando}`, JSON.stringify(propio) === JSON.stringify(ajeno), JSON.stringify({ propio, ajeno }));
  }
  const nodePropio = mod.motivoDe([{ tipo: 'node' }], '/repo');
  check('el motivo de opencode no nombra Claude Code', /opencode/.test(nodePropio) && !/Claude Code/.test(nodePropio), nodePropio);

  console.log('\ncrearGuardas: cache y errores');
  const dirConfig = tmpDir('feat187-config-');
  try {
    const sinArchivo = mod.crearGuardas({ ruta: path.join(dirConfig, 'no-existe.json') });
    const errores = [];
    const original = console.error;
    console.error = (...a) => { errores.push(a.join(' ')); };
    try {
      check('sin archivo devuelve []', (await sinArchivo.vigentes()).length === 0);
      check('sin archivo usa ask por defecto', sinArchivo.efecto() === 'ask');
      check('sin archivo no avisa', errores.filter((e) => /lagrange:/.test(e)).length === 0, JSON.stringify(errores));
    } finally {
      console.error = original;
    }

    const ruta = escribirGuardas(dirConfig, [{ secuencia: ['git', 'push'], motivo: 'no push' }]);
    const reloj = { t: 1000 };
    const guardas = mod.crearGuardas({ ruta, ahora: () => reloj.t });
    check('lee la regla', (await guardas.vigentes()).length === 1);
    check('cachea dentro de los 10 s', (await guardas.vigentes()).length === 1);
    check('efecto ask por defecto', guardas.efecto() === 'ask');
    escribirGuardas(dirConfig, [{ secuencia: ['rm'], motivo: 'no rm' }]);
    reloj.t += 10_001;
    const nuevas = await guardas.vigentes();
    check('relee después de los 10 s', nuevas.length === 1 && nuevas[0].motivo === 'no rm', JSON.stringify(nuevas));
    check('el efecto sigue ask sin la clave', guardas.efecto() === 'ask');
    escribirGuardas(dirConfig, [{ secuencia: ['rm'], motivo: 'no rm' }], { guardas_efecto: 'deny' });
    reloj.t += 10_001;
    await guardas.vigentes();
    check('lee guardas_efecto deny', guardas.efecto() === 'deny');
    escribirGuardas(dirConfig, [{ secuencia: ['rm'], motivo: 'no rm' }], { guardas_efecto: 'ask' });
    reloj.t += 10_001;
    await guardas.vigentes();
    check('lee guardas_efecto ask', guardas.efecto() === 'ask');

    fs.writeFileSync(ruta, '{ roto');
    const t = new Date(Date.now() + 4000);
    fs.utimesSync(ruta, t, t);
    reloj.t += 10_001;
    const rotos = [];
    console.error = (...a) => { rotos.push(a.join(' ')); };
    const avisos = () => rotos.filter((e) => /lagrange:/.test(e));
    try {
      check('JSON roto apaga las guardas', (await guardas.vigentes()).length === 0);
      check('JSON roto vuelve a ask', guardas.efecto() === 'ask');
      check('JSON roto avisa una vez', avisos().length === 1, JSON.stringify(rotos));
      reloj.t += 10_001;
      check('sigue apagado en la próxima lectura', (await guardas.vigentes()).length === 0);
      check('no repite el aviso', avisos().length === 1, JSON.stringify(rotos));
    } finally {
      console.error = original;
    }
  } finally {
    fs.rmSync(dirConfig, { recursive: true, force: true });
  }

  console.log('\ncrearGuardas: efectos aislados por instancia');
  const dirAsk = tmpDir('feat187-ask-');
  const dirDeny = tmpDir('feat187-deny-');
  try {
    const gAsk = mod.crearGuardas({ ruta: escribirGuardas(dirAsk, [{ secuencia: ['git', 'push'], motivo: 'push' }]) });
    const gDeny = mod.crearGuardas({ ruta: escribirGuardas(dirDeny, [{ secuencia: ['git', 'push'], motivo: 'push' }], { guardas_efecto: 'deny' }) });
    check('instancia ask', (await gAsk.vigentes()).length === 1 && gAsk.efecto() === 'ask');
    check('instancia deny', (await gDeny.vigentes()).length === 1 && gDeny.efecto() === 'deny');
    check('no se contaminan', gAsk.efecto() === 'ask' && gDeny.efecto() === 'deny');
  } finally {
    fs.rmSync(dirAsk, { recursive: true, force: true });
    fs.rmSync(dirDeny, { recursive: true, force: true });
  }

  console.log('\nhook: guardas (ask por defecto)');
  const dirGuardas = tmpDir('feat187-guardas-');
  try {
    const ruta = escribirGuardas(dirGuardas, [{ secuencia: ['git', 'push'], motivo: 'no push', raiz: '/repo' }]);
    const mock = mockCtx({ guardasPath: ruta, location: '/repo' });
    const cleanup = await mod.default.setup(mock.ctx);
    const evaluar = mock.permission();
    check('registra permission.evaluate', typeof evaluar === 'function');

    const pregunta = { action: 'shell', resources: ['git push origin main'], effect: 'allow' };
    await evaluar(pregunta);
    check('pregunta el comando con guarda', pregunta.effect === 'ask' && /no push/.test(pregunta.message || ''), JSON.stringify(pregunta));
    check('el ask no pide al modelo que se lo pida al usuario', !/pedíselo al usuario/.test(pregunta.message || ''), JSON.stringify(pregunta));

    const pasa = { action: 'shell', resources: ['git status'], effect: 'allow' };
    await evaluar(pasa);
    check('deja pasar un comando sin guarda', pasa.effect === 'allow', JSON.stringify(pasa));

    const edit = { action: 'edit', resources: ['/repo/x'], effect: 'allow' };
    const antes = mock.sessionCalls();
    await evaluar(edit);
    check('no toca acciones que no son shell', edit.effect === 'allow' && mock.sessionCalls() === antes, JSON.stringify(edit));

    const multiple = { action: 'shell', resources: ['echo ok', 'git push origin main'], effect: 'allow' };
    await evaluar(multiple);
    check('pregunta si cualquier resource matchea', multiple.effect === 'ask', JSON.stringify(multiple));

    const malo = { action: 'shell', resources: [1, null, ''], effect: 'allow' };
    await evaluar(malo);
    check('resources inválidos no rompen', malo.effect === 'allow', JSON.stringify(malo));
    await evaluar(null);
    await evaluar({});
    check('eventos inválidos no rechazan', true);

    const falla = mockCtx({ guardasPath: ruta, location: '/repo', sesionFalla: true });
    const cleanupFalla = await mod.default.setup(falla.ctx);
    const preguntaFalla = { action: 'shell', resources: ['git push origin main'], effect: 'allow' };
    await falla.permission()(preguntaFalla);
    check('session.get que falla cae a location.directory', preguntaFalla.effect === 'ask', JSON.stringify(preguntaFalla));
    await cleanupFalla();

    await cleanup();
    check('cleanup dispone las tres registrations', mock.hookDisposed() && mock.transformDisposed() && mock.permissionDisposed());

    const fallaPermiso = mockCtx({ guardasPath: path.join(dirGuardas, 'no-existe.json'), permissionThrows: true });
    let throwe = false;
    try { await mod.default.setup(fallaPermiso.ctx); } catch { throwe = true; }
    check('si permission falla, dispone hook y transform y propaga', throwe && fallaPermiso.hookDisposed() && fallaPermiso.transformDisposed());
  } finally {
    fs.rmSync(dirGuardas, { recursive: true, force: true });
  }

  console.log('\nhook: guardas (deny por config)');
  const dirDenyConfig = tmpDir('feat187-deny-config-');
  try {
    const ruta = escribirGuardas(dirDenyConfig, [{ secuencia: ['git', 'push'], motivo: 'no push', raiz: '/repo' }], { guardas_efecto: 'deny' });
    const mock = mockCtx({ guardasPath: ruta, location: '/repo' });
    const cleanup = await mod.default.setup(mock.ctx);
    const deny = { action: 'shell', resources: ['git push origin main'], effect: 'allow' };
    await mock.permission()(deny);
    check('guardas_efecto deny niega', deny.effect === 'deny' && /no push/.test(deny.message || '') && /pedíselo al usuario/.test(deny.message || ''), JSON.stringify(deny));
    await cleanup();
  } finally {
    fs.rmSync(dirDenyConfig, { recursive: true, force: true });
  }

  console.log('\nhook: guardas (efecto inválido)');
  const dirEfectoRoto = tmpDir('feat187-efecto-roto-');
  try {
    const ruta = escribirGuardas(dirEfectoRoto, [{ secuencia: ['git', 'push'], motivo: 'no push', raiz: '/repo' }], { guardas_efecto: 'otra' });
    const mock = mockCtx({ guardasPath: ruta, location: '/repo' });
    const cleanup = await mod.default.setup(mock.ctx);
    const deny = { action: 'shell', resources: ['git push origin main'], effect: 'allow' };
    await mock.permission()(deny);
    check('un efecto inválido cae en deny', deny.effect === 'deny', JSON.stringify(deny));
    await cleanup();
  } finally {
    fs.rmSync(dirEfectoRoto, { recursive: true, force: true });
  }

  console.log('\nhook: guardas sin raíz');
  const dirSinRaiz = tmpDir('feat187-sin-raiz-');
  try {
    const ruta = escribirGuardas(dirSinRaiz, [{ secuencia: ['git', 'push'], motivo: 'push global' }]);
    const mock = mockCtx({ guardasPath: ruta, location: '/repo' });
    const cleanup = await mod.default.setup(mock.ctx);
    const pregunta = { action: 'shell', resources: ['git push origin main'], effect: 'allow' };
    await mock.permission()(pregunta);
    check('una guarda sin raíz no consulta la sesión', pregunta.effect === 'ask' && mock.sessionCalls() === 0, JSON.stringify({ pregunta, llamadas: mock.sessionCalls() }));
    await cleanup();
  } finally {
    fs.rmSync(dirSinRaiz, { recursive: true, force: true });
  }

  console.log('\nhook: vista previa (ask)');
  const dirVacia = tmpDir('feat187-vacia-');
  const repo = tmpDir('feat187-repo-');
  try {
    const ruta = escribirGuardas(dirVacia, []);
    const mock = mockCtx({ guardasPath: ruta, location: repo });
    const cleanup = await mod.default.setup(mock.ctx);
    const evaluar = mock.permission();

    const node = { action: 'shell', resources: ['Stop-Process -Name node'], effect: 'allow' };
    await evaluar(node);
    check('matar node pregunta', node.effect === 'ask' && /mata todos los node/.test(node.message || ''), JSON.stringify(node));

    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'console.log(1);\n');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'inicial'], { cwd: repo, stdio: 'ignore' });

    const borrado = { action: 'shell', resources: ['rm -rf src'], effect: 'allow' };
    await evaluar(borrado);
    check('borrar archivos versionados pregunta', borrado.effect === 'ask' && /archivo versionado/.test(borrado.message || ''), JSON.stringify(borrado));

    const inocuo = { action: 'shell', resources: ['echo hola'], effect: 'allow' };
    await evaluar(inocuo);
    check('un comando sin daño pasa', inocuo.effect === 'allow', JSON.stringify(inocuo));

    const sinMedir = { action: 'shell', resources: ['rm -rf src/*.js'], effect: 'allow' };
    await evaluar(sinMedir);
    check('un comodín no medible pregunta igual', sinMedir.effect === 'ask' && /no se pudo medir/.test(sinMedir.message || ''), JSON.stringify(sinMedir));

    const dirGuardia = tmpDir('feat187-guardia-');
    try {
      const rutaGuardia = escribirGuardas(dirGuardia, [{ secuencia: ['rm', '-rf'], motivo: 'no borrar src' }]);
      const mockGuardia = mockCtx({ guardasPath: rutaGuardia, location: repo });
      const cleanupGuardia = await mod.default.setup(mockGuardia.ctx);
      const guardada = { action: 'shell', resources: ['rm -rf src'], effect: 'allow' };
      await mockGuardia.permission()(guardada);
      check('la guarda gana y no mide la vista previa', guardada.effect === 'ask' && /Lagrange · guarda: no borrar src/.test(guardada.message || '') && !/vista previa/.test(guardada.message || ''), JSON.stringify(guardada));
      await cleanupGuardia();
    } finally {
      fs.rmSync(dirGuardia, { recursive: true, force: true });
    }

    await cleanup();
  } finally {
    fs.rmSync(dirVacia, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
