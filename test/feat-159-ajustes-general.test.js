/**
 * FEAT-159 — Ajustes > General: `model`, `effort`, `timeout_minutes`,
 * `readonly_isolation`, `background_toasts` y los frenos de cuota, con una
 * sola validación para el panel y `set_config`, y su propia versión.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');

const ajustes = require('../mcp-server/lib/ajustes.js');
const { loadConfig } = require('../mcp-server/lib/config.js');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const fuente = (f) => fs.readFileSync(path.join(UI, f), 'utf8');

function homeNuevo(contenido) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat159-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (contenido !== undefined) fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify(contenido, null, 2));
  return home;
}
const archivo = (home) => path.join(home, '.claude', 'antigravity.json');
const leer = (home) => JSON.parse(fs.readFileSync(archivo(home), 'utf8'));

const BASE = {
  x_otra: 1,
  motores: { claude: { bin: 'C:/x/claude.exe' }, roles: { alma: { motor: 'claude', modelo: 'sonnet', esfuerzo: null, cuenta: null } } },
  voice_setup: { version: 3, status: 'configured', languages: ['es'], default_language: 'es', defaults: { es: { audio: { profile: 'P', provider: 'omnivoice' }, identity: { mode: 'neutral' } } }, fallbacks: { es: [] } }
};

async function main() {
  await group('lectura', () => {
    const home = homeNuevo(BASE);
    const e = ajustes.leerAjustes({ homeDir: home });
    const g = e.general;
    check('sin claves → todo null', g.model === null && g.effort === null && g.timeout_minutes === null && g.readonly_isolation === null && g.background_toasts === null && g.frenos.claude === null && g.frenos.antigravity === null, JSON.stringify(g));
    check('versión propia de 16 hex', /^[0-9a-f]{16}$/.test(e.versiones.general));
    check('límites del servidor', e.limites.avisosFondo.join() === 'fanout,lotes,cuota,mensajes' && e.limites.aislamientos.join() === 'auto,container,host' && e.limites.esfuerzos.join() === 'low,medium,high' && e.limites.timeoutMax === 120, JSON.stringify(e.limites));
    removeFixture(home);
    const roto = homeNuevo({ ...BASE, timeout_minutes: '15', readonly_isolation: 'docker', background_toasts: 'spam', motores: { antigravity: { freno_cuota_5h: 3 } } });
    const r = ajustes.leerAjustes({ homeDir: roto });
    check('valores rotos → null con aviso, sin tumbar la lectura', r.ok && r.general.timeout_minutes === null && r.general.readonly_isolation === null && r.general.frenos.antigravity === null && r.avisos.general.length === 4, JSON.stringify(r.avisos.general));
    const aMano = homeNuevo({ model: 'gemini-9-flash-exp' });
    check('un modelo por defecto escrito a mano entra al catálogo', ajustes.leerAjustes({ homeDir: aMano }).catalogo.find((c) => c.motor === 'antigravity').modelos.some((x) => x.modelo === 'gemini-9-flash-exp'));
    for (const h of [roto, aMano]) removeFixture(h);
  });

  await group('guardar', () => {
    const home = homeNuevo(BASE);
    const v = () => ajustes.leerAjustes({ homeDir: home }).versiones;
    const guardar = (general) => ajustes.guardarAjustes({ general: { versionSeccion: v().general, ...general } }, { homeDir: home });
    const antes = v();
    let r = guardar({ readonly_isolation: 'host' });
    let d = leer(home);
    check('readonly_isolation se escribe', r.ok && d.readonly_isolation === 'host', JSON.stringify(r));
    check('lo ajeno queda intacto', d.x_otra === 1 && d.voice_setup.defaults.es.audio.profile === 'P' && d.motores.roles.alma.modelo === 'sonnet');
    check('backup', fs.existsSync(`${archivo(home)}.bak-ajustes`));
    check('las otras versiones no cambian', ['identidades', 'voz', 'motores'].every((k) => v()[k] === antes[k]));

    const casos = [
      [{ readonly_isolation: 'docker' }, 'general.readonly_isolation'],
      [{ background_toasts: ['spam'] }, 'general.background_toasts'],
      [{ frenos: { claude: 1.5 } }, 'general.frenos.claude'],
      [{ frenos: { codex: 0.5 } }, 'general.frenos.codex'],
      [{ effort: 'ultra' }, 'general.effort'],
      [{ model: 'a\u0007b' }, 'general.model'],
      [{ otra: 1 }, 'general.otra']
    ];
    for (const t of [0, 121, 2.5, '15']) casos.push([{ timeout_minutes: t }, 'general.timeout_minutes']);
    for (const [pedido, campo] of casos) {
      const crudo = fs.readFileSync(archivo(home), 'utf8');
      r = guardar(pedido);
      check(`${JSON.stringify(pedido)} → 400 en ${campo}, sin escribir`, !r.ok && r.codigo === 400 && r.campo === campo && fs.readFileSync(archivo(home), 'utf8') === crudo, JSON.stringify(r));
    }

    r = guardar({ background_toasts: ['cuota', 'fanout'] });
    check('avisos en orden canónico', r.ok && leer(home).background_toasts.join() === 'fanout,cuota');
    r = guardar({ background_toasts: [] });
    check('ninguno → "none"', r.ok && leer(home).background_toasts === 'none');
    r = guardar({ background_toasts: ['mensajes', 'lotes', 'cuota', 'fanout'] });
    check('los cuatro → se borra la clave', r.ok && !('background_toasts' in leer(home)));

    const vm = v().motores;
    r = guardar({ frenos: { claude: 0.8 } });
    d = leer(home);
    check('freno con bin conservado', r.ok && d.motores.claude.bin === 'C:/x/claude.exe' && d.motores.claude.freno_cuota_5h === 0.8, JSON.stringify(d.motores));
    check('un freno no cambia la versión de motores', v().motores === vm);
    r = guardar({ frenos: { antigravity: null } });
    check('quitar un freno que no está no crea motores.antigravity', r.ok && !('antigravity' in leer(home).motores));

    r = guardar({ model: 'gemini-3.8-flash', effort: 'high', timeout_minutes: 30 });
    d = leer(home);
    check('modelo, esfuerzo y timeout', r.ok && d.model === 'gemini-3.8-flash' && d.effort === 'high' && d.timeout_minutes === 30, JSON.stringify(r));
    r = guardar({ model: 'claude-opus-5-5-medium' });
    check('un modelo sufijado con esfuerzo guardado no se rechaza (esfuerzoParaCli lo filtra)', r.ok, JSON.stringify(r));
    r = guardar({ model: null, effort: 'low' });
    check('esfuerzo sin modelo → vale (agy elige el modelo)', r.ok && !('model' in leer(home)) && leer(home).effort === 'low', JSON.stringify(r));

    const vg = v().general;
    const e = ajustes.leerAjustes({ homeDir: home });
    r = ajustes.guardarAjustes({ motores: { versionSeccion: e.versiones.motores, roles: {} } }, { homeDir: home });
    check('cambiar un rol no cambia la versión de general', r.ok && v().general === vg, JSON.stringify(r));

    const vieja = v().general;
    const ext = leer(home); ext.readonly_isolation = 'container'; fs.writeFileSync(archivo(home), JSON.stringify(ext));
    r = ajustes.guardarAjustes({ general: { versionSeccion: vieja, readonly_isolation: 'auto' } }, { homeDir: home });
    check('cambio por fuera → 409 en general', !r.ok && r.codigo === 409 && r.conflictos.includes('general'), JSON.stringify(r.conflictos));

    const e2 = ajustes.leerAjustes({ homeDir: home });
    r = ajustes.guardarAjustes({
      motores: { versionSeccion: e2.versiones.motores, roles: { alma: { motor: 'claude', modelo: 'opus', esfuerzo: null } } },
      general: { versionSeccion: e2.versiones.general, frenos: { claude: 0.5 } }
    }, { homeDir: home });
    d = leer(home);
    check('motores y general en el mismo pedido', r.ok && d.motores.roles.alma.modelo === 'opus' && d.motores.claude.freno_cuota_5h === 0.5 && d.motores.claude.bin === 'C:/x/claude.exe', JSON.stringify(r));
    removeFixture(home);
  });

  await group('loadConfig: timeout_minutes', () => {
    const home = homeNuevo({ timeout_minutes: '15' });
    const viejo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AGY_TIMEOUT_MINUTES: process.env.AGY_TIMEOUT_MINUTES };
    process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.AGY_TIMEOUT_MINUTES;
    try {
      let c = loadConfig(home);
      check('"15" de texto → se ignora con aviso', c.defaultTimeoutMinutes === 15 && c.avisos.some((a) => /timeout_minutes/.test(a)), JSON.stringify(c.avisos));
      fs.writeFileSync(archivo(home), JSON.stringify({ timeout_minutes: 40 }));
      c = loadConfig(home);
      check('40 → vale', c.defaultTimeoutMinutes === 40);
    } finally {
      for (const [k, x] of Object.entries(viejo)) { if (x === undefined) delete process.env[k]; else process.env[k] = x; }
      removeFixture(home);
    }
  });

  await group('set_config usa la misma validación', async () => {
    const home = homeNuevo({ model: 'gemini-3.8-flash' });
    const server = startServer({ cwd: home, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: null } });
    try {
      await server.initialize();
      let r = await server.callTool('set_config', { effort: 'ultra' });
      const texto = r.result?.content?.[0]?.text || '';
      check('effort "ultra" → error y archivo intacto', r.result?.isError && /esfuerzo/.test(texto) && !('effort' in leer(home)), texto);
      r = await server.callTool('set_config', { timeout_minutes: 500 });
      check('timeout 500 → error', r.result?.isError && !('timeout_minutes' in leer(home)));
      r = await server.callTool('set_config', { effort: 'low' });
      check('effort sin model sigue andando', !r.result?.isError && leer(home).effort === 'low' && leer(home).model === 'gemini-3.8-flash');
    } finally {
      await server.stop();
      removeFixture(home);
    }
  });

  await group('UI', async () => {
    const gen = fuente('ajustes-general.js');
    const vista = fuente('vista-ajustes.js');
    check('ajustes-general.js ≤ 210 líneas', gen.split('\n').length <= 210, String(gen.split('\n').length));
    check('sin listas propias (llegan de limites)', !/\['fanout', 'lotes'/.test(gen) && !/\['auto', 'container'/.test(gen) && !/\['low', 'medium', 'high'\]/.test(gen) && /limites\.avisosFondo/.test(gen) && /limites\.aislamientos/.test(gen));
    check('pestaña y sección editable', /\['general', 'General'\]/.test(vista) && /EDITABLES = \[[^\]]*'general'/.test(vista));
    check('el aviso de pisado por pestaña es positivo', /PISADO_DE_PESTANA/.test(vista) && !/c !== 'motores\.roles'/.test(vista));
    const { cambiosGenerales } = await import(pathToFileURL(path.join(UI, 'ajustes-general.js')).href);
    const base = { model: null, effort: null, timeout_minutes: null, readonly_isolation: null, background_toasts: null, frenos: { claude: null, antigravity: 0.9 } };
    const c = cambiosGenerales(base, { ...base, readonly_isolation: 'host', frenos: { claude: null, antigravity: null } });
    check('solo viajan las claves cambiadas', JSON.stringify(c) === JSON.stringify({ readonly_isolation: 'host', frenos: { antigravity: null } }), JSON.stringify(c));
  });

  await group('bot.js: lo que pisa el proyecto y el entorno', () => {
    const bot = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'bot.js'), 'utf8');
    check('pisadoPorProyecto mira las claves generales y los frenos', /CLAVES_GENERALES_DE_PROYECTO = \['model', 'effort', 'timeout_minutes', 'readonly_isolation', 'background_toasts'\]/.test(bot) && /motores\.\$\{m\}\.freno_cuota_5h/.test(bot));
    check('el global no se cuenta como proyecto', /const vistos = new Set\(\[path\.join\(process\.env\.HOME/.test(bot));
    check('entorno: solo las cuatro variables', /entorno: \(\) => Object\.fromEntries\(\['LAGRANGE_SOLO_LECTURA', 'AGY_MODEL', 'AGY_EFFORT', 'AGY_TIMEOUT_MINUTES'\]/.test(bot));
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
