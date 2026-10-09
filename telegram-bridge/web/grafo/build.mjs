#!/usr/bin/env node
/**
 * FEAT-148 G1 — Build de la isla del grafo de Tuberías.
 *
 * Es el único lugar con build de la consola. Compila `src/montar.tsx` (TypeScript +
 * React Flow sobre `preact/compat`) a un solo módulo ES, `public/vendor/grafo.module.js`,
 * que se commitea y el daemon sirve solo si su sha256 coincide con `vendor/MANIFEST.json`,
 * igual que Preact (FEAT-136). La hoja de estilos sale a `public/grafo.css`.
 *
 *   node build.mjs           compila y escribe la salida y el manifiesto
 *   node build.mjs --check   chequea tipos, compila en memoria y compara byte a byte
 *                            con lo commiteado (build reproducible); no escribe nada
 *
 * Preact y sus hooks NO entran al bundle: se resuelven a los vendorizados
 * (`./preact.module.js`, `./hooks.module.js`), así hay una sola instancia de Preact.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(AQUI, '..', 'public');
const VENDOR = path.join(PUBLICO, 'vendor');
const SALIDA_JS = 'grafo.module.js';
const SALIDA_CSS = 'grafo.css';
const ORIGEN = 'grafo';
const EXTERNOS = Object.freeze({ preact: './preact.module.js', 'preact/hooks': './hooks.module.js' });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function exigirDependencias() {
  if (!fs.existsSync(path.join(AQUI, 'node_modules', 'esbuild'))) {
    throw new Error('Faltan las dependencias de la isla del grafo. Corré: npm ci --prefix telegram-bridge/web/grafo');
  }
}

/**
 * La salida solo puede importar los dos vendorizados. Los imports salen del
 * metafile de esbuild (los reales), no de buscar texto: xyflow tiene un aviso
 * que dice `import "@xyflow/react/dist/style.css"` dentro de un string.
 */
export function validarSalida(codigo, imports) {
  const permitidos = new Set(Object.values(EXTERNOS));
  const ajenos = imports.filter((i) => !permitidos.has(i));
  if (ajenos.length) throw new Error(`grafo.module.js importa algo que no es un vendorizado: ${ajenos.join(', ')}`);
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(codigo)) throw new Error('grafo.module.js usa eval o new Function (lo bloquea la CSP)');
}

async function compilar() {
  const esbuild = await import('esbuild');
  const vendorizados = {
    name: 'vendorizados',
    setup(b) {
      b.onResolve({ filter: /^preact(\/hooks)?$/ }, (a) => ({ path: EXTERNOS[a.path], external: true }));
    }
  };
  const r = await esbuild.build({
    absWorkingDir: AQUI,
    entryPoints: ['src/montar.tsx'],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' },
    plugins: [vendorizados],
    legalComments: 'eof',
    charset: 'utf8',
    write: false,
    metafile: true,
    outfile: SALIDA_JS,
    logLevel: 'silent'
  });
  const js = Buffer.from(r.outputFiles[0].contents);
  const codigo = js.toString('utf8');
  const salidaMeta = Object.values(r.metafile.outputs)[0];
  validarSalida(codigo, [...new Set((salidaMeta.imports || []).map((i) => i.path))]);
  const entradas = Object.keys(r.metafile.inputs);
  if (entradas.some((e) => /node_modules\/preact\/(dist\/preact|hooks\/dist\/hooks)\./.test(e))) {
    throw new Error('el bundle trae su propia copia de Preact: tiene que usar la vendorizada');
  }
  const css = Buffer.from([
    '/* FEAT-148 — Generado por telegram-bridge/web/grafo/build.mjs: no editar a mano. */',
    '/* @xyflow/react — MIT */',
    fs.readFileSync(path.join(AQUI, 'node_modules', '@xyflow', 'react', 'dist', 'style.css'), 'utf8').replace(/\r\n/g, '\n').trim(),
    '/* Nodos de Lagrange (src/estilos.css) */',
    fs.readFileSync(path.join(AQUI, 'src', 'estilos.css'), 'utf8').replace(/\r\n/g, '\n').trim(),
    ''
  ].join('\n'), 'utf8');
  return { js, css, paquetes: paquetesDelBundle(entradas) };
}

/** Los paquetes de npm que entraron al bundle, con versión, licencia e integridad del lock. */
function paquetesDelBundle(entradas) {
  const lock = JSON.parse(fs.readFileSync(path.join(AQUI, 'package-lock.json'), 'utf8')).packages || {};
  const nombres = new Set();
  for (const e of entradas) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(e.replace(/\\/g, '/'));
    if (m) nombres.add(m[1]);
  }
  return [...nombres].sort().map((nombre) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(AQUI, 'node_modules', nombre, 'package.json'), 'utf8'));
    const enLock = lock[`node_modules/${nombre}`] || {};
    return { nombre, version: pkg.version, licencia: pkg.license || null, integridad: enLock.integrity || null, tarball: enLock.resolved || null, origen: ORIGEN };
  });
}

/** El manifiesto con las entradas del grafo reemplazadas y las ajenas intactas. */
export function manifiestoConGrafo(previo, { js, paquetes }) {
  const base = previo && typeof previo === 'object' ? previo : { paquetes: [], archivos: {} };
  const archivos = Object.fromEntries(Object.entries(base.archivos || {}).filter(([, a]) => !(a && a.origen === ORIGEN)));
  archivos[SALIDA_JS] = { paquete: 'lagrange-grafo', version: 'build', sha256: sha256(js), origen: ORIGEN };
  return {
    ...base,
    paquetes: [...(base.paquetes || []).filter((p) => !(p && p.origen === ORIGEN)), ...paquetes],
    archivos
  };
}

function chequearTipos() {
  const tsc = path.join(AQUI, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', AQUI], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsc encontró errores de tipos:\n${(r.stdout || '') + (r.stderr || '')}`.trim());
}

/**
 * Compila las `pruebas/*.ts` con esbuild a una carpeta temporal y las corre con Node.
 * No se llaman `*.test.ts`: `claude plugin test` (test:mod) toma esos como tests de mods.
 */
async function correrTests() {
  const esbuild = await import('esbuild');
  const dirTest = path.join(AQUI, 'pruebas');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-grafo-test-'));
  try {
    for (const archivo of fs.readdirSync(dirTest).filter((f) => f.endsWith('.ts')).sort()) {
      const salida = path.join(tmp, archivo.replace(/\.ts$/, '.mjs'));
      await esbuild.build({ absWorkingDir: AQUI, entryPoints: [path.join('pruebas', archivo)], bundle: true, platform: 'node', format: 'esm', outfile: salida, logLevel: 'silent' });
      const r = spawnSync(process.execPath, [salida], { encoding: 'utf8' });
      process.stdout.write(`${archivo}\n${r.stdout || ''}${r.stderr || ''}`);
      if (r.status !== 0) throw new Error(`falló el test ${archivo}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const check = process.argv.includes('--check');
  exigirDependencias();
  const rutaManifiesto = path.join(VENDOR, 'MANIFEST.json');
  const previo = JSON.parse(fs.readFileSync(rutaManifiesto, 'utf8'));
  if (check) {
    chequearTipos();
    await correrTests();
  }
  const salida = await compilar();
  const manifiesto = manifiestoConGrafo(previo, salida);
  if (!check) {
    fs.writeFileSync(path.join(VENDOR, SALIDA_JS), salida.js);
    fs.writeFileSync(path.join(PUBLICO, SALIDA_CSS), salida.css);
    fs.writeFileSync(rutaManifiesto, `${JSON.stringify({ ...manifiesto, generado: previo.generado }, null, 2)}\n`);
    console.log(`grafo.module.js ${(salida.js.length / 1024).toFixed(1)} KB · sha256 ${sha256(salida.js).slice(0, 12)} · ${salida.paquetes.length} paquetes en el bundle`);
    return;
  }
  const diferencias = [];
  const leer = (ruta) => { try { return fs.readFileSync(ruta); } catch { return null; } };
  if (!salida.js.equals(leer(path.join(VENDOR, SALIDA_JS)) || Buffer.alloc(0))) diferencias.push(`vendor/${SALIDA_JS}`);
  if (!salida.css.equals(leer(path.join(PUBLICO, SALIDA_CSS)) || Buffer.alloc(0))) diferencias.push(SALIDA_CSS);
  const enArchivo = JSON.stringify({ a: previo.archivos?.[SALIDA_JS], p: (previo.paquetes || []).filter((p) => p.origen === ORIGEN) });
  const esperado = JSON.stringify({ a: manifiesto.archivos[SALIDA_JS], p: manifiesto.paquetes.filter((p) => p.origen === ORIGEN) });
  if (enArchivo !== esperado) diferencias.push('vendor/MANIFEST.json (entradas del grafo)');
  if (diferencias.length) throw new Error(`El build del grafo no coincide con lo commiteado: ${diferencias.join(', ')}. Corré npm run grafo:build y commiteá el resultado.`);
  console.log('grafo: tipos OK y build reproducible (coincide byte a byte con lo commiteado)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
