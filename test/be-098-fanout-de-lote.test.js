/**
 * BE-098 — Un lote confinado escribe el estado de fan-out (statusline y
 * detención) y el tablero lo pintaba dos veces: como lote y como un fan-out
 * «desde Claude Code» en `ok` antes de la prueba y la auditoría.
 *
 * Sin DOM, como test/be-063.test.js: la función que decide se evalúa sacada de
 * la fuente, y el cableado se revisa en la fuente.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const desde = appJs.indexOf('  function esFanoutDeLote(');
const trozo = appJs.slice(desde, appJs.indexOf('\n  }\n', desde) + 4);
const esFanoutDeLote = new Function(`${trozo}; return esFanoutDeLote;`)();

group('esFanoutDeLote', () => {
  const lote = { id: 'web-abc', workspace: { id: '7' } };
  check('mismo slug y workspace → es del lote', esFanoutDeLote({ slug: 'web-abc', workspace: { id: '7' } }, [lote]));
  check('workspace numérico contra texto → igual', esFanoutDeLote({ slug: 'web-abc', workspace: { id: 7 } }, [lote]));
  check('mismo slug en otro workspace → no', !esFanoutDeLote({ slug: 'web-abc', workspace: { id: '8' } }, [lote]));
  check('otro slug → no', !esFanoutDeLote({ slug: 'fanout-normal', workspace: { id: '7' } }, [lote]));
  check('sin lotes confinados → no', !esFanoutDeLote({ slug: 'web-abc', workspace: { id: '7' } }, []));
});

group('cableado en app.js', () => {
  check('lotesDeTablero descarta los fan-out de un lote',
    /const lotesDeTablero = \(\) => [^;]*\.filter\(\(f\) => !esFanoutDeLote\(f, lotesConfinados\(\)\)\)/.test(appJs));
  const detalleLote = appJs.slice(appJs.indexOf('  function pintarDetalleLote('), appJs.indexOf('  function pintarDetalleLoteConfinado('));
  check('un f: de un lote abre el detalle del lote (sin redirigir mientras carga)',
    detalleLote.includes("abrirDetalle(`c:${partes[2]}`)") && detalleLote.includes('estado.lotes === null'));
  const confinado = appJs.slice(appJs.indexOf('  function pintarDetalleLoteConfinado('));
  check('el detalle del lote tiene Detener, de dos pasos y solo mientras escribe',
    /if \(l\.estado === 'corriendo' && st\.estado === 'corriendo'\) \{[\s\S]{0,400}dosPasos\(detener[\s\S]{0,120}detenerSubtarea\(\{ workspace: l\.workspace, slug: l\.id \}, st\)/.test(confinado));
  check('un fan-out normal sigue diciendo de dónde salió y con su Detener',
    detalleLote.includes("fila('Origen', 'fan-out lanzado desde Claude Code')") && detalleLote.includes("dosPasos(detener, '¿Detener? Clic de nuevo', () => detenerSubtarea(l, st))"));
});

report();
