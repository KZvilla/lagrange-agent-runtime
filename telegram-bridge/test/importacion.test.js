/**
 * BE-176 — Test 35 [BE-007]: importar un módulo no debe tocar el disco.
 *
 * La primera versión resolvía las rutas en el cuerpo del módulo, y como
 * `resolveDataFile` crea directorios y migra el fichero heredado, bastaba con
 * ejecutar la suite —que importa bot.js— para MOVER el lockfile del bot que
 * estuviera corriendo de verdad. Importar no es usar.
 *
 * El fixture (módulos y junction de node_modules) vive en `harness.js`; este
 * archivo conserva las cuatro aserciones del caso original.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { copiarFixture, FAKE_TOKEN } from './harness.js';

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-import-'));
try {
  const { codigo, datos } = copiarFixture(raiz);
  fs.writeFileSync(path.join(codigo, 'bridge.lock'), JSON.stringify({ pid: 999999, startedAt: null, bootId: null }));
  fs.writeFileSync(path.join(codigo, 'state.json'), '{"chats":{},"pendingAsks":{}}');

  // En Windows `import()` exige una URL file://: una ruta absoluta con letra de
  // unidad se interpreta como el protocolo «c:».
  const res = spawnSync(process.execPath, ['-e', 'import(process.argv[1]).then(()=>console.log("importado"))', pathToFileURL(path.join(codigo, 'bot.js')).href], {
    env: {
      ...process.env,
      TELEGRAM_BRIDGE_DATA_DIR: datos,
      TELEGRAM_BRIDGE_STATE_FILE: '',
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN
    },
    encoding: 'utf8'
  });

  assert(res.stdout.includes('importado'), `El módulo debe importarse limpiamente: ${res.stderr}`);
  assert(fs.existsSync(path.join(codigo, 'bridge.lock')), 'Importar bot.js NO debe migrar el lockfile');
  assert(fs.existsSync(path.join(codigo, 'state.json')), 'Importar bot.js NO debe migrar el state.json');
  assert(!fs.existsSync(datos), 'Importar bot.js NO debe crear siquiera el directorio de datos');

  console.log('✔ Test 35 [BE-007]: importar bot.js no crea directorios ni migra ficheros');
} finally {
  // En Windows el junction se borra sin recursión y antes de la raíz.
  try { fs.rmSync(path.join(raiz, 'telegram-bridge', 'node_modules'), { recursive: false, force: true }); } catch {}
  fs.rmSync(raiz, { recursive: true, force: true });
}
