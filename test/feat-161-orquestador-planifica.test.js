/**
 * FEAT-161 — El orquestador (FEAT-059) también sugiere archivos y prueba por hija;
 * el registro los guarda en la hija y el borrador de Tuberías los precarga. Es el
 * nodo `planificar` de FEAT-149, fuera del grafo.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const orquestador = require('../mcp-server/agents/orquestador.js');
const tablero = require('../mcp-server/almas/bloque-tablero.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-feat-161-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
const fuente = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  await group('D1 — la plantilla', () => {
    const pedido = orquestador.armarPedido({ tarjeta: { pedido: 'x' } });
    check('la propuesta de ejemplo trae archivos y prueba (comillas simples)', pedido.includes(`<propuesta para="nombre-tal-cual" archivos="src/a.js, test/a.test.js" prueba='["npm","test"]'>`));
    check('dice que son opcionales y cómo van', pedido.includes('`archivos` y `prueba` son opcionales: si no estás seguro, omitilos.') && pedido.includes('entre comillas SIMPLES'));
    check('la plantilla sigue sin fabricar hijas', orquestador.extraerHijas(pedido).operaciones.length === 0);
  });

  await group('D2 — leer y filtrar', () => {
    const respuesta = String.raw`Reparto.
<tablero>
<propuesta para="lector" archivos="src\a.js, test/a.test.js, /etc/x, C:\x, ../x, a/../b, src/a.js" prueba='["npm","test"]'>
Hija 1
hacer 1
</propuesta>
<propuesta para="lector" prueba="npm test">
Hija 2
hacer 2
</propuesta>
<propuesta para="lector" prueba='[]' archivos="/abs">
Hija 3
hacer 3
</propuesta>
<propuesta para="lector">
Hija 4
hacer 4
</propuesta>
</tablero>`;
    const ops = orquestador.extraerHijas(respuesta).operaciones;
    check('cuatro hijas: una sugerencia mala no tira la hija', ops.length === 4);
    check('archivos normalizados: barras a /, sin absolutas, unidades, .. ni repetidos',
      JSON.stringify(ops[0].sugerencia) === '{"archivos":["src/a.js","test/a.test.js"],"prueba":["npm","test"]}', JSON.stringify(ops[0].sugerencia));
    check('una prueba que no es JSON se descarta entera', ops[1].sugerencia === null, JSON.stringify(ops[1].sugerencia));
    check('un array vacío y solo rutas absolutas: null', ops[2].sugerencia === null);
    check('sin atributos: null', ops[3].sugerencia === null);
    check('los atributos crudos no se filtran a la operación', ops.every((o) => !('extras' in o)));
    const s = (extras) => orquestador.sugerenciaDeHija({ extras });
    check('prueba con un elemento que no es string: fuera', s({ prueba: '["npm", 3]' }) === null);
    check('prueba de más de 20 argumentos: fuera', s({ prueba: JSON.stringify(Array(21).fill('a')) }) === null);
    check('prueba de más de 1 KB: fuera', s({ prueba: JSON.stringify(['a'.repeat(1100)]) }) === null);
    check('más de 20 archivos: se recortan', s({ archivos: Array.from({ length: 25 }, (_, i) => `f${i}.js`).join(',') }).archivos.length === 20);
    check('las almas no conservan atributos extra', !('extras' in tablero.extraerBloque(respuesta).operaciones[0]));
  });

  await group('D3 — guardarla en la hija', async () => {
    const tareas = await import('../telegram-bridge/tareas.js');
    const madre = tareas.crearTarjeta({ titulo: 'Madre', pedido: 'Coordinar' }).tarea;
    const sug = { archivos: ['src/a.js'], prueba: ['npm', 'test'] };
    const hija = (titulo, extra = {}) => tareas.proponerTarjeta({ autor: 'agente:orquestador', madre: madre.id, titulo, pedido: titulo, ...extra }).tarea;
    const a = hija('A', { sugerencia: sug });
    check('la hija de un agente la guarda', JSON.stringify(a.sugerenciaLote) === JSON.stringify(sug));
    check('sin sugerencia: null', hija('B').sugerenciaLote === null);
    check('una forma inválida se ignora', hija('C', { sugerencia: { archivos: ['../x'], prueba: 'npm test' } }).sugerenciaLote === null);
    check('solo lo válido queda', JSON.stringify(hija('D', { sugerencia: { archivos: ['C:/x'], prueba: ['npm'] } }).sugerenciaLote) === '{"prueba":["npm"]}');
    // Lo que encontró la auditoría: espacios delante, `\0`, barras invertidas, un inválido entre válidos y repetidos.
    const mezcla = hija('D2', { sugerencia: { archivos: [' /etc/passwd', ' C:\\datos', ' ../secreto', 'a\0b', 'src\\modulo\\a.js', 'src/b.js', 'src/b.js', ' src/c.js '] } }).sugerenciaLote;
    check('el registro vuelve a filtrar con las mismas reglas (uno por uno, normalizado, sin repetidos)',
      JSON.stringify(mezcla) === '{"archivos":["src/modulo/a.js","src/b.js","src/c.js"]}', JSON.stringify(mezcla));
    const deAlma = tareas.proponerTarjeta({ clave: 'alya', titulo: 'E', pedido: 'E', sugerencia: sug }).tarea;
    check('la propuesta de un alma no la guarda', deAlma.sugerenciaLote === null);
    const sinMadre = tareas.proponerTarjeta({ autor: 'agente:x', titulo: 'F', pedido: 'F', sugerencia: sug }).tarea;
    check('sin madre no la guarda', sinMadre.sugerenciaLote === null);
    check('una tarjeta del usuario nace con null', tareas.crearTarjeta({ titulo: 'G', pedido: 'G' }).tarea.sugerenciaLote === null);
    tareas.aceptarPropuesta(a.id);
    check('aceptar la propuesta la conserva', JSON.stringify(tareas.obtener(a.id).sugerenciaLote) === JSON.stringify(sug));
    tareas.reiniciarParaTests();
    const t = fuente('telegram-bridge/tareas.js');
    check('las tarjetas viejas la completan con null al cargar', t.includes('  t.sugerenciaLote ??= null;'));
    check('el bot pasa lo que sugirió el orquestador', fuente('telegram-bridge/bot.js').includes('sugerencia: cruda.sugerencia || null, ...asignacion'));
  });

  await group('D4/D5 — exponerla y precargarla', () => {
    check('borradoresDeLote la devuelve por hija', fuente('telegram-bridge/web/nucleo.js').includes('sugerencia: h.sugerenciaLote || null })),'));
    const ui = fuente('telegram-bridge/web/public/ui/tuberias-borrador.js');
    check('tareaDe recibe la hija y precarga la sugerencia', ui.includes("export const tareaDe = (v, h) => v.tareas[h.id] || { archivos: h.sugerencia?.archivos?.join('\\n') || '', prueba: h.sugerencia?.prueba ? JSON.stringify(h.sugerencia.prueba) : '', tope: '' };"));
    check('nadie llama a tareaDe con un id', !ui.includes('tareaDe(v, h.id)') && !ui.includes('tareaDe(s, id)'));
    check('editar recibe la hija', ui.includes('const editar = (h, k, x) => cambiar((s) => { s.tareas[h.id] = { ...tareaDe(s, h), [k]: x }; return s; });') && !ui.includes('editar(h.id,'));
    check('la nota mientras no se toque', ui.includes('${!v.tareas[h.id] && h.sugerencia ? html`<small class="tub-aviso">sugerido por el orquestador · revisalo antes de lanzar</small>` : null}'));
    check('tuberias-borrador.js: 210 líneas o menos', ui.split('\n').length <= 210, String(ui.split('\n').length));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  report();
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
