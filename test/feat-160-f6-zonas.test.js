/**
 * FEAT-160 F6 — El detalle reparte sus bloques en zonas según el caso. Los
 * bloques y sus condiciones son los de siempre: acá se verifica que cada uno
 * cae en exactamente una zona y que el CSS define las tres plantillas.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const vista = fs.readFileSync(path.join(PUBLICO, 'ui', 'vista-tablero.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(PUBLICO, 'app.css'), 'utf8').replace(/\r\n/g, '\n');
const corte = (desde, hasta) => vista.slice(vista.indexOf(desde), vista.indexOf(hasta, vista.indexOf(desde)));

(async () => {
  await group('DetalleTarea: cada bloque en una zona', () => {
    const det = corte('function DetalleTarea(', 'function DetalleFanout(');
    const reparto = det.slice(det.indexOf('<div class=${`detalle-cuerpo ${zonas}'), det.indexOf('<div class="detalle-pie">'));
    const enRama = (rama) => (b) => (rama.match(new RegExp(`\\$\\{${b}\\}`, 'g')) || []).length;
    const [hacer, resto] = reparto.split('\n        : ');
    const BLOQUES = ['bEdicion', 'bDatos', 'bPedido', 'bPartir', 'bFamilia', 'bActividad', 'bResultado', 'bNotas', 'bHistorial'];
    check('los nueve bloques de siempre se arman una vez', BLOQUES.every((b) => (det.match(new RegExp(`const ${b} = `, 'g')) || []).length === 1));
    const enHacer = ['bEdicion', 'bPartir', 'bFamilia', 'bNotas', 'bHistorial'];
    check('Por hacer: edición, partir, familia, notas e historial, una vez cada uno', enHacer.every((b) => enRama(hacer)(b) === 1), hacer);
    const enResto = ['bDatos', 'bPedido', 'bActividad', 'bResultado', 'bFamilia', 'bNotas', 'bHistorial'];
    check('El resto: datos, pedido, actividad, resultado, familia, notas e historial, una vez cada uno', enResto.every((b) => enRama(resto)(b) === 1), resto);
    check('la edición ancha en Por hacer; el foco solo si hay actividad o resultado', det.includes("const zonas = porHacer || !foco ? 'zonas-2-lateral' : 'zonas-3';")
      && det.includes('const foco = Boolean(bActividad || bResultado);'));
    check('las condiciones de los bloques no cambiaron', det.includes('const bPartir = porHacer && !t.propuesta ?') && det.includes('const bFamilia = familia ?')
      && det.includes('const bActividad = conActividad ?') && det.includes('const bHistorial = eventos.length ?'));
    // Auditoría (MINOR) — Las condiciones de los otros cinco bloques y los `key` que conservan el estado de la edición.
    check('edición, datos, pedido, resultado y notas: condiciones de siempre', det.includes('const bEdicion = porHacer ? html`<${EdicionPorHacer}')
      && det.includes('const bDatos = porHacer ? null :') && det.includes('const bPedido = porHacer ? null :')
      && det.includes('const bResultado = resultado ?') && det.includes('const bNotas = html`'));
    check('los formularios conservan su key', ['<${EdicionPorHacer} key=${t.id}', '<${FormularioPartir} key=${`p-${t.id}`}', '<${FormularioLote} key=${`l-${t.id}`}', '<${CompositorNota} key=${`n-${t.id}`}'].every((k) => det.includes(k)));
    check('Zona se declara fuera del componente (si no, Preact desmontaría sus hijos en cada render)', /\nconst Zona = \(\{ children \}\) => /.test(vista) && vista.indexOf('const Zona =') < vista.indexOf('function DetalleTarea('));
    check('el tono del alma sigue en el cuerpo', reparto.includes("${t.sujeto?.tipo === 'alma' ? tono(t.sujeto.clave) : ''}"));
    check('las acciones siguen al pie', det.includes('<div class="detalle-pie"><${AccionesDeDetalle} t=${t} /></div>'));
  });

  await group('Fan-out y lote confinado', () => {
    const fan = corte('function DetalleFanout(', 'function DetalleLoteConfinado(');
    check('fan-out: datos a la izquierda, subtareas en la zona ancha', fan.includes('<div class="detalle-cuerpo zonas-2"><div class="zona">') && /<div class="zona"><div class="detalle-bloque"><\$\{Titulo\}>Subtareas/.test(fan));
    const conf = corte('function DetalleLoteConfinado(', 'function Detalle()');
    check('confinado: datos, Pipelines y avisos a la izquierda; los workers lado a lado', conf.includes('<div class="detalle-cuerpo zonas-2"><div class="zona">')
      && conf.includes('Ver en Pipelines') && conf.includes('<div class="lote-workers">${l.tareas.map((st) => html`<section key=${st.id} class="lote-tarea">'));
    check('integrar y descartar siguen al pie', conf.includes('<div class="detalle-pie">') && conf.includes('texto="Descartar batch"'));
  });

  await group('CSS', () => {
    check('tres plantillas', css.includes('.detalle-cuerpo.zonas-3 { grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr) minmax(240px, 1fr); }')
      && css.includes('.detalle-cuerpo.zonas-2 { grid-template-columns: minmax(240px, 1fr) minmax(0, 3fr); }')
      && css.includes('.detalle-cuerpo.zonas-2-lateral { grid-template-columns: minmax(0, 2fr) minmax(240px, 1fr); }'));
    check('un solo scroll: las zonas no scrollean solas', !/\.zona \{[^}]*overflow/.test(css) && css.includes('.detalle-cuerpo { flex: 1; min-height: 0; overflow-y: auto;'));
    check('mosaicos de 280 px que hacen wrap', css.includes('repeat(auto-fill, minmax(280px, 1fr))') && /\.zonas-2 \.subtarea \{ flex-wrap: wrap;/.test(css));
    check('workers de 300 px con scroll horizontal', css.includes('.lote-workers { display: flex; gap: 12px; overflow-x: auto;') && css.includes('.lote-workers > .lote-tarea { flex: 0 0 300px;'));
    const tel = css.slice(css.indexOf('@media (max-width: 800px), (max-height: 500px) and (orientation: landscape)'));
    check('en la hoja, una columna y los workers apilados', tel.includes('.detalle-cuerpo.zonas-3, .detalle-cuerpo.zonas-2, .detalle-cuerpo.zonas-2-lateral { grid-template-columns: minmax(0, 1fr); }')
      && tel.includes('.lote-workers { flex-direction: column;'));
    const medio = css.slice(css.indexOf('@media (max-width: 1100px) {\n  .detalle-cuerpo.zonas-3'));
    check('entre 801 y 1100, el lateral baja debajo del contexto', medio.startsWith('@media (max-width: 1100px) {\n  .detalle-cuerpo.zonas-3 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }'));
  });

  await group('Las explicaciones van detrás de un ⓘ', () => {
    const ayuda = fs.readFileSync(path.join(PUBLICO, 'ui', 'ayuda.js'), 'utf8');
    check('el ⓘ es un botón con globo accesible, sin title', /aria-describedby=\$\{id\}/.test(ayuda) && /role="tooltip"/.test(ayuda) && !/title=/.test(ayuda.replace(/^\s*\*.*$/gm, '')));
    check('Esc cierra el globo fijado', ayuda.includes("ev.key === 'Escape' && fijo"));
    const sueltos = ['Un alma no usa proyecto.', 'propone de 2 a 6 tarjetas hijas', 'Crea ramas y worktrees.', 'nadie las lee como instrucción', 'Detener deja un pedido', 'evidencia consultiva'];
    check('ninguna explicación queda como texto suelto', sueltos.every((x) => vista.split(x).length - 1 === (vista.match(new RegExp(`texto=[^>]*${x.replace(/[.()]/g, '\$&')}`, 'g')) || []).length), 'algún texto sigue fuera de <Ayuda>');
    // FEAT-160 F3 — La octava: «Lo mueve el ejecutor».
    check('las ocho explicaciones tienen su ⓘ', (vista.match(/<\$\{Ayuda\} etiqueta=/g) || []).length === 8);
    check('el globo se abre con hover, foco o toque', css.includes('.ayuda:hover .ayuda-globo, .ayuda:focus-within .ayuda-globo, .ayuda.abierta .ayuda-globo { display: block; }'));
  });

  report();
})();
