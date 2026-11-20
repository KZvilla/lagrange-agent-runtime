/**
 * FEAT-202 S7 (D10) — El orden de los módulos: lo que es solo de agy vive en `motores/antigravity/`, los nombres viejos
 * de `lib/` son reexports obsoletos (el mismo objeto, para que un parche de un test siga aplicando), y el código del
 * plugin no carga ningún reexport. Los ciclos los cubre `feat-202-s0-capacidades`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const MCP = path.join(RAIZ, 'mcp-server');

const MOVIDOS = {
  'agy-bin': 'bin', 'agy-image': 'image', 'agy-modo': 'modo', 'corte-agy': 'corte',
  'hilos-agy': 'hilos', 'limite-agy': 'limite', 'opciones-agy': 'opciones', 'pedidos-agy': 'pedidos'
};
// Los reexports obsoletos: los ocho de S7, más los de S3 y S4.
const REEXPORTS = [
  ...Object.keys(MOVIDOS).map((v) => path.join(MCP, 'lib', `${v}.js`)),
  path.join(MCP, 'lib', 'uso-agy.js'),
  path.join(MCP, 'motores', 'deepseek-lectura.js')
];

async function main() {
  await group('los módulos de agy en motores/antigravity/', () => {
    for (const [viejo, nuevo] of Object.entries(MOVIDOS)) {
      const destino = path.join(MCP, 'motores', 'antigravity', `${nuevo}.js`);
      check(`${nuevo}.js existe`, fs.existsSync(destino));
      check(`lib/${viejo}.js es el mismo módulo`, require(path.join(MCP, 'lib', `${viejo}.js`)) === require(destino));
      const fuente = fs.readFileSync(path.join(MCP, 'lib', `${viejo}.js`), 'utf8');
      check(`lib/${viejo}.js es solo un reexport marcado como obsoleto`, /Obsoleto/.test(fuente) && (fuente.match(/require\(/g) || []).length === 1);
    }
  });

  await group('el código del plugin no carga un reexport', () => {
    const archivos = execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8' }).split('\n')
      .filter((f) => /\.(c?js|mjs)$/.test(f) && !/^(test|telegram-bridge\/test|docs)\//.test(f));
    const re = /(?:require(?:Cjs)?\(\s*|from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    const usos = [];
    for (const f of archivos) {
      const abs = path.join(RAIZ, f);
      if (!fs.existsSync(abs) || REEXPORTS.includes(abs)) continue;
      const s = fs.readFileSync(abs, 'utf8');
      let m;
      while ((m = re.exec(s))) {
        let t = path.resolve(path.dirname(abs), m[1]);
        if (!t.endsWith('.js') && fs.existsSync(`${t}.js`)) t = `${t}.js`;
        if (REEXPORTS.includes(t)) usos.push(`${f} → ${path.relative(RAIZ, t)}`);
      }
    }
    check('ningún require del plugin apunta a un reexport', usos.length === 0, usos.join('\n'));
    check('se revisó el código del plugin y del bridge', archivos.some((f) => f === 'mcp-server/index.js') && archivos.some((f) => f === 'telegram-bridge/bot.js'));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
