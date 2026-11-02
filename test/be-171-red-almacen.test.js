#!/usr/bin/env node
/**
 * BE-171 — El estado de la red no se pisa si el archivo está corrupto o el
 * lock no se toma.
 *
 * V1-V9 del plan `docs/future-implementations/BE/BE-171/`. Todo determinista:
 * locks a mano, `esperaLockMs`/`lockViejoMs` cortos y dos procesos para la
 * prueba de concurrencia.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const BRIDGE = path.join(RAIZ, 'telegram-bridge');
const ALMACEN = path.join(BRIDGE, 'red', 'almacen.js');
const IDENTIDAD = path.join(BRIDGE, 'red', 'identidad.js');
const imp = (f) => import(pathToFileURL(f).href);

function correr(args) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    hijo.stderr.on('data', (d) => { err += d; });
    hijo.on('close', (code) => resolve({ code, err }));
  });
}

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'be-171-'));
  const almacen = await imp(ALMACEN);
  const identidad = await imp(IDENTIDAD);

  try {
    await group('BE-171: V1 — servidor.json truncado', () => {
      const dir = path.join(raiz, 'v1');
      fs.mkdirSync(dir, { recursive: true });
      const archivo = path.join(dir, 'servidor.json');
      const original = '{"servidorId":"cortado';
      fs.writeFileSync(archivo, original);

      let error = null;
      try { identidad.identidadServidor(dir); } catch (e) { error = e; }
      const copias = fs.readdirSync(dir).filter((f) => f.startsWith('servidor.json.corrupto-'));

      check('V1 lanza JsonCorruptoError', error && error.code === 'EJSONCORRUPTO' && error instanceof SyntaxError, String(error));
      check('V1 no agrega servidorId', fs.readFileSync(archivo, 'utf8') === original);
      check('V1 deja una cuarentena', copias.length === 1, copias.join(', '));
      if (copias.length === 1) {
        check('V1 la cuarentena tiene los bytes originales', fs.readFileSync(path.join(dir, copias[0]), 'utf8') === original);
        if (process.platform !== 'win32') {
          check('V1 la cuarentena queda 0600', (fs.statSync(path.join(dir, copias[0])).mode & 0o777) === 0o600);
        }
      }
    });

    await group('BE-171: V2 — nodos.json truncado', () => {
      const dir = path.join(raiz, 'v2');
      fs.mkdirSync(dir, { recursive: true });
      const archivo = path.join(dir, 'nodos.json');
      const original = '{"nodos": [';
      fs.writeFileSync(archivo, original);

      let error = null;
      let muto = false;
      try {
        identidad.mutarNodos(dir, (d) => { muto = true; d.nodos.push({ id: 'x' }); });
      } catch (e) { error = e; }
      const copias = fs.readdirSync(dir).filter((f) => f.startsWith('nodos.json.corrupto-'));

      check('V2 lanza JsonCorruptoError', error && error.code === 'EJSONCORRUPTO', String(error));
      check('V2 no ejecuta la mutación', !muto);
      check('V2 no pisa el original', fs.readFileSync(archivo, 'utf8') === original);
      check('V2 deja una cuarentena', copias.length === 1, copias.join(', '));
    });

    await group('BE-171: V3 — lock tomado', () => {
      const archivo = path.join(raiz, 'v3.json');
      fs.writeFileSync(archivo, JSON.stringify({ n: 0 }));
      const lock = `${archivo}.lock`;
      fs.writeFileSync(lock, 'x');

      let error = null;
      let muto = false;
      try {
        almacen.mutarJson(archivo, { n: 0 }, (d) => { muto = true; d.n += 1; }, { esperaLockMs: 50 });
      } catch (e) { error = e; }
      fs.unlinkSync(lock);

      check('V3 lanza EBUSY', error && error.code === 'EBUSY', String(error));
      check('V3 no ejecuta la mutación', !muto);
      check('V3 no cambia el archivo', JSON.parse(fs.readFileSync(archivo, 'utf8')).n === 0);
    });

    await group('BE-171: V4 — lock huérfano', () => {
      const archivo = path.join(raiz, 'v4.json');
      fs.writeFileSync(archivo, JSON.stringify({ n: 0 }));
      const lock = `${archivo}.lock`;
      fs.writeFileSync(lock, 'x');
      const viejo = new Date(Date.now() - 10_000);
      fs.utimesSync(lock, viejo, viejo);

      almacen.mutarJson(archivo, { n: 0 }, (d) => { d.n += 1; }, { lockViejoMs: 50 });

      check('V4 retira el lock viejo', !fs.existsSync(lock));
      check('V4 muta y escribe', JSON.parse(fs.readFileSync(archivo, 'utf8')).n === 1);
    });

    await group('BE-171: V5 — EACCES no es corrupción', () => {
      const archivo = path.join(raiz, 'v5.json');
      fs.writeFileSync(archivo, JSON.stringify({ n: 0 }));
      const originalRead = fs.readFileSync;
      fs.readFileSync = (...args) => {
        if (args[0] === archivo) throw Object.assign(new Error('sin permiso'), { code: 'EACCES' });
        return originalRead(...args);
      };
      let error = null;
      try {
        almacen.mutarJson(archivo, { n: 0 }, (d) => { d.n += 1; });
      } catch (e) {
        error = e;
      } finally {
        fs.readFileSync = originalRead;
      }

      const copias = fs.readdirSync(raiz).filter((f) => f.startsWith('v5.json.corrupto-'));
      check('V5 propaga EACCES', error && error.code === 'EACCES', String(error));
      check('V5 no crea cuarentena', copias.length === 0, copias.join(', '));
      check('V5 no toca el archivo', JSON.parse(fs.readFileSync(archivo, 'utf8')).n === 0);
    });

    await group('BE-171: V6 — dos escritores concurrentes', async () => {
      const archivo = path.join(raiz, 'v6.json');
      const script = path.join(raiz, 'escritor-v6.mjs');
      fs.writeFileSync(script, `
        import { mutarJson } from ${JSON.stringify(pathToFileURL(ALMACEN).href)};
        const archivo = process.argv[2];
        const n = Number(process.argv[3]);
        for (let i = 0; i < n; i++) mutarJson(archivo, { n: 0 }, (d) => { d.n = (d.n || 0) + 1; });
      `);

      const [a, b] = await Promise.all([
        correr([script, archivo, '50']),
        correr([script, archivo, '50'])
      ]);

      check('V6 los dos procesos terminan 0', a.code === 0 && b.code === 0, `${a.code}/${b.code} ${a.err} ${b.err}`);
      check('V6 no se pierde ninguna mutación', JSON.parse(fs.readFileSync(archivo, 'utf8')).n === 100);
    });

    await group('BE-171: V7 — archivo ausente', () => {
      const archivo = path.join(raiz, 'v7.json');
      almacen.mutarJson(archivo, { n: 0 }, (d) => { d.n = 1; });
      check('V7 crea el estado por defecto', JSON.parse(fs.readFileSync(archivo, 'utf8')).n === 1);
    });

    await group('BE-171: V8 — leerNodos con JSON corrupto', () => {
      const dir = path.join(raiz, 'v8');
      fs.mkdirSync(dir, { recursive: true });
      const archivo = path.join(dir, 'nodos.json');
      const original = '{"nodos": [';
      fs.writeFileSync(archivo, original);
      const avisos = [];

      const d = identidad.leerNodos(dir, { stderr: { write: (m) => avisos.push(String(m)) } });

      check('V8 devuelve vacío', d.invitaciones.length === 0 && d.nodos.length === 0 && d.asksRemotos.length === 0);
      check('V8 avisa', avisos.some((m) => /JSON corrupto/.test(m)), avisos.join(' | '));
      check('V8 no escribe', fs.readFileSync(archivo, 'utf8') === original);
    });

    await group('BE-171: V9 — leerNodos con EACCES', () => {
      const dir = path.join(raiz, 'v9');
      fs.mkdirSync(dir, { recursive: true });
      const archivo = path.join(dir, 'nodos.json');
      fs.writeFileSync(archivo, '{}');
      const originalRead = fs.readFileSync;
      fs.readFileSync = (...args) => {
        if (args[0] === archivo) throw Object.assign(new Error('sin permiso'), { code: 'EACCES' });
        return originalRead(...args);
      };
      const avisos = [];
      let d = null;
      let error = null;
      try {
        d = identidad.leerNodos(dir, { stderr: { write: (m) => avisos.push(String(m)) } });
      } catch (e) {
        error = e;
      } finally {
        fs.readFileSync = originalRead;
      }

      check('V9 no lanza', !error, String(error));
      check('V9 devuelve vacío', d && d.nodos.length === 0);
      check('V9 avisa', avisos.some((m) => /no se pudo leer/.test(m)), avisos.join(' | '));
    });

    await group('BE-171: V10 — primitiva JSON no es un objeto', () => {
      const dir = path.join(raiz, 'v10');
      fs.mkdirSync(dir, { recursive: true });
      const archivo = path.join(dir, 'servidor.json');
      const original = 'null';
      fs.writeFileSync(archivo, original);

      let error = null;
      try { identidad.identidadServidor(dir); } catch (e) { error = e; }
      const copias = fs.readdirSync(dir).filter((f) => f.startsWith('servidor.json.corrupto-'));

      check('V10 lanza JsonCorruptoError de forma', error && error.code === 'EJSONCORRUPTO' && error.causa === 'shape', String(error));
      check('V10 no pisa la primitiva', fs.readFileSync(archivo, 'utf8') === original);
      check('V10 deja cuarentena', copias.length === 1, copias.join(', '));
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
