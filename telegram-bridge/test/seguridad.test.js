/**
 * BE-176 — Grupo seguridad y estabilidad: Tests 20 a 29.
 *
 * Política de rutas, redacción de secretos, entorno de agy, guardrails,
 * offload de prompts, asks huérfanos, resolución atómica, aviso de cola y
 * rotación de logs. Usa state y temporales propios; no depende de los
 * handlers de bot que quedan en test-bridge.js.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearEntorno, FAKE_TOKEN } from './harness.js';

const { stateFile: TEST_STATE_FILE } = crearEntorno();
const state = await import('../state.js');
const testChatId = 999999999;

// ==============================================================================
// Tests de la ronda de seguridad y estabilidad (SEC-00x / BE-00x / FEAT-001)
// ==============================================================================

const policy = await import('../policy.js');
const logrotate = await import('../logrotate.js');
const { buildGuardrailedPrompt, offloadLargePrompt, loadPolicy } = await import('../executor.js');

// Test 20 [SEC-002]: deny_paths se evalúa como glob real, no como lista fija.
// La versión que solo reconocía los tres patrones por defecto devolvía `false`
// en silencio para cualquier política que el usuario escribiera.
const denegadasPorDefecto = ['C:\\proj\\.env', '/home/u/app/.env.local', '/srv/id_rsa.key', 'C:/certs/server.pem'];
for (const ruta of denegadasPorDefecto) {
  assert(policy.isPathDenied(ruta, policy.DEFAULT_DENY_PATHS), `${ruta} debe estar denegada`);
}
for (const ruta of ['C:/proj/README.md', '/home/u/notes.txt']) {
  assert(!policy.isPathDenied(ruta, policy.DEFAULT_DENY_PATHS), `${ruta} debe estar permitida`);
}
// Patrón personalizado con directorio: es justo lo que un matcher por basename
// no puede expresar.
assert(policy.isPathDenied('C:/proj/secrets/api.txt', ['secrets/**']), 'secrets/** debe casar a cualquier profundidad');
assert(policy.isPathDenied('C:/proj/a/b/secrets/x/y.txt', ['secrets/**']), 'secrets/** debe casar anidado');
assert(!policy.isPathDenied('C:/proj/public/api.txt', ['secrets/**']), 'fuera de secrets/ debe pasar');
assert.strictEqual(policy.matchDeniedPath('C:/proj/.env', policy.DEFAULT_DENY_PATHS), '.env*', 'devuelve el patrón culpable');
assert.throws(
  () => policy.assertPathAllowed('C:/proj/.env', policy.DEFAULT_DENY_PATHS),
  (err) => err instanceof policy.PolicyViolationError,
  'assertPathAllowed lanza PolicyViolationError'
);
assert.doesNotThrow(() => policy.assertPathAllowed('C:/proj/README.md', policy.DEFAULT_DENY_PATHS));
console.log('✔ Test 20 [SEC-002]: deny_paths se evalúa como glob real');

// Test 21 [SEC-002]: la subida a Telegram rechaza la ruta ANTES de tocar la red.
// El fichero se crea de verdad para que el rechazo no dependa de que no exista.
{
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-deny-'));
  const envFalso = path.join(dirTmp, '.env.test');
  fs.writeFileSync(envFalso, 'TELEGRAM_BOT_TOKEN=1234567890:AAsecretoQueNoDebeSalirDeAqui\n');

  const fetchOriginal = globalThis.fetch;
  let huboRed = false;
  globalThis.fetch = async () => { huboRed = true; throw new Error('no debería haber red'); };

  const notify = await import('../notify.js');
  await assert.rejects(
    () => notify.sendTelegramNotification({ message: 'toma el env', filePath: envFalso }),
    (err) => err instanceof policy.PolicyViolationError,
    'sendTelegramNotification rechaza un adjunto prohibido'
  );
  assert.strictEqual(huboRed, false, 'No debe hacerse ninguna petición de red al rechazar');

  globalThis.fetch = fetchOriginal;
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 21 [SEC-002]: telegram_notify no sube un adjunto prohibido ni contacta la red');

// Test 22 [SEC-000]: el entorno del hijo `agy` no lleva secretos del bridge.
// `agy` corre con --dangerously-skip-permissions y puede ejecutar comandos: un
// `echo` del token bastaría para publicarlo en el chat.
{
  const entorno = policy.sanitizeEnv({
    PATH: '/usr/bin',
    WORKSPACE_DIR: 'C:/proj',
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_NOTIFY_CHAT_ID: '123',
    ALLOWED_USER_IDS: '123,456'
  });
  assert.strictEqual(entorno.TELEGRAM_BOT_TOKEN, undefined, 'El token no se hereda');
  assert.strictEqual(entorno.ALLOWED_USER_IDS, undefined, 'La whitelist no se hereda');
  assert.strictEqual(entorno.TELEGRAM_NOTIFY_CHAT_ID, undefined, 'El chat de notificación no se hereda');
  assert.strictEqual(entorno.PATH, '/usr/bin', 'El resto del entorno se conserva');
  assert.strictEqual(entorno.WORKSPACE_DIR, 'C:/proj', 'El workspace se conserva');
  assert(!JSON.stringify(entorno).includes(FAKE_TOKEN), 'Ningún rastro del token');
}
console.log('✔ Test 22 [SEC-000]: el entorno de agy va sin secretos del bridge');

// Test 23 [SEC-004]: enmascarado de tokens en texto destinado al log o al chat.
assert.strictEqual(
  policy.redactSecrets(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`),
  'https://api.telegram.org/bot1234567890:[REDACTED]/sendMessage',
  'Enmascara el token dentro de una URL de la API'
);
assert(
  !policy.redactSecrets(`TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}`).includes('AAFakeToken'),
  'Enmascara también el token suelto, sin el prefijo bot'
);
assert.strictEqual(policy.redactSecrets('duración 12:30, ratio 1234567:8'), 'duración 12:30, ratio 1234567:8', 'No toca texto inocuo');
assert.strictEqual(policy.redactSecrets(null), '', 'Tolera null');
console.log('✔ Test 23 [SEC-004]: redactSecrets cubre URL y token suelto');

// Test 24 [BE-000]: los guardrails llevan la política EFECTIVA, no los defaults.
// Antes /status mostraba policy.* y al modelo se le inyectaban los defaults: lo
// que el usuario configuraba no llegaba nunca a quien podía atenderlo.
{
  const dirWs = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-policy-'));
  fs.mkdirSync(path.join(dirWs, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dirWs, '.claude', 'antigravity.json'),
    JSON.stringify({ permissions: { deny_paths: ['secretos/**', '*.pfx'], deny_commands: ['terraform destroy*'] } })
  );

  const cargada = loadPolicy(dirWs);
  assert.deepStrictEqual(cargada.denyPaths, ['secretos/**', '*.pfx'], 'loadPolicy toma las rutas del fichero');
  assert.deepStrictEqual(cargada.denyCommands, ['terraform destroy*'], 'loadPolicy toma los comandos del fichero');

  const inyectado = buildGuardrailedPrompt(cargada, 'haz algo');
  assert(inyectado.includes('secretos/**'), 'El guardrail lleva la ruta configurada');
  assert(inyectado.includes('terraform destroy*'), 'El guardrail lleva el comando configurado');
  assert(!inyectado.includes('git push*'), 'El guardrail NO cae en los defaults cuando hay política');
  assert(inyectado.endsWith('haz algo'), 'El prompt del usuario queda al final');

  fs.rmSync(dirWs, { recursive: true, force: true });
}
console.log('✔ Test 24 [BE-000]: los guardrails inyectan la política efectiva');

// Test 25 [BE-001]: un prompt que no cabe en un argumento se vuelca a fichero.
// Nota de alcance: por el camino de Telegram esto no se dispara —un mensaje no
// pasa de 4096 caracteres—; cubre a los llamantes directos de runAgyTask.
{
  const promptGigante = 'x'.repeat(40000);
  const base = ['--mode', 'plan', '-p', promptGigante];
  const { args, cleanup } = offloadLargePrompt(base);

  assert.notStrictEqual(args[3], promptGigante, 'El prompt se sustituye por un puntero');
  assert(args[3].length < 1000, 'El puntero cabe de sobra en un argumento');
  const idxDir = args.lastIndexOf('--add-dir');
  assert(idxDir > 0, 'Se añade el directorio temporal a los accesibles');
  const dirVolcado = args[idxDir + 1];
  const ficheroVolcado = path.join(dirVolcado, 'PROMPT.md');
  assert(fs.existsSync(ficheroVolcado), 'El PROMPT.md existe');
  assert.strictEqual(fs.readFileSync(ficheroVolcado, 'utf8'), promptGigante, 'El volcado es íntegro');
  assert(args[3].includes(ficheroVolcado), 'El puntero nombra el fichero');

  cleanup();
  assert(!fs.existsSync(dirVolcado), 'cleanup() borra el directorio temporal');

  const corto = ['-p', 'hola'];
  assert.strictEqual(offloadLargePrompt(corto).args, corto, 'Un prompt normal pasa intacto');
}
console.log('✔ Test 25 [BE-001]: offloadLargePrompt vuelca, apunta y limpia');

// Test 26 [BE-004]: los asks pendientes vencidos se recolectan; los vivos no.
// El umbral es el vencimiento declarado de cada ask, no una constante: con un
// umbral fijo, un ask con timeout mayor se marcaría expirado mientras su
// notify.js sigue esperándolo, y el botón respondería «expiró» sin desbloquear.
{
  state.registerPendingAsk('ask_vivo', {
    question: '¿sigo?', options: ['Sí', 'No'], chatId: testChatId, messageId: 1,
    timeoutSeconds: 4 * 3600 // 4 h: por encima de cualquier umbral fijo razonable
  });
  state.registerPendingAsk('ask_huerfano', {
    question: '¿y esto?', options: ['Sí'], chatId: testChatId, messageId: 2,
    timeoutSeconds: 300
  });

  // Se retrasa a mano el huérfano: su cliente murió y su plazo ya venció.
  const crudo = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  const hace3h = new Date(Date.now() - 3 * 3600 * 1000);
  crudo.pendingAsks.ask_huerfano.createdAt = hace3h.toISOString();
  crudo.pendingAsks.ask_huerfano.expiresAt = new Date(hace3h.getTime() + 300 * 1000).toISOString();
  // Un registro sin ninguna marca de tiempo utilizable: no se puede fechar ni
  // atribuir a nadie, y era justo el caso que se colaba por el hueco del NaN.
  crudo.pendingAsks.ask_corrupto = { askId: 'ask_corrupto', status: 'pending', chatId: testChatId };
  fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(crudo, null, 2));

  state.purgeAsks();

  assert.strictEqual(state.getPendingAsk('ask_vivo').status, 'pending', 'Un ask dentro de plazo sigue pendiente');
  assert.strictEqual(state.getPendingAsk('ask_huerfano').status, 'expired', 'Un ask vencido pasa a expired');
  assert.strictEqual(state.getPendingAsk('ask_corrupto'), null, 'Un ask sin fecha utilizable se elimina');

  // Una vez expirado y pasada la retención, desaparece.
  const crudo2 = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  crudo2.pendingAsks.ask_huerfano.expiredAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(crudo2, null, 2));
  state.purgeAsks();
  assert.strictEqual(state.getPendingAsk('ask_huerfano'), null, 'Tras la retención se elimina del estado');
}
console.log('✔ Test 26 [BE-004]: los asks huérfanos se recolectan sin tocar los vivos');

// Test 27 [SEC-003]: resolver un ask es atómico. La comprobación de estado vive
// dentro del lock; hacerla en el llamante era un TOCTOU y dos pulsaciones
// seguidas resolvían dos veces, pisando la primera respuesta.
{
  state.registerPendingAsk('ask_doble', {
    question: '¿aplico?', options: ['Aprobar', 'Rechazar'], chatId: testChatId, messageId: 3, timeoutSeconds: 300
  });
  const primero = state.resolvePendingAsk('ask_doble', 'Aprobar', 111);
  const segundo = state.resolvePendingAsk('ask_doble', 'Rechazar', 222);

  assert(primero && primero.status === 'answered', 'La primera pulsación resuelve');
  assert.strictEqual(segundo, null, 'La segunda pulsación no resuelve nada');
  assert.strictEqual(state.getPendingAsk('ask_doble').answer, 'Aprobar', 'La respuesta original se conserva');
  assert.strictEqual(state.getPendingAsk('ask_doble').answeredBy, 111, 'El autor original se conserva');

  const yaExpirado = state.expirePendingAsk('ask_doble');
  assert.strictEqual(yaExpirado, null, 'Un ask ya respondido no se puede expirar');
}
console.log('✔ Test 27 [SEC-003]: resolvePendingAsk es atómico y no se resuelve dos veces');

// A partir de aquí se ejercita `bot.js` directamente. Es lo que el refactor a
// módulo importable hace posible: mientras el arranque vivía en el cuerpo del
// módulo, importarlo tomaba el lockfile, validaba el token y abría el long
// polling, así que ningún handler suyo podía probarse.
process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
const {
  createBot,
  resetRuntimeState,
  avisoDeDespacho,
  buildWorkspacesKeyboard,
  buildStopMessageAndKeyboard,
  armarPromptDeReaccion,
  ALLOWED_UPDATES,
  iniciarPolling
} = await import('../bot.js');

// Test 28 [BE-003]: el aviso anuncia la posición real en la fila, no el índice
// de la cola. Con una tarea corriendo, el primero en cola es el segundo en fila.
assert(
  avisoDeDespacho({ habiaTareaEnCurso: false, posEnCola: 1, mode: 'plan' }).includes('Generando plan'),
  'Sin nada en curso, arranca de inmediato'
);
assert(
  avisoDeDespacho({ habiaTareaEnCurso: false, posEnCola: 1, mode: 'accept-edits' }).includes('Ejecutando tarea'),
  'El modo se refleja en el aviso'
);
assert(
  avisoDeDespacho({ habiaTareaEnCurso: true, posEnCola: 1, mode: 'plan' }).includes('posición #2'),
  'Con una tarea en curso, el primero en cola va el segundo'
);
assert(
  avisoDeDespacho({ habiaTareaEnCurso: true, posEnCola: 3, mode: 'plan' }).includes('posición #4'),
  'La posición cuenta la tarea en ejecución'
);
assert(
  avisoDeDespacho({ habiaTareaEnCurso: false, posEnCola: 2, mode: 'plan' }).includes('posición #2'),
  'Cola con resto y nada en curso: la posición es el índice'
);
console.log('✔ Test 28 [BE-003]: el aviso de cola anuncia la posición real');

// Test 29 [BE-005]: la rotación copia y trunca, nunca renombra.
// El log lo tiene abierto en modo append el cmd.exe de la redirección: un
// rename falla o deja el handle apuntando al fichero renombrado, y daemon.log
// no vuelve a recibir nada. Truncar sí funciona con un handle en append.
{
  const dirLog = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-log-'));
  const logFile = path.join(dirLog, 'daemon.log');
  fs.writeFileSync(logFile, 'a'.repeat(2048));

  assert.strictEqual(logrotate.rotateIfNeeded(logFile, 4096), false, 'Por debajo del tope no rota');
  assert.strictEqual(fs.statSync(logFile).size, 2048, 'El log intacto');

  assert.strictEqual(logrotate.rotateIfNeeded(logFile, 1024), true, 'Por encima del tope rota');
  assert(fs.existsSync(logFile), 'El log sigue existiendo tras rotar (no se renombró)');
  assert.strictEqual(fs.statSync(logFile).size, 0, 'El log queda truncado a cero');
  assert.strictEqual(fs.statSync(`${logFile}.old`).size, 2048, 'La generación anterior se conserva íntegra');

  assert.strictEqual(logrotate.rotateIfNeeded(path.join(dirLog, 'no-existe.log'), 1), false, 'Sin fichero no falla');
  fs.rmSync(dirLog, { recursive: true, force: true });
}
console.log('✔ Test 29 [BE-005]: la rotación trunca en sitio y conserva una generación');

