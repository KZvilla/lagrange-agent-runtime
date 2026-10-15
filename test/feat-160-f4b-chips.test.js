/**
 * FEAT-160 F4b — Un solo sistema de chips: la clase `.ficha` con modificadores
 * de tono, tamaño y forma reemplaza a chip-estado, chip-sub, notas-cuenta y
 * etiqueta-propuesta. La regla de la propuesta (ui/reglas-tablero.js) se
 * ejecuta; el CSS y los componentes se leen como texto.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (rel) => fs.readFileSync(path.join(PUBLICO, rel), 'utf8').replace(/\r\n/g, '\n');
const css = leer('app.css');
const vista = leer('ui/vista-tablero.js');
const base = leer('ui/tablero-tarjeta.js');
const familia = leer('ui/tablero-familia.js');
const programado = leer('ui/vista-programado.js');
const panel = leer('ui/panel.js');
const ui = fs.readdirSync(path.join(PUBLICO, 'ui')).filter((f) => f.endsWith('.js')).map((f) => [f, leer(`ui/${f}`)]);

(async () => {
  const R = await import(pathToFileURL(path.join(PUBLICO, 'ui', 'reglas-tablero.js')).href);

  await group('La propuesta nombra al autor solo si no es quien la hace', () => {
    const alya = { tipo: 'alma', clave: 'alya' };
    check('un alma que se la propone a sí misma', R.autorEsSujeto({ creadaPor: 'alma:alya', sujeto: alya }) === true);
    check('un alma que la propone para un agente', R.autorEsSujeto({ creadaPor: 'alma:alya', sujeto: { tipo: 'agente', nombre: 'rev' } }) === false);
    check('una propuesta sin asignar', R.autorEsSujeto({ creadaPor: 'alma:alya', sujeto: null }) === false);
    check('un agente orquestador que la propone para sí', R.autorEsSujeto({ creadaPor: 'agente:rev', sujeto: { tipo: 'agente', nombre: 'rev' } }) === true);
    check('otra alma', R.autorEsSujeto({ creadaPor: 'alma:alya', sujeto: { tipo: 'alma', clave: 'otra' } }) === false);
    check('el usuario', R.autorEsSujeto({ creadaPor: 'usuario', sujeto: alya }) === false);
    check('la tarjeta lo usa y conserva el literal que fija Test 106', vista.includes("${autorEsSujeto(t) ? 'Propuesta' : html`Propuesta · ${autorDe(t.creadaPor)}`}")
      && vista.includes('class="ficha ficha-propuesta"'));
  });

  await group('Las clases viejas no quedan', () => {
    const viejas = /\b(chip-estado|chip-sub|notas-cuenta|etiqueta-propuesta|punto-chip)\b|(^|[^-\w])est-(curso|ok|mal|aviso)\b/m;
    check('app.css', !viejas.test(css), (css.match(viejas) || [''])[0]);
    const conViejas = ui.filter(([, t]) => viejas.test(t)).map(([f]) => f);
    check('ui/*.js', conViejas.length === 0, conViejas.join(' '));
    check('el .chip de la barra y Ajustes sigue', /^\.chip \{/m.test(css) && /^\.chip\.activo \{/m.test(css));
    check('SUB_DE_ESTADO y las sub-* de la barra siguen', base.includes('export const SUB_DE_ESTADO') && /^\.seg\.sub-ok, \.punto\.sub-ok \{/m.test(css));
  });

  await group('La clase base', () => {
    check('.ficha definida una sola vez, con 20 px de alto', (css.match(/^\.ficha \{/gm) || []).length === 1 && /^\.ficha \{[^}]*height: 20px;/m.test(css));
    check('un chip que abre algo no lleva fondo', /^button\.ficha \{ background: transparent; cursor: pointer; transition: border-color \.18s ease; \}/m.test(css));
    check('…y lo dice el borde, escrito explícito al pasar o con el foco', css.includes('button.ficha:hover, button.ficha:focus-visible { border-color: var(--ficha-tono); }'));
    check('sin transición si se pide menos movimiento', css.includes('@media (prefers-reduced-motion: reduce) { button.ficha { transition: none; } }'));
    check('en la tira de familia, centrada', css.includes('.tira-familia-pasos .ficha { align-self: center; }'));
    check('sin :has', !css.includes(':has('));
  });

  await group('Dónde va cada variante', () => {
    check('subtareas: ficha-id con FICHA_DE_SUB, y un reintento es aviso', base.includes("reintentando: 'ficha-aviso'")
      && base.includes("class=${`ficha ficha-id ${FICHA_DE_SUB[st.estado] || ''}`}"));
    check('el «batch · …» es un botón ficha-id, en la tarjeta y en la tira', vista.includes('estado = html`<button type="button" class="ficha ficha-id"')
      && familia.includes('<button type="button" class="ficha ficha-id" onClick='));
    check('notas e hijas son contadores', base.includes('<span class="ficha ficha-contador" title=') && vista.includes('<span class="ficha ficha-contador" title="Tarjetas hijas terminadas">'));
    check('chica en el detalle y en la tira de familia', vista.includes('<${ChipEstado} t=${t} chica />') && familia.includes('<${ChipEstado} t=${m} chica />'));
    check('Programado: chica solo en la cabecera del lateral', programado.includes('function ChipProgramacion({ p, chica = false })')
      && programado.includes('<${ChipProgramacion} p=${p} chica />') && (programado.match(/<\$\{ChipProgramacion\} p=\$\{p\} \/>/g) || []).length === 1);
    check('el panel arma la suya, chica', panel.includes('<span class=${`ficha ficha-chica ${clase}`}>${etiqueta}</span>'));
  });

  report();
})();
