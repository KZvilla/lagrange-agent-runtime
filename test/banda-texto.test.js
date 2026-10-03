/**
 * FEAT-109 — El veredicto de la banda de agy es el mismo que el del lote.
 *
 * `hooks/banda-texto.ts` no puede importar `parsearVeredicto` (el mod no tiene
 * Node) y este runner no carga TypeScript: como test/be-098, la regex se saca
 * de la fuente y se corre junto a la del auditor sobre los mismos casos.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');
const { parsearVeredicto } = require('../mcp-server/lotes/auditor.js');

const fuente = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'banda-texto.ts'), 'utf8').replace(/\r\n/g, '\n');
const m = /^const VEREDICTO = (\/.+\/[a-z]*)$/m.exec(fuente);
const VEREDICTO = m ? new Function(`return ${m[1]};`)() : null;
const veredictoDe = (texto) => {
  const r = VEREDICTO.exec(String(texto ?? ''));
  return r ? r[1].toUpperCase() : null;
};

group('la regex está en la fuente', () => {
  check('const VEREDICTO = /…/ en banda-texto.ts', VEREDICTO instanceof RegExp, m && m[1]);
});

group('paridad con parsearVeredicto', () => {
  const casos = {
    pass: '# Auditoría\n\n## Verdict: PASS\n\nTodo bien.',
    reservas: '## Verdict: PASS WITH RESERVATIONS\n',
    fail: 'texto\n## Verdict: FAIL\nmás',
    minusculas: '## verdict: pass with reservations',
    espacios: '## Verdict:    FAIL   ',
    sinVeredicto: 'Sin veredicto en ningún lado.',
    enMedio: 'Resumen: ## Verdict: PASS (no es una línea propia)',
    otroValor: '## Verdict: MAYBE',
    vacio: '',
    nulo: null
  };
  for (const [nombre, texto] of Object.entries(casos)) {
    const a = VEREDICTO ? veredictoDe(texto) : 'sin-regex';
    const b = parsearVeredicto(texto);
    check(`${nombre}: ${JSON.stringify(b)}`, a === b, `banda=${a} lote=${b}`);
  }
});

report();
