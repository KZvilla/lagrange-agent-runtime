/**
 * El archivo de uso se escribe con temporal + rename y lo leen, sin lock,
 * procesos que no escriben (el preflight de cuota de FEAT-179 lo lee en cada
 * llamada). En Windows, `rename` sobre un archivo que otro proceso tiene
 * abierto para leer falla con EPERM: sin reintento, la escritura se perdía en
 * silencio («Failed to record usage»), y la CI de v1.59.0 contó 97 de 100.
 *
 * Dos lectores en bucle y dos escritores de verdad (procesos aparte): ningún
 * registro puede fallar por el rename. Lo que el lock degrade a propósito se
 * anuncia y no cuenta como pérdida silenciosa.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const USO = path.join(__dirname, '..', 'mcp-server', 'lib', 'uso-agy.js');
const POR_ESCRITOR = 150;

const LECTOR = `
const fs = require('fs'); const ruta = process.argv[1];
const fin = Date.now() + Number(process.argv[2]);
while (Date.now() < fin) { try { fs.readFileSync(ruta, 'utf8'); } catch {} }
`;
const ESCRITOR = `
const { crearAlmacenUso } = require(process.argv[1]);
const avisos = [];
const a = crearAlmacenUso({ ruta: process.argv[2], stderr: { write: (m) => avisos.push(String(m)) } });
for (let i = 0; i < Number(process.argv[3]); i++) a.registrar('run', null, null, '', 1, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
console.log(JSON.stringify({
  fallos: avisos.filter((m) => /Failed to record usage/.test(m)),
  degradaciones: avisos.filter((m) => /Se escribe sin exclusi/.test(m)).length
}));
`;

function correr(args) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    hijo.stdout.on('data', (d) => { out += d; });
    hijo.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uso-rename-'));
  const ruta = path.join(dir, 'antigravity-usage.json');
  try {
    await group('escritores contra lectores sin lock', async () => {
      const lectores = [correr(['-e', LECTOR, ruta, '6000']), correr(['-e', LECTOR, ruta, '6000'])];
      const escritores = [correr(['-e', ESCRITOR, USO, ruta, String(POR_ESCRITOR)]), correr(['-e', ESCRITOR, USO, ruta, String(POR_ESCRITOR)])];
      const res = (await Promise.all(escritores)).map((r) => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch { return { fallos: [`salida ilegible: ${r.out}`], degradaciones: 0 }; } });
      await Promise.all(lectores);
      const fallos = res.flatMap((r) => r.fallos);
      const degradaciones = res.reduce((n, r) => n + r.degradaciones, 0);
      const total = JSON.parse(fs.readFileSync(ruta, 'utf8')).session.total_calls;
      check('ningún registro falla por el rename', fallos.length === 0, fallos.slice(0, 2).join(' | '));
      check('lo contado más lo anunciado da el total', total <= 2 * POR_ESCRITOR && total >= 2 * POR_ESCRITOR - degradaciones, `contó ${total}, degradaciones ${degradaciones}`);
      check('no quedan temporales', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
    });

    await group('BE-168: rename siempre ocupado o lectura a medias', async () => {
      const { crearAlmacenUso } = require(USO);
      const r2 = path.join(dir, 'b168.json');
      const avisos = [];
      const a = crearAlmacenUso({ ruta: r2, stderr: { write: (m) => avisos.push(String(m)) } });
      const uso = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
      a.registrar('run', null, null, '', 1, uso);
      const { renameSync, readFileSync } = fs;
      fs.renameSync = () => { throw Object.assign(new Error('ocupado'), { code: 'EPERM' }); };
      try { a.registrar('run', null, null, '', 1, uso); } finally { fs.renameSync = renameSync; }
      check('sin rename, el registro se escribe en el lugar', JSON.parse(readFileSync(r2, 'utf8')).session.total_calls === 2, avisos.join(' | '));
      check('y no deja temporal', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
      let aMedias = true;
      fs.readFileSync = (...args) => {
        if (aMedias && args[0] === r2) { aMedias = false; return '{"session": {"total_ca'; }
        return readFileSync(...args);
      };
      try { a.registrar('run', null, null, '', 1, uso); } finally { fs.readFileSync = readFileSync; }
      check('una lectura a medias no parte de cero', JSON.parse(readFileSync(r2, 'utf8')).session.total_calls === 3 && !avisos.some((m) => /ilegible/.test(m)), avisos.join(' | '));
    });

    await group('BE-169: un archivo ilegible no borra el historial', async () => {
      const { crearAlmacenUso } = require(USO);
      const uso = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
      const { readFileSync } = fs;
      const nuevo = (nombre) => {
        const r = path.join(dir, nombre);
        const avisos = [];
        return { r, avisos, a: crearAlmacenUso({ ruta: r, stderr: { write: (m) => avisos.push(String(m)) } }) };
      };
      const llamadas = (r) => JSON.parse(readFileSync(r, 'utf8')).session.total_calls;
      const ocupado = (r, veces = Infinity) => {
        fs.readFileSync = (...args) => {
          if (args[0] === r && veces-- > 0) throw Object.assign(new Error('ocupado'), { code: 'EPERM' });
          return readFileSync(...args);
        };
      };

      const truncado = nuevo('b169-truncado.json');
      truncado.a.registrar('run', null, null, '', 1, uso);
      fs.writeFileSync(truncado.r, '{"session": {"total_ca');
      truncado.a.registrar('run', null, null, '', 1, uso);
      check('truncado sin temporal: lo dañado queda en .corrupto', readFileSync(`${truncado.r}.corrupto`, 'utf8') === '{"session": {"total_ca');
      check('truncado sin temporal: lo avisa', truncado.avisos.some((m) => /copia en \.corrupto, se parte de cero/.test(m)), truncado.avisos.join(' | '));

      const rescate = nuevo('b169-rescate.json');
      for (let i = 0; i < 3; i++) rescate.a.registrar('run', null, null, '', 1, uso);
      fs.copyFileSync(rescate.r, `${rescate.r}.999.tmp`);
      fs.writeFileSync(`${rescate.r}.998.tmp`, '{"session": {"tot');
      fs.writeFileSync(rescate.r, '');
      rescate.a.registrar('run', null, null, '', 1, uso);
      check('truncado con temporal: se recupera el historial', llamadas(rescate.r) === 4, String(llamadas(rescate.r)));

      const viejo = nuevo('b169-viejo.json');
      for (let i = 0; i < 3; i++) viejo.a.registrar('run', null, null, '', 1, uso);
      fs.copyFileSync(viejo.r, `${viejo.r}.997.tmp`);
      const haceUnDia = new Date(Date.now() - 86400000);
      fs.utimesSync(`${viejo.r}.997.tmp`, haceUnDia, haceUnDia);
      fs.writeFileSync(`${viejo.r}.996.tmp`, '{"session": true}');
      fs.writeFileSync(viejo.r, '');
      viejo.a.registrar('run', null, null, '', 1, uso);
      check('un temporal viejo o sin session no se rescata', llamadas(viejo.r) === 1, String(llamadas(viejo.r)));

      const sinCopia = nuevo('b169-sin-copia.json');
      sinCopia.a.registrar('run', null, null, '', 1, uso);
      fs.writeFileSync(sinCopia.r, '{"session"');
      const { copyFileSync } = fs;
      fs.copyFileSync = () => { throw new Error('sin copia'); };
      try { sinCopia.a.registrar('run', null, null, '', 1, uso); } finally { fs.copyFileSync = copyFileSync; }
      check('sin copia posible: no pisa el archivo', readFileSync(sinCopia.r, 'utf8') === '{"session"');

      const borrado = nuevo('b169-reiniciar.json');
      borrado.a.registrar('run', null, null, '', 1, uso);
      const previo = readFileSync(borrado.r, 'utf8');
      ocupado(borrado.r);
      let lanzo = false;
      try { borrado.a.reiniciar(); } catch { lanzo = true; } finally { fs.readFileSync = readFileSync; }
      check('reiniciar con el archivo ocupado: falla sin pisarlo', lanzo && readFileSync(borrado.r, 'utf8') === previo);

      const siempre = nuevo('b169-ocupado.json');
      siempre.a.registrar('run', null, null, '', 1, uso);
      const antes = readFileSync(siempre.r, 'utf8');
      ocupado(siempre.r);
      try { siempre.a.registrar('run', null, null, '', 1, uso); } finally { fs.readFileSync = readFileSync; }
      check('ocupado siempre: no pisa el archivo', readFileSync(siempre.r, 'utf8') === antes);
      check('ocupado siempre: pierde el registro y lo avisa', siempre.avisos.some((m) => /Failed to record usage/.test(m)), siempre.avisos.join(' | '));
      check('ocupado siempre: no deja temporal', !fs.existsSync(`${siempre.r}.${process.pid}.tmp`));
      ocupado(siempre.r);
      let lectura;
      try { lectura = siempre.a.leer(); } finally { fs.readFileSync = readFileSync; }
      check('ocupado siempre: quien solo lee no falla', lectura.session.total_calls === 0);
      siempre.a.registrar('run', null, null, '', 1, uso);
      check('libre otra vez: sigue contando', llamadas(siempre.r) === 2, String(llamadas(siempre.r)));

      const rato = nuevo('b169-rato.json');
      rato.a.registrar('run', null, null, '', 1, uso);
      ocupado(rato.r, 3);
      try { rato.a.registrar('run', null, null, '', 1, uso); } finally { fs.readFileSync = readFileSync; }
      check('ocupado un rato: se reintenta', llamadas(rato.r) === 2 && !rato.avisos.some((m) => /ilegible/.test(m)), rato.avisos.join(' | '));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
