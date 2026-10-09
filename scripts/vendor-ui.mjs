#!/usr/bin/env node
/**
 * FEAT-136 F0 — Vendoriza Preact, @preact/signals y htm para la consola web.
 *
 * La consola no tiene build (CSP `script-src 'self'`, sin importmap inline):
 * los módulos ES se copian a `telegram-bridge/web/public/vendor/` con sus
 * imports reescritos a rutas relativas, y `MANIFEST.json` guarda el sha256 de
 * cada uno. El daemon solo sirve un vendorizado cuyo sha256 coincide.
 *
 * Se corre a mano para actualizar (`npm run vendor:ui`), nunca en la build:
 *   1. baja el tarball exacto de cada paquete del registro de npm;
 *   2. verifica su `integrity` (sha512) contra la que publica el registro;
 *   3. extrae los archivos `.mjs` y la licencia;
 *   4. reescribe los imports desnudos (`preact`, `preact/hooks`,
 *      `@preact/signals-core`) a `./<archivo>.module.js`, y falla si queda
 *      alguno sin reescribir;
 *   5. escribe el manifiesto.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = path.join(RAIZ, 'telegram-bridge', 'web', 'public', 'vendor');
const REGISTRO = 'https://registry.npmjs.org';

export const PAQUETES = [
  { nombre: 'preact', version: '11.0.0', licencia: 'MIT', archivos: [['package/dist/preact.mjs', 'preact.module.js'], ['package/hooks/dist/hooks.mjs', 'hooks.module.js']] },
  { nombre: '@preact/signals-core', version: '1.14.4', licencia: 'MIT', archivos: [['package/dist/signals-core.mjs', 'signals-core.module.js']] },
  { nombre: '@preact/signals', version: '2.11.3', licencia: 'MIT', archivos: [['package/dist/signals.mjs', 'signals.module.js']] },
  { nombre: 'htm', version: '3.1.1', licencia: 'Apache-2.0', archivos: [['package/dist/htm.mjs', 'htm.module.js']] }
];

export const REESCRITURAS = Object.freeze({
  preact: './preact.module.js',
  'preact/hooks': './hooks.module.js',
  '@preact/signals-core': './signals-core.module.js'
});

/** Reescribe los imports desnudos; lanza si queda un especificador que no empieza con `./`. */
export function reescribirImports(codigo, archivo) {
  const salida = codigo.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g, (todo, antes, comilla, espec) => {
    if (espec.startsWith('./')) return todo;
    if (!Object.hasOwn(REESCRITURAS, espec)) throw new Error(`${archivo}: import sin reescritura conocida: ${espec}`);
    return `${antes}${comilla}${REESCRITURAS[espec]}${comilla}`;
  });
  return salida;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * FEAT-148 — El manifiesto tiene dos escritores: este script y el build del
 * grafo (`telegram-bridge/web/grafo/build.mjs`), cuyas entradas llevan
 * `origen`. Cada uno reemplaza solo lo suyo: acá se conservan las ajenas.
 */
export function fusionarManifiesto(previo, nuevo) {
  const paquetesAjenos = ((previo && previo.paquetes) || []).filter((p) => p && p.origen);
  const archivosAjenos = Object.fromEntries(Object.entries((previo && previo.archivos) || {}).filter(([, a]) => a && a.origen));
  return { ...nuevo, paquetes: [...nuevo.paquetes, ...paquetesAjenos], archivos: { ...nuevo.archivos, ...archivosAjenos } };
}

async function bajar(url) {
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function vendorizar() {
  fs.mkdirSync(DESTINO, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-ui-'));
  const manifiesto = { generado: new Date().toISOString(), paquetes: [], archivos: {} };
  try {
    for (const p of PAQUETES) {
      const meta = JSON.parse((await bajar(`${REGISTRO}/${p.nombre.replace('/', '%2f')}/${p.version}`)).toString('utf8'));
      const integridad = meta.dist && meta.dist.integrity;
      if (!/^sha512-/.test(integridad || '')) throw new Error(`${p.nombre}: el registro no publica integrity sha512`);
      const tarball = await bajar(meta.dist.tarball);
      const calculada = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
      if (calculada !== integridad) throw new Error(`${p.nombre}@${p.version}: integrity no coincide`);
      const dir = path.join(tmp, p.nombre.replace('/', '__'));
      fs.mkdirSync(dir);
      const archivoTgz = path.join(dir, 'p.tgz');
      fs.writeFileSync(archivoTgz, tarball);
      const tar = spawnSync('tar', ['-xzf', 'p.tgz'], { cwd: dir, encoding: 'utf8' });
      if (tar.status !== 0) throw new Error(`${p.nombre}: tar falló: ${tar.stderr}`);
      for (const [origen, destino] of p.archivos) {
        const codigo = reescribirImports(fs.readFileSync(path.join(dir, origen), 'utf8'), destino);
        fs.writeFileSync(path.join(DESTINO, destino), codigo);
        manifiesto.archivos[destino] = { paquete: p.nombre, version: p.version, sha256: sha256(Buffer.from(codigo, 'utf8')) };
      }
      const licencia = fs.readFileSync(path.join(dir, 'package', 'LICENSE'));
      fs.writeFileSync(path.join(DESTINO, `${p.nombre.replace('/', '__').replace('@', '')}.LICENSE.txt`), licencia);
      manifiesto.paquetes.push({ nombre: p.nombre, version: p.version, licencia: p.licencia, integridad, tarball: meta.dist.tarball });
      console.log(`✓ ${p.nombre}@${p.version}`);
    }
    let previo = null;
    try { previo = JSON.parse(fs.readFileSync(path.join(DESTINO, 'MANIFEST.json'), 'utf8')); } catch {}
    fs.writeFileSync(path.join(DESTINO, 'MANIFEST.json'), `${JSON.stringify(fusionarManifiesto(previo, manifiesto), null, 2)}\n`);
    console.log(`Manifiesto: ${Object.keys(manifiesto.archivos).length} archivos en ${path.relative(RAIZ, DESTINO)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  vendorizar().catch((err) => { console.error(err.message); process.exit(1); });
}
