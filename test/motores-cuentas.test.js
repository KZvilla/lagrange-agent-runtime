/**
 * FEAT-085 — Cuenta de Claude por rol: `motores.cuentas` (solo carpetas, nunca
 * credenciales) y `cuenta` en un rol de claude. Cubre la validación, el
 * entorno del hijo, el preflight, el armado, las sondas por cuenta y las
 * superficies (charla, cast, consolidación): hilos, uso y cuota bajo
 * `claude@<cuenta>`.
 *
 * Nunca lanza el `claude` real ni agy: `execFile` se parchea antes de requerir
 * los módulos (como `motores-claude.test.js`) y el ejecutor de claude es doble.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const execFileReal = cp.execFile;
cp.execFile = function (_bin, _args, _opts, cb) {
  if (/taskkill/i.test(String(_bin))) return execFileReal.apply(this, arguments);
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, 'lagrange-alma\nlector\n', ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const roles = require('../mcp-server/motores/roles.js');
const configMotores = require('../mcp-server/motores/config-motores.js');
const { entornoParaClaude, CREDENCIALES_QUE_GANAN } = require('../mcp-server/motores/entorno.js');
const motor = require('../mcp-server/motores/claude.js');
const motores = require('../mcp-server/motores/index.js');
const politicas = require('../mcp-server/motores/politicas.js');
const sondasClaude = require('../mcp-server/motores/sondas-claude.js');
const sondas = require('../mcp-server/motores/sondas.js');
const charla = require('../mcp-server/almas/charla.js');
const consolidar = require('../mcp-server/almas/consolidar.js');
const cast = require('../mcp-server/agents/cast.js');
const hilos = require('../mcp-server/almas/hilos.js');
const estadoAgentes = require('../mcp-server/agents/estado.js');
const registro = require('../mcp-server/agents/registry.js');
const semilla = require('../mcp-server/almas/semilla.js');
const usoAgy = require('../mcp-server/lib/uso-agy.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };
const valorDe = (argv, flag) => argv[argv.indexOf(flag) + 1];

/** Corre `fn` con variables de `process.env` cambiadas y las restaura siempre. */
async function conEnv(cambios, fn) {
  const previo = Object.fromEntries(Object.keys(cambios).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(cambios)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat085-'));
  const home = path.join(raiz, 'home');
  const cuentaDir = path.join(raiz, 'claude-work');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(cuentaDir, { recursive: true });
  const base = path.join(raiz, 'almas');
  const env = { LAGRANGE_ALMAS_DIR: base };

  try {
    await group('roles.js: cuentas y cuenta del rol', () => {
      const ok = roles.validarCuentas({ trabajo: { configDir: '~/.claude-work' } }, { homeDir: home });
      check('una cuenta con configDir pasa, con ~ expandida', ok.ok && ok.cuentas.trabajo.configDir === path.join(home, '.claude-work'));
      check('y se guarda como se escribió', ok.ok && ok.crudas.trabajo.configDir === '~/.claude-work');
      const token = roles.validarCuentas({ trabajo: { configDir: cuentaDir, token: 'x' } }, { homeDir: home });
      check('un campo que no es configDir se rechaza (nunca credenciales)', !token.ok && /solo admite `configDir`/.test(token.motivo), token.motivo);
      const pareceToken = roles.validarCuentas({ trabajo: { configDir: 'sk-ant-oat01-abc' } }, { homeDir: home });
      check('un configDir con forma de token se rechaza', !pareceToken.ok && /parece una credencial/.test(pareceToken.motivo));
      check('apuntar a ~/.claude se rechaza', !roles.validarCuentas({ x: { configDir: '~/.claude' } }, { homeDir: home }).ok);
      check('un nombre inválido se rechaza', !roles.validarCuentas({ 'Trabajo!': { configDir: cuentaDir } }, { homeDir: home }).ok);
      check('sin sección, vacío', roles.validarCuentas(undefined).ok);

      const conCuenta = roles.validarRoles({ 'cast:lector': { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } });
      check('un rol de claude con cuenta pasa y la conserva', conCuenta.ok && conCuenta.roles['cast:lector'].cuenta === 'trabajo');
      const sinCuenta = roles.validarRoles({ alma: { motor: 'claude', modelo: 'sonnet' } });
      check('sin cuenta, la entrada no gana la clave (igual que antes)', sinCuenta.ok && !('cuenta' in sinCuenta.roles.alma));
      const agy = roles.validarRoles({ alma: { motor: 'antigravity', cuenta: 'trabajo' } });
      check('cuenta con antigravity se rechaza', !agy.ok && /solo aplica al motor claude/.test(agy.motivo));
      const inexistente = roles.validarRoles({ alma: { motor: 'claude', modelo: 'sonnet', cuenta: 'otra' } }, { estricto: true, cuentas: ['trabajo'] });
      check('en escritura, una cuenta que no existe se rechaza', !inexistente.ok && /no está en `motores.cuentas`/.test(inexistente.motivo));
      const enCarga = roles.validarRoles({ alma: { motor: 'claude', modelo: 'sonnet', cuenta: 'otra' } });
      check('en la carga pasa (lo frena el preflight)', enCarga.ok);
      check('claveDeCuenta', roles.claveDeCuenta('claude') === 'claude' && roles.claveDeCuenta('claude', 'trabajo') === 'claude@trabajo');
    });

    await group('config-motores: escritura y la web', () => {
      const m = configMotores.fusionarMotores({}, {
        cuentas: { trabajo: { configDir: cuentaDir } },
        roles: { 'cast:lector': { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } }
      }, { homeDir: home });
      check('cuentas y un rol que la usa se guardan juntos', m.cuentas.trabajo.configDir === cuentaDir && m.roles['cast:lector'].cuenta === 'trabajo');
      let error = null;
      try { configMotores.fusionarMotores({}, { roles: { alma: { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } } }, { homeDir: home }); } catch (e) { error = e.message; }
      check('un rol con cuenta inexistente no se guarda', /no está en `motores.cuentas`/.test(error || ''), error);
      error = null;
      try { configMotores.fusionarMotores(m, { cuentas: {} }, { homeDir: home }); } catch (e) { error = e.message; }
      check('quitar una cuenta en uso no se puede', /se quitaría/.test(error || ''), error);
      const proyecto = configMotores.fusionarMotores({}, { roles: { alma: { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } } }, { homeDir: home, nombresCuentas: ['trabajo'] });
      check('el proyecto valida contra las cuentas de la global', proyecto.roles.alma.cuenta === 'trabajo');

      fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: m }));
      const r1 = configMotores.guardarRol('cast:lector', { motor: 'claude', modelo: 'opus', esfuerzo: null }, { homeDir: home });
      check('la web cambia el modelo y la cuenta se conserva', r1.ok && r1.roles['cast:lector'].modelo === 'opus' && r1.roles['cast:lector'].cuenta === 'trabajo', JSON.stringify(r1));
      const r2 = configMotores.guardarRol('cast:lector', { motor: 'antigravity', modelo: null, esfuerzo: null }, { homeDir: home });
      check('pasar a antigravity la suelta (no aplica)', r2.ok && !('cuenta' in r2.roles['cast:lector']), JSON.stringify(r2));
      configMotores.guardarRol('cast:lector', { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' }, { homeDir: home });
      const r3 = configMotores.guardarRol('cast:lector', { motor: 'claude', modelo: 'sonnet', cuenta: null }, { homeDir: home });
      check('cuenta: null la quita', r3.ok && !('cuenta' in r3.roles['cast:lector']), JSON.stringify(r3));
      const guardado = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'antigravity.json'), 'utf8'));
      check('ningún campo de credencial llegó al archivo', !/token|sk-ant|oauth/i.test(JSON.stringify(guardado)));
    });

    await group('lib/config.js: carga', async () => {
      const cwd = path.join(raiz, 'proyecto');
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({
        motores: { cuentas: { trabajo: { configDir: cuentaDir } }, roles: { alma: { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } } }
      }));
      fs.writeFileSync(path.join(cwd, '.claude', 'antigravity.json'), JSON.stringify({
        motores: { cuentas: { ajena: { configDir: path.join(raiz, 'ajena') } } }
      }));
      await conEnv({ HOME: home, USERPROFILE: home }, () => {
        delete require.cache[require.resolve('../mcp-server/lib/config.js')];
        const { loadConfig } = require('../mcp-server/lib/config.js');
        const c = loadConfig(cwd);
        check('las cuentas de la global se cargan resueltas', c.motores.cuentas && c.motores.cuentas.trabajo.configDir === path.resolve(cuentaDir));
        check('las del proyecto se ignoran, con aviso', !c.motores.cuentas.ajena && c.avisos.some(a => /solo se lee de la configuración global/.test(a)));
        check('el rol con cuenta se carga', c.motores.roles.alma.cuenta === 'trabajo');
        fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ motores: { cuentas: { trabajo: { configDir: cuentaDir, apiKey: 'x' } } } }));
        const mala = loadConfig(cwd);
        check('una sección inválida se ignora entera, con aviso', !mala.motores.cuentas && mala.avisos.some(a => /motores.cuentas se ignora entera/.test(a)));
      });
    });

    await group('entorno.js: el hijo corre con la carpeta de la cuenta', () => {
      const heredado = {
        PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'sk-ant-x', anthropic_auth_token: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'r', CLAUDE_CODE_OAUTH_SCOPES: 's', ANTHROPIC_PROFILE: 'p',
        ANTHROPIC_FEDERATION_RULE_ID: 'f', ANTHROPIC_ORGANIZATION_ID: 'g', Claude_Config_Dir: 'C:\\otra', ANTHROPIC_BASE_URL: 'https://x'
      };
      const hijo = entornoParaClaude(heredado, { configDir: cuentaDir });
      const quedan = Object.keys(hijo).filter(k => CREDENCIALES_QUE_GANAN.has(k.toUpperCase()));
      check('ninguna credencial que gana al login queda (en ninguna grafía)', quedan.length === 0, JSON.stringify(quedan));
      const dirs = Object.keys(hijo).filter(k => k.toUpperCase() === 'CLAUDE_CONFIG_DIR');
      check('CLAUDE_CONFIG_DIR es una sola, la de la cuenta', dirs.length === 1 && hijo.CLAUDE_CONFIG_DIR === cuentaDir, JSON.stringify(dirs));
      check('el resto sigue (PATH, ANTHROPIC_BASE_URL)', hijo.PATH === 'C:\\bin' && hijo.ANTHROPIC_BASE_URL === 'https://x');
      const sin = entornoParaClaude(heredado);
      check('sin cuenta, la autenticación heredada queda como antes', sin.ANTHROPIC_API_KEY === 'sk-ant-x' && sin.CLAUDE_CODE_OAUTH_TOKEN === 'o');
      check('BE-047: sin cuenta, la carpeta heredada no queda', !Object.keys(sin).some(k => k.toUpperCase() === 'CLAUDE_CONFIG_DIR'), JSON.stringify(Object.keys(sin)));
    });

    const config = { motores: { cuentas: { trabajo: { configDir: cuentaDir } }, roles: {}, claude: { freno_cuota_5h: 0.5 } } };

    await group('claude.js: preflight y armar', async () => {
      const leidas = [];
      const ctx = (extra = {}) => ({ config, bin: 'claude-doble', env: { PATH: 'x' }, leerSondas: async (clave, perfil) => { leidas.push(`${clave}/${perfil}`); return { ok: true }; }, ...extra });
      const pre = await motor.preflight({ perfil: 'sin-tools', modelo: 'sonnet', cuenta: 'trabajo' }, ctx());
      check('con cuenta: pasa y devuelve la carpeta', pre.ok && pre.configDir === cuentaDir, JSON.stringify(pre));
      check('las sondas se leen con la clave de la cuenta', leidas.includes('claude@trabajo/sin-tools'), JSON.stringify(leidas));
      const sin = await motor.preflight({ perfil: 'sin-tools', modelo: 'sonnet' }, ctx());
      check('sin cuenta: sin carpeta y sondas de claude', sin.ok && sin.configDir === null && leidas.includes('claude/sin-tools'));
      const otra = await motor.preflight({ perfil: 'sin-tools', modelo: 'sonnet', cuenta: 'otra' }, ctx());
      check('cuenta desconocida → rechazo con motivo, sin leer sondas', !otra.ok && /no está en motores.cuentas/.test(otra.motivo) && !leidas.includes('claude@otra/sin-tools'));
      const sinCarpeta = await motor.preflight({ perfil: 'sin-tools', modelo: 'sonnet', cuenta: 'trabajo' },
        ctx({ config: { motores: { cuentas: { trabajo: { configDir: path.join(raiz, 'no-existe') } } } } }));
      check('carpeta inexistente → rechazo', !sinCarpeta.ok && /no existe la carpeta/.test(sinCarpeta.motivo));
      const bedrock = await motor.preflight({ perfil: 'sin-tools', modelo: 'sonnet', cuenta: 'trabajo' }, ctx({ env: { claude_code_use_bedrock: '1' } }));
      check('proveedor forzado en el entorno → rechazo', !bedrock.ok && /proveedor en la nube/.test(bedrock.motivo));

      const cuotas = [];
      const frenado = await motor.preflight({ perfil: 'sin-tools', modelo: 'sonnet', cuenta: 'trabajo', origen: 'fondo' },
        ctx({ leerCuota: (clave) => { cuotas.push(clave); return clave === 'claude@trabajo' ? { ventana_5h: 0.9, visto_en: new Date().toISOString() } : null; } }));
      check('el freno lee la cuota de la cuenta y frena solo ese rol', !frenado.ok && frenado.frenado && cuotas[0] === 'claude@trabajo' && /claude@trabajo/.test(frenado.motivo), JSON.stringify(cuotas));
      const libre = await motor.preflight({ perfil: 'sin-tools', modelo: 'sonnet', origen: 'fondo' },
        ctx({ leerCuota: (clave) => (clave === 'claude@trabajo' ? { ventana_5h: 0.9, visto_en: new Date().toISOString() } : null) }));
      check('la cuota de otra cuenta no frena a la por defecto', libre.ok);

      const conCuenta = motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'sonnet', cuenta: 'trabajo' }, { env: { ANTHROPIC_API_KEY: 'k', PATH: 'p' }, configDir: cuentaDir });
      const sinCuenta = motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'sonnet' }, { env: { ANTHROPIC_API_KEY: 'k', PATH: 'p' }, configDir: cuentaDir });
      check('armar con cuenta: CLAUDE_CONFIG_DIR y sin la API key', conCuenta.env.CLAUDE_CONFIG_DIR === cuentaDir && !('ANTHROPIC_API_KEY' in conCuenta.env));
      check('sin cuenta, configDir se ignora', !('CLAUDE_CONFIG_DIR' in sinCuenta.env) && sinCuenta.env.ANTHROPIC_API_KEY === 'k');
      const desdeWork = motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'sonnet' }, { env: { CLAUDE_CONFIG_DIR: cuentaDir, PATH: 'p' } });
      check('BE-047: armar sin cuenta desde una sesión con otra carpeta → el hijo corre con la principal', !('CLAUDE_CONFIG_DIR' in desdeWork.env) && desdeWork.env.PATH === 'p');
      const sinId = (argv) => argv.filter((a, i) => argv[i - 1] !== '--session-id' && a !== '--session-id');
      check('el argv no cambia con cuenta', JSON.stringify(sinId(conCuenta.argv)) === JSON.stringify(sinId(sinCuenta.argv)));
      let lanzo = null;
      try { motor.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'sonnet', cuenta: 'trabajo' }, {}); } catch (e) { lanzo = e.message; }
      check('cuenta sin carpeta no se arma (segunda barrera)', /llegó sin su carpeta/.test(lanzo || ''), lanzo);
      check('politicas: sin cuenta lee la cuota del motor', (() => { let k = null; politicas.verificarPoliticas(motor, { modelo: 'x', origen: 'fondo' }, { config, leerCuota: (c) => { k = c; return null; } }); return k === 'claude'; })());
    });

    await group('sondas por cuenta', async () => {
      const cuentaOk = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: cuentaDir, email: 'otra@empresa.com', subscriptionType: 'max', orgId: 'o' });
      check('C0 pasa con login en la carpeta', sondasClaude.evaluarC0(cuentaOk, { configDir: cuentaDir }).resultado === 'pasa');
      const noLogin = sondasClaude.evaluarC0(JSON.stringify({ loggedIn: false, configDirectory: cuentaDir }), { configDir: cuentaDir });
      check('C0 falla sin login', noLogin.resultado === 'falla' && /no tiene login/.test(noLogin.motivo));
      const otraCarpeta = sondasClaude.evaluarC0(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: path.join(home, '.claude') }), { configDir: cuentaDir });
      check('C0 falla si leyó otra carpeta', otraCarpeta.resultado === 'falla' && /no la de la cuenta/.test(otraCarpeta.motivo));
      check('C0 falla con otro método', sondasClaude.evaluarC0(JSON.stringify({ loggedIn: true, authMethod: 'console', configDirectory: cuentaDir }), { configDir: cuentaDir }).resultado === 'falla');
      check('C0 inconclusa sin JSON', sondasClaude.evaluarC0('no', { configDir: cuentaDir }).resultado === 'inconclusa');

      const init = (apiKeySource) => [{ type: 'system', subtype: 'init', tools: [], mcp_servers: [], permissionMode: 'default', apiKeySource }, { type: 'result', subtype: 'success', is_error: false, result: 'ok' }];
      check('C1 con cuenta exige apiKeySource none', sondasClaude.evaluarInventario(init('none'), { loginEnDisco: true }).resultado === 'pasa'
        && sondasClaude.evaluarInventario(init('ANTHROPIC_API_KEY'), { loginEnDisco: true }).resultado === 'falla');
      check('C1 sin cuenta no lo mira (como antes)', sondasClaude.evaluarInventario(init('ANTHROPIC_API_KEY')).resultado === 'pasa');

      const lanzados = [];
      const lanzar = async (perfil) => { lanzados.push(perfil); return { eventos: init('none'), error: null }; };
      const ctx = sondasClaude.crearContextoSondas({
        homeDir: home, cuenta: 'trabajo', configDir: cuentaDir, lanzar, estadoAuth: async () => cuentaOk,
        obtenerBin: () => ({ ok: true, bin: 'claude-doble' }), version: () => '2.1.282'
      });
      check('el contexto usa la clave de la cuenta', ctx.clave === 'claude@trabajo');
      const corrida = await ctx.correrAhora();
      const guardado = sondas.leerResultados(home);
      check('los resultados quedan bajo claude@trabajo', guardado['claude@trabajo'] && guardado['claude@trabajo']['sin-tools'] && !guardado.claude, JSON.stringify(Object.keys(guardado)));
      check('C0 corre primera en cada perfil', Object.keys(corrida.entradas['sin-tools'].sondas)[0] === 'C0' && Object.keys(corrida.entradas.lectura.sondas)[0] === 'C0');
      check('la huella suma la carpeta', guardado['claude@trabajo']['sin-tools'].huella.configDir === cuentaDir);
      const v = await ctx.leerSondas('sin-tools');
      check('vigentes para esa cuenta', v.ok, v.motivo);
      const otraDir = sondasClaude.crearContextoSondas({ homeDir: home, cuenta: 'trabajo', configDir: path.join(raiz, 'movida'), obtenerBin: () => ({ ok: true, bin: 'claude-doble' }), version: () => '2.1.282' });
      check('si la cuenta apunta a otra carpeta, hay que re-verificar', !(await otraDir.leerSondas('sin-tools')).ok);
      const porDefecto = sondasClaude.crearContextoSondas({ homeDir: home, obtenerBin: () => ({ ok: true, bin: 'claude-doble' }), version: () => '2.1.282' });
      check('las de la cuenta no valen para la por defecto', !(await porDefecto.leerSondas('sin-tools')).ok);

      const global = motores.crearContextoSondas({ homeDir: home, config: () => config });
      check('motores: una cuenta desconocida rechaza sin lanzar', !(await global.leerSondas('claude@otra', 'sin-tools')).ok);
      check('motores: claude@trabajo es su propio contexto', global.deMotor('claude@trabajo').clave === 'claude@trabajo' && global.deMotor('claude').clave === 'claude');
    });

    await group('superficies: hilo, uso y cuota bajo claude@trabajo', async () => {
      semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });
      const dirSkill = path.join(home, '.gemini', 'config', 'skills', 'revisor');
      fs.mkdirSync(dirSkill, { recursive: true });
      fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), '---\nname: revisor\ndescription: skill de prueba\nrisk: low\n---\n\nRevisá.\n', 'utf8');
      registro.instalarAgente('lector', { skill: 'revisor' }, home);

      const cfg = (rolesTabla) => ({ motores: { cuentas: { trabajo: { configDir: cuentaDir } }, roles: rolesTabla } });
      const ctx = (rolesTabla) => ({ config: cfg(rolesTabla), bin: 'claude-doble', env: {}, leerSondas: async () => ({ ok: true }) });
      const nuncaAgy = async () => { throw new Error('agy no debería correr'); };
      const specs = [];
      const cl = async (spec) => {
        specs.push(spec);
        const id = spec.argv.includes('--resume') ? valorDe(spec.argv, '--resume') : valorDe(spec.argv, '--session-id');
        return { success: true, lanzado: true, codigo: 0, eventos: [
          { type: 'system', subtype: 'init', session_id: id, tools: [] },
          { type: 'rate_limit_event', rate_limit_info: { five_hour: { utilization: 0.3 } } },
          { type: 'result', subtype: 'success', is_error: false, result: 'Hola.', session_id: id, modelUsage: {} }
        ] };
      };

      const usos = [];
      const r = await charla.charlar({
        clave: 'alya', texto: 'hola', agyBin: 'agy', ejecutar: nuncaAgy, ejecutarClaude: cl, homeDir: home, env,
        contextoMotor: ctx({ 'alma:alya': { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } }), registrarUso: u => usos.push(u)
      });
      check('charla con cuenta: el hijo recibe la carpeta', r.ok && specs[0].env.CLAUDE_CONFIG_DIR === cuentaDir, r.motivo);
      check('el hilo queda bajo claude@trabajo y no bajo claude', hilos.hiloDe('alya', { env, motor: 'claude@trabajo' }) === r.hilo && !hilos.hiloDe('alya', { env, motor: 'claude' }));
      check('el uso se registra con la clave de la cuenta', usos[0] && usos[0].motor === 'claude@trabajo');
      check('el resultado trae la cuenta para el pie', r.cuenta === 'trabajo' && r.motor === 'claude');
      const r2 = await charla.charlar({
        clave: 'alya', texto: 'sigo', agyBin: 'agy', ejecutar: nuncaAgy, ejecutarClaude: cl, homeDir: home, env,
        contextoMotor: ctx({ 'alma:alya': { motor: 'claude', modelo: 'sonnet' } })
      });
      check('sin cuenta no retoma el hilo de la cuenta', r2.ok && !r2.continuado && !specs[1].argv.includes('--resume') && !('CLAUDE_CONFIG_DIR' in specs[1].env));
      hilos.olvidarHilo('alya', env);

      const usosCast = [];
      const c = await cast.castear({
        agent: 'lector', prompt: 'mirá', cwd: home, agyBin: 'agy', ejecutar: nuncaAgy, ejecutarClaude: cl, homeDir: home,
        contextoMotor: ctx({ 'cast:lector': { motor: 'claude', modelo: 'sonnet', cuenta: 'trabajo' } }),
        registrarUso: u => usosCast.push(u), opciones: { memory: false }
      });
      const specCast = specs[specs.length - 1];
      check('cast con cuenta: carpeta en el hijo', c.ok && specCast.env.CLAUDE_CONFIG_DIR === cuentaDir, c.error);
      check('hilo del cast bajo claude@trabajo', estadoAgentes.hiloDe('lector', home, { motor: 'claude@trabajo' }) === c.conversationId && !estadoAgentes.hiloDe('lector', home, { motor: 'claude' }));
      check('uso del cast con la clave de la cuenta', usosCast[0] && usosCast[0].motor === 'claude@trabajo');
      const lanzadosAntes = specs.length;
      const fallido = await cast.castear({
        agent: 'lector', prompt: 'x', cwd: home, agyBin: 'agy', ejecutar: nuncaAgy, ejecutarClaude: cl, homeDir: home,
        contextoMotor: ctx({ 'cast:lector': { motor: 'claude', modelo: 'sonnet', cuenta: 'fantasma' } }), opciones: { memory: false }
      });
      check('cast con cuenta inexistente: no se lanza, con motivo', !fallido.ok && /no está en motores.cuentas/.test(fallido.error) && specs.length === lanzadosAntes);

      // La consolidación: aislada (sin hilo), pero con la cuenta.
      const rutaUso = path.join(home, '.claude', 'antigravity-usage.json');
      const almacen = usoAgy.crearAlmacenUso({ ruta: rutaUso, stderr: { write() {} } });
      almacen.registrarLlamada({ tool: 'cast', motor: 'claude@trabajo', usage: { total_tokens: 3 }, cuota: { ventana_5h: 0.4 } });
      check('uso-agy: la cuota queda bajo claude@trabajo', almacen.leerCuota('claude@trabajo') && almacen.leerCuota('claude@trabajo').ventana_5h === 0.4 && !almacen.leerCuota('claude'));
      const resumen = usoAgy.resumenUso({ ruta: rutaUso });
      check('uso-agy: el resumen por motor no descarta la clave con cuenta', resumen && resumen.porMotor && resumen.porMotor['claude@trabajo'], JSON.stringify(resumen && resumen.porMotor));
      check('uso-agy: la cuota de la cuenta sale por nombre', resumen && resumen.cuotaClaudePorCuenta && resumen.cuotaClaudePorCuenta.trabajo && resumen.cuotaClaudePorCuenta.trabajo.ventana5h === 0.4, JSON.stringify(resumen));

      // La consolidación: aislada (sin hilo), pero con la cuenta y su clave de uso.
      const turnos = [];
      for (let i = 0; i < 3; i++) consolidar.agregarTurno(turnos, { rol: 'usuario', texto: `turno ${i}` });
      consolidar.agregarTurno(turnos, { rol: 'alma', texto: 'respuesta' });
      const archivo = consolidar.volcar({ clave: 'alya', streamId: 'prueba-cuenta', turnos }, env);
      const usosCons = [];
      const antes = specs.length;
      const rc = await consolidar.consolidarTodos({
        archivo, env, agyBin: 'agy', homeDir: home, ejecutar: nuncaAgy, ejecutarClaude: cl, registrarUso: u => usosCons.push(u),
        contextoMotor: ctx({ consolidar: { motor: 'claude', modelo: 'claude-haiku-4-5-20251001', cuenta: 'trabajo' } })
      });
      const specCons = specs[antes];
      check('consolidar con cuenta: carpeta en el hijo, aislada', rc.length === 1 && specCons && specCons.env.CLAUDE_CONFIG_DIR === cuentaDir && specCons.argv.includes('--no-session-persistence'), JSON.stringify(rc));
      check('uso de la consolidación con la clave de la cuenta', usosCons[0] && usosCons[0].motor === 'claude@trabajo', JSON.stringify(usosCons[0]));
    });
  } finally {
    borrar(raiz);
  }
  report();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
