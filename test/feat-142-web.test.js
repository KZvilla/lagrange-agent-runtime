/** FEAT-142: the native mirror is opt-in for drafts and does not change browser storage. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const values = new Map();
global.localStorage = {
  get length() { return values.size; },
  key(i) { return [...values.keys()][i] ?? null; },
  getItem(k) { return values.get(k) ?? null; },
  setItem(k, v) { values.set(k, String(v)); },
  removeItem(k) { values.delete(k); },
};
const sent = [];
global.__lagrangeDesktopBridge = {
  available: true, draftsOptIn: false, forgetting: false,
  request(op, key, value) { sent.push({ op, key, value }); return Promise.resolve({ status: 'committed' }); },
};

(async () => {
  const p = await import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui', 'persistencia.js')).href);
  assert.equal(p.escribir('ruta.ultima', '/tablero'), true);
  assert.equal(values.get('lagrange.ui.v1.ruta.ultima'), '"/tablero"');
  assert.deepEqual(sent.at(-1), { op: 'put', key: 'lagrange.ui.v1.ruta.ultima', value: '"/tablero"' });
  const before = sent.length;
  p.escribir('borrador.alma:alya', 'hola');
  assert.equal(sent.length, before, 'drafts stay local until opted in');
  global.__lagrangeDesktopBridge.draftsOptIn = true;
  p.escribir('borrador.alma:alya', 'hola');
  assert.equal(sent.at(-1).key, 'lagrange.ui.v1.borrador.alma:alya');
  p.borrar('borrador.alma:alya');
  assert.equal(sent.at(-1).op, 'delete');
  p.espejarTema('oscuro');
  assert.deepEqual(sent.at(-1), { op: 'put', key: 'lagrange.tema', value: 'oscuro' });
  const validCount = sent.length;
  p.escribir('panel.invalido', true);
  p.escribir('borrador.BAD', 'x');
  assert.equal(sent.length, validCount, 'invalid keys never enter the native channel');
  global.__lagrangeDesktopBridge.forgetting = true;
  p.escribir('ruta.ultima', '/ajustes');
  assert.equal(sent.at(-1).key, 'lagrange.tema', 'forget suppresses late mirror writes');
  delete global.__lagrangeDesktopBridge;
  p.escribir('ruta.ultima', '/logs');
  assert.equal(values.get('lagrange.ui.v1.ruta.ultima'), '"/logs"', 'normal browser storage still works');
  console.log('FEAT-142 web mirror: passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
