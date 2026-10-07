/**
 * FEAT-117 fase 0 — El subagente `agy` corre en Haiku: solo arma la llamada a
 * la tool de agy y devuelve su respuesta (el razonamiento es de Gemini). Sin
 * `model`, heredaba el modelo de la sesión (Opus).
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

group('agents/agy.md declara model: haiku en su frontmatter', () => {
  const texto = fs.readFileSync(path.join(__dirname, '..', 'agents', 'agy.md'), 'utf8');
  const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  check('tiene frontmatter', Boolean(m));
  check('model: haiku', Boolean(m) && /^model:\s*haiku\s*$/m.test(m[1]));
});

report();
