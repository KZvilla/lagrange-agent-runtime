/**
 * FEAT-007 — Las skills son la fachada semantica compartida. Los hosts pueden
 * prefijar tools de MCP de manera distinta, y las capacidades que leen sesion
 * o UI de un host deben declarar su frontera antes de sugerir su uso.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');
const dirs = fs.readdirSync(SKILLS, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
const fuentes = new Map(dirs.map(name => [
  name,
  fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
]));
const todo = [...fuentes.values()].join('\n');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const referencia = fs.readFileSync(path.join(ROOT, 'REFERENCE.md'), 'utf8').replace(/\r\n/g, '\n');

async function main() {
  await group('los manifests compartidos conservan una sola fachada', () => {
    check('son seis skills (FEAT-087 suma recall)', dirs.length === 6, dirs.join(', '));
    for (const [name, source] of fuentes) {
      const manifestName = source.match(/^---\n[\s\S]*?^name:\s*([^\n]+)$/m)?.[1]?.trim();
      check(`${name}: nombre coincide con el directorio`, manifestName === name, String(manifestName));
    }
    check('ninguna skill fija el prefijo de Claude', !/mcp__lagrange__/i.test(todo));
    check('ninguna skill fija el prefijo de opencode', !/lagrange_agy_/i.test(todo));
  });

  await group('cada flujo central se descubre por nombre semantico', () => {
    for (const tool of [
      'agy_run', 'agy_plan', 'agy_review', 'agy_audit', 'agy_research',
      'agy_usage', 'agy_status', 'set_config', 'agy_fanout',
      'cast_agent', 'alma', 'say', 'telegram_notify'
    ]) {
      // BE-048: `alma` y `say` sin prefijo son palabras comunes; como tool van entre backticks.
      const patron = ['alma', 'say'].includes(tool) ? `\`${tool}\`` : `\\b${tool}\\b`;
      check(`guia ${tool}`, new RegExp(patron).test(todo));
    }
  });

  await group('las excepciones de host fallan de forma explicita', () => {
    check('summary declara el hook confiable y el fallo cerrado de Codex',
      /Host boundary[\s\S]{0,500}Codex[\s\S]{0,300}hook must be trusted[\s\S]{0,350}fails closed/i.test(fuentes.get('session-summary')));
    check('agy-cli exige identidad no ambigua para summary de Codex',
      /agy_session_summary[\s\S]{0,700}Codex requires[\s\S]{0,350}ambiguous state fails closed/i.test(fuentes.get('agy-cli')));
    check('agy-cli deriva narrate a say si el hook no esta disponible',
      /In Codex[\s\S]{0,220}narrate[\s\S]{0,250}`say`[\s\S]{0,100}do not guess/i.test(fuentes.get('agy-cli')));
    check('setup no toca statusLine desde Codex',
      /Claude Code only in the current MVP[\s\S]{0,250}skip this track without editing `~\/\.claude\/settings\.json`/i.test(fuentes.get('setup')));
    check('fanout no promete statusline Codex',
      /statusline (?:is|es) Claude Code-only en el MVP; no se anuncia en\s+Codex/i.test(fuentes.get('fanout')));
    check('la skill adversarial no depende de Claude', !/\bClaude Code\b/.test(fuentes.get('adversarial-review')));
  });

  await group('FEAT-088: el Track F de setup (segunda cuenta) no toca lo que no debe', () => {
    const setup = fuentes.get('setup');
    const f = setup.slice(setup.indexOf('### Track F'), setup.indexOf('## Step 3'));
    check('existe el Track F', f.startsWith('### Track F'));
    check('solo Claude Code: fuera de él se saltea', /Claude Code\s+only[\s\S]{0,300}In Codex or opencode,\s+report that and skip it/.test(f));
    check('el login es del usuario', /The login is always the user's/.test(f) && /runs `claude-work` and `\/login` themselves/.test(f));
    check('settings.json se copia, nunca se enlaza', /`settings\.json` is copied, never linked/.test(f));
    check('saca las credenciales del bloque env y apiKeyHelper', /Remove credentials[\s\S]{0,200}`env` block[\s\S]{0,400}`apiKeyHelper`/.test(f));
    check('nunca credenciales, projects ni sesiones', /Never create, copy or link\*\* `projects\/`, `sessions\/`, `\.claude\.json`,\s+`\.credentials\.json`/.test(f));
    check('hooks/ no se enlaza', /Do \*\*not\*\* link `hooks\/`/.test(f));
    check('el perfil del shell lo edita el usuario', /the user pastes it[\s\S]{0,120}do not edit their shell profile yourself/.test(f));
    check('set_config lee y fusiona las tablas', /replaces the whole table[\s\S]{0,300}read the\s+current `motores\.cuentas` and `motores\.roles`/.test(f));
    check('las sondas avisan su costo', /five short Haiku calls[\s\S]{0,80}Say so before running them/.test(f));
  });

  await group('FEAT-177: el Track H de setup (opencode nativo) en las dos skills', () => {
    const lee = (...partes) => fs.readFileSync(path.join(ROOT, ...partes), 'utf8').replace(/\r\n/g, '\n');
    const script = lee('scripts', 'opencode-setup.mjs');
    const cc = fuentes.get('setup');
    const oc = lee('.opencode', 'skills', 'setup', 'SKILL.md');
    const trozo = (texto) => texto.slice(texto.indexOf('### Track H'), texto.indexOf('## Step 3'));
    const hCc = trozo(cc);
    const hOc = trozo(oc);

    check('Claude Code: existe el Track H', hCc.startsWith('### Track H'));
    check('Claude Code: cuenta ocho tracks, ya no siete', /all eight tracks/.test(cc) && /The eight tracks are independent/.test(cc) && !/all seven tracks|The seven tracks/.test(cc));
    check('Claude Code: la tabla lista el Track H y el paso 1 nombra su diagnóstico', /\| \*\*H\. Native opencode/.test(cc) && /Track H has no status tool/.test(cc));
    check('Claude Code: resuelve <plugin-root> con el idiom de Track E', /ls -1d "\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}"\/plugins\/cache\/\*\/lagrange\/\*\/[^\n]*sort -V \| tail -1[^\n]*opencode-setup\.mjs" --diagnose/.test(hCc));
    check('BE-167 Claude Code: la fuente queda fuera de .opencode/plugins/ y el addon tiene id propio', /`\.opencode\/lagrange-plugin\.js`, outside `\.opencode\/plugins\/`[\s\S]{0,300}same id[\s\S]{0,300}`\.opencode\/plugins\/lagrange-addon\.js`/.test(hCc));
    check('BE-167 Claude Code: dentro del clon el track también aplica e insideClone solo informa', /Inside a clone\*\* \(`insideClone`\) the track applies too; the flag only informs/.test(hCc) && !/Do not copy anything/.test(hCc));
    check('BE-167 Claude Code: el diagnóstico de un plugin que falla es /api/plugin', /\/api\/plugin\?location\[directory\]=<clone>[\s\S]{0,200}Duplicate plugin ID/.test(hCc));
    check('Claude Code: --apply pide un sí explícito, --yes, backups y no-op en la segunda corrida', /explicit yes[\s\S]{0,200}--apply --yes[\s\S]{0,300}\.backups[\s\S]{0,500}a second run changes nothing/.test(hCc));
    check('Claude Code: el .jsonc no se reescribe y se avisa del .json tapado', /never rewritten[\s\S]{0,400}"type": "local"[\s\S]{0,400}opencode reads the `\.jsonc`/.test(hCc));
    check('Claude Code: se verifica en una corrida posterior, tras reiniciar o recargar', /Verify by effect, in a later run[\s\S]{0,200}opencode reload[\s\S]{0,300}opencode mcp list/.test(hCc));
    check('Claude Code: avisa que la copia queda vieja tras cada release', /After each Lagrange release, run this track again/.test(hCc));
    check('Claude Code: LAGRANGE_HOST solo en la config de opencode y sin secretos', /`LAGRANGE_HOST` goes only in opencode's\s+own config/.test(hCc) && /no secrets read or written/.test(hCc));
    check('Claude Code: nunca instala opencode', /never installs opencode/.test(hCc));
    check('Claude Code: ninguna tool con prefijo de opencode en el track', !/lagrange_agy_/.test(hCc));

    check('opencode: existe el Track H y cuenta siete (A–F y H), no seis', hOc.startsWith('### Track H') && /all seven tracks \(A–F and H\)/.test(oc) && /The seven tracks are independent/.test(oc) && !/all six tracks|The six tracks/.test(oc));
    check('opencode: la tabla lista el Track H', /\| \*\*H\. Native opencode/.test(oc));
    check('BE-167 opencode: --apply corre desde el clon y el addon conserva el session id sin global', /lagrange-addon\.js`[\s\S]{0,200}while\s+the global copy is missing/.test(hOc) && /\*\*Apply,\*\* also from the clone root[\s\S]{0,200}--apply --yes\n/.test(hOc) && !/`--apply` does nothing/.test(hOc));
    check('BE-167 opencode: el diagnóstico de un plugin que falla es /api/plugin', /\/api\/plugin\?location\[directory\]=<clone>[\s\S]{0,200}Duplicate plugin ID/.test(hOc));
    check('opencode: avisa que un SKILL.md suelto no trae scripts/ ni mcp-server/', /no `scripts\/` and no `mcp-server\/`/.test(hOc));
    check('opencode: el Track G sigue fuera (BE-160)', /Track G[^\n]*is not in\s+this skill yet/.test(hOc));
    check('opencode: verifica tras reiniciar o recargar', /Verify by effect, in a later run[\s\S]{0,200}opencode reload/.test(hOc));

    check('las dos skills nombran el script y el script existe', hCc.includes('scripts/opencode-setup.mjs') && hOc.includes('scripts/opencode-setup.mjs') && script.length > 0);
    for (const bandera of ['--diagnose', '--apply', '--yes', '--probe', '--force', '--cwd', '--json']) {
      check(`el script entiende ${bandera}`, script.includes(`'${bandera}'`), bandera);
    }
    for (const bandera of ['--diagnose', '--apply --yes', '--probe', '--force', '--cwd']) {
      check(`Claude Code menciona ${bandera}`, hCc.includes(bandera), bandera);
    }

    const cmdCc = lee('commands', 'setup.md');
    const cmdOc = lee('.opencode', 'commands', 'lagrange', 'setup.md');
    check('commands/setup.md: el argument-hint incluye opencode y la descripción lo nombra', /^argument-hint: \[voicebox \| telegram \| daemon \| cuenta \| opencode\]$/m.test(cmdCc) && /^description:[^\n]*native opencode/m.test(cmdCc));
    check('el comando de opencode nombra opencode y no promete un argument-hint', /^description:[^\n]*native opencode/m.test(cmdOc) && !/argument-hint/.test(cmdOc));
    check('el prefijo de opencode sigue prohibido en las skills compartidas', !/lagrange_agy_/i.test(todo));
  });

  await group('README ensena el paquete Codex real y sus limites', () => {
    check('instala el marketplace repo-local', /codex plugin marketplace add \/absolute\/path\/to\/lagrange-agent-runtime/.test(readme));
    check('instala lagrange por selector', /codex plugin add lagrange@kzvilla-lagrange-codex/.test(readme));
    check('ya no receta config.toml manual para Codex', !/\[mcp_servers\.lagrange\]/.test(readme) && !/\[mcp_servers\.lagrange\]/.test(referencia));
    check('documenta la matriz de capacidad', /\| Capability \| Claude Code \| Codex MVP \|/.test(referencia));
    check('summary Codex exige confiar el hook', /agy_session_summary[^\n]*\| Full \| Full after trusting the packaged session hook/.test(referencia));
    check('narrate Codex usa el hook o deriva a say', /Automatic checkpoint narration with `narrate`[^\n]*trusting the packaged session hook; otherwise use `say`/.test(referencia));
    check('el estado compartido sigue explicito', /state under `~\/\.claude\/` during the\s+MVP/.test(readme));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
