/**
 * FEAT-148 G1 — La isla del grafo, sin compilar nada (el build y sus tipos los
 * prueba el gate `grafo:check`): lo commiteado coincide con el manifiesto, el
 * módulo solo importa los vendorizados, el daemon lo sirve y vendor-ui.mjs
 * conserva las entradas del grafo.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const WEB = path.join(RAIZ, 'telegram-bridge', 'web');
const PUBLICO = path.join(WEB, 'public');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  const manifiesto = JSON.parse(fs.readFileSync(path.join(PUBLICO, 'vendor', 'MANIFEST.json'), 'utf8'));
  const modulo = fs.readFileSync(path.join(PUBLICO, 'vendor', 'grafo.module.js'));
  const codigo = modulo.toString('utf8');

  await group('isla del grafo: lo commiteado', () => {
    const entrada = manifiesto.archivos['grafo.module.js'];
    check('grafo.module.js está en el manifiesto con origen "grafo"', entrada && entrada.origen === 'grafo');
    check('su sha256 coincide con el manifiesto', entrada && sha256(modulo) === entrada.sha256);
    // Imports de nivel de módulo (el minificado los deja al principio, tras `;` o `}`).
    const imports = [...codigo.matchAll(/(?:^|[;}])\s*import\s*(?:[\w$*{}\s,]+from\s*)?"([^"]+)"/g)].map((m) => m[1]);
    check('solo importa los dos vendorizados de Preact', imports.length > 0 && imports.every((i) => i === './preact.module.js' || i === './hooks.module.js'), imports.join(', '));
    check('no trae eval ni new Function', !/\beval\s*\(|\bnew\s+Function\s*\(/.test(codigo));
    check('los paquetes del bundle tienen licencia en el manifiesto',
      manifiesto.paquetes.filter((p) => p.origen === 'grafo').length > 0 && manifiesto.paquetes.filter((p) => p.origen === 'grafo').every((p) => p.licencia && p.version));
    check('grafo.css existe y viene del build', fs.readFileSync(path.join(PUBLICO, 'grafo.css'), 'utf8').startsWith('/* FEAT-148 — Generado por'));
  });

  await group('isla del grafo: fuente', () => {
    const src = path.join(WEB, 'grafo', 'src');
    const fuentes = fs.readdirSync(src).filter((f) => /\.tsx?$/.test(f)).map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');
    check('la fuente no usa dangerouslySetInnerHTML ni innerHTML', !/dangerouslySetInnerHTML|innerHTML/.test(fuentes));
    check('la isla no hace fetch: la consola le pasa los datos', !/\bfetch\s*\(/.test(fuentes));
    check('exporta montar con actualizar y desmontar', /export function montar\(/.test(fuentes) && /actualizar:/.test(fuentes) && /desmontar:/.test(fuentes));
  });

  await group('servido por el daemon', async () => {
    const { cargarModulosUI } = await import(pathToFileURL(path.join(WEB, 'modulos-ui.js')).href);
    const { rutas } = cargarModulosUI({ dirPublico: PUBLICO });
    check('cargarModulosUI sirve /vendor/grafo.module.js (sha verificado)', rutas.has('/vendor/grafo.module.js'));
    const servidor = fs.readFileSync(path.join(WEB, 'servidor.js'), 'utf8');
    check('/grafo.css está entre los estáticos', /'\/grafo\.css': \['grafo\.css', 'text\/css; charset=utf-8'\]/.test(servidor));
  });

  await group('vendor-ui.mjs conserva las entradas del grafo', async () => {
    const { fusionarManifiesto } = await import(pathToFileURL(path.join(RAIZ, 'scripts', 'vendor-ui.mjs')).href);
    const previo = {
      paquetes: [{ nombre: 'preact', version: '10' }, { nombre: 'zustand', version: '4', origen: 'grafo' }],
      archivos: { 'preact.module.js': { sha256: 'viejo' }, 'grafo.module.js': { sha256: 'g', origen: 'grafo' } }
    };
    const nuevo = { generado: 'x', paquetes: [{ nombre: 'preact', version: '11' }], archivos: { 'preact.module.js': { sha256: 'nuevo' } } };
    const r = fusionarManifiesto(previo, nuevo);
    check('reemplaza lo suyo', r.archivos['preact.module.js'].sha256 === 'nuevo' && r.paquetes.filter((p) => p.nombre === 'preact').length === 1 && r.paquetes[0].version === '11');
    check('conserva lo del grafo', r.archivos['grafo.module.js'].sha256 === 'g' && r.paquetes.some((p) => p.nombre === 'zustand'));
    check('sin manifiesto previo, es el nuevo', JSON.stringify(fusionarManifiesto(null, nuevo).archivos) === JSON.stringify(nuevo.archivos));
  });

  report();
}

main();
