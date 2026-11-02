#!/usr/bin/env node
/**
 * BE-172 — El helper de escritura atómica comparte la resiliencia de Windows
 * sin cambiar modos ni dejar temporales.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const HELPER = path.join(__dirname, '..', 'mcp-server', 'lib', 'fs-atomico.js');
const { escribirAtomico } = require(HELPER);

function correr(args) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    hijo.stderr.on('data', (d) => { err += d; });
    hijo.on('close', (code) => resolve({ code, err }));
  });
}

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'be-172-'));

  try {
    await group('BE-172: V1 — EPERM transitorio', () => {
      const ruta = path.join(raiz, 'v1.txt');
      const original = fs.renameSync;
      let intentos = 0;
      fs.renameSync = (...args) => {
        intentos += 1;
        if (intentos <= 2) throw Object.assign(new Error('ocupado'), { code: 'EPERM' });
        return original(...args);
      };
      try {
        escribirAtomico(ruta, 'contenido');
      } finally {
        fs.renameSync = original;
      }
      const temporales = fs.readdirSync(raiz).filter((f) => f.startsWith('v1.txt.tmp-'));
      check('V1 escribe tras dos EPERM', fs.readFileSync(ruta, 'utf8') === 'contenido', String(intentos));
      check('V1 no deja temporales', temporales.length === 0, temporales.join(', '));
    });

    await group('BE-172: V2 — EPERM permanente', () => {
      const ruta = path.join(raiz, 'v2.txt');
      const original = fs.renameSync;
      fs.renameSync = () => { throw Object.assign(new Error('ocupado'), { code: 'EPERM' }); };
      let error = null;
      try {
        escribirAtomico(ruta, 'contenido', { esperaRenombreMs: 50 });
      } catch (e) {
        error = e;
      } finally {
        fs.renameSync = original;
      }
      const temporales = fs.readdirSync(raiz).filter((f) => f.startsWith('v2.txt.tmp-'));
      check('V2 propaga EPERM', error && error.code === 'EPERM', String(error));
      check('V2 no deja temporales', temporales.length === 0, temporales.join(', '));
    });

    await group('BE-172: V3 — dos procesos', async () => {
      const ruta = path.join(raiz, 'v3.json');
      const script = path.join(raiz, 'escritor-v3.cjs');
      fs.writeFileSync(script, `
        const { escribirAtomico } = require(${JSON.stringify(HELPER)});
        escribirAtomico(process.argv[2], JSON.stringify({ quien: process.argv[3] }));
      `);
      const [a, b] = await Promise.all([
        correr([script, ruta, 'a']),
        correr([script, ruta, 'b'])
      ]);
      const temporales = fs.readdirSync(raiz).filter((f) => f.startsWith('v3.json.tmp-'));
      const quien = JSON.parse(fs.readFileSync(ruta, 'utf8')).quien;
      check('V3 los dos procesos terminan 0', a.code === 0 && b.code === 0, `${a.code}/${b.code} ${a.err} ${b.err}`);
      check('V3 el archivo final es uno de los dos', quien === 'a' || quien === 'b', quien);
      check('V3 no deja temporales', temporales.length === 0, temporales.join(', '));
    });

    await group('BE-172: V4 — modos', () => {
      const rutaDefault = path.join(raiz, 'v4-default.txt');
      const rutaPrivada = path.join(raiz, 'v4-privada.txt');
      escribirAtomico(rutaDefault, 'x');
      escribirAtomico(rutaPrivada, 'x', { mode: 0o600 });
      if (process.platform !== 'win32') {
        const umask = process.umask();
        const esperado = 0o666 & ~umask;
        check('V4 conserva el modo por defecto', (fs.statSync(rutaDefault).mode & 0o777) === esperado, `${(fs.statSync(rutaDefault).mode & 0o777).toString(8)} vs ${esperado.toString(8)}`);
        check('V4 respeta 0600 explícito', (fs.statSync(rutaPrivada).mode & 0o777) === 0o600);
      }
    });

    await group('BE-172: V5 — errores no transitorios', () => {
      const ruta = path.join(raiz, 'v5.txt');
      const original = fs.renameSync;
      fs.renameSync = () => { throw Object.assign(new Error('sin espacio'), { code: 'ENOSPC' }); };
      const t0 = Date.now();
      let error = null;
      try {
        escribirAtomico(ruta, 'contenido');
      } catch (e) {
        error = e;
      } finally {
        fs.renameSync = original;
      }
      const ms = Date.now() - t0;
      check('V5 propaga ENOSPC', error && error.code === 'ENOSPC', String(error));
      check('V5 no espera el deadline', ms < 200, `${ms} ms`);
      const temporales = fs.readdirSync(raiz).filter((f) => f.startsWith('v5.txt.tmp-'));
      check('V5 no deja temporales', temporales.length === 0, temporales.join(', '));

      const rutaRetry = path.join(raiz, 'v5-retry.txt');
      const originalRetry = fs.renameSync;
      let intentos = 0;
      fs.renameSync = (...args) => {
        intentos += 1;
        if (intentos === 1) throw Object.assign(new Error('sin permiso'), { code: 'EACCES' });
        return originalRetry(...args);
      };
      try {
        escribirAtomico(rutaRetry, 'contenido');
      } finally {
        fs.renameSync = originalRetry;
      }
      check('V5 EACCES sí se reintenta', fs.readFileSync(rutaRetry, 'utf8') === 'contenido' && intentos === 2, String(intentos));
    });
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
