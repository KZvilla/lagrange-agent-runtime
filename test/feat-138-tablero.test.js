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

  report();
})();
