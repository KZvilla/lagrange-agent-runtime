/**
 * Script standalone de statusline para agy_fanout (FEAT-008 V1).
 *
 * Regresión concreta que motiva este archivo (2026-09-05): `ejecutarDelegado`
 * corría el comando delegado con el shell default de `execSync`, que en
 * Windows es `cmd.exe` — y el delegado real que guarda el setup (p. ej. el
 * propio comando de `claude-hud`) usa sintaxis POSIX (`case`, `${var:-x}`,
 * `$( )`) porque así es como Claude Code invoca `statusLine.command`. Sin
 * pedir `bash` explícitamente, el delegado fallaba con
 * "'cols' no se reconoce como un comando..." y se perdía. Detectado recién al
 * instalar la Track E de setup contra la statusline real del usuario — no lo
 * cubría ningún test hasta ahora.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { resolverBash } = require('../mcp-server/lib/bash');

const { crearEscritorDeEstado } = require('../mcp-server/fanout-estado.js');

const SCRIPT = path.join(__dirname, '..', 'mcp-server', 'fanout-statusline.js');
const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };
const sinAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function correr(cwd, stdin = { cwd }) {
  // HOME/USERPROFILE apuntan al mismo `cwd` de prueba: el script busca el
  // delegado global ahí, no en el ~/.claude real de quien corre los tests —
  // si no se aisla esto, un delegado configurado de verdad en la máquina
  // (como el de la Track E de setup) se cuela y rompe estos tests.
  return execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
    // FEAT-104 — También el bridge: un daemon real caído no se cuela como «bridge caído».
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd, TELEGRAM_BRIDGE_DATA_DIR: cwd }
  });
}

function escribirDelegado(cwd, delegado) {
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'antigravity.json'), JSON.stringify({ fanout_statusline_delegate: delegado }));
}

async function main() {
  let cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('sin corrida activa y sin delegado', () => {
      check('no imprime nada', correr(cwd) === '');
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('delegado con sintaxis POSIX (la regresión del shell en Windows)', () => {
      // `case` y `${VAR:-x}` no los entiende cmd.exe. Si ejecutarDelegado deja
      // de pedir `bash` explícitamente, esto vuelve a fallar en Windows.
      // Windows sin bash de Git: el script pierde el segmento a propósito
      // (lib/bash.js), así que no hay shell POSIX que probar.
      if (process.platform === 'win32' && !resolverBash()) {
        console.log('  (sin bash de Git: se omite)');
        check('el delegado corrió con un shell POSIX — omitido, sin bash de Git', true);
        return;
      }
      escribirDelegado(cwd, 'x=${NO_EXISTE:-marca-delegado}; case "$x" in marca-*) echo "$x";; esac');
      const salida = correr(cwd);
      check('el delegado corrió con un shell POSIX', salida.trim() === 'marca-delegado', JSON.stringify(salida));
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('delegado roto no rompe el script (cae al catch)', () => {
      escribirDelegado(cwd, 'comando_que_no_existe_seguro_xyz');
      const salida = correr(cwd);
      check('no revienta, imprime vacío', salida === '', JSON.stringify(salida));
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('corrida activa sin delegado', () => {
      const escritor = crearEscritorDeEstado(cwd, 'demo', [{ id: 'a' }, { id: 'b' }]);
      escritor.iniciar({ ramaBase: 'feat/demo', concurrencia: 2 });
      escritor.marcar('a', { estado: 'ok' });
      escritor.marcar('b', { estado: 'corriendo' });
      const salida = correr(cwd);
      check('muestra la línea de fanout', /fanout demo: 1\/2/.test(salida), salida);
      check('cuenta el que sigue corriendo', /1 corriendo/.test(salida), salida);
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('compone delegado + corrida activa, delegado primero', () => {
      escribirDelegado(cwd, 'echo "BASE"');
      const escritor = crearEscritorDeEstado(cwd, 'demo2', [{ id: 'a' }]);
      escritor.iniciar({});
      escritor.marcar('a', { estado: 'corriendo' });
      const salida = correr(cwd);
      const lineas = salida.trim().split('\n');
      check('primera línea es el delegado', lineas[0] === 'BASE', salida);
      check('segunda línea es el fanout', /fanout demo2/.test(lineas[1] || ''), salida);
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('corrida terminada hace rato no se muestra (TTL)', () => {
      const escritor = crearEscritorDeEstado(cwd, 'vieja', [{ id: 'a' }]);
      escritor.iniciar({});
      escritor.marcar('a', { estado: 'ok' });
      escritor.terminar();
      const ruta = escritor.rutaArchivo;
      const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      datos.terminado = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      fs.writeFileSync(ruta, JSON.stringify(datos));
      check('no imprime nada', correr(cwd) === '');
    });
  } finally { borrar(cwd); }

  // FEAT-104 — Sin delegado, la primera línea es la propia; con delegado, la suya.
  const STDIN = (dir) => ({ cwd: dir, model: { display_name: 'Opus 5.5' }, effort: 'high', context_window: { used_percentage: 41 }, cost: { total_cost_usd: 1.5 } });
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('FEAT-104: sin delegado, la base propia primero', () => {
      const escritor = crearEscritorDeEstado(cwd, 'demo3', [{ id: 'a' }]);
      escritor.iniciar({});
      escritor.marcar('a', { estado: 'corriendo' });
      const salida = correr(cwd, STDIN(cwd));
      const lineas = salida.trim().split('\n');
      check('primera línea: modelo y esfuerzo', /^Opus 5\.5 · high │ /.test(sinAnsi(lineas[0] || '')), salida);
      check('el modelo en cian por defecto', (lineas[0] || '').startsWith('\x1b[36mOpus 5.5'), JSON.stringify(lineas[0]));
      check('con contexto y costo', /ctx .*41%/.test(lineas[0]) && lineas[0].includes('$1.50'), salida);
      check('después el fanout', /fanout demo3/.test(lineas[1] || ''), salida);
      check('nunca [object Promise]', !salida.includes('[object'), salida);
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('FEAT-104: la línea de Lagrange va entre la base y el fanout', () => {
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.claude', 'lagrange-cuarentena.json'), JSON.stringify({ entradas: [{ id: 'q_a', agente: 'a', creada: new Date().toISOString() }] }));
      fs.writeFileSync(path.join(cwd, 'bridge.lock'), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
      const escritor = crearEscritorDeEstado(cwd, 'demo4', [{ id: 'a' }]);
      escritor.iniciar({});
      escritor.marcar('a', { estado: 'corriendo' });
      const lineas = correr(cwd, STDIN(cwd)).trim().split('\n');
      check('segunda línea: Lagrange (lock huérfano y cuarentena)', lineas[1] === 'bridge caído │ 🧪 1 en cuarentena', JSON.stringify(lineas));
      check('tercera: el fanout', /fanout demo4/.test(lineas[2] || ''), JSON.stringify(lineas));
      // §7 — statusline_colores del antigravity.json del HOME de prueba.
      fs.writeFileSync(path.join(cwd, '.claude', 'antigravity.json'), JSON.stringify({ statusline_colores: { modelo: 'verde' } }));
      check('statusline_colores se aplica', correr(cwd, STDIN(cwd)).startsWith('\x1b[32mOpus 5.5'));
      const proyecto = path.join(cwd, 'proyecto');
      fs.mkdirSync(path.join(proyecto, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(proyecto, '.claude', 'antigravity.json'), JSON.stringify({ statusline_colores: { proyecto: 'azul' } }));
      const combinada = correr(cwd, STDIN(proyecto));
      check('global + proyecto se combinan por clave', combinada.startsWith('\x1b[32mOpus 5.5') && combinada.includes('\x1b[34mproyecto\x1b[0m'), JSON.stringify(combinada.split('\n')[0]));
      escribirDelegado(cwd, 'echo "BASE"');
      const conDelegado = correr(cwd, STDIN(cwd)).trim().split('\n');
      check('con delegado: la suya primero, después Lagrange', conDelegado[0] === 'BASE' && conDelegado[1] === 'bridge caído │ 🧪 1 en cuarentena', JSON.stringify(conDelegado));
    });
  } finally { borrar(cwd); }

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
