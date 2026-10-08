/**
 * FEAT-138 F1 — Por hacer con orden propio (`posicion`), `moverTarjeta` y la
 * tabla de transiciones del tablero (lo que arrastrar o «Mover a…» dispara).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat-138-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const almacen = require('../mcp-server/agents/almacen.js');
const guardarOriginal = almacen.guardarJson;
let escrituras = 0;
almacen.guardarJson = (...args) => { escrituras++; return guardarOriginal(...args); };

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tareas = await import('../telegram-bridge/tareas.js');
  const columna = () => tareas.listar().filter((t) => t.estado === 'por_hacer').sort(tareas.porPosicion).map((t) => t.titulo);
  const nueva = async (titulo) => { await espera(3); return tareas.crearTarjeta({ titulo, pedido: `Hacer ${titulo}` }).tarea; };

  await group('Migración: las tarjetas de antes quedan en el orden de siempre', () => {
    const vieja = (id, titulo, actualizada, extra = {}) => ({
      id, titulo, pedido: titulo, estado: 'por_hacer', creada: actualizada, actualizada, carril: null, sujeto: null,
      notas: [], eventos: [], actividad: [], ...extra
    });
    fs.writeFileSync(path.join(dir, 'tareas.json'), JSON.stringify({ version: 2, tareas: [
      vieja('t_a', 'Vieja', '2026-10-01T10:00:00.000Z'),
      vieja('t_b', 'Media', '2026-10-02T10:00:00.000Z'),
      vieja('t_c', 'Nueva', '2026-10-03T10:00:00.000Z'),
      { ...vieja('t_d', 'Cerrada', '2026-10-01T09:00:00.000Z'), estado: 'ok', posicion: 4, terminada: '2026-10-01T09:30:00.000Z' }
    ] }));
    tareas.reiniciarParaTests();
    check('la más reciente arriba, como antes', JSON.stringify(columna()) === JSON.stringify(['Nueva', 'Media', 'Vieja']), columna().join(','));
    check('todas tienen posición entera', tareas.listar().filter((t) => t.estado === 'por_hacer').every((t) => Number.isInteger(t.posicion)));
    check('una cerrada no tiene posición', !('posicion' in tareas.obtener('t_d')));
    const enDisco = JSON.parse(fs.readFileSync(path.join(dir, 'tareas.json'), 'utf8')).tareas;
    check('la migración se guardó', enDisco.filter((t) => t.estado === 'por_hacer').every((t) => Number.isInteger(t.posicion)));
  });

  await group('Una tarjeta nueva va arriba sin tocar a las demás', async () => {
    const antes = Object.fromEntries(tareas.listar().map((t) => [t.id, t.posicion]));
    const avisos = [];
    const baja = tareas.suscribir((t) => avisos.push(t.id));
    const n = await nueva('Recién creada');
    baja();
    check('arriba de todo', columna()[0] === 'Recién creada', columna().join(','));
    check('un solo aviso: el de la nueva', avisos.length === 1 && avisos[0] === n.id);
    check('las demás no cambiaron', tareas.listar().filter((t) => t.id !== n.id).every((t) => t.posicion === antes[t.id]));
  });

  await group('moverTarjeta', () => {
    tareas.reiniciarParaTests();
    const porTitulo = (titulo) => tareas.listar().find((t) => t.titulo === titulo);
    const [r, n, m, v] = ['Recién creada', 'Nueva', 'Media', 'Vieja'].map(porTitulo);
    check('orden de partida', JSON.stringify(columna()) === JSON.stringify(['Recién creada', 'Nueva', 'Media', 'Vieja']), columna().join(','));

    const avisos = [];
    const baja = tareas.suscribir((t) => avisos.push(t.id));
    let antes = escrituras;
    let res = tareas.moverTarjeta(r.id, { antes: v.id });
    check('abajo de todo (debajo de la última)', res.ok && JSON.stringify(columna()) === JSON.stringify(['Nueva', 'Media', 'Vieja', 'Recién creada']), columna().join(','));
    check('renumera 1..n', JSON.stringify(tareas.listar().filter((t) => t.estado === 'por_hacer').sort(tareas.porPosicion).map((t) => t.posicion)) === '[1,2,3,4]');
    check('una sola escritura', escrituras - antes === 1);
    check('avisa por cada tarjeta que cambió de lugar', avisos.length === res.movidas && res.movidas > 0);

    res = tareas.moverTarjeta(r.id, { antes: n.id, despues: m.id });
    check('entre dos vecinas', res.ok && JSON.stringify(columna()) === JSON.stringify(['Nueva', 'Recién creada', 'Media', 'Vieja']), columna().join(','));
    res = tareas.moverTarjeta(v.id, {});
    check('sin vecinas: arriba de todo', res.ok && columna()[0] === 'Vieja', columna().join(','));
    avisos.length = 0;
    antes = escrituras;
    res = tareas.moverTarjeta(v.id, { despues: n.id });
    check('a donde ya estaba: sin escritura ni avisos', res.ok && res.movidas === 0 && escrituras === antes && avisos.length === 0);
    baja();

    check('vecinas que ya no están juntas: 409', tareas.moverTarjeta(r.id, { antes: v.id, despues: m.id }).codigo === 409);
    check('vecina inexistente: 409', tareas.moverTarjeta(r.id, { antes: 't_noexiste' }).codigo === 409);
    check('vecina de sí misma: 400', tareas.moverTarjeta(r.id, { antes: r.id }).codigo === 400);
    check('vecina fuera de Por hacer: 409', tareas.moverTarjeta(r.id, { antes: 't_d' }).codigo === 409);
    check('una tarea que no está en Por hacer no se mueve', tareas.moverTarjeta('t_d', {}).ok === false);
    check('no agrega eventos al historial', !tareas.obtener(r.id).eventos.some((e) => e.tipo === 'movida'));
  });

  await group('Al salir de Por hacer, la posición se borra', () => {
    const t = tareas.listar().find((x) => x.titulo === 'Media');
    tareas.editarTarjeta(t.id, { sujeto: { tipo: 'alma', clave: 'alya' } });
    const lanzada = tareas.lanzarTarjeta(t.id, { carril: 'alma', sujeto: { tipo: 'alma', clave: 'alya' } });
    check('se lanzó', lanzada && lanzada.estado === 'en_cola');
    check('sin posicion', !('posicion' in tareas.obtener(t.id)));
    check('el resumen (SSE) tampoco la trae', !('posicion' in tareas.resumen(tareas.obtener(t.id))));
  });

  await group('La ruta y su nivel', () => {
    const servidor = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'servidor.js'), 'utf8');
    const nucleo = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'nucleo.js'), 'utf8');
    check('POST /api/tarjetas/:id/mover es una mutación', /patron: new RegExp\(`\^\/api\/tarjetas\/\$\{segmento\}\/mover\$`\), mutacion: true, fn: \(\{ p, cuerpo \}\) => nucleo\.moverTarjeta\(p\[0\], cuerpo\)/.test(servidor));
    check('de nivel operar', /moverTarjeta: 'operar'/.test(servidor));
    check('el núcleo valida las vecinas', /if \(!vecina\(cuerpo\.antes\) \|\| !vecina\(cuerpo\.despues\)\) return error\(400/.test(nucleo));
  });

  await group('Cliente: la tabla de transiciones', () => {
    const vista = fs.readFileSync(path.join(PUBLICO, 'ui', 'vista-tablero.js'), 'utf8').replace(/\r\n/g, '\n');
    const tabla = vista.slice(vista.indexOf('export const TRANSICIONES'), vista.indexOf('});', vista.indexOf('export const TRANSICIONES')));
    const pares = [...tabla.matchAll(/'(\w+)→(\w+)': \{ accion: '(\w+)', confirmar: (true|false), nivel: '(\w+)'/g)].map((m) => `${m[1]}→${m[2]}:${m[3]}:${m[4]}:${m[5]}`);
    check('las cinco decididas por el usuario', JSON.stringify(pares) === JSON.stringify([
      'hacer→cola:lanzar:true:ejecutar', 'cola→mal:cancelar:true:operar', 'curso→mal:cancelar:true:operar',
      'mal→hacer:devolver:false:operar', 'mal→cola:reintentar:false:ejecutar'
    ]), pares.join(' '));
    check('nunca se suelta en Trabajando ni Terminado', !/→(curso|ok)'/.test(tabla));
    check('en «Todos» no se mueve nada', vista.includes("nodo.value === 'todos' ? 'Elegí un nodo para mover tarjetas") && /if \(motivoSinMover\(\)\) return null;/.test(vista));
    check('en «Todos», Por hacer dice por qué no se mueve', vista.includes("motivoSinMover() ? 'elegí un nodo para moverlas' : 'no corren hasta lanzarlas'"));
    check('el carril principal no se cancela', vista.includes("if (tr.accion === 'cancelar') return t.carril === 'principal' ?"));
    check('el nivel se chequea antes (no pasa por un clic)', /if \(!alcanza\(tr\.nivel\)\) return motivoRemoto\(\);/.test(vista));
    check('Por hacer se ordena por posicion', vista.includes("if (c.id === 'hacer') xs.sort(porPosicion);"));
    check('lanzar y cancelar confirman en el menú', /if \(d\.confirmar\) \{ setConfirmando\(d\); return; \}/.test(vista));
  });

  await group('F2: arrastrar', () => {
    const arr = fs.readFileSync(path.join(PUBLICO, 'ui', 'tablero-arrastre.js'), 'utf8').replace(/\r\n/g, '\n');
    const vista = fs.readFileSync(path.join(PUBLICO, 'ui', 'vista-tablero.js'), 'utf8').replace(/\r\n/g, '\n');
    const css = fs.readFileSync(path.join(PUBLICO, 'app.css'), 'utf8');
    check('Pointer Events propios, sin el drag & drop de HTML5', /pointermove/.test(arr) && !/draggable|dragstart|dataTransfer/.test(arr + vista));
    check('con el dedo, solo desde el asa', arr.includes("if (dedo && !ev.target.closest('.asa-arrastre')) return;") && /\.asa-arrastre \{[^}]*touch-action: none/.test(css));
    check('con el mouse, después de 6 px (un clic sigue abriendo el detalle)', arr.includes('const UMBRAL_PX = 6;') && arr.includes('< UMBRAL_PX) return;'));
    check('los botones de la tarjeta no empiezan un arrastre', arr.includes("ev.target.closest('button, a, input, select, textarea, label, .menu-mover')"));
    check('Esc lo corta', /if \(ev\.key !== 'Escape' \|\| !sesion\) return;[\s\S]*cancelarArrastre\(\);/.test(arr));
    check('soltar solo actúa si el destino es válido', arr.includes('if (a?.sobre && a.motivo === null) cfg.soltar('));
    check('el clic que sigue al soltar no abre el detalle', /window\.addEventListener\('click', comer, \{ capture: true, once: true \}\);\s*setTimeout\(\(\) => window\.removeEventListener\('click', comer, true\), 0\);/.test(arr));
    check('todo se limpia al terminar', ['pointermove', 'pointerup', 'pointercancel', 'keydown'].every((e) => arr.includes(`window.removeEventListener('${e}'`)) && arr.includes('sesion.fantasma?.remove();'));
    check('la copia que sigue al puntero no captura eventos', /\.fantasma-arrastre \{[^}]*pointer-events: none/.test(css));
    check('Trabajando y Terminado dicen por qué no', vista.includes("'Trabajando lo decide el ejecutor.'") && vista.includes("'Terminado lo marca un resultado real.'"));
    check('con filtros no se reordena', vista.includes('hayOcultasEnHacer() ?'));
    check('si la tarjeta cambia de estado, el arrastre se corta', vista.includes("cancelarArrastre(); avisar('La tarjeta cambió mientras la arrastrabas.');"));
    check('lanzar y cancelar confirman al soltar', vista.includes('if (tr.confirmar) confirmacion.value = { t, tr, hasta };'));
    check('la confirmación enfoca «No»', /const no = useRef\(null\);\s*useEffect\(\(\) => \{\s*no\.current\?\.focus\(\);/.test(vista));
    check('la línea de inserción en Por hacer', vista.includes('class="marca-insercion"'));
  });

  await group('F3: el teléfono', () => {
    const vista = fs.readFileSync(path.join(PUBLICO, 'ui', 'vista-tablero.js'), 'utf8').replace(/\r\n/g, '\n');
    const css = fs.readFileSync(path.join(PUBLICO, 'app.css'), 'utf8').replace(/\r\n/g, '\n');
    check('la columna mirada persiste y se valida', vista.includes("persistente('tablero.columna', 'hacer', { validar: (v) => COLUMNAS.some((c) => c.id === v) })"));
    check('las pestañas no existen fuera del teléfono', css.includes('.pestanas-columnas { display: none; }'));
    const tel = css.slice(css.indexOf('@media (max-width: 800px) {\n  .tablero-cuerpo .columnas { display: flex;'));
    check('carrusel con scroll-snap', /scroll-snap-type: x mandatory/.test(tel.slice(0, 600)) && /scroll-snap-align: start/.test(tel.slice(0, 600)));
    check('el arrastre pasa de columna al acercarse al borde', fs.readFileSync(path.join(PUBLICO, 'ui', 'tablero-arrastre.js'), 'utf8').includes('carril.scrollLeft += PASO_SCROLL_PX'));
  });

  report();
})();
