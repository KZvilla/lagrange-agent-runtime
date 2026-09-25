/**
 * BE-041 — `nivelesPara(motor, modelo)`, la fuente única de esfuerzos por
 * modelo, y sus tres consumidores: `esfuerzoParaCli` (agy), el motor `claude`
 * y `validarRoles` (normaliza al cargar, rechaza al escribir).
 *
 * Hechos: `agy models` 1.2.9 (Flash low/medium/high, Pro low/high; un Gemini
 * corto sin `--effort` aborta) y la doc de Claude Code (Haiku 4.5 sin
 * esfuerzo; Opus/Sonnet 4.6 sin xhigh).
 */
const { check, group, report } = require('./lib/assert');
const { nivelesPara, admiteNivel, modeloBloqueado } = require('../mcp-server/motores/niveles.js');
const compat = require('../mcp-server/lib/cli-compat.js');
const roles = require('../mcp-server/motores/roles.js');
const agy = require('../mcp-server/motores/antigravity.js');
const claude = require('../mcp-server/motores/claude.js');

const lista = (n) => n.niveles.join(',');

async function main() {
  await group('la tabla: antigravity', () => {
    check('Flash corto: low,medium,high, implícito medium', lista(nivelesPara('antigravity', 'gemini-3.8-flash')) === 'low,medium,high' && nivelesPara('antigravity', 'gemini-3.8-flash').implicito === 'medium');
    check('Pro corto: low,high, implícito low', lista(nivelesPara('antigravity', 'gemini-3.1-pro')) === 'low,high' && nivelesPara('antigravity', 'gemini-3.1-pro').implicito === 'low');
    for (const m of [null, '', 'gemini-3.8-flash-high', 'gemini-3.1-pro-low', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium', 'mistral-large']) {
      check(`no admite: ${m || '(sin modelo)'}`, nivelesPara('antigravity', m).admite === false);
    }
    check('sin distinguir mayúsculas', nivelesPara('antigravity', 'Gemini-3.8-Flash').admite && admiteNivel('antigravity', 'gemini-3.8-flash', 'HIGH'));
  });

  await group('la tabla: claude', () => {
    check('Haiku no admite esfuerzo', !nivelesPara('claude', 'claude-haiku-4-5-20251001').admite && !nivelesPara('claude', 'haiku').admite);
    check('Opus/Sonnet 4.6 sin xhigh', lista(nivelesPara('claude', 'claude-opus-4-6')) === 'low,medium,high,max' && lista(nivelesPara('claude', 'claude-sonnet-4-6')) === 'low,medium,high,max');
    check('alias y 5.x: low..max', lista(nivelesPara('claude', 'sonnet')) === 'low,medium,high,xhigh,max' && nivelesPara('claude', 'claude-opus-5-5').conocido);
    check('implícito null: rige el default del modelo', nivelesPara('claude', 'claude-opus-5').implicito === null && nivelesPara('claude', 'sonnet').implicito === null);
    check('desconocido: conjunto completo, no conocido', nivelesPara('claude', 'modelo-raro').admite && nivelesPara('claude', 'modelo-raro').conocido === false);
    check('claude sin modelo: no admite', !nivelesPara('claude', null).admite);
    check('motor desconocido: no admite', !nivelesPara('codex', 'gpt-6').admite);
  });

  await group('esfuerzoParaCli (agy 1.2.9)', () => {
    const e = compat.esfuerzoParaCli;
    check('Flash sin pedido ni defecto → medium', e({ modelo: 'gemini-3.8-flash' }) === 'medium');
    check('Pro sin nada → low', e({ modelo: 'gemini-3.1-pro' }) === 'low');
    check('Pro con defecto medium → low (no aborta)', e({ modelo: 'gemini-3.1-pro', porDefecto: 'medium' }) === 'low');
    check('Flash con defecto high → high', e({ modelo: 'gemini-3.8-flash', porDefecto: 'high' }) === 'high');
    check('sin modelo → null (agy elige, BE-015)', e({ modelo: null, porDefecto: 'high' }) === null);
    check('sufijado y Claude → null', e({ modelo: 'gemini-3.8-flash-high', porDefecto: 'high' }) === null && e({ modelo: 'claude-sonnet-4-6', porDefecto: 'high' }) === null);
    check('pedido explícito intacto (lo valida validarModeloEsfuerzo)', e({ modelo: 'gemini-3.1-pro', pedido: 'medium' }) === 'medium'
      && /low, high/.test(compat.validarModeloEsfuerzo(['--model', 'gemini-3.1-pro', '--effort', 'medium'])));
  });

  await group('motores', () => {
    const argv = agy.armar({ perfil: 'lectura', cast: 'lector', prompt: 'x', modelo: 'gemini-3.8-flash', formato: 'json' });
    check('cast de agy con Flash y sin esfuerzo: --effort medium', argv[argv.indexOf('--effort') + 1] === 'medium');
    check('claude.esfuerzo con Haiku → null', claude.esfuerzo({ modelo: 'claude-haiku-4-5-20251001', pedido: 'low' }) === null);
    check('claude.esfuerzo con Sonnet → el pedido', claude.esfuerzo({ modelo: 'sonnet', pedido: 'MEDIUM' }) === 'medium');
    check('claude.esfuerzo cae al defecto si el pedido no aplica', claude.esfuerzo({ modelo: 'claude-opus-4-6', pedido: 'xhigh', porDefecto: 'high' }) === 'high');
  });

  await group('validarRoles: normaliza al cargar, rechaza al escribir', () => {
    const entrada = {
      alma: { motor: 'claude', modelo: 'claude-haiku-4-5-20251001', esfuerzo: 'low' },
      consolidar: { motor: 'antigravity', modelo: 'gemini-3.1-pro', esfuerzo: 'medium' },
      cast: { motor: 'antigravity', esfuerzo: 'medium' }
    };
    const carga = roles.validarRoles(entrada);
    check('la carga no descarta la sección', carga.ok);
    check('Haiku queda sin esfuerzo', carga.roles.alma.esfuerzo === null);
    check('Pro+medium queda en low', carga.roles.consolidar.esfuerzo === 'low');
    check('agy sin modelo: pasa tal cual', carga.roles.cast.esfuerzo === 'medium');
    check('con un aviso por cada normalización', carga.avisos.length === 2 && carga.avisos.every(a => /se usa/.test(a)));
    const escritura = roles.validarRoles(entrada, { estricto: true });
    check('la escritura rechaza con el motivo', !escritura.ok && /no admite esfuerzo/.test(escritura.motivo));
    check('estricto con Pro+medium también rechaza', /admite: low, high/.test(roles.validarRoles({ consolidar: entrada.consolidar }, { estricto: true }).motivo));
    check('un nivel inexistente sigue invalidando', !roles.validarRoles({ alma: { motor: 'claude', modelo: 'sonnet', esfuerzo: 'turbo' } }).ok);
  });

  await group('BE-045: Fable fuera, implícito de Opus 5.5, Sonnet 4.5 sin esfuerzo', () => {
    for (const m of ['fable', 'FABLE', 'fable[1m]', 'best', 'claude-fable-5-1', 'claude-fable-5']) {
      check(`bloquea ${m}`, /créditos/.test(modeloBloqueado('claude', m) || ''));
    }
    for (const m of ['opus', 'sonnet', 'claude-opus-5-5', 'haiku', 'fabled-model-x', 'bestia', null]) {
      check(`no bloquea ${m}`, modeloBloqueado('claude', m) === null);
    }
    check('en antigravity no bloquea nada', modeloBloqueado('antigravity', 'fable') === null);
    check('Fable no ofrece esfuerzo', !nivelesPara('claude', 'fable').admite && !nivelesPara('claude', 'claude-fable-5-1').admite);
    for (const m of ['opus', 'opus[1m]', 'claude-opus-5-5', 'OPUS']) {
      check(`${m}: implícito medium, conjunto completo`, nivelesPara('claude', m).implicito === 'medium' && lista(nivelesPara('claude', m)) === 'low,medium,high,xhigh,max');
    }
    for (const m of ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest']) {
      check(`${m}: no admite esfuerzo`, !nivelesPara('claude', m).admite);
    }
    check('Sonnet 4.6 sigue sin xhigh', lista(nivelesPara('claude', 'claude-sonnet-4-6')) === 'low,medium,high,max');
    check('Opus 4.5 no se toca', lista(nivelesPara('claude', 'claude-opus-4-5')) === 'low,medium,high,xhigh,max');
    for (const modelo of ['fable', 'best', 'claude-fable-5-1']) {
      const carga = roles.validarRoles({ alma: { motor: 'claude', modelo } });
      const escritura = roles.validarRoles({ alma: { motor: 'claude', modelo } }, { estricto: true });
      check(`validarRoles rechaza ${modelo} al cargar y al escribir`, !carga.ok && !escritura.ok && /créditos/.test(carga.motivo) && /créditos/.test(escritura.motivo));
    }
    let lanzo = null;
    try { claude.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'claude-fable-5-1', aislado: true }, { env: {} }); } catch (err) { lanzo = err; }
    check('armar con Fable lanza', lanzo && /créditos/.test(lanzo.message));
    check('armar con sonnet no lanza', Array.isArray(claude.armar({ perfil: 'sin-tools', prompt: 'x', modelo: 'sonnet', aislado: true }, { env: {} }).argv));
    check('el implícito no se manda: opus sin pedido sigue sin --effort', claude.esfuerzo({ modelo: 'opus', pedido: null }) === null);
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
