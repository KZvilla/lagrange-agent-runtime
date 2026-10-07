/**
 * FEAT-133 + BE-113 — La voz de la identidad de la sesión (Spica, Epikouros).
 *
 * Unitarios de `identidad-sesion.js` (cuándo se inyecta la voz y con qué
 * idioma, la fusión de `set_config identidad_voz`), la carga solo global de
 * `identidad_sesion` y la integración por MCP: con `clientInfo.name =
 * 'claude-code'` un `say` sin voz sigue la ruta explícita con la voz de la
 * identidad; con cualquier otro cliente, todo como antes.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture } = require('./lib/mcp-client');
const {
  CLIENTE_CLAUDE_CODE, vozDeIdentidad, vozDeLaSesion, fusionarVozDeIdentidad
} = require('../mcp-server/lib/identidad-sesion.js');
const { aplicarIdentidad } = require('../mcp-server/lib/config.js');

const HOME = 'C:/Users/alguien';
const TABLA = {
  principal: { nombre: 'Spica', emblema: '✦', color: 'cian', voz: { es: 'Priscilla', en: 'Emily', idioma: 'es' } },
  trabajo: { nombre: 'Epikouros', emblema: '☘', color: 'verde', voz: { es: 'Isabel', en: 'Aria' } },
  sinvoz: { nombre: 'Muda' }
};
const CONFIG = {
  identidadSesion: TABLA,
  motores: { cuentas: { trabajo: { configDir: '~/.claude-work' }, sinvoz: { configDir: '~/.claude-muda' } } },
  voiceSetup: null
};
const sesion = (args, extra = {}) => vozDeLaSesion({
  args, config: CONFIG, cliente: CLIENTE_CLAUDE_CODE, configDir: null, home: HOME, ...extra
});

async function main() {
  await group('vozDeLaSesion: cuándo se inyecta', () => {
    check('el cliente medido de Claude Code es "claude-code"', CLIENTE_CLAUDE_CODE === 'claude-code');
    const r = sesion({ text: 'hola' });
    check('principal sin voz → Priscilla en es', r && r.args.voice === 'Priscilla' && r.args.language === 'es', JSON.stringify(r));
    check('muestra el nombre de la identidad', r && r.identidad.nombre === 'Spica' && r.identidad.perfil === 'Priscilla');
    check('no pisa el resto de los args', r && r.args.text === 'hola');
    const t = sesion({}, { configDir: `${HOME}/.claude-work` });
    check('la cuenta sale de CLAUDE_CONFIG_DIR (trabajo → Isabel)', t && t.args.voice === 'Isabel' && t.identidad.nombre === 'Epikouros', JSON.stringify(t));
    for (const pedido of [{ voice: 'Alya' }, { profile: 'Alya' }, { soul: 'alya' }]) {
      check(`lo explícito gana: ${JSON.stringify(pedido)} → no toca nada`, sesion(pedido) === null);
    }
    for (const cliente of ['codex-mcp-client', 'opencode', 'antigravity-tests', null, undefined, 'Claude-Code']) {
      check(`cliente ${JSON.stringify(cliente)} → sin identidad`, sesion({}, { cliente }) === null);
    }
    check('cuenta sin voz → sin identidad', sesion({}, { configDir: `${HOME}/.claude-muda` }) === null);
    check('carpeta que no es de ninguna cuenta → sin identidad', sesion({}, { configDir: `${HOME}/.otra` }) === null);
    check('sin identidad_sesion → null', vozDeLaSesion({ args: {}, config: {}, cliente: CLIENTE_CLAUDE_CODE, home: HOME }) === null);
    check('una config rota nunca tira', vozDeLaSesion({ args: {}, config: { identidadSesion: 'x' }, cliente: CLIENTE_CLAUDE_CODE, home: HOME }) === null);
  });

  await group('vozDeLaSesion: el idioma', () => {
    check('language pedido gana (en → Emily)', sesion({ language: 'en' }).args.voice === 'Emily');
    const trabajo = { configDir: `${HOME}/.claude-work` };
    check('sin language ni voz.idioma, el default de voice_setup (en → Aria)',
      sesion({}, { ...trabajo, config: { ...CONFIG, voiceSetup: { status: 'configured', default_language: 'en' } } }).args.voice === 'Aria');
    check('un voice_setup no configurado no aporta idioma',
      sesion({}, { ...trabajo, config: { ...CONFIG, voiceSetup: { status: 'unconfigured', default_language: 'en' } } }).args.voice === 'Isabel');
    for (const pedido of ['EN', ' en ', 'en-US']) {
      const r = sesion({ language: pedido });
      check(`language ${JSON.stringify(pedido)} se normaliza a en (Emily)`, r.args.voice === 'Emily' && r.args.language === 'en', JSON.stringify(r.args));
    }
    check('sin nada, es', sesion({}, trabajo).args.language === 'es');
    const soloEs = { ...CONFIG, identidadSesion: { principal: { nombre: 'Spica', voz: { es: 'Priscilla' } } } };
    check('sin voz para el idioma pedido → null (cae a voice_setup)', sesion({ language: 'en' }, { config: soloEs }) === null);
    check('un language inválido se ignora', sesion({ language: 'fr' }).args.language === 'es');
  });

  await group('vozDeIdentidad: solo la forma', () => {
    check('nombres de perfil', JSON.stringify(vozDeIdentidad(TABLA.principal)) === JSON.stringify({ es: 'Priscilla', en: 'Emily', idioma: 'es' }));
    check('sin bloque voz → null', vozDeIdentidad(TABLA.sinvoz) === null);
    check('perfiles vacíos o con controles → null', vozDeIdentidad({ voz: { es: ' ', en: 'a\u0007b' } }) === null);
    check('idioma inválido se descarta', vozDeIdentidad({ voz: { es: 'X', idioma: 'fr' } }).idioma === null);
    check('perfil de más de 128 caracteres se descarta', vozDeIdentidad({ voz: { es: 'x'.repeat(129) } }) === null);
  });

  await group('fusionarVozDeIdentidad (set_config identidad_voz)', () => {
    const r = fusionarVozDeIdentidad(TABLA, { cuenta: 'principal', es: 'Alya' });
    check('cambia solo es', r.principal.voz.es === 'Alya' && r.principal.voz.en === 'Emily' && r.principal.voz.idioma === 'es');
    check('nombre, emblema y color intactos', r.principal.nombre === 'Spica' && r.principal.emblema === '✦' && r.principal.color === 'cian');
    check('las otras cuentas intactas', JSON.stringify(r.trabajo) === JSON.stringify(TABLA.trabajo));
    check('no muta la tabla original', TABLA.principal.voz.es === 'Priscilla');
    const sinEn = fusionarVozDeIdentidad(TABLA, { cuenta: 'principal', en: null, idioma: null });
    check('null quita', !('en' in sinEn.principal.voz) && !('idioma' in sinEn.principal.voz));
    const vacia = fusionarVozDeIdentidad({ x: { nombre: 'X', voz: { es: 'A' } } }, { cuenta: 'x', es: null });
    check('sin perfiles se borra el bloque voz', !('voz' in vacia.x) && vacia.x.nombre === 'X');
    const nueva = fusionarVozDeIdentidad(TABLA, { cuenta: 'sinvoz', es: 'Dora' });
    check('crea el bloque si no había', nueva.sinvoz.voz.es === 'Dora');
    const lanza = (pedido, tabla = TABLA) => { try { fusionarVozDeIdentidad(tabla, pedido); return null; } catch (e) { return e.message; } };
    check('cuenta inexistente → error', /no tiene una identidad con nombre/.test(lanza({ cuenta: 'nadie', es: 'A' }) || ''));
    check('cuenta sin nombre → error', /no tiene una identidad con nombre/.test(lanza({ cuenta: 'x', es: 'A' }, { x: { voz: {} } }) || ''));
    check('clave desconocida → error', /no está permitido/.test(lanza({ cuenta: 'principal', nombre: 'Otra' }) || ''));
    check('idioma inválido → error', /idioma/.test(lanza({ cuenta: 'principal', idioma: 'fr' }) || ''));
    check('perfil inválido → error', /nombre de un perfil/.test(lanza({ cuenta: 'principal', es: 42 }) || ''));
    check('sin tabla → error', /no tiene una identidad/.test(lanza({ cuenta: 'principal', es: 'A' }, null) || ''));
  });

  await group('aplicarIdentidad: solo de la config global', () => {
    const global = { avisos: [], identidadSesion: null };
    aplicarIdentidad(global, { identidad_sesion: TABLA });
    check('la global se carga', global.identidadSesion === TABLA);
    const proyecto = { avisos: [], identidadSesion: TABLA };
    aplicarIdentidad(proyecto, { identidad_sesion: { principal: { nombre: 'Intrusa' } } }, { global: false });
    check('la del proyecto se ignora', proyecto.identidadSesion === TABLA);
    check('con aviso', proyecto.avisos.some(a => /identidad_sesion solo se lee de la configuración global/.test(a)));
    const rota = { avisos: [], identidadSesion: null };
    aplicarIdentidad(rota, { identidad_sesion: [1, 2] });
    check('un valor que no es objeto queda null', rota.identidadSesion === null);
  });

  // ── Integración por MCP ─────────────────────────────────────────────────
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-133-'));
  const home = path.join(fixture, 'home');
  const cwd = path.join(fixture, 'proyecto');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  const globalPath = path.join(home, '.claude', 'antigravity.json');
  const configInicial = {
    // Nunca arrancar el Voicebox real de la máquina desde un test.
    voicebox_autostart: false,
    voicebox_url: 'http://127.0.0.1:1',
    identidad_sesion: { principal: { nombre: 'Spica', emblema: '✦', color: 'cian', voz: { es: 'Priscilla', en: 'Emily' } } }
  };
  fs.writeFileSync(globalPath, JSON.stringify(configInicial, null, 2));
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: null };

  const decir = async (server, args = {}) => {
    const r = await server.callTool('say', { text: 'Hola desde la prueba.', send_telegram: false, local_playback: false, ...args }, 15000);
    return r.result?.content?.[0]?.text || '';
  };
  const motivo = (texto) => (/\*\*Motivo\*\*: `([^`]+)`/.exec(texto) || [])[1] || null;

  let claude = null;
  let otro = null;
  let porDefecto = null;
  let sinInit = null;
  try {
    // El cliente por defecto de la suite (antigravity-tests) y un tools/call sin initialize: sin identidad.
    porDefecto = startServer({ cwd, env });
    await porDefecto.initialize();
    sinInit = startServer({ cwd, env });
    await group('MCP: sin Claude Code no hay identidad', async () => {
      const dePorDefecto = await decir(porDefecto);
      check('cliente antigravity-tests → setup_required, como siempre', motivo(dePorDefecto) === 'setup_required', dePorDefecto);
      const deSinInit = await decir(sinInit);
      check('tools/call sin initialize → setup_required', motivo(deSinInit) === 'setup_required', deSinInit);
    });

    claude = startServer({ cwd, env });
    await claude.initialize({ name: 'claude-code', version: '2.1.291' });
    otro = startServer({ cwd, env });
    await otro.initialize({ name: 'codex-mcp-client', version: '0.158.0' });

    await group('MCP: say sin voz según el cliente', async () => {
      const deOtro = await decir(otro);
      check('Codex sin voice_setup → setup_required, como siempre', motivo(deOtro) === 'setup_required', deOtro);
      const deClaude = await decir(claude);
      const explicito = await decir(claude, { voice: 'Priscilla', language: 'es' });
      check('Claude Code sin voz → ya no es setup_required', motivo(deClaude) !== 'setup_required', deClaude);
      check('… y termina igual que pedir Priscilla explícita', motivo(deClaude) === motivo(explicito), `${motivo(deClaude)} vs ${motivo(explicito)}`);
      // Sin personalidad: con un alma, say reescribiría el texto con agy de verdad.
      const conAlma = await decir(claude, { soul: 'alma-que-no-existe', personality: false });
      check('con soul la identidad no participa (setup_required, como hoy)', motivo(conAlma) === 'setup_required', conAlma);
    });

    await group('MCP: set_config identidad_voz', async () => {
      let r = await claude.callTool('set_config', { identidad_voz: { cuenta: 'principal', en: 'Aria', idioma: 'en' } });
      const guardado = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
      check('guarda solo la voz', !r.result?.isError
        && guardado.identidad_sesion.principal.voz.en === 'Aria'
        && guardado.identidad_sesion.principal.voz.es === 'Priscilla'
        && guardado.identidad_sesion.principal.voz.idioma === 'en', r.result?.content?.[0]?.text);
      check('nombre, emblema y color intactos', guardado.identidad_sesion.principal.nombre === 'Spica'
        && guardado.identidad_sesion.principal.emblema === '✦' && guardado.identidad_sesion.principal.color === 'cian');
      check('el resto de la config intacto', guardado.voicebox_autostart === false && guardado.voicebox_url === 'http://127.0.0.1:1');
      check('la salida lista la voz de la identidad', /Voces de identidad: Spica \(principal\): es Priscilla, en Aria, idioma en/.test(r.result?.content?.[0]?.text || ''), r.result?.content?.[0]?.text);

      r = await claude.callTool('set_config', { scope: 'project', cwd, identidad_voz: { cuenta: 'principal', es: 'Alya' } });
      check('scope project → error', r.result?.isError && /solo se guarda con scope "global"/.test(r.result.content[0].text), r.result?.content?.[0]?.text);
      check('y no escribe el proyecto', !fs.existsSync(path.join(cwd, '.claude', 'antigravity.json')));

      r = await claude.callTool('set_config', { identidad_voz: { cuenta: 'trabajo', es: 'Isabel' } });
      check('cuenta sin identidad → error', r.result?.isError && /no tiene una identidad con nombre/.test(r.result.content[0].text), r.result?.content?.[0]?.text);
    });
  } finally {
    for (const s of [claude, otro, porDefecto, sinInit]) if (s) await s.stop();
    removeFixture(fixture);
  }

  await group('BE-113: las descripciones de say y narrate', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'index.js'), 'utf8');
    check('ya no prometen Emily/Diego como default local', !src.includes('Defaults to "Emily" for English and "Diego Alvarez" for Spanish.'));
    const nuevas = src.split('the voice of the session identity is used').length - 1;
    check('describen el orden real en say y narrate', nuevas === 2, String(nuevas));
    // Sin audio real en los tests: el cableado del nombre visible se fija sobre el código.
    const nombreVisible = src.split('nombreVisible: sesionVoz ? sesionVoz.identidad.nombre : null,').length - 1;
    check('el nombre de la identidad viaja a las 3 emisiones (resumen, narrate, say)', nombreVisible === 3, String(nombreVisible));
    check('el spinner usa el nombre visible', src.includes('avisarVozEnCurso({ voz: nombreVisible || (profile && profile.name)'));
    check('el caption de Telegram usa el nombre visible', src.includes('(Voz: ${nombreVisible || profile.name}'));
    const salida = src.split('vozSesion: sesionVoz ? sesionVoz.identidad : null,').length - 1;
    check('la salida de narrate y say muestra la voz de la sesión', salida === 2, String(salida));
    check('VOZ_POR_DEFECTO del servidor sigue igual', /VOZ_POR_DEFECTO = Object\.freeze\(\{ es: 'Diego Alvarez', en: 'Emily' \}\)/.test(
      fs.readFileSync(path.join(__dirname, '..', 'mcp-server', 'voz-sintesis.js'), 'utf8')));
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
