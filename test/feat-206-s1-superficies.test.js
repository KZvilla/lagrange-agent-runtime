/**
 * FEAT-206 S1 — Las superficies del respaldo agnóstico: el schema de `set_config`, la escritura estricta (el mapa
 * entero contra los roles que quedan, también cuando cambia un rol), la proyección v2 y el destino global de la consola.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');
const configMotores = require(path.join(MCP, 'motores', 'config-motores.js'));
const { motoresV2 } = require(path.join(MCP, 'motores', 'proyeccion.js'));
const fuente = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

async function main() {
  await group('set_config: el schema y los textos', () => {
    const src = fuente('mcp-server/index.js');
    const patrones = src.match(/pattern: '\^\(claude@\[a-z0-9\]\[a-z0-9-\]\{0,31\}\|deepseek\|opencode-go\|antigravity\)\$'/g) || [];
    check('fallback_agy y fallback_agy_roles aceptan antigravity', patrones.length === 2, String(patrones.length));
    const re = new RegExp(patrones[0] ? '^(claude@[a-z0-9][a-z0-9-]{0,31}|deepseek|opencode-go|antigravity)$' : '^$');
    check('el patrón acepta antigravity y rechaza agy', re.test('antigravity') && !re.test('agy'));
    check('la descripción ya no dice que un rol fijo nunca cae', !/Roles with a fixed engine in motores\.roles never fall back/.test(src));
    check('la descripción dice que un rol fijo también hereda', /Roles with a fixed engine in motores\.roles inherit it too/.test(src));
    check('una sola frase de alcance: research, run, imagen y voz no tienen respaldo', /research, run, imagen and voz have no fallback/.test(src));
    check('el error de fallback_agy nombra antigravity (texto compartido)', /fallback_agy inválido: tiene que ser \$\{DESTINOS_VALIDOS_TEXTO\}/.test(src));
    check('saveConfig revalida también cuando cambian los roles', /updates\.motores\.roles !== undefined/.test(src) && /estricto: true, roles: \(existing\.motores && existing\.motores\.roles\) \|\| \{\}/.test(src));
    check('Ajustes usa la lista compartida de destinos', /\$\{DESTINOS_VALIDOS_TEXTO\.replace\(/.test(fuente('mcp-server/lib/ajustes.js')));
  });

  await group('la escritura: el mapa entero contra los roles que quedan', () => {
    const datos = {
      motores: { cuentas: { trabajo: { configDir: '/x' } }, roles: {} },
      fallback_agy_roles: { cast: 'claude@trabajo', texto: 'deepseek' }
    };
    const aClaude = configMotores.aplicarRol(datos, 'cast', { motor: 'claude', modelo: 'sonnet' });
    check('pasar cast a claude con respaldo claude@: 400', !aClaude.ok && /fallback_agy_roles/.test(aClaude.motivo) && /claude/.test(aClaude.motivo), aClaude.motivo);
    check('el motivo dice cómo limpiar sin borrar el mapa', /fallback_agy_roles entero/.test(aClaude.motivo || ''));
    const aDs = configMotores.aplicarRol(datos, 'texto', { motor: 'deepseek', modelo: 'deepseek-flash' });
    check('pasar texto a deepseek con respaldo deepseek: 400 (mismo motor)', !aDs.ok && /mismo motor/.test(aDs.motivo), aDs.motivo);
    const aGo = configMotores.aplicarRol(datos, 'texto', { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash' });
    check('pasar texto a Go con respaldo deepseek: pasa', aGo.ok, aGo.motivo);
    const conRol = { motores: { cuentas: {}, roles: { review: { motor: 'deepseek', modelo: 'deepseek-flash' } } } };
    const mismo = configMotores.aplicarRespaldoRol(conRol, 'review', 'deepseek');
    check('respaldo de review en deepseek = su motor: 400', !mismo.ok && /mismo motor/.test(mismo.motivo), mismo.motivo);
    const otro = configMotores.aplicarRespaldoRol(conRol, 'review', 'antigravity');
    check('respaldo de review en antigravity: pasa', otro.ok && otro.datos.fallback_agy_roles.review === 'antigravity', otro.motivo);
    const sinRol = configMotores.aplicarRespaldoRol({ motores: { cuentas: {} } }, 'audit', 'antigravity');
    check('audit sin rol (corre en agy) con respaldo antigravity: 400 (mismo motor)', !sinRol.ok && /mismo motor/.test(sinRol.motivo), sinRol.motivo);
    const viejo = { motores: { cuentas: { trabajo: { configDir: '/x' } }, roles: { cast: { motor: 'claude', modelo: 'sonnet' } } }, fallback_agy_roles: { cast: 'claude@trabajo' } };
    const otroRol = configMotores.aplicarRespaldoRol(viejo, 'texto', 'deepseek');
    check('un mapa preexistente que ya choca se rechaza al tocar otra entrada', !otroRol.ok && /cast/.test(otroRol.motivo), otroRol.motivo);
  });

  await group('la proyección v2', () => {
    const vista = { roles: [
      { rol: 'texto', respaldo: { destino: 'antigravity', origen: 'rol', desde: null, aplica: true, nota: null, limite: false, admite: ['deepseek', 'antigravity'] } },
      { rol: 'alma', respaldo: { destino: 'antigravity', origen: 'defecto', desde: null, aplica: true, nota: null, admite: [] } },
      { rol: 'audit', respaldo: { destino: 'opencode-go', origen: 'rol', desde: null, aplica: true, nota: 'hilo-retomado', limite: true, admite: [] } },
      { rol: 'review', respaldo: { destino: 'deepseek', origen: 'rol', desde: null, aplica: false, nota: 'mismo-motor', admite: [] } },
      { rol: 'plan', respaldo: { destino: null, origen: 'global', desde: null, aplica: false, nota: 'fijo-en-agy', admite: [] } }
    ] };
    const p = motoresV2(vista).roles.map((r) => r.respaldo);
    check('antigravity pasa como destino y como opción', p[0].destino === 'antigravity' && p[0].admite.includes('antigravity'));
    check('el origen defecto pasa', p[1].origen === 'defecto' && p[1].destino === 'antigravity');
    check('limite pasa y por defecto es false', p[2].limite === true && p[0].limite === false && p[1].limite === false);
    check('las notas nuevas pasan', p[3].nota === 'mismo-motor');
    check('una nota vieja ya no pasa', p[4].nota === null);
    const nucleo = fuente('telegram-bridge/web/nucleo.js');
    check('la consola acepta antigravity como destino global', /f === 'deepseek' \|\| f === 'opencode-go' \|\| f === 'antigravity'/.test(nucleo));
  });

  await group('la documentación', () => {
    const wiki = fuente('wiki/Engines-and-Fallback.md');
    check('la wiki explica el respaldo de cualquier motor', /a role's engine cannot answer/.test(wiki) && /"antigravity"/.test(wiki));
    check('la wiki avisa de las versiones mezcladas', /Plugins older than 2\.15\.0 ignore `"antigravity"`/.test(wiki));
    check('la wiki dice que claude no corre audit, review ni plan', /cannot be fixed on claude/.test(wiki));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
