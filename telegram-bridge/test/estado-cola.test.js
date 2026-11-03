/**
 * BE-176 — Grupo estado y cola: Tests 4, 5, 6, 7, 8, 11, 12, 13 y 16.
 *
 * Comparten estado en memoria y en disco (el ask del Test 8 se resuelve en el
 * 13, el Context del 6 se reutiliza en el 16), así que viven juntos en un solo
 * proceso. El estado de test se fija antes de importar state.js.
 *
 * Los bloques se movieron verbatim: mismos casos, textos y aserciones.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { crearEntorno, FAKE_TOKEN, BOT_ID_PRUEBA, tg } from './harness.js';

const { stateFile: TEST_STATE_FILE } = crearEntorno();
const state = await import('../state.js');
const queue = await import('../queue.js');
const { Api, Context } = await import('grammy');

// Test 4: Persistencia de estado
const testChatId = 999999999;
state.setConversationId(tg(testChatId), 'test-conv-12345', { test: true });
assert.strictEqual(state.getConversationId(tg(testChatId)), 'test-conv-12345', 'Debe recuperar el conversationId');

state.clearConversationId(tg(testChatId));
assert.strictEqual(state.getConversationId(tg(testChatId)), null, 'Debe borrar conversationId tras clear');
console.log('✔ Test 4: Persistencia de estado validada');

// Test 5: Cola de tareas en memoria (concurrency 1)
assert.strictEqual(queue.getQueueLength(), 0, 'La cola arranca vacía');
assert.strictEqual(queue.enqueueTask({ id: 'task-1', prompt: 'test' }), 1, 'Debe devolver la posición');
assert.strictEqual(queue.getQueueLength(), 1, 'Cola debe incrementar');
const dequeued = queue.dequeueTask();
assert.strictEqual(dequeued.id, 'task-1', 'Debe desencolar la tarea');
assert.strictEqual(queue.dequeueTask(), null, 'Cola vacía devuelve null');
console.log('✔ Test 5: Cola de ejecución (concurrency 1) validada');

// Test 6 (regresión): un Context vivo de grammY sobrevive al paso por la cola.
// Antes la cola se serializaba a state.json y el Context volvía como objeto plano:
// `ctx.replyWithChatAction is not a function` tumbaba el bot en cada /run.
const api = new Api(FAKE_TOKEN);
const update = {
  update_id: 1,
  message: {
    message_id: 10,
    date: Math.floor(Date.now() / 1000),
    chat: { id: testChatId, type: 'private' },
    from: { id: testChatId, is_bot: false, first_name: 'Test' },
    text: '/run algo'
  }
};
const ctx = new Context(update, api, { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' });

// El modo de fallo que se está previniendo, documentado como aserción:
const roundTripped = JSON.parse(JSON.stringify({ ctx }));
assert.strictEqual(typeof roundTripped.ctx.reply, 'undefined', 'Un Context serializado pierde sus métodos');

queue.enqueueTask({ ctx, chatId: testChatId, prompt: 'algo', mode: 'plan', conversationId: null });
const liveTask = queue.dequeueTask();
assert.strictEqual(liveTask.ctx, ctx, 'La cola debe devolver la misma referencia de Context');
for (const method of ['reply', 'replyWithChatAction', 'answerCallbackQuery', 'editMessageReplyMarkup']) {
  assert.strictEqual(typeof liveTask.ctx[method], 'function', `ctx.${method} debe seguir siendo invocable`);
}
assert.strictEqual(liveTask.chatId, testChatId, 'Los datos de la tarea deben conservarse');
assert.strictEqual(liveTask.mode, 'plan', 'El modo debe conservarse');
console.log('✔ Test 6: el Context vivo sobrevive a encolar/desencolar');

// Test 7: la vista serializable de la cola no arrastra handles ni secretos
queue.enqueueTask({ ctx, chatId: testChatId, prompt: 'x'.repeat(500), mode: 'plan' });
const snapshot = queue.getQueueSnapshot();
const snapshotJson = JSON.stringify(snapshot);
assert.strictEqual(snapshot.length, 1, 'El snapshot refleja la cola');
assert.strictEqual(snapshot[0].ctx, undefined, 'El snapshot no expone el Context');
assert(!snapshotJson.includes(FAKE_TOKEN), 'El snapshot no debe contener el token del bot');
assert(snapshot[0].promptPreview.length <= 80, 'El prompt se recorta en el snapshot');
queue.clearQueue();
console.log('✔ Test 7: getQueueSnapshot() es serializable y sin secretos');

// Test 8: el estado persistido nunca contiene el token del bot.
// Un ask pendiente es lo más parecido a la ruta que filtraba el secreto.
state.registerPendingAsk('ask-test-1', {
  question: '¿Continuar?',
  options: ['Sí', 'No'],
  chatId: testChatId,
  messageId: 42
});
state.setConversationId(tg(testChatId), 'conv-abc');
const persisted = fs.readFileSync(TEST_STATE_FILE, 'utf8');
assert(!persisted.includes(FAKE_TOKEN), 'state.json NO debe contener el TELEGRAM_BOT_TOKEN');
assert(!persisted.includes('"token"'), 'state.json NO debe contener ningún campo token');
assert(!persisted.includes('"queue"'), 'state.json ya no persiste la cola de tareas');
assert.strictEqual(typeof state.enqueueTask, 'undefined', 'state.js ya no debe exponer la cola');
console.log('✔ Test 8: el estado en disco está libre de secretos');


// Test 11: escritura atómica — no debe quedar ningún .tmp ni .lock huérfano,
// y el contenido en disco debe ser siempre JSON completo y parseable.
state.setConversationId(tg(testChatId), 'conv-atomica');
const stateDir = path.dirname(TEST_STATE_FILE);
const residuos = fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
assert.deepStrictEqual(residuos, [], `No debe quedar residuo de escritura: ${residuos.join(', ')}`);
assert.doesNotThrow(
  () => JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8')),
  'El estado en disco siempre debe ser JSON completo'
);
console.log('✔ Test 11: escritura atómica sin residuos');

// Test 12: caché por mtime — una escritura externa debe invalidarla.
assert.strictEqual(state.getConversationId(tg(testChatId)), 'conv-atomica', 'Lectura cacheada');
const onDisk = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
onDisk.chats[`${BOT_ID_PRUEBA}:${testChatId}`].lastConversationId = 'conv-externa';
fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(onDisk, null, 2), 'utf8');
assert.strictEqual(
  state.getConversationId(tg(testChatId)),
  'conv-externa',
  'La caché debe invalidarse cuando otro proceso escribe el fichero'
);
console.log('✔ Test 12: la caché se invalida por mtime');

// Test 13: ciclo de vida y recolección de asks.
state.registerPendingAsk('ask-vivo', { question: 'q', options: ['a'], chatId: testChatId, messageId: 1 });
state.registerPendingAsk('ask-caduca', { question: 'q', options: ['a'], chatId: testChatId, messageId: 2 });

const expirado = state.expirePendingAsk('ask-caduca');
assert.strictEqual(expirado.status, 'expired', 'El timeout debe marcar expired');
assert(expirado.expiredAt, 'Debe registrar cuándo expiró');
assert.strictEqual(state.expirePendingAsk('ask-caduca'), null, 'No se vuelve a expirar lo ya cerrado');

const respondido = state.resolvePendingAsk('ask-test-1', 'Sí', testChatId);
assert.strictEqual(respondido.status, 'answered', 'resolvePendingAsk marca answered');

// Con retención 0 se van los cerrados; el pendiente se queda: puede haber un
// notify.js esperándolo.
const purgados = state.purgeAsks(0);
assert.strictEqual(purgados, 2, `Debe purgar los 2 asks cerrados, purgó ${purgados}`);
assert(state.getPendingAsk('ask-vivo'), 'Un ask pendiente NUNCA se purga');
assert.strictEqual(state.getPendingAsk('ask-caduca'), null, 'El expirado se purga');
assert.strictEqual(state.getPendingAsk('ask-test-1'), null, 'El respondido se purga');
console.log('✔ Test 13: asks se expiran y se recolectan');


// Test 16: la cola guarda la MISMA referencia, no una copia. De eso depende que
// dispatchTask pueda anotar el statusMessageId después de encolar.
const tareaViva = { ctx, chatId: testChatId, prompt: 'p', mode: 'plan', statusMessageId: null };
queue.enqueueTask(tareaViva);
tareaViva.statusMessageId = 4242;
const recuperada = queue.dequeueTask();
assert.strictEqual(recuperada, tareaViva, 'La cola guarda la referencia, no una copia');
assert.strictEqual(recuperada.statusMessageId, 4242, 'Las mutaciones posteriores al encolado se ven');
assert(recuperada.enqueuedAt, 'enqueueTask anota cuándo se encoló');
console.log('✔ Test 16: la cola preserva la identidad de la tarea');

