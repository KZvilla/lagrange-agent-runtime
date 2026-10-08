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

// FEAT-136 F3 — El tablero vive en ui/vista-tablero.js (módulo con DOM): la función se evalúa sacada de la
// fuente (es una línea) y el cableado se revisa ahí.
const appJs = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui', 'vista-tablero.js'), 'utf8').replace(/\r\n/g, '\n');
const linea = appJs.split('\n').find((l) => l.startsWith('export const esFanoutDeLote = '));
const esFanoutDeLote = new Function(`return ${linea.replace('export const esFanoutDeLote = ', '').replace(/;$/, '')};`)();

group('esFanoutDeLote', () => {
  const lote = { id: 'web-abc', workspace: { id: '7' } };
  check('mismo slug y workspace → es del lote', esFanoutDeLote({ slug: 'web-abc', workspace: { id: '7' } }, [lote]));
  check('workspace numérico contra texto → igual', esFanoutDeLote({ slug: 'web-abc', workspace: { id: 7 } }, [lote]));
  check('mismo slug en otro workspace → no', !esFanoutDeLote({ slug: 'web-abc', workspace: { id: '8' } }, [lote]));
  check('otro slug → no', !esFanoutDeLote({ slug: 'fanout-normal', workspace: { id: '7' } }, [lote]));
  check('sin lotes confinados → no', !esFanoutDeLote({ slug: 'web-abc', workspace: { id: '7' } }, []));
});

group('cableado en ui/vista-tablero.js', () => {
  check('lotesDeTablero descarta los fan-out de un lote',
    /const lotesDeTablero = \(\) => [^;]*\.filter\(\(f\) => !esFanoutDeLote\(f, lotesConfinados\(\)\)\)/.test(appJs));
  const detalleLote = appJs.slice(appJs.indexOf('function DetalleFanout('), appJs.indexOf('function VerDiff('));
  check('un f: de un lote abre el detalle del lote (sin redirigir mientras carga)',
    detalleLote.includes("abrirDetalle(`c:${partes[2]}`)") && detalleLote.includes('lotes.value === null'));
  const confinado = appJs.slice(appJs.indexOf('function DetalleLoteConfinado('), appJs.indexOf('function Detalle()'));
  check('el detalle del lote tiene Detener, de dos pasos y solo mientras escribe',
    /l\.estado === 'corriendo' && st\.estado === 'corriendo'[\s\S]{0,300}BotonDosPasos[^\n]*texto="Detener"[^\n]*detenerSubtarea\(\{ workspace: l\.workspace, slug: l\.id \}, st\)/.test(confinado));
  check('un fan-out normal sigue diciendo de dónde salió y con su Detener',
    detalleLote.includes('fan-out lanzado desde Claude Code') && /texto="Detener" armado="¿Detener\? Clic de nuevo" alConfirmar=\$\{\(\) => detenerSubtarea\(l, st\)\}/.test(detalleLote));
});

report();
