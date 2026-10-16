/**
 * FEAT-160 F3b — La tarjeta en tres franjas: banda (título, estado, «⋮»),
 * cuerpo (contenido y quién) y un pie con una sola acción, que se despliega al
 * pasar el mouse. El dibujo vive en ui/tablero-tarjeta.js; cada tarjeta decide
 * qué va en cada franja. Acá: el módulo, la tabla de acciones y el CSS.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (rel) => fs.readFileSync(path.join(PUBLICO, rel), 'utf8').replace(/\r\n/g, '\n');
const vista = leer('ui/vista-tablero.js');
const base = leer('ui/tablero-tarjeta.js');
const css = leer('app.css');
const corte = (txt, desde, hasta) => txt.slice(txt.indexOf(desde), txt.indexOf(hasta, txt.indexOf(desde)));

(async () => {
  await group('El módulo solo dibuja', () => {
    const imports = [...base.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
    check('importa solo módulos hoja', JSON.stringify(imports) === JSON.stringify(['./html.js', '../vendor/hooks.module.js', './comp-base.js']), imports.join(' '));
    check('210 líneas o menos', base.split('\n').length <= 210, String(base.split('\n').length));
    check('vista-tablero.js lo usa y re-exporta lo que otros importan', vista.includes("from './tablero-tarjeta.js';") && /export \{[^}]*ChipEstado[^}]*\};/.test(vista)
      && leer('ui/vista-programado.js').includes("import { Asignacion, ChipEstado } from './vista-tablero.js';"));
    const tb = corte(base, 'export function TarjetaBase(', '\n}\n');
    check('tres franjas: banda con título, estado y «⋮»; cuerpo; pie solo si hay principal', tb.indexOf('class="tarjeta-banda"') < tb.indexOf('class="tarjeta-cuerpo"')
      && tb.includes('${principal ? html`<div class="tarjeta-pie">') && /<\$\{MenuAcciones\} disparador="⋮" clase="tarjeta-mas" etiqueta="Más acciones" items=\$\{secundarias\} abajo \/>/.test(tb));
    check('el asa del dedo va primera en la banda', tb.includes('${asa}<button type="button" class=${`tarjeta-abrir'));
  });

  await group('Un solo menú', () => {
    // BE-141 — MenuAcciones vive en comp-base.js (componente compartido).
    const menu = corte(leer('ui/comp-base.js'), 'export function MenuAcciones(', '\n}\n');
    check('accesible: haspopup, expanded, role menu, Esc y clic afuera', menu.includes('aria-haspopup="menu"') && menu.includes('aria-expanded=${String(abierto)}') && menu.includes('role="menu"')
      && menu.includes("ev.key === 'Escape'") && menu.includes("addEventListener('pointerdown', fuera, true)"));
    check('marca lo que ejecuta, en el ítem y en su confirmación', menu.includes("data-nivel=${d.nivel === 'ejecutar' ? 'ejecutar' : undefined}") && menu.includes("data-nivel=${confirmando.nivel === 'ejecutar' ? 'ejecutar' : undefined}"));
    check('dos pasos para lo armado, deshabilitado para lo que no se puede', menu.includes('d.armado') && menu.includes('<${BotonDosPasos}') && menu.includes('disabled=${Boolean(d.no)}'));
    const mover = corte(vista, 'export function MenuMover(', '// ── FEAT-138 F2');
    check('«Mover a…» es una envoltura: sin estado propio', !mover.includes('useState') && mover.includes('confirmarYEjecutar({ t, tr: d, desde: d.desde });'));
    check('ya no se pregunta «¿Cancelar…?» (solo se lanza)', !vista.includes("'¿Cancelar'") && !base.includes("'¿Cancelar'"));
  });

  await group('Una acción a la vista; el resto en «⋮»', () => {
    const hacer = corte(vista, 'function TarjetaPorHacer(', 'function Tarjeta(');
    check('Por hacer: Lanzar (una sola línea, con la propuesta) o Preparar batch… si es madre', (hacer.match(/texto="Lanzar"/g) || []).length === 1
      && hacer.includes('title=${madre} onClick=${() => abrirDetalle(t.id)}>Preparar batch…</button>'));
    check('…y en «⋮» el orden, aceptar y borrar o descartar (dos pasos)', hacer.includes('movidasDeHacer(t)') && hacer.includes("texto: 'Aceptar'")
      && hacer.includes("armado: '¿Borrar? Clic de nuevo'") && hacer.includes("armado: '¿Descartar? Clic de nuevo'"));
    check('una tarjeta de un batch: el chip en la banda, sin acciones', hacer.includes('estado = html`<button type="button" class="ficha ficha-id"') && hacer.includes('if (!t.loteId) {'));
    const tarjeta = corte(vista, 'function Tarjeta(', '// ── Asignar y crear');
    const orden = ["texto=${columna === 'cola' ? 'quitar' : 'cancelar'}", 'reintentarTarea(t.id)', "texto: 'Volver a Por hacer'", "texto: t.archivada ? 'Desarchivar' : 'Archivar'"].map((x) => tarjeta.indexOf(x));
    check('el ejecutor: quitar o cancelar; en Con error, Reintentar, Volver y Archivar en ese orden', orden.every((i, k) => i > -1 && (k === 0 || i > orden[k - 1])), orden.join(' '));
    check('la primera al pie, el resto a «⋮»', tarjeta.includes('const [primera, ...resto] = acciones;') && tarjeta.includes('principal=${primera?.boton} secundarias=${resto}'));
    check('Reintentar no tiene forma de ítem de menú (nunca va a «⋮»)', /acciones\.push\(\{ boton: html`<button type="button" class="accion" data-nivel="ejecutar" onClick=\$\{\(\) => reintentarTarea\(t\.id\)\}>Reintentar<\/button>` \}\)/.test(tarjeta));
    check('el carril principal no ofrece cancelar', tarjeta.includes("if ((columna === 'cola' || columna === 'curso') && t.carril !== 'principal') {"));
  });

  await group('CSS', () => {
    check('el pie cerrado colapsa de verdad (0fr con min-height 0)', css.includes('.tarjeta-pie { display: grid; grid-template-rows: 0fr;') && /\.tarjeta-pie-fila \{ min-height: 0; overflow: hidden;/.test(css));
    check('se abre con hover o foco (un «¿seguro?» armado tiene el foco), sin :has', css.includes('.tarjeta:hover > .tarjeta-pie, .tarjeta:focus-within > .tarjeta-pie { grid-template-rows: 1fr; }') && !css.includes(':has('));
    check('en táctil, siempre abierto', /@media \(any-hover: none\) \{\n  \.tarjeta-pie \{ grid-template-rows: 1fr; \}/.test(css));
    check('mientras se arrastra (con mouse), cerrado y sin transición', /@media \(any-hover: hover\) \{\n  body\.arrastrando \.tarjeta > \.tarjeta-pie, body\.arrastrando \.tarjeta:hover > \.tarjeta-pie \{ grid-template-rows: 0fr; transition: none; \}/.test(css));
    check('sin animación con reduced-motion', css.includes('@media (prefers-reduced-motion: reduce) { .tarjeta-pie, .tarjeta-pie-fila { transition: none; } }'));
    check('ya no se esconden los botones con opacidad (F6)', !css.includes('.tarjeta .accion:not(.armado) { opacity: 0;'));
    check('el tono de la columna tiñe la banda y la línea de 2 px', css.includes('.col-mal { --col-tono: var(--error); }') && css.includes('color-mix(in srgb, var(--col-tono, var(--acento)) 10%, var(--panel))')
      && /\.tablero-cuerpo \.columna-titulo::before \{[^}]*height: 2px;[^}]*background: var\(--col-tono/.test(css));
    check('«⋮» sin borde y del ancho justo; ningún botón del pie se parte', /\.tarjeta-mas \{[^}]*width: fit-content;[^}]*border: 0;/.test(css) && css.includes('.tarjeta-pie-fila button { white-space: nowrap; }'));
    check('el asa del dedo ya no es absoluta', /\.asa-arrastre \{ display: none; flex: none;/.test(css) && !/\.asa-arrastre \{[^}]*position: absolute/.test(css));
  });

  report();
})();
