/**
 * FEAT-193 — Status line de Lagrange en `agy-plugin/` y registro opt-in en `scripts/agy-plugin.mjs`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');

const RAIZ = path.join(__dirname, '..');
const SCRIPT_SL = path.join(RAIZ, 'agy-plugin', 'scripts', 'statusline.mjs');
const SCRIPT_CMD = path.join(RAIZ, 'agy-plugin', 'scripts', 'statusline.cmd');
const SCRIPT_INSTALL = path.join(RAIZ, 'scripts', 'agy-plugin.mjs');

const sinAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

function entornoAislado(home) {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function correrCliStatusline(input, args = []) {
  return execFileSync(process.execPath, [SCRIPT_SL, ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true
  });
}

function correrCliInstalador(home, args = []) {
  return execFileSync(process.execPath, [SCRIPT_INSTALL, '--home', home, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: entornoAislado(home)
  });
}

async function main() {
  const sl = await import(pathToFileURL(SCRIPT_SL).href);
  const inst = await import(pathToFileURL(SCRIPT_INSTALL).href);

  await group('armarLineas: payload real de agy 1.5.8, privacidad y guardas', () => {
    const repo = temporalQueSeBorra('feat193-repo-');
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/status\n');

    const payload = {
      cwd: repo,
      transcript_path: 'C:/secreto/transcript.jsonl',
      email: 'persona@ejemplo.com',
      model: { id: 'Gemini 4 Hydrogen (High)', display_name: 'Gemini 4 Hydrogen (High)', effort: 'high' },
      workspace: { current_dir: repo, project_dir: repo },
      context_window: { used_percentage: 20.16, remaining_percentage: 79.84 },
      quota: {
        '3p-5h': { remaining_fraction: 1, reset_in_seconds: 17932 },
        '3p-weekly': { remaining_fraction: 1, reset_in_seconds: 601553 },
        'gemini-5h': { remaining_fraction: 0.4903, reset_in_seconds: 9861 },
        'gemini-argon-wtu-weekly': { remaining_fraction: 0.1282, reset_in_seconds: 169165 },
        'gemini-weekly': { remaining_fraction: 0.175, reset_in_seconds: 18825 },
        'apagado-5h': { remaining_fraction: 0.1, reset_in_seconds: 120, disabled: true },
        'otro-bucket': { remaining_fraction: 0.65, reset_in_seconds: 900 }
      }
    };

    const rawSalida = sl.armarLineas(payload);
    const salida = sinAnsi(rawSalida);
    check('no duplica "(High) · high"', salida.includes('Gemini 4 Hydrogen (High) │ ') && !salida.includes('· high'), salida);
    check('usa separadores │ atenuados (dim)', rawSalida.includes('\x1b[2m │ \x1b[0m'), rawSalida);
    check('proyecto y rama sin spawnear git', salida.includes(`${path.basename(repo)} (feat/status)`), salida);
    check('contexto usado y libre con barra', salida.includes('ctx ██░░░░░░░░ 20% (80% libre)'), salida);
    check('agrupa cuotas en una sola sección con ·',
      salida.includes('gem 5h:49% (2h44m) · 7d:18% (5h13m) · argon 7d:13% (1d) · 3p 100% · otro-bucket:65%'),
      salida);
    check('omite buckets disabled', !salida.includes('apagado'), salida);
    check('conserva bucket desconocido y omite reset sobre 50%', salida.includes('otro-bucket:65%') && !salida.includes('otro-bucket:65% ('), salida);
    check('nunca expone email ni transcript_path', !salida.includes('persona@ejemplo.com') && !salida.includes('transcript.jsonl'), salida);

    const compacta = sinAnsi(sl.armarLineas({ ...payload, terminal_width: 100 }));
    check('modo compacto (<115 cols) acorta barra y omite (% libre)',
      compacta.includes('ctx █░░░░░ 20%') && !compacta.includes('libre)'),
      compacta);

    const conEffort = sinAnsi(sl.armarLineas({
      model: { display_name: 'Claude Sonnet', effort: 'medium' },
      context_window: { remaining_percentage: 70 },
      cost: { total_usd: 1.25, estimated: true }
    }));
    check('agrega effort cuando display_name no lo trae', conEffort.startsWith('Claude Sonnet · medium │ '), conEffort);
    check('deriva usado desde remaining_percentage', conEffort.includes('ctx ███░░░░░░░ 30% (70% libre)'), conEffort);
    check('costo estimado con ~', conEffort.includes('~$1.25'), conEffort);

    const solo200k = sinAnsi(sl.armarLineas({ model: { id: 'm' }, exceeds_200k_tokens: true }));
    check('fallback ctx >200k', solo200k.includes('ctx >200k'), solo200k);

    check('stdin vacío, null, array u objeto vacío devuelve ""',
      sl.armarLineas(null) === '' && sl.armarLineas([]) === '' && sl.armarLineas({}) === '' && sl.armarLineas('x') === '');
    check('soloLagrange vacío sin workspace devuelve ""',
      sl.armarLineas({}, { soloLagrange: true }) === '');
  });

  await group('formatearReset: umbrales exactos', () => {
    check('<60s → (<1m) (nunca (0m))', sl.formatearReset(42) === '(<1m)');
    check('minutos', sl.formatearReset(2700) === '(45m)');
    check('horas y minutos', sl.formatearReset(9861) === '(2h44m)');
    check('días', sl.formatearReset(169165) === '(1d)');
    check('0 o inválido → null', sl.formatearReset(0) === null && sl.formatearReset(-5) === null && sl.formatearReset(NaN) === null);
  });

  await group('leerRamaYRaiz: worktree y carpeta sin .git', () => {
    const base = temporalQueSeBorra('feat193-git-');
    const sub = path.join(base, 'sin-git', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const sinGit = sl.leerRamaYRaiz(sub);
    check('sin .git conserva raiz = base (no / ni C:\\)', sinGit.raiz === path.resolve(sub) && sinGit.rama === null, JSON.stringify(sinGit));

    const wt = path.join(base, 'wt');
    const realGitDir = path.join(base, 'repo.git', 'worktrees', 'wt');
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(realGitDir, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${realGitDir}\n`);
    fs.writeFileSync(path.join(realGitDir, 'HEAD'), 'abcdef1234567890\n');
    const resWt = sl.leerRamaYRaiz(wt);
    check('worktree con SHA detached', resWt.raiz === path.resolve(wt) && resWt.rama === 'abcdef1', JSON.stringify(resWt));
  });

  await group('pedidos pendientes FEAT-192 y modo --solo-lagrange', () => {
    const repo = temporalQueSeBorra('feat193-ped-');
    const pedDir = path.join(repo, '.lagrange', 'agy', 'pedidos');
    const infDir = path.join(repo, '.lagrange', 'agy', 'informes');
    fs.mkdirSync(pedDir, { recursive: true });
    fs.mkdirSync(infDir, { recursive: true });

    fs.writeFileSync(path.join(pedDir, 'a1b2c3.md'), '---\nid: a1b2c3\ntipo: audit\ncreado: 2026-11-13T10:00:00Z\n---\n');
    fs.writeFileSync(path.join(pedDir, 'b2c3d4.md'), '---\nid: b2c3d4\ntipo: review\ncreado: 2026-11-13T12:00:00Z\n---\n');
    fs.writeFileSync(path.join(pedDir, 'c3d4e5.md'), '---\nid: c3d4e5\ntipo: plan\ncreado: 2026-11-13T14:00:00Z\n---\n');
    fs.writeFileSync(path.join(infDir, 'c3d4e5.md'), '---\nid: c3d4e5\n---\nlisto\n');
    fs.writeFileSync(path.join(pedDir, 'invalido.md'), '---\nid: invalido\ntipo: audit\n---\n');

    const pend = sl.listarPedidosPendientes(repo);
    check('lista solo los 2 sin informe, más nuevo primero', pend.length === 2 && pend[0].id === 'b2c3d4' && pend[1].id === 'a1b2c3', JSON.stringify(pend));

    const l = sinAnsi(sl.armarLineas({
      workspace: { project_dir: repo },
      context_window: { used_percentage: 10, remaining_percentage: 90 },
      model: { display_name: 'Gemini 4 Hydrogen (High)' },
      quota: { 'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 5000 } }
    }, { soloLagrange: true }));

    const [l1, l2] = l.split('\n');
    check('--solo-lagrange omite modelo y proyecto', !l1.includes('Hydrogen') && !l1.includes(path.basename(repo)), l1);
    check('--solo-lagrange mantiene contexto, cuota y línea 2 de pedidos',
      l1.includes('ctx █░░░░░░░░░ 10% (90% libre)') && l1.includes('gem 5h:80%') && l2 === '[lagrange] 2 pedidos pendientes (más reciente: b2c3d4 /lagrange-review)', l);

    fs.writeFileSync(path.join(infDir, 'a1b2c3.md'), '---\nid: a1b2c3\n---\n');
    const uno = sinAnsi(sl.armarLineas({ workspace: { project_dir: repo } }, { soloLagrange: true }));
    check('con 1 pedido y sin context_window muestra solo la línea del pedido', uno === '[lagrange] pedido b2c3d4 (/lagrange-review)', uno);
  });

  await group('CLI de statusline.mjs (stdin y errores silenciosos)', () => {
    const out = sinAnsi(correrCliStatusline(JSON.stringify({
      model: { display_name: 'Gemini 4 Hydrogen (High)' },
      context_window: { used_percentage: 25, remaining_percentage: 75 }
    })));
    check('CLI responde por stdout con payload válido', out.includes('Gemini 4 Hydrogen (High)') && out.includes('25% (75% libre)'), out);
    check('CLI con JSON roto devuelve vacío sin fallar', correrCliStatusline('{roto') === '');
    check('CLI con stdin vacío devuelve vacío sin fallar', correrCliStatusline('') === '');

    if (process.platform === 'win32') {
      const outCmd = sinAnsi(execSync(`"${SCRIPT_CMD.replace(/\\/g, '/')}" --solo-lagrange`, {
        shell: 'cmd.exe',
        input: JSON.stringify({ context_window: { used_percentage: 40, remaining_percentage: 60 } }),
        encoding: 'utf8',
        windowsHide: true
      }));
      check('wrapper .cmd en Windows pasa flags y stdin', outCmd === 'ctx ████░░░░░░ 40% (60% libre)', outCmd);
    }
  });

  await group('scripts/agy-plugin.mjs: parseo estricto y preflight antes de mutar', () => {
    for (const malos of [
      ['--status-line'],
      ['--statusline', '--statusline-stack'],
      ['--statusline', '--statusline-off'],
      ['--validar', '--statusline'],
      ['--force'],
      ['--statusline-off', '--force'],
      ['--home'],
      ['--home', '--statusline']
    ]) {
      let fallo = false;
      try { inst.parsearArgs(malos); } catch { fallo = true; }
      check(`rechaza ${malos.join(' ')}`, fallo);
    }

    const home = temporalQueSeBorra('feat193-pre-');
    const settingsPath = inst.rutaSettings(home);
    const destino = inst.destinoPorDefecto(home);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

    fs.writeFileSync(settingsPath, '{corrupto');
    let errCorrupto = false;
    try { correrCliInstalador(home, ['--statusline']); } catch { errCorrupto = true; }
    check('JSON corrupto aborta sin copiar el plugin', errCorrupto && !fs.existsSync(destino));

    fs.writeFileSync(settingsPath, '[]');
    let errArray = false;
    try { inst.configurarStatusLine({ home }); } catch { errArray = true; }
    check('JSON raíz array aborta sin copiar el plugin', errArray && !fs.existsSync(destino));

    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'C:/otro/hud.exe' } }));
    let errAjeno = false;
    try { inst.configurarStatusLine({ home }); } catch { errAjeno = true; }
    check('statusLine ajena sin --force aborta sin copiar el plugin', errAjeno && !fs.existsSync(destino));
  });

  await group('scripts/agy-plugin.mjs: instalación, BOM, backups en 2 pasos y --statusline-off', () => {
    const home = temporalQueSeBorra('feat193-flow-');
    const settingsPath = inst.rutaSettings(home);
    const backupsDir = path.join(path.dirname(settingsPath), '.backups');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

    // Archivo previo con BOM UTF-8 + statusLine ajena + otras claves que deben conservarse.
    const original = {
      model: 'Gemini 4 Hydrogen (Medium)',
      agentMode: 'default',
      statusLine: { type: 'command', command: 'C:/mi-barra/custom.cmd' }
    };
    fs.writeFileSync(settingsPath, `\uFEFF${JSON.stringify(original, null, 2)}`, 'utf8');

    // Paso 1: --statusline --force (vía CLI con --home aislado)
    correrCliInstalador(home, ['--statusline', '--force']);
    const s1 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    check('preserva claves previas y quita BOM', s1.model === 'Gemini 4 Hydrogen (Medium)' && s1.agentMode === 'default');
    check('registra comando propio con stack_with_default: false',
      inst.esComandoPropio(s1.statusLine?.command) && s1.statusLine?.stack_with_default === false && s1.statusLine?.enabled === true,
      JSON.stringify(s1.statusLine));
    if (process.platform === 'win32') {
      const rAgy = spawnSync('cmd', ['/c', s1.statusLine.command], {
        input: JSON.stringify({ model: { display_name: 'Gemini 4 Hydrogen (High)' }, context_window: { used_percentage: 20, remaining_percentage: 80 } }),
        encoding: 'utf8',
        windowsHide: true
      });
      check('comando win32 sin comillas corre directo bajo cmd /c (contrato agy)',
        rAgy.status === 0 && sinAnsi(rAgy.stdout).includes('ctx'),
        `${rAgy.status}: ${rAgy.stderr}`);
    }
    const b1 = fs.readdirSync(backupsDir);
    check('creó el primer respaldo con la config original',
      b1.length === 1 && JSON.parse(fs.readFileSync(path.join(backupsDir, b1[0]), 'utf8').replace(/^\uFEFF/, '')).statusLine.command === 'C:/mi-barra/custom.cmd',
      b1.join(', '));

    // Paso 2: --statusline-stack (NO debe pisar el primer respaldo)
    correrCliInstalador(home, ['--statusline-stack']);
    const s2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    check('cambia a stack_with_default: true y --solo-lagrange',
      s2.statusLine?.stack_with_default === true && s2.statusLine?.command.includes('--solo-lagrange'),
      JSON.stringify(s2.statusLine));
    const b2 = fs.readdirSync(backupsDir).sort();
    check('segundo respaldo NO pisa el primero (flujo de 2 pasos)',
      b2.length === 2 && JSON.parse(fs.readFileSync(path.join(backupsDir, b2[0]), 'utf8').replace(/^\uFEFF/, '')).statusLine.command === 'C:/mi-barra/custom.cmd',
      b2.join(', '));

    // Paso 3: --statusline-off
    correrCliInstalador(home, ['--statusline-off']);
    const s3 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    check('--statusline-off quita statusLine y conserva resto de settings', !('statusLine' in s3) && s3.model === 'Gemini 4 Hydrogen (Medium)');
    check('tercer respaldo creado y original intacto en .backups/', fs.readdirSync(backupsDir).length === 3);

    // --statusline-off sobre barra ajena nunca la borra
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'C:/ajeno/barra.sh' } }));
    let offAjeno = false;
    try { correrCliInstalador(home, ['--statusline-off']); } catch { offAjeno = true; }
    check('--statusline-off rehúsa borrar statusLine ajena',
      offAjeno && JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command === 'C:/ajeno/barra.sh');
  });

  await group('rotación de backups (MAX_BACKUPS = 10)', () => {
    const home = temporalQueSeBorra('feat193-rot-');
    const settingsPath = inst.rutaSettings(home);
    const backupsDir = path.join(path.dirname(settingsPath), '.backups');
    let t = Date.UTC(2026, 10, 13, 12, 0, 0);
    for (let i = 0; i < 12; i++) {
      t += 1000;
      inst.configurarStatusLine({ home, soloLagrange: i % 2 === 0, ahora: () => new Date(t) });
    }
    const lista = fs.readdirSync(backupsDir);
    check('mantiene máximo 10 respaldos rotativos', lista.length === 10, `len=${lista.length}`);

    const unixCmd = inst.comandoStatusLine('/home/con espacio/.gemini/config/plugins/lagrange', { soloLagrange: true, platform: 'linux' });
    check('en Unix mantiene comillas para sh -c', unixCmd === '"/home/con espacio/.gemini/config/plugins/lagrange/scripts/statusline.sh" --solo-lagrange', unixCmd);

    if (process.platform === 'win32') {
      const homeEsp = temporalQueSeBorra('feat193 con espacio-');
      const resEsp = inst.configurarStatusLine({ home: homeEsp, soloLagrange: true });
      const rEsp = spawnSync('cmd', ['/c', resEsp.comando], {
        input: JSON.stringify({ context_window: { used_percentage: 30, remaining_percentage: 70 } }),
        encoding: 'utf8',
        windowsHide: true
      });
      check('home con espacio en win32 resuelve 8.3 y corre bajo cmd /c',
        inst.esComandoPropio(resEsp.comando) && rEsp.status === 0 && sinAnsi(rEsp.stdout) === 'ctx ███░░░░░░░ 30% (70% libre)',
        `${resEsp.comando} -> ${rEsp.status}: ${rEsp.stderr}`);
    }
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
