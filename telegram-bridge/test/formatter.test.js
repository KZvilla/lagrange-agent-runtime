/**
 * BE-176 — Grupo formatter: Tests 3, 14, 15, 18 y 19.
 *
 * Son funciones puras de `formatter.js`: no usan `state`, `queue`, `tg` ni el
 * estado compartido de `test-bridge.js`. El resto de la suite sigue en
 * `test-bridge.js`; el Test 35 vive en `test/importacion.test.js`.
 *
 * Los bloques se movieron verbatim: mismos casos, textos y aserciones.
 */
import assert from 'node:assert';
import { splitMessage, markdownToTelegramHtml, escapeHtml, formatElapsed, finalProgressLabel } from '../formatter.js';

// Test 3: división de mensajes. La aserción anterior (`chunks[0].includes('```')`)
// pasaba trivialmente porque el propio texto de prueba lleva fences: lo que
// importa es que TODO trozo quede con los fences equilibrados y dentro del límite.
const shortText = 'Hola mundo!';
assert.strictEqual(splitMessage(shortText, 50).length, 1, 'Texto corto no se divide');

const fencesEquilibrados = (chunk) => ((chunk.match(/```/g) || []).length % 2) === 0;
const sinTrozosVacios = (cs) => cs.every((c) => c.replace(/```[^\n]*/g, '').trim().length > 0);

const casosSplit = {
  // El fence de apertura es justo la línea que desborda: cerrar el trozo
  // anterior dejaría un fence huérfano de un bloque que nunca se abrió.
  'apertura desborda': ['x'.repeat(35) + '\n```js\ncode aqui\n```\nfin', 40],
  // Una sola línea más larga que el límite, dentro de un bloque.
  'linea gigante': ['```js\n' + 'z'.repeat(120) + '\n```', 50],
  // El texto termina dentro de un bloque sin cerrar.
  'termina abierto': ['a'.repeat(30) + '\n```js\n' + 'b'.repeat(30), 40],
  'texto plano largo': [Array.from({ length: 12 }, (_, i) => `Linea ${i} con algo de texto.`).join('\n'), 60]
};

for (const [nombre, [texto, limite]] of Object.entries(casosSplit)) {
  const cs = splitMessage(texto, limite);
  assert(cs.length >= 2, `${nombre}: debe dividirse`);
  assert(cs.every(fencesEquilibrados), `${nombre}: todo trozo con fences equilibrados`);
  assert(cs.every((c) => c.length <= limite), `${nombre}: ningún trozo supera el límite`);
  assert(sinTrozosVacios(cs), `${nombre}: sin trozos que sean solo un bloque vacío`);
}
console.log(`✔ Test 3: splitMessage equilibra fences en ${Object.keys(casosSplit).length} casos límite`);

// Test 14: el formateo a HTML es determinista y nunca produce marcado inválido.
assert.strictEqual(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d', 'Escapa los tres caracteres');
assert.strictEqual(
  markdownToTelegramHtml('<script>alert(1)</script>'),
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  'El HTML del usuario se escapa, no se interpreta'
);
assert.strictEqual(markdownToTelegramHtml('*negrita* y _cursiva_'), '<b>negrita</b> y <i>cursiva</i>');
assert.strictEqual(markdownToTelegramHtml('**doble** tambien'), '<b>doble</b> tambien');
assert.strictEqual(markdownToTelegramHtml('con `codigo` dentro'), 'con <code>codigo</code> dentro');
assert.strictEqual(
  markdownToTelegramHtml('el `a < b` escapa'),
  'el <code>a &lt; b</code> escapa',
  'El código en línea también se escapa'
);

// Lo que rompía el Markdown legado: marcadores sueltos. Ahora salen literales.
for (const suelto of ['foo_bar sin pareja', 'un * asterisco suelto', 'guion_bajo_medio', 'a ** b']) {
  const html = markdownToTelegramHtml(suelto);
  assert(!html.includes('<b>') && !html.includes('<i>'), `Marcador suelto literal: ${suelto}`);
}

const conBloque = markdownToTelegramHtml('texto\n```js\nif (a < b && c) {}\n```');
assert(
  conBloque.includes('<pre><code class="language-js">if (a &lt; b &amp;&amp; c) {}</code></pre>'),
  `El bloque de código se escapa y se etiqueta: ${conBloque}`
);
assert(
  markdownToTelegramHtml('```py\nprint(1)').includes('</code></pre>'),
  'Un bloque sin cerrar se cierra implícitamente'
);

// Ninguna etiqueta abierta puede quedar sin cerrar en la salida.
const abiertas = (conBloque.match(/<[a-z]+[^>]*>/g) || []).length;
const cerradas = (conBloque.match(/<\/[a-z]+>/g) || []).length;
assert.strictEqual(abiertas, cerradas, 'Toda etiqueta emitida se cierra');
console.log('✔ Test 14: markdownToTelegramHtml es determinista y escapa siempre');

// Test 15: formatElapsed, usado por el mensaje de progreso editable.
assert.strictEqual(formatElapsed(0), '0s');
assert.strictEqual(formatElapsed(45), '45s');
assert.strictEqual(formatElapsed(65), '1m 05s');
assert.strictEqual(formatElapsed(3599), '59m 59s');
assert.strictEqual(formatElapsed(3600), '1h 00m');
// El caso que disparó el arreglo: 18733.2s de sesión acumulada.
assert.strictEqual(formatElapsed(18733.2), '5h 12m');
console.log('✔ Test 15: formatElapsed');

// Test 18: una cancelación tiene etiqueta propia. Compartía la del fallo, así
// que /cancel dejaba el mensaje en «⚠️ Terminado con error tras 21s» y parecía
// que la tarea había reventado sola.
assert.strictEqual(finalProgressLabel({ cancelled: true, success: false }), '🛑 Cancelado tras');
assert.strictEqual(finalProgressLabel({ success: true }), '✅ Completado en');
assert.strictEqual(finalProgressLabel({ success: false }), '⚠️ Terminado con error tras');
console.log('✔ Test 18: finalProgressLabel distingue cancelación de error');

// Test 19: el enfasis que envuelve codigo en linea. Se procesaban los tramos a
// ambos lados del codigo por separado, asi que cada asterisco de
// *negrita con `codigo` dentro* caia en un tramo distinto, no casaba ninguno y
// los asteriscos llegaban literales al mensaje.
assert.strictEqual(
  markdownToTelegramHtml('*17 commits en `main`, release `v0.4.0` publicada.*'),
  '<b>17 commits en <code>main</code>, release <code>v0.4.0</code> publicada.</b>',
  'La negrita debe abarcar el codigo en linea'
);
assert.strictEqual(
  markdownToTelegramHtml('_cursiva con `code` dentro_'),
  '<i>cursiva con <code>code</code> dentro</i>',
  'Lo mismo para la cursiva'
);
// El centinela interno no debe poder inyectarse desde el texto del usuario.
assert.strictEqual(
  markdownToTelegramHtml('\u00000\u0000 y `x`'),
  '0 y <code>x</code>',
  'Un centinela escrito por el usuario se descarta'
);
assert.strictEqual(
  markdownToTelegramHtml('`<script>alert(1)</script>`'),
  '<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>',
  'El codigo en linea se sigue escapando'
);
console.log('✔ Test 19: el enfasis abarca el codigo en linea');
