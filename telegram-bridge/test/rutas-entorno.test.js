/**
 * BE-176 — Grupo rutas y entorno: Tests 33, 34, 36, 37, 38, 39 y 40.
 *
 * No usa ctx, queue ni testChatId: solo state, paths, notify y
 * claude-launcher, con temporales propios. El estado de test se fija antes
 * de importar state.js, igual que en test-bridge.js.
 *
 * Los bloques se movieron verbatim: mismos casos, textos y aserciones.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearEntorno } from './harness.js';

const { stateFile: TEST_STATE_FILE } = crearEntorno();
const state = await import('../state.js');
const claudeLauncher = await import('../claude-launcher.js');

// Test 33 [BE-007]: el estado y el lock se resuelven a un directorio de usuario,
// no junto al código. El bridge existe en dos carpetas a la vez —el checkout y
// el plugin instalado— y sus dos procesos no salen de la misma: con la ruta
// relativa a __dirname, notify.js registraba el ask en un state.json y bot.js
// resolvía el botón contra otro.
{
  const paths = await import('../paths.js');

  const dataPrevio = process.env.TELEGRAM_BRIDGE_DATA_DIR;
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-paths-'));
  const datos = path.join(raiz, 'datos');
  const codigoA = path.join(raiz, 'checkout', 'telegram-bridge');
  const codigoB = path.join(raiz, 'plugin', 'telegram-bridge');
  fs.mkdirSync(codigoA, { recursive: true });
  fs.mkdirSync(codigoB, { recursive: true });

  process.env.TELEGRAM_BRIDGE_DATA_DIR = datos;

  // Dos copias del código convergen en el MISMO fichero. Es la propiedad que
  // hace posible el human-in-the-loop entre procesos distintos.
  const desdeA = paths.resolveDataFile('state.json', codigoA);
  const desdeB = paths.resolveDataFile('state.json', codigoB);
  assert.strictEqual(desdeA, desdeB, 'Dos copias del código resuelven el mismo state.json');
  assert.strictEqual(desdeA, path.join(datos, 'state.json'), 'Y es el del directorio de datos');
  assert(fs.existsSync(datos), 'El directorio de datos se crea');

  // El legado se migra una sola vez.
  fs.rmSync(datos, { recursive: true, force: true });
  fs.writeFileSync(path.join(codigoA, 'state.json'), '{"chats":{"1":{"lastConversationId":"viejo"}}}');
  const migrado = paths.resolveDataFile('state.json', codigoA);
  assert(fs.existsSync(migrado), 'El estado legado se migra al destino');
  assert(!fs.existsSync(path.join(codigoA, 'state.json')), 'Y desaparece de la ubicación antigua');
  assert(JSON.parse(fs.readFileSync(migrado, 'utf8')).chats['1'].lastConversationId === 'viejo', 'El contenido se conserva');

  // Con destino ya presente, el legado NO se pisa ni se fusiona: dos historiales
  // distintos no se reconcilian solos sin arriesgar perder conversaciones.
  fs.writeFileSync(path.join(codigoB, 'state.json'), '{"chats":{"2":{"lastConversationId":"otro"}}}');
  paths.resolveDataFile('state.json', codigoB);
  assert(fs.existsSync(path.join(codigoB, 'state.json')), 'Un legado sobrante se deja intacto para inspección');
  assert.strictEqual(
    JSON.parse(fs.readFileSync(migrado, 'utf8')).chats['1'].lastConversationId,
    'viejo',
    'El estado canónico no se pisa'
  );

  // Si el directorio de datos no se puede usar, se cae al comportamiento previo
  // en lugar de dejar el bridge sin arrancar. Se fuerza pidiendo un directorio
  // colgando de un fichero regular, que ningún sistema puede crear.
  const bloqueador = path.join(raiz, 'soy-un-fichero');
  fs.writeFileSync(bloqueador, 'x');
  process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(bloqueador, 'imposible');
  assert.strictEqual(paths.resolveBridgeDataDir(codigoB), codigoB, 'Sin directorio de datos usable, se cae al de reserva');

  assert.strictEqual(paths.legacyDataFile('bridge.lock', codigoA), path.join(codigoA, 'bridge.lock'), 'legacyDataFile apunta al directorio del código');

  if (dataPrevio === undefined) delete process.env.TELEGRAM_BRIDGE_DATA_DIR;
  else process.env.TELEGRAM_BRIDGE_DATA_DIR = dataPrevio;
  fs.rmSync(raiz, { recursive: true, force: true });
}
console.log('✔ Test 33 [BE-007]: estado y lock convergen en un directorio de usuario');

// Test 34 [BE-007]: TELEGRAM_BRIDGE_STATE_FILE sigue mandando sobre todo lo
// demás. Es de lo que depende que esta misma suite no toque el estado real.
assert.strictEqual(state.getStateFilePath(), TEST_STATE_FILE, 'El override explícito gana');
console.log('✔ Test 34 [BE-007]: TELEGRAM_BRIDGE_STATE_FILE tiene precedencia sobre el directorio de datos');

// Test 36 [BE-008]: el .env se busca tambien en una ubicacion que sobrevive a
// `claude plugin update`.
//
// Contexto: cada version del plugin se instala en su PROPIO directorio
// (`cache/<market>/<plugin>/<version>/`) y la actualizacion no arrastra los
// ficheros que no estan en git. Un `.env` junto al codigo desaparece en cada
// update, y el sintoma no es un fallo de arranque sino una herramienta que un
// dia responde «No hay usuarios configurados»: credenciales duraderas dentro
// de un directorio versionado, la misma clase de defecto que BE-007.
{
  const paths = await import('../paths.js');
  const dataPrevio = process.env.TELEGRAM_BRIDGE_DATA_DIR;
  const envPrevio = process.env.TELEGRAM_BRIDGE_ENV_FILE;

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-env-'));
  const datos = path.join(raiz, 'datos');
  const plugin = path.join(raiz, 'cache', 'lagrange', '0.9.0');
  const bridge = path.join(plugin, 'telegram-bridge');
  fs.mkdirSync(bridge, { recursive: true });
  fs.mkdirSync(datos, { recursive: true });
  process.env.TELEGRAM_BRIDGE_DATA_DIR = datos;
  delete process.env.TELEGRAM_BRIDGE_ENV_FILE;

  const candidatos = paths.bridgeEnvCandidates(bridge);
  assert.strictEqual(candidatos[0], path.join(bridge, '.env'), 'Primero el .env del bridge');
  assert.strictEqual(candidatos[1], path.join(plugin, '.env'), 'Luego el de la raiz del plugin');
  assert.strictEqual(candidatos[2], path.join(datos, '.env'), 'Y por ultimo el duradero');

  // Sin ningun .env: el diagnostico debe decir donde se busco y cual es el
  // duradero. Sin eso, el fallo no es accionable.
  const diag = paths.describeEnvSearch(candidatos);
  for (const c of candidatos) assert(diag.includes(c), `El diagnostico nombra ${c}`);
  assert(/plugin update/i.test(diag), 'El diagnostico explica por que se pierde');
  assert.strictEqual(paths.loadBridgeEnv(bridge).loaded, null, 'Sin ficheros no carga nada');
  assert(/No se encontró ningún \.env/.test(diag), 'Sin cargado, el texto de siempre');

  // BE-097 — Con un .env cargado: dice cuál se usó, no "no se encontró ninguno".
  const conCargado = paths.describeEnvSearch(candidatos, { cargado: candidatos[0] });
  assert(!/No se encontró ningún/.test(conCargado), 'Con cargado no dice que no encontró ninguno');
  assert(conCargado.includes(`Se usó el .env de ${candidatos[0]}`), 'Nombra el .env que se usó');
  assert(/conviene moverlo/.test(conCargado) && conCargado.includes(candidatos[2]), 'Si no es el duradero, sugiere moverlo');
  const elDuradero = paths.describeEnvSearch(candidatos, { cargado: candidatos[2] });
  assert(!/conviene moverlo/.test(elDuradero), 'Si ya es el duradero, no sugiere moverlo');

  // Solo el duradero: es el escenario justo despues de un plugin update.
  fs.writeFileSync(path.join(datos, '.env'), 'AGY_TEST_ENV_MARKER=duradero\n');
  delete process.env.AGY_TEST_ENV_MARKER;
  const soloDuradero = paths.loadBridgeEnv(bridge);
  assert.strictEqual(soloDuradero.loaded, path.join(datos, '.env'), 'Cae al .env duradero');
  assert.strictEqual(process.env.AGY_TEST_ENV_MARKER, 'duradero', 'Y carga sus variables');

  // El .env local sigue teniendo precedencia: ninguna instalacion existente
  // cambia de fichero por este arreglo.
  fs.writeFileSync(path.join(bridge, '.env'), 'AGY_TEST_ENV_MARKER=local\n');
  delete process.env.AGY_TEST_ENV_MARKER;
  const conLocal = paths.loadBridgeEnv(bridge);
  assert.strictEqual(conLocal.loaded, path.join(bridge, '.env'), 'El .env local gana');
  assert.strictEqual(process.env.AGY_TEST_ENV_MARKER, 'local', 'Y son sus variables las que quedan');

  // Override explicito por encima de todo.
  const suelto = path.join(raiz, 'otro.env');
  fs.writeFileSync(suelto, 'AGY_TEST_ENV_MARKER=explicito\n');
  process.env.TELEGRAM_BRIDGE_ENV_FILE = suelto;
  delete process.env.AGY_TEST_ENV_MARKER;
  assert.strictEqual(paths.loadBridgeEnv(bridge).loaded, suelto, 'TELEGRAM_BRIDGE_ENV_FILE manda');
  assert.strictEqual(process.env.AGY_TEST_ENV_MARKER, 'explicito', 'Y carga sus variables');

  // Buscar el .env NO puede crear el directorio de datos: la busqueda ocurre en
  // el cuerpo del modulo, y crear directorios ahi convierte un import en una
  // escritura (la misma invariante que fija el Test 35).
  const datosVirgen = path.join(raiz, 'sin-crear');
  process.env.TELEGRAM_BRIDGE_DATA_DIR = datosVirgen;
  delete process.env.TELEGRAM_BRIDGE_ENV_FILE;
  paths.bridgeEnvCandidates(bridge);
  paths.loadBridgeEnv(bridge);
  assert(!fs.existsSync(datosVirgen), 'Buscar el .env no crea el directorio de datos');

  delete process.env.AGY_TEST_ENV_MARKER;
  if (dataPrevio === undefined) delete process.env.TELEGRAM_BRIDGE_DATA_DIR;
  else process.env.TELEGRAM_BRIDGE_DATA_DIR = dataPrevio;
  if (envPrevio === undefined) delete process.env.TELEGRAM_BRIDGE_ENV_FILE;
  else process.env.TELEGRAM_BRIDGE_ENV_FILE = envPrevio;
  fs.rmSync(raiz, { recursive: true, force: true });
}
console.log('✔ Test 36 [BE-008]: el .env sobrevive a un plugin update sin cambiar la precedencia');

// Test 37 [SEC-003]: el contenido que se sube a Telegram se redacta.
// `deny_paths` decide QUE fichero puede salir; esto decide QUE va dentro. Son
// controles distintos y hacen falta los dos: un resumen de sesion es un fichero
// perfectamente permitido cuyo contenido se deriva del transcript -- rutas,
// lineas de comando completas, salidas de herramientas. Si por una de esas
// lineas paso un token, viajaba a los servidores de Telegram sin filtrar.
{
  const notify = await import('../notify.js');
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-upload-'));
  const TOKEN_FALSO = '1234567890:AAFakeTokenParaEsteTestNoEsReal';

  const md = path.join(dirTmp, 'handoff.md');
  const contenido = '# Handoff\n\nSe exporto TELEGRAM_BOT_TOKEN=' + TOKEN_FALSO + ' en la consola.\n';
  fs.writeFileSync(md, contenido);

  const subido = notify.leerParaSubir(md, 'handoff.md').toString('utf8');
  assert(!subido.includes('AAFakeTokenParaEsteTest'), 'El token no debe viajar dentro del .md subido');
  assert(subido.includes('[REDACTED]'), 'La redaccion debe quedar marcada');
  assert(subido.includes('# Handoff'), 'El resto del documento se conserva');

  const enDisco = fs.readFileSync(md, 'utf8');
  assert.strictEqual(enDisco, contenido, 'El fichero en disco NO se modifica');

  // Un binario se sube tal cual: redactarlo lo corromperia.
  const bin = path.join(dirTmp, 'nota.ogg');
  const bytes = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0xff, 0xfe, 0x01]);
  fs.writeFileSync(bin, bytes);
  assert(notify.leerParaSubir(bin, 'nota.ogg').equals(bytes), 'Un binario se sube byte a byte');

  // Un texto sin secretos vuelve identico.
  const limpio = path.join(dirTmp, 'limpio.md');
  fs.writeFileSync(limpio, '# Sin secretos\n');
  assert.strictEqual(
    notify.leerParaSubir(limpio, 'limpio.md').toString('utf8'),
    '# Sin secretos\n',
    'Un texto limpio no cambia'
  );

  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 37 [SEC-003]: la subida de ficheros redacta secretos y no toca el disco');

// Test 38 [FEAT-001 / BE-008]: getKnownWorkspaces lee proyectos, normaliza, descarta WSL y deduplica por casing
{
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-test-'));
  const fakeConfig = path.join(dirTmp, '.claude.json');

  const dir1 = path.join(dirTmp, 'app1', 'frontend');
  const dir2 = path.join(dirTmp, 'app2', 'frontend');
  const dir3 = path.join(dirTmp, 'landing');
  fs.mkdirSync(dir1, { recursive: true });
  fs.mkdirSync(dir2, { recursive: true });
  fs.mkdirSync(dir3, { recursive: true });

  const fakeJson = {
    projects: {
      [dir1]: {},
      [dir1.toLowerCase()]: {}, // Duplicado de casing
      [dir2]: {}, // Misma base "frontend" pero padre "app2"
      [dir3]: {},
      [path.join(dirTmp, 'no_existe')]: {}, // Inexistente
      'wsl:ubuntu-24.04:/home/user/backend': {} // WSL
    }
  };

  const rawOriginal = JSON.stringify(fakeJson, null, 2);
  fs.writeFileSync(fakeConfig, rawOriginal, 'utf8');

  const workspaces = claudeLauncher.getKnownWorkspaces({ claudeJsonPath: fakeConfig });

  // 1. Debe haber exactamente 3 proyectos válidos (dir1, dir2, dir3)
  assert.strictEqual(workspaces.length, 3, 'Debe descartar inexistentes, WSL y duplicados de casing');

  // 2. Comprobar desambiguación de nombres duplicados ("frontend (app1)" y "frontend (app2)")
  const ws1 = workspaces.find((w) => w.path.toLowerCase() === dir1.toLowerCase());
  const ws2 = workspaces.find((w) => w.path.toLowerCase() === dir2.toLowerCase());
  const ws3 = workspaces.find((w) => w.path.toLowerCase() === dir3.toLowerCase());

  assert(ws1 && ws2 && ws3, 'Todos los proyectos reales deben encontrarse');
  assert.strictEqual(ws1.name, 'frontend');
  assert.strictEqual(ws2.name, 'frontend');
  assert(ws1.displayName.includes('app1'), 'ws1 debe estar desambiguado con su carpeta padre app1');
  assert(ws2.displayName.includes('app2'), 'ws2 debe estar desambiguado con su carpeta padre app2');
  assert(ws3.displayName.startsWith('landing (') && ws3.displayName.endsWith(')'),
    'ws3 sin colisión también lleva su carpeta padre: «frontend» a secas no decía de qué repo era');

  // 3. Comprobar que los IDs sean compactos y estables (hash de 8 caracteres) y mantengan numericId
  assert(workspaces.every((w) => typeof w.id === 'string' && /^[0-9a-f]{8}$/.test(w.id)), 'Los IDs deben ser hashes hexadecimales estables de 8 caracteres');
  assert(workspaces.every((w, idx) => w.numericId === idx), 'numericId debe ser secuencial para compatibilidad retroactiva');

  // 4. Invariante de seguridad: el archivo fuente NUNCA se modifica
  const rawDespues = fs.readFileSync(fakeConfig, 'utf8');
  assert.strictEqual(rawOriginal, rawDespues, 'El archivo .claude.json nunca debe ser modificado por la lectura');

  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 38 [FEAT-001 / BE-008]: getKnownWorkspaces lee proyectos, normaliza, descarta WSL y deduplica por casing sin tocar disco');

// Test 39 [BE-008]: getKnownWorkspaces ante archivo inexistente o JSON corrupto
{
  const noExiste = path.join(os.tmpdir(), 'archivo_que_no_existe_jamas.json');
  assert.deepStrictEqual(claudeLauncher.getKnownWorkspaces({ claudeJsonPath: noExiste }), [], 'Archivo inexistente retorna []');

  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-badjson-'));
  const badJson = path.join(dirTmp, 'corrupt.json');
  fs.writeFileSync(badJson, '{ "projects": { invalid JSON ...', 'utf8');
  assert.deepStrictEqual(claudeLauncher.getKnownWorkspaces({ claudeJsonPath: badJson }), [], 'JSON corrupto retorna [] sin lanzar');
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 39 [BE-008]: getKnownWorkspaces es resiliente a fichero ausente o JSON corrupto');

// Test 40 [FEAT-002]: resolveClaudeBin localiza el ejecutable de Claude Code
{
  const binClaude = claudeLauncher.resolveClaudeBin();
  assert(typeof binClaude === 'string' && binClaude.length > 0, 'resolveClaudeBin debe retornar una cadena no vacía');
  assert(/claude(\.exe|\.cmd)?$/i.test(binClaude), `El binario debe apuntar a claude: ${binClaude}`);
}
console.log('✔ Test 40 [FEAT-002]: resolveClaudeBin localiza el ejecutable de Claude Code en el sistema');

