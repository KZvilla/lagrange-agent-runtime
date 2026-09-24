/**
 * SEC-020 fase 2 — El matcher de `deny_paths`: en el modo contenedor es lo que
 * decide qué archivos NO entran a la instantánea que lee el agente.
 */
const { check, group, report } = require('./lib/assert');
const { crearMatcher } = require('../mcp-server/lib/glob-rutas.js');

async function main() {
  await group('los defaults de la política', () => {
    const m = crearMatcher(['.env*', '**/*.key', '**/*.pem'], { insensible: false });
    check('.env en la raíz', m('.env'));
    check('.env.local en un subdirectorio (patrón sin / = por nombre)', m('app/config/.env.local'));
    check('**/*.key en la raíz', m('server.key'));
    check('**/*.key en profundidad', m('a/b/c/server.key'));
    check('**/*.pem', m('certs/ca.pem'));
    check('no tapa lo que no coincide', !m('src/index.js') && !m('docs/env.md') && !m('keys/readme.md'));
    check('.env no tapa un archivo que solo contiene "env"', !m('src/environment.js'));
  });

  await group('semántica de los comodines', () => {
    const m = crearMatcher(['secrets/*.json', '/raiz.txt', 'a/**/z.txt', 'x?.log'], { insensible: false });
    check('* no cruza directorios', m('secrets/a.json') && !m('secrets/sub/a.json'));
    check('/ inicial ancla a la raíz', m('raiz.txt') && !m('sub/raiz.txt'));
    check('**/ = cero o más directorios', m('a/z.txt') && m('a/b/c/z.txt') && !m('b/z.txt'));
    check('? es un carácter', m('x1.log') && !m('x12.log'));
    const lit = crearMatcher(['a+b(c).txt'], { insensible: false });
    check('los metacaracteres de regex son literales', lit('a+b(c).txt') && !lit('aab(c).txt'));
  });

  await group('bordes', () => {
    check('sin patrones no coincide nada', !crearMatcher([])('.env') && !crearMatcher(undefined)('.env'));
    check('patrones vacíos se ignoran', !crearMatcher(['', '   '])('x'));
    check('barras de Windows en la ruta', crearMatcher(['**/*.key'], { insensible: false })('a\\b\\c.key'));
    check('mayúsculas: insensible donde se pide', crearMatcher(['.ENV*'], { insensible: true })('.env.local'));
    check('mayúsculas: sensible donde se pide', !crearMatcher(['.ENV*'], { insensible: false })('.env.local'));
    check('ruta vacía no coincide', !crearMatcher(['*'])(''));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
