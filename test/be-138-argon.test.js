/**
 * BE-138 — Gemini 4 Argon (agy 1.3.6): su grupo de cuota propio, solo semanal y opcional (en Ultra no viene), el
 * grupo de sus ids, el catálogo y el esfuerzo. El JSON es el medido el 2026-10-16; nunca abre el agy real.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const cuota = require('../mcp-server/lib/cuota-agy.js');
const { grupoDeCuota } = require('../mcp-server/motores/antigravity.js');
const { nivelesPara, catalogo } = require('../mcp-server/motores/niveles.js');
const { validarModeloEsfuerzo, esfuerzoParaCli } = require('../mcp-server/lib/cli-compat.js');

const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cuota-usage', 'usage.json'), 'utf8'));
const ARGON = {
  name: 'Gemini 4 Argon',
  description: 'For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.',
  buckets: [{ id: 'gemini-argon-wtu-weekly', name: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remaining_fraction: 0.99, reset_time: '2026-10-23T04:24:01Z' }]
};
const conArgon = (argon = ARGON) => {
  const o = JSON.parse(JSON.stringify(BASE));
  o.command.data.groups.push(JSON.parse(JSON.stringify(argon)));
  return o;
};

group('parsearUsageJson con el grupo de Argon (plan Pro)', () => {
  const p = cuota.parsearUsageJson(conArgon());
  check('ok', p.ok === true, p.motivo);
  check('sin desconocidos', p.ok && p.desconocidos.length === 0, p.desconocidos);
  check('argon semanal 0.99', p.ok && p.grupos.argon.semanal.restante === 0.99);
  check('argon sin 5 h', p.ok && p.grupos.argon.cinco_horas === null);
  check('gemini sigue con sus dos ventanas', p.ok && p.grupos.gemini.semanal && p.grupos.gemini.cinco_horas);
});

group('sin Argon (Ultra o agy viejo) sigue andando', () => {
  const p = cuota.parsearUsageJson(BASE);
  check('ok', p.ok === true, p.motivo);
  check('sin grupo argon', p.ok && !('argon' in p.grupos));
});

group('lo que sigue siendo obligatorio', () => {
  const sinSemanal = cuota.parsearUsageJson(conArgon({ ...ARGON, buckets: [] }));
  check('Argon sin semanal falla', !sinSemanal.ok && /argon: falta la ventana semanal/.test(sinSemanal.motivo), sinSemanal.motivo);
  const o = conArgon();
  o.command.data.groups = o.command.data.groups.filter((g) => g.name !== 'Claude and GPT models');
  const sinClaude = cuota.parsearUsageJson(o);
  check('sin Claude/GPT falla', !sinClaude.ok && /falta el grupo claude_gpt/.test(sinClaude.motivo), sinClaude.motivo);
  const o2 = conArgon();
  o2.command.data.groups[0].buckets = o2.command.data.groups[0].buckets.filter((b) => b.window !== '5h');
  const sin5h = cuota.parsearUsageJson(o2);
  check('Gemini sin 5 h falla', !sin5h.ok && /gemini: falta la ventana cinco_horas/.test(sin5h.motivo), sin5h.motivo);
});

group('cuotaDesdeUsage con un grupo solo semanal', () => {
  let c = null;
  let error = null;
  try { c = cuota.cuotaDesdeUsage(cuota.parsearUsageJson(conArgon()), { fuente: 'usage-json', vistoEn: new Date('2026-10-16T04:30:00Z') }); } catch (e) { error = e; }
  check('no lanza', !error, error && error.message);
  check('ventana_7d 0.01', c && c.grupos.argon.ventana_7d === 0.01);
  check('ventana_5h y resetea_5h null', c && c.grupos.argon.ventana_5h === null && c.grupos.argon.resetea_5h === null);
  check('resetea_7d del JSON', c && c.grupos.argon.resetea_7d === '2026-10-23T04:24:01.000Z', c && c.grupos.argon.resetea_7d);
});

group('parsearUsage (pantalla) con el bloque de Argon', () => {
  const PANTALLA = fs.readFileSync(path.join(__dirname, 'fixtures', 'cuota-usage', 'pantalla.txt'), 'utf8');
  const texto = `${PANTALLA.replace(/\s*$/, '')}\nGEMINI 4 ARGON\nGemini 4 Argon Weekly Limit\n████████████ 99%\nRefreshes in 167h 30m\n`;
  const p = cuota.parsearUsage(texto);
  check('ok', p.ok === true, p.motivo);
  check('argon semanal 0.99', p.ok && p.grupos.argon && p.grupos.argon.semanal.restante === 0.99);
  check('sin desconocidos', p.ok && p.desconocidos.length === 0, p.ok && p.desconocidos);
  check('la pantalla de siempre sigue ok', cuota.parsearUsage(PANTALLA).ok === true);
  const conModels = cuota.parsearUsage(texto.replace(/^GEMINI 4 ARGON$/m, 'GEMINI 4 ARGON MODELS'));
  check('también con el encabezado «GEMINI 4 ARGON MODELS»', conModels.ok && conModels.grupos.argon && conModels.grupos.argon.semanal.restante === 0.99, conModels.motivo);
});

group('grupoDeCuota', () => {
  for (const m of ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon']) {
    check(`${m} → argon`, grupoDeCuota({ modelo: m }) === 'argon');
  }
  check('Flash sigue en gemini', grupoDeCuota({ modelo: 'gemini-3.8-flash' }) === 'gemini');
  check('Sonnet sigue en claude_gpt', grupoDeCuota({ modelo: 'claude-sonnet-5-5-medium' }) === 'claude_gpt');
});

group('sin bloqueo cruzado entre Flash y Argon', () => {
  const ahora = Date.parse('2026-10-16T05:00:00Z');
  const futuro = new Date(ahora + 40 * 60000).toISOString();
  const leer = (grupos) => () => ({ cuota: { antigravity: { visto_en: new Date(ahora - 60000).toISOString(), grupos } } });
  const libre = { ventana_5h: 0.1, ventana_7d: 0.1, resetea_5h: futuro, resetea_7d: futuro };
  const flashAgotado = leer({ gemini: { ...libre, ventana_5h: 1 }, claude_gpt: libre, argon: { ventana_5h: null, ventana_7d: 0.01, resetea_5h: null, resetea_7d: futuro } });
  check('Flash agotado no frena Argon', cuota.cuotaDeModelo('gemini-4-argon-high', { ahora, leer: flashAgotado }).agotada === false);
  check('Flash agotado frena Flash', cuota.cuotaDeModelo('gemini-3.8-flash', { ahora, leer: flashAgotado }).agotada === true);
  const argonAgotado = leer({ gemini: libre, claude_gpt: libre, argon: { ventana_5h: null, ventana_7d: 1, resetea_5h: null, resetea_7d: futuro } });
  const r = cuota.cuotaDeModelo('gemini-4-argon-low', { ahora, leer: argonAgotado });
  check('Argon agotado frena Argon, por la semanal', r.grupo === 'argon' && r.agotada === true && r.ventana === 'semanal', r);
  check('Argon agotado no frena Flash', cuota.cuotaDeModelo('gemini-3.8-flash', { ahora, leer: argonAgotado }).agotada === false);
  const vieja = leer({ gemini: libre, claude_gpt: libre });
  check('cuota guardada sin argon: no agotado', cuota.cuotaDeModelo('gemini-4-argon-medium', { ahora, leer: vieja }).agotada === false);
  check('estado desconocido trae argon', cuota.estadoCuotaAgy({ ahora, leer: () => null }).grupos.argon.agotada === false);
});

group('restanteDeGrupo', () => {
  const ahora = Date.parse('2026-10-16T05:00:00Z');
  const leer = () => ({ cuota: { antigravity: { visto_en: new Date(ahora - 60000).toISOString(), grupos: {
    argon: { ventana_5h: null, ventana_7d: 0.01 }, claude_gpt: { ventana_5h: null, ventana_7d: 0.5 } } } } });
  const a = cuota.restanteDeGrupo('argon', { ahora, leer });
  check('argon: 5 h null, semanal 0.99', a && a.restante_5h === null && a.restante_7d === 0.99, a);
  check('claude_gpt sin 5 h sigue siendo null', cuota.restanteDeGrupo('claude_gpt', { ahora, leer }) === null);
});

group('catálogo y esfuerzo', () => {
  const agy = catalogo().find((x) => x.motor === 'antigravity').modelos.map((x) => x.modelo);
  check('Flash sigue primero después de null', agy[0] === null && agy[1] === 'gemini-3.8-flash', agy.slice(0, 3));
  for (const m of ['gemini-4-argon-medium', 'gemini-4-argon-low', 'gemini-4-argon-high']) {
    check(`${m} en el catálogo, sin esfuerzo`, agy.includes(m) && nivelesPara('antigravity', m).admite === false);
  }
  check('gemini-4-argon corto no admite esfuerzo', nivelesPara('antigravity', 'gemini-4-argon').admite === false);
  check('al corto no se le agrega el esfuerzo por defecto', esfuerzoParaCli({ modelo: 'gemini-4-argon', porDefecto: 'high' }) === null);
  check('sufijado + effort se rechaza', /ya fija el esfuerzo/.test(validarModeloEsfuerzo(['--model', 'gemini-4-argon-high', '--effort', 'high']) || ''));
  check('corto + effort se rechaza', /no admite effort/.test(validarModeloEsfuerzo(['--model', 'gemini-4-argon', '--effort', 'low']) || ''));
  check('Flash + effort sigue valiendo', validarModeloEsfuerzo(['--model', 'gemini-3.8-flash', '--effort', 'high']) === null);
});

group('presentación sin una 5 h inventada', () => {
  const raiz = path.join(__dirname, '..');
  const leerFuente = (p) => fs.readFileSync(path.join(raiz, p), 'utf8');
  check('agy_usage nombra Gemini 4 Argon', /argon: 'Gemini 4 Argon'/.test(leerFuente('mcp-server/index.js')));
  check('agy_usage solo escribe 5-hour si hay dato', /if \(Number\.isFinite\(v\.ventana_5h\)\) out \+= `  - 5-hour/.test(leerFuente('mcp-server/index.js')));
  check('getModelSpecs no le da a Argon la ventana de Flash', /m\.includes\('argon'\)[\s\S]{0,80}contextWindow: null/.test(leerFuente('mcp-server/index.js')));
  check('Proveedores omite la 5 h sin dato', /Number\.isFinite\(v\.ventana5h\) \? ` · \$\{resto\(v\.ventana5h\)\} 5 h` : ''/.test(leerFuente('telegram-bridge/web/public/ui/vista-proveedores.js')));
});

report();
