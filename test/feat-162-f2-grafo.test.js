/**
 * FEAT-162 F2 — La orquestación activa como grafo vivo. La función pura y el confeti los
 * prueba `grafo/pruebas/orquestacion.ts` (dentro de `grafo:check`); acá, el lado de la
 * consola, leído como texto: el cargador compartido, qué se monta y cuándo, y la red.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');

const WEB = path.join(__dirname, '..', 'telegram-bridge', 'web');
const leer = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  const vista = leer('public/ui/vista-orquestacion.js');
  const grafo = leer('public/ui/orquestacion-grafo.js');
  const isla = leer('public/ui/isla-grafo.js');
  const tub = leer('public/ui/tuberias-lienzo.js');
  const app = leer('public/app.js');
  const montar = leer('grafo/src/montar.tsx');
  const bundle = leer('public/vendor/grafo.module.js');
  const pkg = JSON.parse(leer('grafo/package.json'));

  await group('La isla', () => {
    check('montar.tsx reexporta montarOrquestacion (un solo bundle)', montar.includes("export { montarOrquestacion } from './orquestacion';") && /export function montar\(/.test(montar));
    check('el bundle lo trae', bundle.includes('montarOrquestacion'));
    check('canvas-confetti y sus tipos, con versión exacta', /^\d+\.\d+\.\d+$/.test(pkg.devDependencies['canvas-confetti'] || '') && /^\d+\.\d+\.\d+$/.test(pkg.devDependencies['@types/canvas-confetti'] || ''));
    check('sin dagre', !pkg.devDependencies['@dagrejs/dagre']);
  });

  await group('El cargador compartido', () => {
    check('isla-grafo.js: el css una vez y el import cacheado', isla.includes("css.href = '/grafo.css';") && isla.includes("isla ??= import('../vendor/grafo.module.js')"));
    check('Tuberías lo usa (y ya no tiene el suyo)', tub.includes("import { cargarIsla } from './isla-grafo.js';") && !tub.includes('function cargarIsla('));
    check('Orquestación también', grafo.includes("import { cargarIsla } from './isla-grafo.js';") && grafo.includes('m.montarOrquestacion(nodo.current, ultimos.current)'));
  });

  await group('Qué se monta', () => {
    check('el grafo solo en la activa', vista.includes("${activa ? html`<${GrafoOrquestacion} o=${o} alCambio=${alCambio} />` : null}"));
    check('si la isla no carga, queda la lista', grafo.includes('la lista de abajo sigue al día'));
    check('la lista de F1 sigue (aprobaciones, pasos, acciones)', vista.includes('<${Aprobaciones} o=${o} alResolver=${alCambio} />') && vista.includes('<${Pasos} o=${o} />') && vista.includes('<${Acciones} o=${o} />'));
    check('aprobar y rechazar desde el nodo van a las mismas rutas', grafo.includes('/api/orquestaciones/${enc(o.id)}/aprobaciones/${enc(aid)}/${que}'));
    check('abrir una tarjeta navega sin recargar (data-ruta)', grafo.includes("a.dataset.ruta = '';") && grafo.includes('`/tablero?t=${enc(enlace.id)}`'));
  });

  await group('La red', () => {
    check('solo lo enlazado, por id, con tope de 30', grafo.includes('const TOPE_VINCULADOS = 30;') && grafo.includes('`/api/tareas/${enc(e.id)}`') && grafo.includes('`/api/lotes/${enc(e.id)}`') && !grafo.includes("api('/api/tareas'"));
    check('en paralelo y un 404 no tira el resto', grafo.includes('Promise.allSettled') && grafo.includes('noExiste: true'));
    check('nunca más de una vez cada 2 s', grafo.includes('ultimoPedido + 2000 - Date.now()'));
    check('un lote que corre se repide cada 15 s', grafo.includes('15_000'));
    check('app.js le pasa los eventos de tarjetas', app.includes("import { alCambiarTareaOrquestacion } from './ui/orquestacion-grafo.js';") && app.includes('alCambiarTarea(e.tarea); alCambiarTareaOrquestacion(e.tarea);'));
    check('y solo repide si la tarjeta está enlazada', grafo.includes("enlacesDe(o).some((e) => e.tipo === 'tarjeta' && e.id === t.id)"));
  });

  // Lo que encontró la auditoría de la implementación (hilo 35e59386).
  await group('Ciclo de vida', () => {
    check('al cambiar de orquestación, el cleanup no borra la nueva', grafo.includes('if (montada?.id === o.id) montada = null;') && !grafo.includes('montada = null; };'));
    check('el pedido pendiente se cancela al desmontar', /clearTimeout\(pendienteVinc\);\n\s*instancia\.current\?\.desmontar\(\);/.test(grafo));
    check('lo enlazado de la anterior no se cuela en la nueva', grafo.includes('vinculados.value = { tarjetas: {}, lotes: {} };'));
    // Reauditoría (hilo 58479410): un pedido en vuelo al desmontar no repuebla nada.
    check('un pedido en vuelo de otra orquestación se descarta', /await Promise\.allSettled[\s\S]*?if \(montada\?\.id !== o\.id\) return;[\s\S]*?vinculados\.value = v;/.test(grafo));
    const isla = leer('grafo/src/orquestacion.tsx');
    check('las acciones van en los datos del nodo, no en una global', !/^let acciones/m.test(isla) && isla.includes('data: { ...n.data, acciones }'));
    check('Aprobar en el nodo lleva data-nivel="ejecutar"', isla.includes('nivel="ejecutar"') && isla.includes('data-nivel={nivel}'));
    check('el asa anónima de salida solo en el orquestador y los pasos', !isla.includes("d.tipo !== 'sub' && <Handle type=\"source\""));
  });

  await group('Topes', () => {
    for (const [n, t] of [['vista-orquestacion.js', vista], ['orquestacion-grafo.js', grafo], ['isla-grafo.js', isla]]) check(`${n}: 210 líneas o menos`, t.split('\n').length <= 210, String(t.split('\n').length));
  });

  report();
})();
