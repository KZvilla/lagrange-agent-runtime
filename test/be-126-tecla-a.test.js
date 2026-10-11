/**
 * BE-126 — La tecla A del editor de grafos (FEAT-156) no abría nunca la paleta de nodos: su guarda buscaba cualquier
 * `[aria-modal="true"]`, y la paleta de comandos general vive siempre en el DOM, oculta con `hidden`. Lo encontró
 * Codex en el smoke de Lagrange Desktop. Ahora solo cuenta un modal visible.
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert.js');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const editor = fs.readFileSync(path.join(UI, 'tuberias-editor-grafo.js'), 'utf8');
const cuerpo = /export const modalVisible = (\(doc = document\) => .*);\s*$/m.exec(editor)?.[1];
const modalVisible = new Function('document', `return ${cuerpo};`)(null);

/** Un DOM mínimo: cada elemento sabe si algún ancestro tiene `hidden`. */
const el = (oculto) => ({ closest: (sel) => (sel === '[hidden]' && oculto ? {} : null) });
const doc = (...elementos) => ({ querySelectorAll: (sel) => (sel === '[aria-modal="true"]' ? elementos : []) });

(async () => {
  await group('qué cuenta como modal abierto', () => {
    check('la función existe y la usa la guarda de la tecla A', Boolean(cuerpo) && /!paleta\.value && !menu\.value && !modalVisible\(\)\)/.test(editor) && !/document\.querySelector\('\[aria-modal="true"\]'\)/.test(editor));
    check('sin modales: no hay', modalVisible(doc()) === false);
    check('la paleta general oculta (hidden) no cuenta', modalVisible(doc(el(true))) === false);
    check('un diálogo visible sí cuenta (renombrar, reconstruir…)', modalVisible(doc(el(true), el(false))) === true);
    const paleta = fs.readFileSync(path.join(UI, 'paleta.js'), 'utf8');
    check('la paleta general sigue oculta con hidden en un ancestro (lo que mira la guarda)', /class="paleta-fondo"[^>]*hidden=\$\{!abierta\}/.test(paleta) && /role="dialog" aria-modal="true"/.test(paleta));
  });
  report();
})();
