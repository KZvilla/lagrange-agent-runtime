/**
 * BE-062 — Un nodo que nunca va a conectarse (revocado, sin emparejar o que el
 * servidor no reconoce) no encola: rechaza con el motivo. Y la revocación
 * descarta lo que había encolado, que era para un servidor que ya no lo acepta.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'be-062-'));
fs.writeFileSync(path.join(raiz, '.env'), 'ALLOWED_USER_IDS=555000111\n');
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos-servidor');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

const BRIDGE = path.join(__dirname, '..', 'telegram-bridge');
const imp = (f) => import(pathToFileURL(path.join(BRIDGE, f)).href);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { crearCanalWeb, CHAT_WEB_LOCAL } = await imp('web/canal.js');
  const srv = await imp('web/servidor.js');
  const { crearServidorNodos } = await imp('red/servidor-nodos.js');
  const { crearNucleoRemoto } = await imp('red/nucleo-remoto.js');
  const { crearClienteNodo } = await imp('red/cliente-nodo.js');
  const admin = await imp('red/admin.js');

  const dirServidor = process.env.TELEGRAM_BRIDGE_DATA_DIR;
  const dirNodo = path.join(raiz, 'datos-nodo');
  const canal = crearCanalWeb();
  const servidorNodos = crearServidorNodos({ dataDir: dirServidor, canal, chatId: CHAT_WEB_LOCAL });
  const web = srv.crearServidorWeb({ nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: 'w'.repeat(48), red: { servidorNodos, nucleoRemoto: (id) => crearNucleoRemoto(servidorNodos.rpc, id) } });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${web.address().port}`;
  const { codigo } = admin.invitar(dirServidor);
  await admin.unirse(dirNodo, base, codigo, { nombre: 'casa-wsl' });
  // El servidor se apaga: el nodo queda emparejado pero sin conexión (el caso que sí encola).
  await new Promise((r) => { web.close(r); servidorNodos.cerrar(); });

  const logs = [];
  const cliente = crearClienteNodo({ dataDir: dirNodo, nucleo: {}, canal: null, chatId: CHAT_WEB_LOCAL, permitidos: new Set(), backoffMinMs: 30, entreSaludosMs: 30, log: (l) => logs.push(l) });
  cliente.iniciar();
  await esperar(100);

  try {
    await group('Con un corte de red, encola como siempre (FEAT-089 §5.4)', async () => {
      const r = await cliente.mensaje({ texto: 'antes de revocar' });
      check('emparejado y sin conexión: encolado', r.ok && r.encolado === true && cliente.colaPendiente() === 1);
    });

    await group('Revocado: descarta la cola y rechaza en vez de encolar', async () => {
      await cliente.atenderMensajeParaTests({ tipo: 'revocado' });
      check('la revocación vacía la cola (no se cuela en un emparejamiento nuevo)', cliente.colaPendiente() === 0 && cliente.revocado());
      check('y lo dice en el log', logs.some((l) => /Se descartan 1 mensaje\(s\) encolado\(s\): el nodo fue revocado/.test(l)));
      check('borró nodo.json', !fs.existsSync(path.join(dirNodo, 'nodo.json')));
      let error = null;
      try { await cliente.mensaje({ texto: 'después de revocar' }); } catch (err) { error = err; }
      check('un notify después de revocar se rechaza con el motivo, sin encolar', error?.codigo === 409 && /fue revocado por su servidor/.test(error.message) && cliente.colaPendiente() === 0, error?.message);
      let errorVoz = null;
      try { await cliente.voz(Buffer.from('x'), 'pie'); } catch (err) { errorVoz = err; }
      check('la voz también dice que está revocado (no "servidor no disponible")', errorVoz?.codigo === 409 && /revocado/.test(errorVoz.message), errorVoz?.message);
    });

    await group('Sin emparejar: rechaza en vez de encolar', async () => {
      const suelto = crearClienteNodo({ dataDir: path.join(raiz, 'sin-emparejar'), nucleo: {}, canal: null, chatId: CHAT_WEB_LOCAL, permitidos: new Set(), log: () => {} });
      check('iniciar dice que no está emparejado', suelto.iniciar() === false);
      let error = null;
      try { await suelto.mensaje({ texto: 'x' }); } catch (err) { error = err; }
      check('el notify se rechaza con cómo emparejarlo', error?.codigo === 409 && /no está emparejado/.test(error.message) && suelto.colaPendiente() === 0, error?.message);
      suelto.detener();
    });
  } finally {
    cliente.detener();
  }
  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
