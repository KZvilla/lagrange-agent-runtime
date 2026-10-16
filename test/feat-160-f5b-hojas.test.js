/**
 * FEAT-160 F5b — En el teléfono, el alta y los filtros del tablero son hojas
 * inferiores (ui/hoja.js) y «+ Nueva» va en la barra; «Cancelar…» pasa a
 * «Frenar…» y cada opción dice qué corta y cuánto hay. reglas-filtro.js se
 * ejecuta; el resto se lee como texto (los componentes no se importan en node).
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (rel) => fs.readFileSync(path.join(PUBLICO, rel), 'utf8').replace(/\r\n/g, '\n');
const css = leer('app.css');
const app = leer('app.js');
const index = leer('index.html');
const vista = leer('ui/vista-tablero.js');
const filtros = leer('ui/tablero-filtros.js');
const barra = leer('ui/barra.js');
const hoja = leer('ui/hoja.js');
const corte = (txt, desde, hasta) => txt.slice(txt.indexOf(desde), txt.indexOf(hasta, txt.indexOf(desde)));

(async () => {
  const R = await import(pathToFileURL(path.join(PUBLICO, 'ui', 'reglas-filtro.js')).href);

  await group('La hoja', () => {
    check('hoja.js exporta Hoja y enCarrusel, con la media query de telefono.js', hoja.includes('export function Hoja(') && hoja.includes('export const enCarrusel = signal(')
      && hoja.includes("import { MQ_CARRUSEL } from './telefono.js';") && hoja.includes("mq?.addEventListener('change'"));
    check('sin matchMedia (node) no rompe', hoja.includes("typeof matchMedia === 'function' ? matchMedia(MQ_CARRUSEL) : null"));
    check('un diálogo modal con su título', hoja.includes('role="dialog" aria-modal="true" aria-labelledby=${`${id}-titulo`}'));
    check('el velo es hermano del diálogo y cierra con pointerdown', /<div class="velo-hoja" aria-hidden="true" onPointerDown=.*<\/div>\n\s*<section class="hoja"/.test(hoja));
    check('Esc cierra en captura y no sigue (no cierra también el detalle)', hoja.includes("window.addEventListener('keydown', tecla, true);") && hoja.includes('ev.stopPropagation();')
      && hoja.includes("window.removeEventListener('keydown', tecla, true);"));
    check('el foco entra al primer control del cuerpo', hoja.includes('.hoja-cuerpo :is(${ENFOCABLE})'));
    check('telefono.js sigue sin imports', !/^import /m.test(leer('ui/telefono.js')));
    check('CSS: la hoja encima del cajón y debajo de la paleta, al alto dinámico', css.includes('.velo-hoja { position: fixed; inset: 0; z-index: 26;')
      && /\.hoja \{ position: fixed; left: 0; right: 0; bottom: 0; z-index: 27; height: 76dvh; max-height: calc\(100dvh - 24px\);/.test(css));
    check('el teclado de Android empuja la hoja', index.includes('interactive-widget=resizes-content'));
  });

  await group('El alta', () => {
    check('«+ Nueva» en la barra: su raíz, antes de Frenar', /<div class="raiz-ui" id="raiz-nueva"><\/div>\n\s*<div class="raiz-ui" id="raiz-cancelar"><\/div>/.test(index)
      && app.includes("render(h(BotonNuevaBarra, {}), $('#raiz-nueva'));"));
    const deBarra = corte(vista, 'export function BotonNuevaBarra()', '\n}\n');
    check('solo en el tablero y en el carrusel, con su id', deBarra.includes("if (ruta.value.vista !== 'tablero' || !enCarrusel.value) return null;") && deBarra.includes('id="nueva-tarjeta-barra"'));
    check('en el carrusel el encabezado de Por hacer no lo dibuja', vista.includes("/>${enCarrusel.value ? null : html`<${BotonNueva} />`}` : null}"));
    check('la paleta abre el alta sin buscar un botón', app.includes('setTimeout(abrirNueva, 50)') && !app.includes("$('#nueva-tarjeta')?.click()")
      && vista.includes('export function abrirNueva() {\n  if (lugaresEnHacer() > 0) nuevaAbierta.value = true;'));
    const enHoja = corte(vista, '  if (enHoja) {', '\n  }\n');
    check('la hoja la arma NuevaTarjeta (enviar y cerrar son suyos)', enHoja.includes('<${Hoja} id="hoja-nueva" titulo="Nueva tarjeta"') && enHoja.includes('alCerrar=${() => cerrar(false)}'));
    check('campos con rótulo: Título, Pedido, Asignar a y Proyecto', enHoja.includes('<${Campo} texto="Título">') && enHoja.includes('<${Campo} texto="Pedido">')
      && enHoja.includes('<${Asignacion} envolver="campo" textoProyecto="Proyecto"'));
    check('los tres botones en el pie', enHoja.includes('>Cancelar</button>') && enHoja.includes('onClick=${() => enviar(false)}>Guardar</button>') && enHoja.includes('onClick=${() => enviar(true)}>Guardar y lanzar</button>'));
    check('cerrar sin guardar no limpia el borrador', vista.includes('if (limpiar) nueva.value = { titulo: \'\', pedido: \'\' };') && !enHoja.includes('cerrar(true)'));
    check('la monta Tablero, solo abierta y en el carrusel', vista.includes('${enCarrusel.value && nuevaAbierta.value ? html`<${NuevaTarjeta} enHoja />` : null}'));
    check('en la columna queda solo el aviso de lleno', vista.includes('if (enCarrusel.value) return lleno ? html`<p class="tenue nueva-llena">${MOTIVO_HACER_LLENO}</p>` : null;'));
    check('el foco vuelve al botón que se ve', vista.includes("document.getElementById(enCarrusel.value ? 'nueva-tarjeta-barra' : 'nueva-tarjeta')?.focus()"));
  });

  await group('Los filtros', () => {
    const f = { ...R.FILTRO_VACIO, quien: 'alma:alya', proyecto: 'lagrange', hoy: true };
    const escritorio = R.escondidosActivos(f, 'todo');
    check('sin campos: lo de escritorio (solo lo del panel)', JSON.stringify(escritorio.map((p) => p.clave)) === '["hoy"]');
    const tel = R.escondidosActivos(f, 'todo', { quien: 'Alya' });
    check('con campos: Quién y Proyecto también, primero', JSON.stringify(tel.map((p) => p.clave)) === '["quien","proyecto","hoy"]'
      && tel[0].texto === 'Quién: Alya' && tel[1].texto === 'Proyecto: lagrange');
    check('sus pastillas los apagan', JSON.stringify(tel[0].quitar) === '{"quien":"todo"}' && JSON.stringify(tel[1].quitar) === '{"proyecto":""}');
    check('sin nombre, el valor crudo', R.escondidosActivos(f, 'todo', { quien: undefined })[0].texto === 'Quién: alma:alya');
    check('hayFiltros no cambia', R.hayFiltros(f, 'todo') === true && R.hayFiltros(R.FILTRO_VACIO, 'todo') === false);
    check('en el carrusel Quién y Proyecto no van en la barra', filtros.includes('    ${telefono ? null : campos}\n') && (filtros.match(/id="filtro-quien"/g) || []).length === 1);
    const deHoja = corte(filtros, 'function HojaFiltros(', '\n}\n');
    check('la hoja: Quién, Proyecto y lo del panel; Limpiar; «Ver N tarjetas»', deHoja.includes('<div class="filtros-hoja">${campos}<${CuerpoFiltros}') && deHoja.includes('>Limpiar</button>')
      && deHoja.includes("visibles === 1 ? 'Ver 1 tarjeta' : `Ver ${visibles} tarjetas`"));
    check('el panel flotante solo fuera del carrusel; su Esc y su clic afuera tampoco', filtros.includes('${abierto && !telefono ? html`<${PanelFiltros}') && filtros.includes('if (!abierto || enCarrusel.value) return undefined;'));
    check('la vista cuenta tareas y lotes que pasan', vista.includes('const visibles = tareasDelTablero().filter((x) => pasaFiltros(x)).length + todosLotes.filter((l) => pasaFiltros(l)).length;'));
    check('sin la regla del panel al ancho de la barra', !css.includes('.filtros-panel { left: 12px; right: 12px;'));
  });

  await group('Frenar', () => {
    const menu = corte(barra, 'export function MenuCancelar(', 'export function SelectorNodo(');
    check('ni «Cancelar…» ni las opciones viejas', !/'Cancelar (charla|cast|ambos)'|>Cancelar…<|"Cancelar…"/.test(barra) && !/'Cancelar (la charla|el cast|charla y cast)/.test(app));
    check('botón «Frenar…» con su nombre accesible', menu.includes('aria-label="Frenar…"') && menu.includes('<span class="texto-cancelar">Frenar…</span>'));
    check('cada opción: qué corta y cuánto hay', menu.includes("opcion('alma', 'charlas', `Corta la charla en curso y vacía su cola (${cuantoHay('alma')})`)")
      && menu.includes("opcion('cast', 'casts', `Corta el cast en curso y vacía su cola (${cuantoHay('cast')})`)") && menu.includes("opcion('', 'los dos', 'Charlas y casts, de todos los chats')"));
    check('se confirma con un segundo toque', menu.includes('armado=${html`<b>¿Frenar ${nombre}? Tocá de nuevo</b><span>${detalle}</span>`}'));
    check('cuánto hay sale de los carriles', barra.includes("return partes.join(' · ') || 'nada ahora';"));
    check('la nota dice lo que no toca', menu.includes('No toca el carril principal (/run y /plan de Telegram), los lotes ni el daemon.'));
    check('los avisos', menu.includes("'No había nada que frenar.'") && app.includes("'No había nada que frenar.'"));
    check('la paleta', app.includes("texto: 'Frenar charlas', grupo: 'frenar'") && app.includes("texto: 'Frenar casts', grupo: 'frenar'") && app.includes("texto: 'Frenar charlas y casts', grupo: 'frenar'"));
    check('por dentro, lo mismo', menu.includes('id="cancelar"') && menu.includes('id="menu-cancelar"') && menu.includes("api('/api/cancelar'") && app.includes('if (menuCancelar.value) { menuCancelar.value = false; return; }'));
    check('las opciones en dos líneas', css.includes('.menu-cancelar .menu button { display: flex; flex-direction: column;'));
  });

  await group('La barra a 360 px (D6, medido en vivo)', () => {
    check('los botones de 44 px no se encogen', css.includes('  .boton-lateral, .boton-paleta, #cancelar { flex-shrink: 0; }'));
    check('hasta 420 px, sin «· borrador» ni el nombre de la marca', css.includes('@media (max-width: 420px) { .boton-nueva-barra .nueva-extra, .marca-nombre { display: none; } }'));
    check('el sufijo va en su span', vista.includes('>+ Nueva<span class="nueva-extra">${n.pedido || n.titulo ?'));
  });

  await group('Topes', () => {
    check('vista-tablero.js no pasa de 1340 líneas', vista.split('\n').length <= 1340, String(vista.split('\n').length));
    for (const [n, t] of [['hoja.js', hoja], ['tablero-filtros.js', filtros], ['barra.js', barra]]) check(`${n}: 210 líneas o menos`, t.split('\n').length <= 210, String(t.split('\n').length));
    check('sin :has', !css.includes(':has('));
  });

  report();
})();
