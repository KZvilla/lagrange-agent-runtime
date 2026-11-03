/**
 * BE-173 — Segunda rebanada: `telegram_bridge_status` vive en
 * `mcp-server/tools/bridge-status.js`.
 *
 * El handler se prueba directo, con un bridge temporal de módulos ESM y dobles
 * de `execFileSync`, `recall` e `instalaciones`: sin servidor MCP, sin daemon
 * real y sin depender de la máquina. Los textos son el contrato que ya cubre
 * `feat-095-instalaciones` de punta a punta.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { manejarEstadoBridge } = require(path.join(__dirname, '..', 'mcp-server', 'tools', 'bridge-status.js'));

const RAIZ = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
const TEMPORALES = [];

const MODULO_PATHS = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const aqui = path.dirname(fileURLToPath(import.meta.url));
const leer = () => JSON.parse(fs.readFileSync(path.join(aqui, 'fake.json'), 'utf8'));
export function bridgeDataDirPath() { return leer().dataDir; }
export function estadoDaemon() { return leer().daemon; }
export function informeEnv() { return leer().env; }
export function bridgeEnvCandidates(dir) {
  const f = leer();
  return dir === f.bridgeDir ? f.envCandidates : (f.otrasEnvCandidates || []);
}
`;

const MODULO_WEB = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const aqui = path.dirname(fileURLToPath(import.meta.url));
export function leerAccesoWeb() {
  try { return JSON.parse(fs.readFileSync(path.join(aqui, '..', 'fake.json'), 'utf8')).web ?? null; }
  catch { return null; }
}
`;

const MODULO_BOTS = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const aqui = path.dirname(fileURLToPath(import.meta.url));
const leer = () => JSON.parse(fs.readFileSync(path.join(aqui, 'fake.json'), 'utf8'));
export function leerBots() { return leer().botsResult || { bots: [], errores: [] }; }
export function describirBot(b) { return b.descripcion || 'bot ' + b.id; }
`;

const MODULO_RED = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const aqui = path.dirname(fileURLToPath(import.meta.url));
export function estado() {
  return JSON.parse(fs.readFileSync(path.join(aqui, '..', 'fake.json'), 'utf8')).red || { emparejado: false };
}
`;

function escribir(esc) {
  fs.mkdirSync(path.join(esc.bridge, 'web'), { recursive: true });
  fs.mkdirSync(path.join(esc.bridge, 'red'), { recursive: true });
  fs.mkdirSync(esc.data, { recursive: true });
  fs.writeFileSync(path.join(esc.raiz, 'package.json'), JSON.stringify({ version: PKG.version }));
  fs.writeFileSync(path.join(esc.bridge, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(esc.bridge, 'paths.js'), MODULO_PATHS);
  fs.writeFileSync(path.join(esc.bridge, 'web', 'acceso.js'), MODULO_WEB);
  fs.writeFileSync(path.join(esc.bridge, 'bots.js'), MODULO_BOTS);
  fs.writeFileSync(path.join(esc.bridge, 'red', 'admin.js'), MODULO_RED);
  fs.writeFileSync(path.join(esc.data, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\nDEEPSEEK_API_KEY=x\nOPENCODE_GO_API_KEY=y\n');
  guardar(esc, {});
}

function guardar(esc, cambios) {
  Object.assign(esc.fake, cambios);
  fs.writeFileSync(path.join(esc.bridge, 'fake.json'), JSON.stringify(esc.fake));
}

function escenario() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-status-')));
  TEMPORALES.push(raiz);
  const bridge = path.join(raiz, 'telegram-bridge');
  const data = path.join(raiz, 'data');
  const otroBridge = path.join(raiz, 'otra-copia');
  const esc = {
    raiz,
    bridge,
    data,
    otroBridge,
    fake: {
      bridgeDir: bridge,
      dataDir: data,
      daemon: { vivo: true, pid: 1234, startedAt: '2026-11-03T10:00:00.000Z', rol: 'servidor' },
      env: { rol: 'servidor' },
      envCandidates: [path.join(data, '.env')],
      otrasEnvCandidates: [],
      web: null,
      botsResult: { bots: [], errores: [] },
      red: { emparejado: false }
    }
  };
  escribir(esc);
  return esc;
}

function deps(esc, extra = {}) {
  const propio = extra.propiaDir === undefined ? esc.raiz : extra.propiaDir;
  return {
    config: { motores: { cuentas: {} } },
    loadConfig: () => ({ motores: { roles: {} }, fallbackAgy: null }),
    recall: { fuentes: () => ({ todas: [], actual: null }) },
    instalaciones: {
      versionesInstaladas: () => [{
        cuenta: 'principal', propia: true, estado: 'instalado',
        version: PKG.version, sha: '4208b82', dir: 'C:/cuentas/principal'
      }],
      avisosDeDeriva: () => [],
      sinDeriva: () => true,
      todoComparable: () => true
    },
    bridgeDir: esc.bridge,
    propiaDir: propio,
    platform: 'win32',
    execFileSync: (comando) => {
      if (comando !== 'powershell') throw new Error(`comando inesperado: ${comando}`);
      return `Ready\n"${path.join(esc.bridge, 'daemon-hidden.vbs')}"`;
    },
    ...extra.deps
  };
}

async function ejecutar(esc, extra = {}) {
  return manejarEstadoBridge({}, deps(esc, extra));
}

async function main() {
  await group('BE-173: extracción y error de carga', async () => {
    check('exporta manejarEstadoBridge', typeof manejarEstadoBridge === 'function');

    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-sin-paths-'));
    TEMPORALES.push(vacio);
    const roto = await manejarEstadoBridge({}, {
      bridgeDir: vacio,
      platform: 'win32',
      execFileSync: () => ''
    });
    check('sin paths.js devuelve isError', roto.isError === true, JSON.stringify(roto));
    check('conserva el texto del error de carga', /No se pudo cargar telegram-bridge\/paths\.js/.test(roto.content[0].text), roto.content[0].text);
  });

  await group('BE-173: servicio, daemon y rol', async () => {
    const esc = escenario();
    const texto = (await ejecutar(esc)).content[0].text;
    check('nombra el gestor y el estado del servicio', /Task Scheduler/.test(texto) && /`Ready`/.test(texto), texto);
    check('muestra PID y arranque del bot vivo', /PID 1234/.test(texto) && /2026-11-03T10:00:00\.000Z/.test(texto), texto);
    check('muestra el rol del lock', /Rol: `servidor`/.test(texto), texto);
    check('confirma la misma copia', /Ambas mitades corren la misma copia/.test(texto), texto);
    check('muestra el lock compartido', /`bridge\.lock`: PID 1234/.test(texto), texto);

    const sinServicio = escenario();
    const texto2 = (await manejarEstadoBridge({}, {
      ...deps(sinServicio),
      execFileSync: () => ''
    })).content[0].text;
    check('sin tarea registrada lo dice', /no registrado/.test(texto2), texto2);
    check('bot a mano se distingue del servicio', /arrancado a mano, no por el gestor/.test(texto2), texto2);

    const sinLock = escenario();
    guardar(sinLock, { daemon: { vivo: false, pid: null, startedAt: null, rol: null }, env: { rol: 'solo' } });
    const texto3 = (await ejecutar(sinLock)).content[0].text;
    check('sin daemon cae al rol del .env', /Rol: `solo`/.test(texto3) && /del `\.env`; no hay daemon vivo/.test(texto3), texto3);
    check('sin lock dice ninguno', /`bridge\.lock`: _ninguno_/.test(texto3), texto3);
  });

  await group('BE-173: estado compartido', async () => {
    const esc = escenario();
    fs.writeFileSync(path.join(esc.data, 'state.json'), JSON.stringify({
      chats: { a: {}, b: {} },
      pendingAsks: {
        p1: { status: 'pending' },
        p2: { status: 'answered' },
        p3: { status: 'pending', botId: 'principal' }
      },
      reaccionables: { legacy: {}, 'web:1': {}, '123:-456:789': {} }
    }));
    const texto = (await ejecutar(esc)).content[0].text;
    check('cuenta chats y asks pendientes', /2 chat\(s\), 2 ask\(s\) pendiente\(s\)/.test(texto), texto);
    check('señala reacciones viejas y asks sin bot', /1 reacción\(es\) sin bot, 2 pregunta\(s\) sin `botId`/.test(texto), texto);

    const vacio = escenario();
    const texto2 = (await ejecutar(vacio)).content[0].text;
    check('sin state.json lo dice', /_todavía no existe_/.test(texto2), texto2);
  });

  await group('BE-173: copias y credenciales', async () => {
    const distinta = escenario();
    fs.mkdirSync(distinta.otroBridge, { recursive: true });
    const envOtro = path.join(distinta.raiz, 'otro.env');
    fs.writeFileSync(envOtro, fs.readFileSync(path.join(distinta.data, '.env')));
    guardar(distinta, { otrasEnvCandidates: [envOtro] });
    const texto = (await manejarEstadoBridge({}, {
      ...deps(distinta),
      execFileSync: () => `Ready\n"${path.join(distinta.otroBridge, 'daemon-hidden.vbs')}"`
    })).content[0].text;
    check('detecta copias distintas', /Corren copias distintas/.test(texto), texto);
    check('.env idéntico en copias distintas no alarma', /Ahora mismo son idénticos/.test(texto), texto);
    check('nombra el .env duradero', /El duradero, que ambas mitades comparten/.test(texto), texto);

    const distinto = escenario();
    fs.mkdirSync(distinto.otroBridge, { recursive: true });
    const envOtro2 = path.join(distinto.raiz, 'otro.env');
    fs.writeFileSync(envOtro2, 'TELEGRAM_BOT_TOKEN=999:otro\n');
    guardar(distinto, { otrasEnvCandidates: [envOtro2] });
    const texto2 = (await manejarEstadoBridge({}, {
      ...deps(distinto),
      execFileSync: () => `Ready\n"${path.join(distinto.otroBridge, 'daemon-hidden.vbs')}"`
    })).content[0].text;
    check('detecta contenido distinto', /su contenido NO coincide/.test(texto2), texto2);

    const durable = escenario();
    const texto3 = (await ejecutar(durable)).content[0].text;
    check('confirma la ubicación duradera', /En la ubicación duradera: sobrevive a `claude plugin update`/.test(texto3), texto3);
  });

  await group('BE-173: versiones', async () => {
    const esc = escenario();
    const texto = (await ejecutar(esc)).content[0].text;
    check('muestra la versión de esta sesión', texto.includes(`Esta sesión (herramientas MCP): \`${PKG.version}\``), texto);
    check('muestra la versión del daemon', texto.includes(`Daemon del bot: \`${PKG.version}\``), texto);
    const versionEscapada = PKG.version.replace(/\./g, '\\.');
    check('detalla la cuenta con sha', new RegExp(`Cuenta \`principal\` _\\(esta sesión\\)_: \`${versionEscapada}\` \\(4208b82\\)`).test(texto), texto);
    check('confirma que no hay deriva', /Sin deriva: la sesión, el daemon y las cuentas están en la misma versión/.test(texto), texto);

    const deriva = escenario();
    const base = deps(deriva);
    base.instalaciones = {
      versionesInstaladas: () => [{ cuenta: 'trabajo', propia: false, estado: 'instalado', version: '1.63.10', sha: 'def5678', dir: 'C:/cuentas/trabajo' }],
      avisosDeDeriva: () => ['la cuenta `trabajo` está en 1.63.10'],
      sinDeriva: () => false,
      todoComparable: () => true
    };
    const texto2 = (await manejarEstadoBridge({}, base)).content[0].text;
    check('muestra el aviso de deriva', /la cuenta `trabajo` está en 1\.63\.10/.test(texto2), texto2);
    check('no afirma "sin deriva" cuando hay aviso', !/Sin deriva/.test(texto2), texto2);
  });

  await group('BE-173: bots y red', async () => {
    const esc = escenario();
    guardar(esc, {
      botsResult: {
        bots: [{ id: 'principal', descripcion: 'bot principal (privado)' }],
        errores: ['un bot sin token']
      }
    });
    const texto = (await ejecutar(esc)).content[0].text;
    check('lista los bots', /bot principal \(privado\)/.test(texto), texto);
    check('lista los errores de bots', /un bot sin token/.test(texto), texto);
    check('informa DeepSeek y OpenCode Go', /DeepSeek \(motor de almas, FEAT-166\): key configurada/.test(texto) && /OpenCode Go .*key configurada/.test(texto), texto);

    const sinGo = escenario();
    fs.writeFileSync(path.join(sinGo.data, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\nDEEPSEEK_API_KEY=x\n');
    const texto2 = (await ejecutar(sinGo)).content[0].text;
    check('sin key ni rol de Go no lo menciona', !/OpenCode Go/.test(texto2), texto2);

    const nodo = escenario();
    guardar(nodo, {
      daemon: { vivo: true, pid: 77, startedAt: '2026-11-03T11:00:00.000Z', rol: 'nodo' },
      env: { rol: 'nodo' },
      red: { emparejado: false }
    });
    const texto3 = (await ejecutar(nodo)).content[0].text;
    check('nodo sin emparejar lo dice', /este nodo no está emparejado/.test(texto3), texto3);
    check('nodo no sirve consola web', /Consola web: _no aplica_/.test(texto3), texto3);

    const nodoOk = escenario();
    guardar(nodoOk, {
      daemon: { vivo: true, pid: 77, startedAt: '2026-11-03T11:00:00.000Z', rol: 'nodo' },
      env: { rol: 'nodo' },
      red: { emparejado: true, conectado: true, servidor: 'https://servidor.invalid', nombre: 'nodo-1' }
    });
    const texto4 = (await ejecutar(nodoOk)).content[0].text;
    check('nodo conectado muestra servidor y nombre', /conectado/.test(texto4) && /servidor\.invalid/.test(texto4) && /nodo-1/.test(texto4), texto4);
  });

  await group('BE-173: consola web', async () => {
    const esc = escenario();
    guardar(esc, {
      web: {
        vivo: true,
        url: 'http://127.0.0.1:4518',
        tailnet: { url: 'https://telefono.invalid', usuario: 'alguien', puerto: 4528 }
      }
    });
    const texto = (await ejecutar(esc)).content[0].text;
    check('muestra la consola web', /http:\/\/127\.0\.0\.1:4518/.test(texto), texto);
    check('muestra la del teléfono', /telefono\.invalid/.test(texto) && /127\.0\.0\.1:4528/.test(texto), texto);

    const apagada = escenario();
    guardar(apagada, { web: { vivo: true, url: 'http://127.0.0.1:4518', tailnet: { apagado: 'sin tailscale' } } });
    const texto2 = (await ejecutar(apagada)).content[0].text;
    check('teléfono apagado se explica', /apagado .*sin tailscale/.test(texto2), texto2);
  });

  await group('BE-173: versión propia por defecto', async () => {
    const esc = escenario();
    const salida = await manejarEstadoBridge({}, {
      ...deps(esc),
      propiaDir: undefined
    });
    const texto = salida.content[0].text;
    check('sin propiaDir lee la raíz real del repo', texto.includes(`Esta sesión (herramientas MCP): \`${PKG.version}\``), texto);
  });

  report();
  for (const dir of TEMPORALES) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
