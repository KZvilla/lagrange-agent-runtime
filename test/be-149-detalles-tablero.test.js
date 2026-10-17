/**
 * BE-149 — Tres detalles de BE-144: el foco va al título cuando la tarea termina de cargar (el rAF de abrir corría antes
 * de que existiera), «Partir» no se estira y el filtro de cumplidas activo se distingue.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const vista = fs.readFileSync(path.join(UI, 'vista-tablero.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(UI, '..', 'app.css'), 'utf8').replace(/\r\n/g, '\n');

group('BE-149', () => {
  check('al cargar la tarea se vuelve a enfocar el título si el foco sigue en la ✕ o suelto', vista.includes("cargarDetalle().then(() => requestAnimationFrame(() => { const a = document.activeElement; if (!a || a === document.body || a.matches('.detalle-cerrar')) enfocar(); }));"));
  check('Partir no se estira', css.includes('.detalle-bloque[data-partir] > .boton { align-self: flex-start; }'));
  check('el filtro de cumplidas activo se distingue', css.includes('.franja-metas-cabecera .accion.activo { color: var(--acento); background: var(--realce);'));
  check('vista-tablero.js dentro de su tope', vista.split('\n').length <= 1340);
});

report();
