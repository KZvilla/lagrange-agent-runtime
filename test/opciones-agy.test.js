/**
 * BE-033 — agy se lanza sin ventana de consola en Windows.
 *
 * Sin `windowsHide`, un agy lanzado desde un proceso sin consola (la
 * consolidación de un alma corre detached) recibe una consola nueva y visible:
 * con Windows Terminal, una pestaña que roba el foco. El arreglo es una línea
 * por lanzamiento, y lo fácil es olvidarla en el próximo. Por eso, además del
 * helper, este test recorre el código: cada llamada que lanza el binario de agy
 * tiene que pasar por `opcionesDeAgy`, y la cuenta de llamadas tiene que
 * coincidir con la tabla del plan (una nueva obliga a mirarla).
 */
const fs = require('node:fs');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { opcionesDeAgy } = require('../mcp-server/lib/opciones-agy.js');

const RAIZ = path.join(__dirname, '..');

// Llamadas que lanzan agy, por archivo. Si cambia, es a propósito: actualizar acá.
const ESPERADAS = {
  'mcp-server/index.js': 5, // executeAgy, agy_voice_stream, agy_status (--version y help), agy_usage (--version, FEAT-074)
  'mcp-server/agy-stream.js': 2, // stdin y streaming (fan-out)
  'mcp-server/almas/consolidar.js': 1, // la consolidación, el caso que abría la ventana
  'mcp-server/agents/registry.js': 1, // agy agents
  'mcp-server/motores/sondas-antigravity.js': 2, // SEC-018: --version y mcp list; las sondas A0-A3
  'mcp-server/lib/cuota-agy.js': 1, // FEAT-074: agy interactivo en la pseudo-terminal, para /usage
  'telegram-bridge/executor.js': 3 // el bot y getAgyVersion (--version y help)
};

function archivosFuente(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) archivosFuente(ruta, acc);
    else if (/\.(c|m)?js$/.test(e.name) && !/(^test-|\.test\.)/.test(e.name)) acc.push(ruta);
  }
  return acc;
}

/** Desde la apertura de la llamada hasta su paréntesis de cierre. */
function sentencia(texto, desde) {
  let nivel = 0;
  for (let i = texto.indexOf('(', desde); i < texto.length; i++) {
    if (texto[i] === '(') nivel++;
    else if (texto[i] === ')' && --nivel === 0) return texto.slice(desde, i + 1);
  }
  return texto.slice(desde);
}

// La llamada tiene que tener el binario de agy como PRIMER argumento: así no la
// confunde el `binario` de audio del bridge ni el `agyBin` que se pasa como dato.
const LLAMADA = /\b(spawn|spawnFn|execFile|execFileSync)\(\s*(AGY_BIN|agyBin|binario)\s*,/g;

async function main() {
  await group('el helper', () => {
    const o = opcionesDeAgy({ cwd: 'x', env: { A: '1' }, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5, encoding: 'utf8' });
    check('pone windowsHide', o.windowsHide === true);
    check('pone shell: false', o.shell === false);
    check('conserva el resto', o.cwd === 'x' && o.env.A === '1' && o.stdio[2] === 'ignore' && o.timeout === 5 && o.encoding === 'utf8');
    const forzado = opcionesDeAgy({ windowsHide: false, shell: true });
    check('un llamador no apaga windowsHide', forzado.windowsHide === true);
    check('ni prende shell', forzado.shell === false);
    check('sin argumentos también', opcionesDeAgy().windowsHide === true);
  });

  await group('BE-034: agy no se actualiza solo', () => {
    const o = opcionesDeAgy({ env: { A: '1' } });
    check('pone la variable con el valor exacto', o.env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true');
    check('conserva el env que recibe', o.env.A === '1');
    check('solo agrega la variable', Object.keys(o.env).sort().join(',') === 'A,AGY_CLI_DISABLE_AUTO_UPDATE');
    check('la pisa aunque el llamador traiga otra', opcionesDeAgy({ env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'false' } }).env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true');
    process.env.BE034_PRUEBA = 'x';
    const sinEnv = opcionesDeAgy();
    delete process.env.BE034_PRUEBA;
    check('sin env parte de process.env', sinEnv.env.BE034_PRUEBA === 'x' && sinEnv.env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true');
    const recibido = { A: '1' };
    opcionesDeAgy({ env: recibido });
    check('no muta el env del llamador', !('AGY_CLI_DISABLE_AUTO_UPDATE' in recibido));
  });

  await group('cada lanzamiento de agy pasa por el helper', () => {
    const encontradas = {};
    for (const archivo of [...archivosFuente(path.join(RAIZ, 'mcp-server')), ...archivosFuente(path.join(RAIZ, 'telegram-bridge'))]) {
      const texto = fs.readFileSync(archivo, 'utf8');
      const rel = path.relative(RAIZ, archivo).split(path.sep).join('/');
      for (const m of texto.matchAll(LLAMADA)) {
        encontradas[rel] = (encontradas[rel] || 0) + 1;
        const linea = texto.slice(0, m.index).split('\n').length;
        check(`${rel}:${linea} usa opcionesDeAgy`, sentencia(texto, m.index).includes('opcionesDeAgy('), sentencia(texto, m.index).slice(0, 160));
      }
    }
    check('las llamadas coinciden con la tabla', JSON.stringify(encontradas, Object.keys(encontradas).sort()) === JSON.stringify(ESPERADAS, Object.keys(ESPERADAS).sort()),
      `encontradas: ${JSON.stringify(encontradas)}`);
  });

  await group('la búsqueda del binario tampoco abre ventana', () => {
    // consolidar.js la corre sin consola: where.exe también es un programa de consola.
    for (const [rel, variable] of [['mcp-server/lib/agy-bin.js', 'file'], ['telegram-bridge/executor.js', 'finder']]) {
      const texto = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
      const i = texto.search(new RegExp(`execFileSync\\(\\s*${variable}\\s*,`));
      check(`${rel} busca el binario`, i >= 0);
      check(`${rel} la búsqueda lleva windowsHide`, i >= 0 && sentencia(texto, i).includes('windowsHide: true'));
    }
  });

  await group('consolidar se lanza como los otros procesos sueltos', () => {
    const texto = fs.readFileSync(path.join(RAIZ, 'mcp-server/index.js'), 'utf8');
    const i = texto.search(/spawn\(process\.execPath, \[path\.join\(__dirname, 'almas', 'consolidar\.js'\)/);
    check('lo encuentra', i >= 0);
    const s = sentencia(texto, i);
    check('detached y con windowsHide', s.includes('detached: true') && s.includes('windowsHide: true'));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
