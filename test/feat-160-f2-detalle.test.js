/**
 * FEAT-160 F2 — El detalle como franja inferior y la familia de la tarjeta
 * abierta: `familiaDe`, la altura del asa, las marcas del tablero y lo que el
 * CSS y el arrastre tienen que respetar.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const UI = path.join(PUBLICO, 'ui');
const importar = (f) => import(pathToFileURL(path.join(UI, f)).href);
const leer = (f) => fs.readFileSync(path.join(f.endsWith('.css') ? PUBLICO : UI, f), 'utf8').replace(/\r\n/g, '\n');

const t = (id, extra = {}) => ({ id, estado: 'por_hacer', titulo: id, creada: '2026-10-14T00:00:00Z', ...extra });

(async () => {
  const R = await importar('reglas-tablero.js');
  const D = await importar('tablero-detalle.js');
  const F = await importar('tablero-familia.js');

  await group('familiaDe', () => {
    const madre = t('m');
    const h1 = t('h1', { motivo: 'hija', madre: 'm', creada: '2026-10-14T01:00:00Z', estado: 'ok' });
    const h2 = t('h2', { motivo: 'hija', madre: 'm', creada: '2026-10-14T02:00:00Z', estado: 'en_curso' });
    const h0 = t('h0', { motivo: 'hija', madre: 'm', creada: '2026-10-14T00:30:00Z', estado: 'en_cola' });
    const ajena = t('x1', { motivo: 'hija', madre: 'otra' });
    const tareas = [madre, h2, ajena, h1, h0];
    check('una tarjeta sola no tiene familia', R.familiaDe(t('sola'), [t('sola')]) === null);
    const deHija = R.familiaDe(h1, tareas);
    check('una hija: la madre primero y las hermanas por creada', JSON.stringify(deHija.miembros.map((m) => m.id)) === JSON.stringify(['m', 'h0', 'h1', 'h2']));
    check('con el índice de la abierta', deHija.indice === 2);
    check('la madre abierta es la primera', R.familiaDe(madre, tareas).indice === 0);
    check('no mezcla las hijas de otra madre', !deHija.miembros.some((m) => m.id === 'x1'));
    const orq = t('o', { motivo: 'orquestar', madre: 'p', estado: 'en_curso' });
    const partiendo = R.familiaDe(t('p'), [t('p'), orq]);
    check('una madre partiéndose sin hijas: madre + orquestadora', JSON.stringify(partiendo?.miembros.map((m) => m.id)) === JSON.stringify(['p', 'o']));
    check('una orquestadora que ya terminó no cuenta', R.familiaDe(t('p'), [t('p'), { ...orq, estado: 'ok' }]) === null);
    // Auditoría r1 (MAJOR) — Abrir la orquestadora también muestra la familia.
    const desdeOrq = R.familiaDe(orq, [t('p'), orq]);
    check('desde la orquestadora: misma familia, índice 1', desdeOrq?.indice === 1 && desdeOrq.madre.id === 'p');
    const conHija = [t('p'), { ...orq, estado: 'ok' }, t('hp', { motivo: 'hija', madre: 'p' })];
    check('una orquestadora terminada, abierta, no tiene familia en el tablero', R.familiaDe(conHija[1], conHija) === null);
    const huerfana = R.familiaDe(h1, [h1, h2]);
    check('madre que ya no está: { id, ausente }', huerfana.madre.id === 'm' && huerfana.madre.ausente === true && !('estado' in huerfana.madre));
    check('sin lista, sin familia', R.familiaDe(h1, null) === null);
  });

  await group('El asa: altura acotada', () => {
    check('↑ y ↓ mueven 5', D.ajustarAlto(45, 'ArrowUp') === 50 && D.ajustarAlto(45, 'ArrowDown') === 40);
    check('nunca pasa de 20–85', D.ajustarAlto(85, 'ArrowUp') === 85 && D.ajustarAlto(20, 'ArrowDown') === 20);
    check('Home y End', D.ajustarAlto(50, 'Home') === 20 && D.ajustarAlto(50, 'End') === 85);
    check('otra tecla no es del asa', D.ajustarAlto(50, 'Enter') === null);
    check('un valor ilegible arranca de 45', D.ajustarAlto(NaN, 'ArrowUp') === 50 && D.ajustarAlto(300, 'ArrowDown') === 40);
    const caja = { top: 100, bottom: 600 };
    check('el puntero a mitad deja 50 %', D.altoDesdePuntero(350, caja) === 50);
    check('fuera de la caja, acotado', D.altoDesdePuntero(0, caja) === 85 && D.altoDesdePuntero(900, caja) === 20);
    check('caja vacía o puntero inválido: 45', D.altoDesdePuntero(10, { top: 5, bottom: 5 }) === 45 && D.altoDesdePuntero(NaN, caja) === 45);
    check('lo persistido fuera de rango no vale', !D.altoValido(10) && !D.altoValido('45') && D.altoValido(45));
  });

  await group('Las marcas del tablero', () => {
    const tareas = [t('m'), t('h1', { motivo: 'hija', madre: 'm' }), t('h2', { motivo: 'hija', madre: 'm', creada: '2026-10-15' }), t('suelta')];
    const f = R.familiaDe(tareas[1], tareas);
    const de = F.marcasDeFamilia(f, 'h1', true);
    check('la madre: familiar y «madre»', de('m').clase === ' familiar' && de('m').marca === 'madre');
    check('la abierta: familiar-abierta y «1/2»', de('h1').clase === ' familiar familiar-abierta' && de('h1').marca === '1/2');
    check('la hermana: «2/2»', de('h2').marca === '2/2');
    check('el resto, atenuada y sin marca', de('suelta').clase === ' atenuada' && de('suelta').marca === null);
    const quieto = F.marcasDeFamilia(f, 'h1', false);
    check('durante un arrastre, nada', ['m', 'h1', 'suelta'].every((id) => quieto(id).clase === '' && quieto(id).marca === null));
    check('sin familia, nada se atenúa', F.marcasDeFamilia(null, 'x', true)('suelta').clase === '');
    const conOrq = R.familiaDe(t('p'), [t('p'), t('o', { motivo: 'orquestar', madre: 'p', estado: 'en_cola' })]);
    check('la orquestadora se marca «partiendo»', F.textoDeMarca(conOrq, 1) === 'partiendo');
    check('la tira no dibuja un segundo reloj (ChipEstado ya lo trae)', !/Reloj/.test(leer('tablero-familia.js').replace(/^\s*\*.*$/gm, '')));
  });

  await group('Módulos, CSS y arrastre', () => {
    const detalle = leer('tablero-detalle.js');
    const familia = leer('tablero-familia.js');
    const vista = leer('vista-tablero.js');
    check('los módulos nuevos no importan vista-tablero.js', !/vista-tablero\.js/.test(detalle.replace(/^\s*\*.*$/gm, '')) && !/from '\.\/vista-tablero\.js'/.test(familia));
    check('210 líneas o menos', detalle.split('\n').length <= 210 && familia.split('\n').length <= 210);
    // FEAT-160 F3 — Subió de 1340 a 1380 para que entren las columnas honestas; F3b muda las tarjetas y lo vuelve a bajar.
    check('vista-tablero.js no pasa de 1380 líneas', vista.split('\n').length <= 1380, String(vista.split('\n').length));
    check('Detalle se queda en vista-tablero.js y usa la franja', vista.includes('function Detalle()') && vista.includes('return html`<${FranjaDetalle} abierta=${Boolean(d)}>${cuerpo}<//>`;'));
    check('el asa es un separador accesible', /role="separator" aria-orientation="horizontal" aria-controls="detalle"/.test(detalle) && /aria-valuenow=\$\{alto\}/.test(detalle));
    check('un solo cálculo de familia por render, vacío durante un arrastre', vista.includes('familiaVisible = marcasDeFamilia(abierta ? reglas.familiaDe(abierta, tareasDelTablero()) : null, abierta?.id, !a);'));
    check('las tres tarjetas dibujan la marca', (vista.match(/\$\{sel\.marca\}/g) || []).length === 3);
    const css = leer('app.css');
    check('el detalle ya no mide 440 px', !/\.detalle[^{]*\{[^}]*440px/.test(css));
    check('el cuerpo del tablero va en columna', css.includes('.tablero-cuerpo { flex: 1; min-height: 0; display: flex; flex-direction: column; }'));
    const tel = css.slice(css.indexOf('@media (max-width: 800px)'));
    check('en el teléfono, hoja inferior sin asa', /\.detalle \{ position: fixed; left: 0; right: 0; bottom: 0; height: 85vh;/.test(tel) && tel.includes('.detalle-asa { display: none; }'));
    check('≤1280 conserva la grilla y ya no tiene el cajón', /@media \(max-width: 1280px\) \{\n  \.tablero-cuerpo \.columnas \{ grid-template-columns: repeat\(3/.test(css) && !/right: 0; top: 52px; bottom: 0;/.test(css));
    check('la marca no entra al flujo', /\.marca-familia \{ position: absolute;/.test(css) && /\.tarjeta\.familiar \{ position: relative;/.test(css));
    const arr = leer('tablero-arrastre.js');
    check('la copia del arrastre no lleva la familia', arr.includes("f.classList.remove('familiar', 'familiar-abierta', 'atenuada');") && arr.includes("f.querySelector('.marca-familia')?.remove();"));
    check('la grilla scrollea solo si la columna no puede', arr.includes('if (!movioColumna && carril && carril.scrollHeight > carril.clientHeight'));
  });

  report();
  // Los módulos de la UI dejan timers vivos (relojes, persistencia): sin esto, node no termina.
  process.exit(process.exitCode || 0);
})();
