/**
 * BE-145 — Pipelines y Orquestación (revisión de UI posterior a BE-141): Auditar en ámbar, el candado dice qué fija,
 * Terminados con tope, títulos de batch enteros, «Editar una copia…»; una orquestación terminada con barra verde, sin
 * scroll doble ni título repetido, de a una abierta.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const W = path.join(__dirname, '..', 'telegram-bridge', 'web');
const leer = (rel) => fs.readFileSync(path.join(W, rel), 'utf8').replace(/\r\n/g, '\n');
const css = leer('public/app.css');

group('Pipelines', () => {
  const estilos = leer('grafo/src/estilos.css');
  check('Auditar en ámbar en la fuente del grafo y en la paleta', estilos.includes('.gn-auditar .gn-cabecera { background: var(--t2-fondo); color: var(--t2); }')
    && estilos.includes('.gn-tramo-auditar { background: color-mix(in srgb, var(--t2) 55%') && css.includes('.tub-paleta-punto.gn-auditar { background: var(--t2); }'));
  check('el artefacto generado coincide (grafo:build corrido)', leer('public/grafo.css').includes('.gn-tramo-auditar{background:color-mix(in srgb,var(--t2) 55%,transparent)}') || leer('public/grafo.css').includes('var(--t2) 55%'));
  check('el candado dice qué fija', leer('grafo/src/montar.tsx').includes("'🔒 Disposición fija'"));
  const lateral = leer('public/ui/tuberias-lateral.js');
  check('«plantilla» una vez, con la nota arriba', lateral.includes("r.descripcion ? 'plantilla' :") && lateral.includes('Las plantillas se duplican para cambiarlas.') && !lateral.includes('plantilla · se duplica'));
  check('Terminados con tope y «ver todos»', lateral.includes('const TERMINADOS_VISIBLES = 5;') && lateral.includes('`ver todos (${terminados.length})`'));
  check('el título del batch completo al pasar y en dos líneas (solo ahí)', lateral.includes('title=${l.titulo ? `${l.titulo} · ${l.id}` : l.id}')
    && css.includes('.tub-lote-fila .recorte { display: -webkit-box;') && css.includes('.recorte { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }'));
  check('«Editar una copia…» en una incorporada', leer('public/ui/tuberias-receta-acciones.js').includes("texto: r.incorporada ? 'Editar una copia…' : 'Editar'"));
  check('un enlace-botón sin subrayado', css.includes('a.boton { text-decoration: none; }'));
});

group('Orquestación', () => {
  const vista = leer('public/ui/vista-orquestacion.js');
  check('barra verde y conversación entera en una terminada', css.includes('.orq-tarjeta.orq-terminada .barra-progreso > span { background: var(--ok); }')
    && css.includes('.orq-tarjeta.orq-terminada .orq-globos { max-height: none; overflow-y: visible; }'));
  check('sin repetir quién y título, solo dentro de la lista', css.includes('details.orq-terminada > .orq-tarjeta > .orq-cabecera > :is(.orq-quien, h2) { display: none; }'));
  check('«n/m pasos» junto a la barra', vista.includes('<span class="tenue orq-cuenta-pasos">${hechos}/${o.pasos.length} pasos</span>'));
  check('de a una abierta', vista.includes('<details class="orq-terminada" name="orq-terminadas">'));
  check('vista-orquestacion.js ≤ 210 líneas', vista.split('\n').length <= 210);
});

report();
