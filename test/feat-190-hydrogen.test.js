/**
 * FEAT-190 — Gemini 4 Hydrogen reemplaza a 3.8 Flash como Gemini por defecto.
 *
 * Hechos medidos con agy 1.5.7 el 2026-11-12: `gemini-4-hydrogen-{low,medium,high,xhigh}`;
 * el nombre corto acepta los cuatro por `--effort` y, SIN `--effort`, corre en `high`
 * (default de Google: gasto silencioso); un id sufijado (`-xhigh` incluido) con `--effort`
 * da "conflicts with --effort".
 *
 * Política del usuario: medium/low por defecto, high solo para auditar, xhigh solo a
 * pedido explícito (nunca un default).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const niveles = require('../mcp-server/motores/niveles.js');
const compat = require('../mcp-server/lib/cli-compat.js');
const roles = require('../mcp-server/motores/roles.js');
const agy = require('../mcp-server/motores/antigravity.js');
const agente = require('../mcp-server/almas/agente.js');

const H = 'gemini-4-hydrogen';
const fuente = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

async function main() {
  await group('niveles de Hydrogen', () => {
    const n = niveles.nivelesPara('antigravity', H);
    check('admite low, medium, high y xhigh', n.admite && n.niveles.join(',') === 'low,medium,high,xhigh', n.niveles);
    check('implícito medium, no el high de Google', n.implicito === 'medium', n.implicito);
    check('MODELO_GEMINI es Hydrogen', niveles.MODELO_GEMINI === H);
    for (const s of ['low', 'medium', 'high', 'xhigh']) {
      check(`el sufijado -${s} no admite --effort`, niveles.nivelesPara('antigravity', `${H}-${s}`).admite === false);
    }
    check('3.8 Flash sigue sin xhigh', !niveles.admiteNivel('antigravity', 'gemini-3.8-flash', 'xhigh'));
    const agyCat = niveles.MODELOS.antigravity;
    check('el catálogo ofrece Hydrogen y ya no 3.8', agyCat.includes(H) && !agyCat.includes('gemini-3.8-flash'));
    const cat = niveles.catalogo([{ motor: 'antigravity', modelo: 'gemini-3.8-flash' }]).find((c) => c.motor === 'antigravity');
    check('un 3.8 guardado se sigue viendo por extras', cat.modelos.some((m) => m.modelo === 'gemini-3.8-flash'));
  });

  await group('siempre se manda --effort con Hydrogen corto', () => {
    for (const porDefecto of [undefined, null, '', 'medium', 'low', 'high', 'xhigh', 'max', 'basura']) {
      const e = compat.esfuerzoParaCli({ modelo: H, pedido: null, porDefecto });
      check(`porDefecto ${JSON.stringify(porDefecto)} → un nivel (${e})`, typeof e === 'string' && e.length > 0);
    }
    check('sin defecto: medium', compat.esfuerzoParaCli({ modelo: H }) === 'medium');
    check('un defecto xhigh no se aplica: medium', compat.esfuerzoParaCli({ modelo: H, porDefecto: 'xhigh' }) === 'medium');
    check('un defecto high sí (agy_audit)', compat.esfuerzoParaCli({ modelo: H, porDefecto: 'high' }) === 'high');
    check('xhigh a pedido explícito se respeta', compat.esfuerzoParaCli({ modelo: H, pedido: 'xhigh' }) === 'xhigh');
    check('sufijado: sin flag', compat.esfuerzoParaCli({ modelo: `${H}-xhigh`, porDefecto: 'medium' }) === null);

    const armado = agy.armar({ prompt: 'x', perfil: 'edicion', cast: 'c', modelo: H });
    check('motor antigravity (cast) manda --effort medium', armado[armado.indexOf('--effort') + 1] === 'medium', armado);
    const alma = agente.argsBase({ modelo: H });
    check('alma manda --effort low', alma[alma.indexOf('--effort') + 1] === 'low', alma);
  });

  await group('validarModeloEsfuerzo', () => {
    check('Hydrogen + xhigh vale', compat.validarModeloEsfuerzo(['--model', H, '--effort', 'xhigh']) === null);
    check('Hydrogen + max no', /no admite effort "max"/.test(compat.validarModeloEsfuerzo(['--model', H, '--effort', 'max']) || ''));
    check('-xhigh + --effort choca', /ya fija el esfuerzo/.test(compat.validarModeloEsfuerzo(['--model', `${H}-xhigh`, '--effort', 'low']) || ''));
  });

  await group('xhigh nunca como default: configuración', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-190-'));
    const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AGY_EFFORT: process.env.AGY_EFFORT };
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.AGY_EFFORT;
      delete require.cache[require.resolve('../mcp-server/lib/config.js')];
      const { loadConfig } = require('../mcp-server/lib/config.js');
      const escribir = (o) => fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify(o));

      escribir({ model: H, effort: 'xhigh' });
      let c = loadConfig(home);
      check('effort xhigh en el archivo se descarta', c.defaultEffort === null, c.defaultEffort);
      check('con aviso', c.avisos.some((a) => /xhigh/.test(a)), c.avisos);

      escribir({ model: H, effort: 'medium' });
      c = loadConfig(home);
      check('medium se respeta, sin aviso', c.defaultEffort === 'medium' && !c.avisos.some((a) => /xhigh/.test(a)));

      escribir({ model: H });
      process.env.AGY_EFFORT = 'XHIGH';
      c = loadConfig(home);
      check('AGY_EFFORT=XHIGH también se descarta', c.defaultEffort === null, c.defaultEffort);
    } finally {
      for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await group('xhigh nunca como default: roles de agy', () => {
    const entrada = { cast: { motor: 'antigravity', modelo: H, esfuerzo: 'xhigh' } };
    const estricto = roles.validarRoles(entrada, { estricto: true });
    check('al escribir se rechaza', estricto.ok === false && /a pedido explícito/.test(estricto.motivo), estricto);
    const carga = roles.validarRoles(entrada);
    check('al cargar se baja a medium con aviso', carga.ok && carga.roles.cast.esfuerzo === 'medium' && carga.avisos.length === 1, carga);
    const alto = roles.validarRoles({ cast: { motor: 'antigravity', modelo: H, esfuerzo: 'high' } }, { estricto: true });
    check('high en un rol de agy sigue valiendo', alto.ok && alto.roles.cast.esfuerzo === 'high');
    const sinModelo = { cast: { motor: 'antigravity', esfuerzo: 'xhigh' } };
    const sinModeloEstricto = roles.validarRoles(sinModelo, { estricto: true });
    check('sin modelo ("el de agy") también se rechaza al escribir', sinModeloEstricto.ok === false, sinModeloEstricto);
    const sinModeloCarga = roles.validarRoles(sinModelo);
    check('sin modelo, al cargar queda sin esfuerzo (decide agy) con aviso', sinModeloCarga.ok && sinModeloCarga.roles.cast.esfuerzo === null && sinModeloCarga.avisos.length === 1, sinModeloCarga);
    const maxAgy = roles.validarRoles({ cast: { motor: 'antigravity', esfuerzo: 'max' } }, { estricto: true });
    check('max en un rol de agy sin modelo se rechaza', maxAgy.ok === false);
    const go = roles.validarRoles({ alma: { motor: 'opencode-go', modelo: niveles.MODELO_OPENCODE_GO, esfuerzo: 'max' } }, { estricto: true });
    check('max de opencode-go no se toca (la guardia es solo de agy)', go.ok && go.roles.alma.esfuerzo === 'max', go);
  });

  await group('xhigh nunca como default: bridge de Telegram', async () => {
    const previo = { AGY_EFFORT: process.env.AGY_EFFORT, AGY_MODEL: process.env.AGY_MODEL };
    try {
      const { modeloPorDefecto } = await import('../telegram-bridge/executor.js');
      process.env.AGY_MODEL = H;
      process.env.AGY_EFFORT = 'xhigh';
      check('AGY_EFFORT=xhigh no llega como default (ni a /cron)', modeloPorDefecto().effortPorDefecto === null);
      process.env.AGY_EFFORT = 'MAX';
      check('AGY_EFFORT=MAX tampoco', modeloPorDefecto().effortPorDefecto === null);
      process.env.AGY_EFFORT = 'medium';
      check('medium pasa', modeloPorDefecto().effortPorDefecto === 'medium');
    } finally {
      for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  await group('lotes: el defecto es medium', () => {
    const src = fuente('mcp-server/lotes/servicio.js');
    check('sin config, las tareas del lote van en medium', (src.match(/config\.defaultEffort \|\| 'medium'/g) || []).length === 2
      && !/config\.defaultEffort \|\| 'low'/.test(src));
  });

  await group('consola web: los editores de roles no ofrecen xhigh en agy', () => {
    const nucleo = fuente('telegram-bridge/web/public/ui/nucleo.js');
    const m = /export const SOLO_A_PEDIDO_AGY = Object\.freeze\(\[([^\]]*)\]\)/.exec(nucleo);
    const web = m ? m[1].split(',').map((x) => x.trim().replace(/'/g, '')) : [];
    check('la lista de la web coincide con la del servidor', web.join(',') === niveles.SOLO_A_PEDIDO.join(','), web);
    for (const f of ['panel.js', 'vista-ajustes.js']) {
      const src = fuente(`telegram-bridge/web/public/ui/${f}`);
      check(`${f} filtra los niveles con SOLO_A_PEDIDO_AGY`, /niveles\.filter\(\(n\) => [^)]*'antigravity' \|\| !SOLO_A_PEDIDO_AGY\.includes\(n\)\)/.test(src));
    }
  });

  await group('política en index.js', () => {
    const src = fuente('mcp-server/index.js');
    check('agy_audit pide high por defecto', /resolverLanzamientoAgy\(args, config, \{ esfuerzoPorDefecto: ESFUERZO_AUDITORIA \}\)/.test(src)
      && /const ESFUERZO_AUDITORIA = 'high';/.test(src));
    check('solo agy_audit lo pide', (src.match(/esfuerzoPorDefecto: ESFUERZO_AUDITORIA/g) || []).length === 1);
    check('el resumen largo va en Hydrogen medium', /const MODELO_RESUMEN_LARGO = MODELO_GEMINI;/.test(src)
      && /const ESFUERZO_RESUMEN_LARGO = 'medium';/.test(src) && /args\.effort \|\| ESFUERZO_RESUMEN_LARGO/.test(src));
    check('sin literales de 3.8 en el servidor', !/'gemini-3\.8-flash'/.test(src));
  });
}

main().then(report).catch((err) => { console.error(err); process.exit(1); });
