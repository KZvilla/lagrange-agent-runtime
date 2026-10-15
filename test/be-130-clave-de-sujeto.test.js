/**
 * BE-130 — FEAT-160 F4 mudó `claveDeSujeto` a reglas-filtro.js sin exportarla
 * ni importarla en vista-tablero.js: abrir el detalle de una tarjeta de Por
 * hacer asignada tiraba `ReferenceError` y el tablero quedaba en blanco hasta
 * recargar. Acá: la función anda, y todo archivo de ui/ que llama a una función
 * de reglas-filtro.js o reglas-tablero.js la define o la importa.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (f) => fs.readFileSync(path.join(UI, f), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  const R = await import(pathToFileURL(path.join(UI, 'reglas-filtro.js')).href);

  await group('La función', () => {
    check('se exporta', typeof R.claveDeSujeto === 'function');
    check('alma y agente', R.claveDeSujeto({ tipo: 'alma', clave: 'alya' }) === 'alma:alya' && R.claveDeSujeto({ tipo: 'agente', nombre: 'revisor' }) === 'agente:revisor');
  });

  await group('Quien la llama, la importa', async () => {
    for (const modulo of ['reglas-filtro.js', 'reglas-tablero.js']) {
      const exportadas = Object.keys(await import(pathToFileURL(path.join(UI, modulo)).href)).filter((n) => /^[a-z]/.test(n));
      const fuente = leer(modulo);
      // Las funciones internas (no exportadas) también: si alguien las llama desde otro archivo, tiene que fallar acá.
      const internas = [...fuente.matchAll(/^(?:const|function)\s+([a-z][\w$]*)/gm)].map((m) => m[1]);
      for (const f of fs.readdirSync(UI).filter((x) => x.endsWith('.js') && x !== modulo)) {
        const t = leer(f);
        const importa = new Set();
        for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) for (const p of m[1].split(',')) importa.add(p.split(/\s+as\s+/).pop().trim());
        const propias = new Set([...t.matchAll(/\b(?:function|const|let)\s+([a-z][\w$]*)/g)].map((m) => m[1]));
        const usa = [...new Set([...exportadas, ...internas])].filter((n) => new RegExp(`(^|[^.\\w$])${n}\\(`).test(t));
        const sinOrigen = usa.filter((n) => !importa.has(n) && !propias.has(n));
        check(`${f}: lo que llama de ${modulo} está importado`, sinOrigen.length === 0, sinOrigen.join(' '));
      }
    }
  });

  check('vista-tablero.js importa claveDeSujeto', /import \{[^}]*\bclaveDeSujeto\b[^}]*\} from '\.\/reglas-filtro\.js';/.test(leer('vista-tablero.js')));
  report();
})();
