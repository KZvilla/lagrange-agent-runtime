/**
 * FEAT-160 F3 — Columnas honestas: Por hacer es tuya (se arrastra, se crea, se
 * lanza) y las otras cuatro las mueve el ejecutor. Los motivos de lo que no se
 * puede hacer se ven, no solo en `title`.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (rel) => fs.readFileSync(path.join(PUBLICO, rel), 'utf8').replace(/\r\n/g, '\n');
const vista = leer('ui/vista-tablero.js');
const arr = leer('ui/tablero-arrastre.js');
const css = leer('app.css');
const corte = (desde, hasta) => vista.slice(vista.indexOf(desde), vista.indexOf(hasta, vista.indexOf(desde)));

(async () => {
  await group('Solo Por hacer se arrastra', () => {
    check('arrastrable: solo por_hacer, sin lote y fuera de «Todos»', vista.includes("export const arrastrable = (t) => !motivoSinMover() && !t.loteId && t.estado === 'por_hacer';"));
    check('EJECUTAR solo lanza', vista.includes('const EJECUTAR = { lanzar: (t) => lanzarTarjeta(t.id) };'));
    const tarjeta = corte('function Tarjeta(', '// ── Asignar y crear');
    check('la tarjeta del ejecutor conserva sus botones', ['cancelarTarea(t.id)', 'reintentarTarea(t.id)', 'devolverTarea(t.id)', 'archivarTarea(t.id, !t.archivada)'].every((x) => tarjeta.includes(x)));
    const acciones = corte('function AccionesDeDetalle(', 'const Zona =');
    check('el detalle también', ['cancelarTarea(t.id)', 'reintentarTarea(t.id)', 'devolverTarea(t.id)', 'archivarTarea(t.id, !t.archivada)'].every((x) => acciones.includes(x)));
  });

  await group('Tu columna y las del ejecutor', () => {
    const col = corte('function Columnas(', '// ── FEAT-138 F3');
    check('el rótulo es un ítem de la grilla antes de En cola, no un contenedor', col.includes('class="rotulo-ejecutor"') && col.includes("${c.id === 'cola' ? rotulo : null}<section key=${c.id}") && !/columnas-ejecutor/.test(vista));
    check('en ancho, dos filas con alto definido', /@media \(min-width: 1281px\) \{\n  \.tablero-cuerpo \.columnas \{ grid-template-rows: auto minmax\(0, 1fr\); \}/.test(css)
      && css.includes('.tablero-cuerpo .columnas > .col-hacer { grid-row: 1 / span 2; }') && css.includes('grid-column: 2 / -1; grid-row: 1;'));
    check('fuera del ancho, el rótulo no existe para la grilla ni el carrusel', css.includes('.rotulo-ejecutor { display: none; }') && css.includes('.tablero-cuerpo .columnas > .columna { flex: 0 0 100%; scroll-snap-align: center;'));
    check('Por hacer con su banda, en los dos temas', (css.match(/--cabecera-mia: #/g) || []).length === 3 && css.includes('.tablero-cuerpo .col-hacer .columna-titulo { background: var(--cabecera-mia);'));
  });

  await group('«+ Nueva» en el encabezado', () => {
    check('el botón en el encabezado de Por hacer, con el id de la paleta', vista.includes('/><${BotonNueva} />` : null}') && vista.includes('id="nueva-tarjeta"') && leer('app.js').includes("$('#nueva-tarjeta')?.click()"));
    check('el abierto vive en una señal compartida', vista.includes('const nuevaAbierta = signal(false);') && vista.includes('const abierta = nuevaAbierta.value;') && !/setAbierta\(true\)\}>\+ Nueva/.test(vista));
    check('el foco vuelve al botón después del render', vista.includes("requestAnimationFrame(() => document.getElementById('nueva-tarjeta')?.focus());"));
    const tareas = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'tareas.js'), 'utf8');
    const servidor = Number(/export const TOPE_POR_HACER = (\d+);/.exec(tareas)?.[1]);
    const cliente = Number(/const TOPE_POR_HACER = (\d+);/.exec(vista)?.[1]);
    check('el tope del cliente es el del registro', servidor === 100 && cliente === servidor, `${cliente} vs ${servidor}`);
    check('se cuenta sobre la columna entera y se deshabilita con motivo', vista.includes('const lugaresEnHacer = () => TOPE_POR_HACER - columnaHacer().length;') && vista.includes('disabled=${quedan <= 0}') && vista.includes('class="tenue nueva-llena">${MOTIVO_HACER_LLENO}'));
  });

  await group('Motivos visibles', () => {
    check('la tarjeta de Por hacer dice por qué no se lanza', vista.includes('${motivo && !madre && !t.loteId ? html`<div class="tarjeta-motivo">${motivo}</div>` : null}'));
    const menu = corte('export function MenuMover(', '// ── FEAT-138 F2');
    check('un destino con motivo: aria-disabled y la segunda línea', menu.includes("aria-disabled=${d.motivo ? 'true' : undefined}") && menu.includes('<span class="menu-motivo">${d.motivo}</span>') && !menu.includes('disabled=${Boolean(d.motivo)}'));
    check('y elegirlo no hace nada (ni confirma)', menu.indexOf('if (d.motivo) return;') > -1 && menu.indexOf('if (d.motivo) return;') < menu.indexOf('if (d.confirmar)'));
    check('el CSS del menú: segunda línea y deshabilitado por aria', css.includes('.menu-mover-lista button { display: flex; flex-wrap: wrap;') && css.includes('.menu-mover-lista .menu-motivo { flex-basis: 100%;')
      && css.includes('.menu-mover-lista button:is(:disabled, [aria-disabled="true"])'));
    check('durante el arrastre, el aviso va superpuesto (no cambia alturas)', /\.columna-titulo \.destino-aviso \{ position: absolute;[^}]*pointer-events: none;[^}]*text-overflow: ellipsis;/.test(css) && vista.includes('class=${`destino-aviso'));
    check('soltar en un destino inválido avisa; el neutro no', arr.includes('else if (a?.sobre && a.motivo) cfg.rechazar(a.motivo);') && vista.includes('rechazar: (motivo) => avisar(motivo)'));
  });

  report();
  process.exit(process.exitCode || 0);
})();
