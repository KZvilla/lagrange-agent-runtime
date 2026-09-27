/**
 * FEAT-091 paso 5 — Bots de nodo (§5, §6, §7, §11.1).
 *
 * `bot.js` carga el `.env` al importarse: antes se fija uno de prueba, con su
 * directorio de datos y su estado. El rol del daemon es global al módulo, así
 * que el lado servidor y el lado nodo se prueban por turnos con
 * `usarRedParaTests`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-091p5-'));
const envPrueba = path.join(raiz, '.env');
fs.writeFileSync(envPrueba, 'ALLOWED_USER_IDS=555000111\n');
process.env.TELEGRAM_BRIDGE_ENV_FILE = envPrueba;
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

const BRIDGE = path.join(__dirname, '..', 'telegram-bridge');
const imp = (f) => import(pathToFileURL(path.join(BRIDGE, f)).href);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 5000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) { if (await cond()) return true; await esperar(20); }
  return false;
}

const USUARIO = '555000111';
const GENERAL_TOKEN = '1234567890:AAFakeTokenForTestingOnly_DoNotUse';
const GENERAL_ID = 1234567890;
const WSL_TOKEN = '3334445556:AAnodoFakeTokenForTestingOnly';
const WSL_ID = 3334445556;
const NODO_ID = '11111111-1111-4111-8111-111111111111';
const OTRO_ID = '22222222-2222-4222-8222-222222222222';
const botInfo = (id, username) => ({ id, is_bot: true, first_name: username, username, can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business_account: false, has_main_web_app: false });
const texto = (t, updateId = 1, extra = {}) => ({
  update_id: updateId,
  message: {
    message_id: 100 + updateId, date: 0, chat: { id: Number(USUARIO), type: 'private' }, from: { id: Number(USUARIO), is_bot: false, first_name: 'Yo' }, text: t,
    // grammY reconoce un comando por su entidad, como los manda Telegram.
    ...(t.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: t.split(/\s/)[0].length }] } : {}),
    ...extra
  }
});
const callback = (data, updateId = 1, messageId = 900) => ({
  update_id: updateId,
  callback_query: { id: String(updateId), from: { id: Number(USUARIO), is_bot: false, first_name: 'Yo' }, chat_instance: 'ci', data, message: { message_id: messageId, date: 0, chat: { id: Number(USUARIO), type: 'private' }, text: 'x' } }
});

async function main() {
  const botMod = await imp('bot.js');
  const stateMod = await imp('state.js');
  const { InputFile, GrammyError } = await import(pathToFileURL(path.join(BRIDGE, 'node_modules', 'grammy', 'out', 'mod.js')).href);
  const { crearOrigenes } = await imp('red/origenes.js');

  // Un servidor de red falso para el lado servidor: lo justo para el ruteo.
  const redFalsa = (extra = {}) => ({
    nodos: [{ id: NODO_ID, nombre: 'casa-wsl', alias: 'ABC' }, { id: OTRO_ID, nombre: 'otro', alias: 'XYZ' }],
    conectados: new Set([NODO_ID, OTRO_ID]),
    telegram: new Set([NODO_ID]),
    pedidos: [],
    nodoPorAlias(a) { return this.nodos.find((n) => n.alias === a) || null; },
    nodoPorNombre(n) { return this.nodos.find((x) => x.nombre === n) || null; },
    existeNodo(id) { return this.nodos.some((n) => n.id === id); },
    nombreDe(id) { return this.nodos.find((n) => n.id === id)?.nombre || null; },
    conectado(id) { return this.conectados.has(id); },
    aceptaTelegram(id) { return this.telegram.has(id); },
    permiteDe(id) { return this.telegram.has(id) ? 'ejecutar' : 'operar'; },
    listaNodos() { return this.nodos.map((n) => ({ ...n, conectado: this.conectados.has(n.id) })); },
    async rpc(id, metodo, args) { this.pedidos.push({ id, metodo, args }); return { aceptado: true }; },
    ...extra
  });

  await group('Ruteo entrante: las siete reglas (§5.1, §11.1.4)', () => {
    const red = redFalsa();
    const origenes = crearOrigenes({});
    origenes.anotar(String(GENERAL_ID), Number(USUARIO), 500, NODO_ID);
    const ctx = (update, me = GENERAL_ID) => {
      const u = update.message || update.callback_query?.message || update.message_reaction;
      return {
        update,
        me: { id: me },
        chat: (update.message || update.callback_query?.message || update.message_reaction)?.chat,
        message: update.message,
        callbackQuery: update.callback_query,
        messageReaction: update.message_reaction,
        _u: u
      };
    };
    const d = (update, opciones = {}) => botMod.destinoDelUpdate(ctx(update, opciones.me), { red, origenes, ...opciones });
    stateMod.setNodoDeChat({ bot: String(GENERAL_ID), chat: Number(USUARIO) }, OTRO_ID);
    check('1: ask: va al servidor aunque el chat esté fijado', d(callback('ask:ask_0123456789abcdef:0')) === null);
    check('1: nodo: va al servidor', d(callback(`nodo:${NODO_ID}`)) === null);
    check('2: /nodo y /web van al servidor', d(texto('/nodo')) === null && d(texto('/web')) === null);
    check('3: un botón con prefijo va a su nodo aunque el chat esté fijado en otro', d(callback('@ABC:exec_plan:x'))?.id === NODO_ID);
    check('3: un alias que no existe → botón perdido', d(callback('@QQQ:x'))?.perdido === true);
    const reaccion = { update_id: 3, message_reaction: { chat: { id: Number(USUARIO), type: 'private' }, message_id: 500, date: 0, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } };
    check('3: una reacción a un mensaje del nodo vuelve a ese nodo', d(reaccion)?.id === NODO_ID);
    check('3: una respuesta a un mensaje del nodo vuelve a ese nodo', d(texto('seguí', 4, { reply_to_message: { message_id: 500, date: 0, chat: { id: Number(USUARIO), type: 'private' } } }))?.id === NODO_ID);
    check('4: un bot vinculado a un nodo va a ese nodo', d(texto('/status'), { me: WSL_ID, vinculo: { tipo: 'nodo', ref: 'casa-wsl' } })?.id === NODO_ID);
    check('4: vinculado a un nodo que no está emparejado → aviso', d(texto('/status'), { me: WSL_ID, vinculo: { tipo: 'nodo', ref: 'nadie' } })?.sinEmparejar === 'nadie');
    check('5: el chat fijado con /nodo va a ese nodo', d(texto('/run algo'))?.id === OTRO_ID);
    check('6: un bot de alma queda en el servidor', d(texto('hola'), { me: 2223334445, vinculo: { tipo: 'alma', ref: 'alya' } }) === null);
    red.nodos = red.nodos.filter((n) => n.id !== OTRO_ID);
    check('5: un nodo fijado que se revocó → vuelve al servidor con aviso', d(texto('/run algo'))?.revocado === true);
    check('y se libera el chat', stateMod.getNodoDeChat({ bot: String(GENERAL_ID), chat: Number(USUARIO) }) === null);
    check('7: lo demás va al servidor', d(texto('/status')) === null);
  });

  await group('Prefijo de botones (§6.4)', () => {
    const r = botMod.prefijarBotones({ inline_keyboard: [[{ text: 'a', callback_data: 'exec_plan:x' }, { text: 'url', url: 'https://x' }]] }, 'ABC');
    check('los botones del nodo salen con @<alias>:', r.markup.inline_keyboard[0][0].callback_data === '@ABC:exec_plan:x' && r.markup.inline_keyboard[0][1].url === 'https://x');
    check('uno que empieza con @ se rechaza', Boolean(botMod.prefijarBotones({ inline_keyboard: [[{ text: 'a', callback_data: '@ABC:ask:x' }]] }, 'ABC').error));
    check('más de 59 bytes se rechaza', Boolean(botMod.prefijarBotones({ inline_keyboard: [[{ text: 'a', callback_data: 'x'.repeat(60) }]] }, 'ABC').error));
    const formas = [`cast_ws:${'a'.repeat(8)}:${'b'.repeat(32)}`, `exec_plan:${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, `cast_cancel:${'a'.repeat(8)}`];
    check('las formas de callback_data de bot.js entran con el prefijo', formas.every((f) => !botMod.prefijarBotones({ inline_keyboard: [[{ text: 'a', callback_data: f }]] }, 'ABC').error));
  });

  await group('API acotada en el servidor (§6.4, §11.1.8)', async () => {
    const llamadas = [];
    const apiFalsa = (botId) => ({
      raw: new Proxy({}, { get: (_, m) => async (payload) => { llamadas.push({ botId, m, payload }); if (payload.chat_id === 'falla') throw Object.assign(new Error('x'), { error_code: 400, description: 'Bad Request: chat not found' }); return { message_id: 700 + llamadas.length, chat: { id: payload.chat_id } }; } }),
      getFile: async (fileId) => ({ file_id: fileId, file_size: fileId === 'grande' ? 25 * 1024 * 1024 : 10, file_path: 'documents/x.txt' })
    });
    const lista = () => [
      { nombre: 'general', botId: String(GENERAL_ID), general: true, vinculo: { tipo: 'servidor' }, usuarios: new Set([USUARIO]) },
      { nombre: 'wsl', botId: String(WSL_ID), general: false, vinculo: { tipo: 'nodo', ref: 'casa-wsl' }, usuarios: new Set([USUARIO]) },
      { nombre: 'otro', botId: '4445556667', general: false, vinculo: { tipo: 'nodo', ref: 'otro' }, usuarios: new Set([USUARIO]) },
      { nombre: 'alya', botId: '2223334445', general: false, vinculo: { tipo: 'alma', ref: 'alya' }, usuarios: new Set([USUARIO]) }
    ];
    const origenes = crearOrigenes({});
    const descargas = [];
    const tg = botMod.telegramParaNodos({ lista, apiDeBot: apiFalsa, tokenDeBot: () => 'TOKEN', origenes: () => origenes, bajar: async (url) => { descargas.push(url); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; } });
    const base = { nodo: NODO_ID, nombre: 'casa-wsl', alias: 'ABC' };
    const fuera = await tg.api({ ...base, bot: String(WSL_ID), metodo: 'getUpdates', payload: {} });
    check('un método fuera de la lista → 403', fuera.ok === false && fuera.error_code === 403);
    const ajeno = await tg.api({ ...base, bot: '4445556667', metodo: 'sendMessage', payload: { chat_id: USUARIO, text: 'x' } });
    const alma = await tg.api({ ...base, bot: '2223334445', metodo: 'sendMessage', payload: { chat_id: USUARIO, text: 'x' } });
    check('el bot de otro nodo o de un alma → 403', ajeno.error_code === 403 && alma.error_code === 403);
    const chat = await tg.api({ ...base, bot: String(WSL_ID), metodo: 'sendMessage', payload: { chat_id: '999', text: 'x' } });
    check('un chat que no es de un usuario del bot → 403', chat.error_code === 403);
    const edita = await tg.api({ ...base, bot: String(GENERAL_ID), metodo: 'editMessageText', payload: { chat_id: USUARIO, message_id: 42, text: 'x' } });
    check('editar un mensaje que no mandó ese nodo → 403', edita.error_code === 403);
    const manda = await tg.api({ ...base, bot: String(WSL_ID), metodo: 'sendMessage', payload: { chat_id: USUARIO, text: 'hola', reply_markup: { inline_keyboard: [[{ text: 'ok', callback_data: 'exec_plan:abc' }]] } } });
    check('mandar por su bot funciona y devuelve la respuesta de Telegram', manda.ok === true && manda.result.message_id > 700);
    check('con sus botones prefijados', llamadas.at(-1).payload.reply_markup.inline_keyboard[0][0].callback_data === '@ABC:exec_plan:abc');
    check('y queda anotado de qué nodo es el mensaje', origenes.de(String(WSL_ID), USUARIO, manda.result.message_id) === NODO_ID);
    const propia = await tg.api({ ...base, bot: String(WSL_ID), metodo: 'editMessageText', payload: { chat_id: USUARIO, message_id: manda.result.message_id, text: 'editado' } });
    check('editar lo suyo funciona', propia.ok === true);
    const otroNodo = await tg.api({ nodo: OTRO_ID, nombre: 'otro', alias: 'XYZ', bot: String(GENERAL_ID), metodo: 'editMessageText', payload: { chat_id: USUARIO, message_id: manda.result.message_id, text: 'robo' } });
    check('otro nodo no puede editar ese mensaje (ni por el general)', otroNodo.error_code === 403);
    const arroba = await tg.api({ ...base, bot: String(WSL_ID), metodo: 'sendMessage', payload: { chat_id: USUARIO, text: 'x', reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: '@XYZ:ask:1' }]] } } });
    check('un callback_data del nodo que empieza con @ → 400', arroba.error_code === 400);
    const error = await tg.api({ ...base, bot: String(WSL_ID), metodo: 'sendChatAction', payload: { chat_id: USUARIO, action: 'typing' } });
    check('sendChatAction pasa', error.ok === true);
    const voz = await tg.apiArchivo({ ...base, bot: String(WSL_ID), metodo: 'sendVoice', campo: 'voice', payload: { chat_id: USUARIO, caption: 'c' }, buffer: Buffer.from('OGG'), filename: '../nota.ogg' });
    check('sendVoice por api-archivo funciona, con el archivo como InputFile', voz.ok === true && llamadas.at(-1).payload.voice instanceof InputFile && llamadas.at(-1).payload.voice.filename === 'nota.ogg');
    const voz2 = await tg.apiArchivo({ ...base, bot: String(WSL_ID), metodo: 'sendDocument', campo: 'document', payload: { chat_id: USUARIO }, buffer: Buffer.from('x'), filename: 'x' });
    check('api-archivo solo acepta voz y audio', voz2.error_code === 403);
    const grande = await tg.descargar({ nombre: 'casa-wsl', bot: String(WSL_ID), fileId: 'grande' });
    check('descargar rechaza más de 20 MB sin bajar', grande.codigo === 413 && descargas.length === 0);
    const chico = await tg.descargar({ nombre: 'casa-wsl', bot: String(WSL_ID), fileId: 'chico' });
    check('y un archivo chico lo baja con el token del servidor', chico.buffer?.length === 3 && descargas[0].includes('/file/botTOKEN/documents/x.txt'));

    // §7 — Lo que reenvía un nodo sale por su bot, sin prefijo; sin bot propio, por el general con prefijo.
    llamadas.length = 0;
    const enviados = [];
    const apiEnvio = (botId) => ({
      sendMessage: async (c, t) => { enviados.push({ botId, c, t }); return { message_id: 1 }; }
    });
    const tg2 = botMod.telegramParaNodos({ lista, apiDeBot: apiEnvio, origenes: () => origenes });
    await tg2.mensaje({ nombre: 'casa-wsl', texto: 'desde wsl' });
    check('un nodo con bot propio sale por su bot y sin prefijo', enviados[0].botId === String(WSL_ID) && !enviados[0].t.includes('[casa-wsl]'), JSON.stringify(enviados[0]));
    const listaSinBot = () => lista().filter((b) => b.nombre !== 'wsl');
    const tg3 = botMod.telegramParaNodos({ lista: listaSinBot, apiDeBot: apiEnvio, origenes: () => origenes });
    process.env.ALLOWED_USER_IDS = USUARIO;
    await tg3.mensaje({ nombre: 'casa-wsl', texto: 'sin bot' });
    check('sin bot propio, por el general con el prefijo', enviados[1].botId === String(GENERAL_ID) && enviados[1].t.includes('[casa-wsl]'), JSON.stringify(enviados[1]));
  });

  await group('El servidor reenvía al nodo (§6.2, §6.5, §11.1.9-10)', async () => {
    const red = redFalsa();
    botMod.resetRuntimeState();
    botMod.usarRedParaTests({ rol: 'servidor', servidorNodos: red, origenes: crearOrigenes({}) });
    const general = botMod.createBot({ token: GENERAL_TOKEN, allowedUserIds: new Set([USUARIO]), botInfo: botInfo(GENERAL_ID, 'general_bot') });
    const deGeneral = [];
    general.api.config.use(async (prev, method, payload) => { deGeneral.push({ method, payload }); return { ok: true, result: method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 1 } } : true }; });
    const wsl = botMod.createBot({ token: WSL_TOKEN, allowedUserIds: new Set([USUARIO]), botInfo: botInfo(WSL_ID, 'wsl_bot'), vinculo: { tipo: 'nodo', ref: 'casa-wsl' }, nombre: 'wsl' });
    const deWsl = [];
    wsl.api.config.use(async (prev, method, payload) => { deWsl.push({ method, payload }); return { ok: true, result: method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 1 } } : true }; });

    await wsl.handleUpdate(texto('/status', 10));
    const p = red.pedidos.at(-1);
    check('un /status por el bot del nodo se reenvía como telegram-update', p?.id === NODO_ID && p.metodo === 'telegram-update' && p.args[0].update.message.text === '/status' && p.args[0].bot.id === WSL_ID && p.args[0].usuarios.includes(USUARIO));
    check('y el servidor no lo atiende', !deWsl.some((x) => x.method === 'sendMessage'));
    await wsl.handleUpdate(callback('@ABC:exec_plan:abc', 11));
    check('el callback con prefijo vuelve al nodo sin el prefijo', red.pedidos.at(-1).args[0].update.callback_query.data === 'exec_plan:abc');
    await general.handleUpdate(callback('@QQQ:exec_plan:abc', 12));
    check('un botón de un nodo que ya no está se contesta, y el servidor no lo ejecuta', deGeneral.some((x) => x.method === 'answerCallbackQuery' && /ya no está/.test(x.payload.text)) && red.pedidos.length === 2);

    red.conectados.delete(NODO_ID);
    deWsl.length = 0;
    await wsl.handleUpdate(texto('/run algo', 13));
    check('nodo desconectado: aviso y no se encola', deWsl.some((x) => x.method === 'sendMessage' && /desconectado/.test(x.payload.text)) && red.pedidos.length === 2);
    red.conectados.add(NODO_ID);
    red.telegram.delete(NODO_ID);
    deWsl.length = 0;
    await wsl.handleUpdate(texto('/run algo', 14));
    check('un nodo con operar: el aviso del §6.3 y no se le manda el update', deWsl.some((x) => x.method === 'sendMessage' && /no acepta pedidos por Telegram/.test(x.payload.text) && /hace falta ejecutar/.test(x.payload.text)) && red.pedidos.length === 2);
    red.telegram.add(NODO_ID);
    red.rpc = async () => ({ codigo: 504, ok: false, error: 'El nodo no respondió.' });
    deWsl.length = 0;
    await wsl.handleUpdate(texto('/status', 15));
    check('si no lo acepta en 10 s: "no respondió"', deWsl.some((x) => x.method === 'sendMessage' && /no respondió/.test(x.payload.text)));

    // /nodo en el general.
    red.rpc = async (id, metodo, args) => { red.pedidos.push({ id, metodo, args }); return { aceptado: true }; };
    deGeneral.length = 0;
    await general.handleUpdate(texto('/nodo', 20));
    const lista = deGeneral.find((x) => x.method === 'sendMessage');
    check('/nodo muestra el actual y botones con los nodos que aceptan Telegram', /servidor/.test(lista?.payload.text || '') && JSON.stringify(lista.payload.reply_markup).includes(`nodo:${NODO_ID}`) && !JSON.stringify(lista.payload.reply_markup).includes(OTRO_ID));
    await general.handleUpdate(callback(`nodo:${NODO_ID}`, 21));
    const ref = { bot: String(GENERAL_ID), chat: Number(USUARIO) };
    check('el botón fija el nodo', stateMod.getNodoDeChat(ref) === NODO_ID);
    const crudoEstado = JSON.parse(fs.readFileSync(process.env.TELEGRAM_BRIDGE_STATE_FILE, 'utf8'));
    check('el campo queda dentro de la entrada del chat, no en la raíz', crudoEstado.chats[`${GENERAL_ID}:${USUARIO}`]?.nodo === NODO_ID && crudoEstado.nodo === undefined);
    const antes = red.pedidos.length;
    await general.handleUpdate(texto('/run algo', 22));
    check('con el nodo fijado, un /run del general va al nodo', red.pedidos.length === antes + 1 && red.pedidos.at(-1).args[0].update.message.text === '/run algo');
    await general.handleUpdate(texto('/nodo servidor', 23));
    check('/nodo servidor libera', stateMod.getNodoDeChat(ref) === null);
    await general.handleUpdate(texto('/nodo casa-wsl', 24));
    check('/nodo <nombre> fija', stateMod.getNodoDeChat(ref) === NODO_ID);
    stateMod.setNodoDeChat(ref, null);
    deWsl.length = 0;
    await wsl.handleUpdate(texto('/nodo', 25));
    check('/nodo en un bot de nodo responde de quién es', deWsl.some((x) => x.method === 'sendMessage' && /Este bot es de nodo:casa-wsl/.test(x.payload.text)));
    botMod.resetRuntimeState();
  });

  await group('El nodo atiende con su propio bot.js, sin token (§6.2, §11.1.7)', async () => {
    const pedidosApi = [];
    const archivos = [];
    let fallarVoz = true;
    const clienteFalso = {
      telegramApi: async ({ bot, metodo, payload }) => { pedidosApi.push({ bot, metodo, payload }); return { ok: true, result: metodo === 'sendMessage' ? { message_id: 55, date: 0, chat: { id: Number(USUARIO) }, text: payload.text } : true }; },
      telegramApiArchivo: async (datos) => {
        archivos.push(datos);
        if (datos.metodo === 'sendVoice' && fallarVoz) return { ok: false, error_code: 400, description: 'Bad Request: VOICE_MESSAGES_FORBIDDEN' };
        return { ok: true, result: { message_id: 56, date: 0, chat: { id: Number(USUARIO) } } };
      },
      descargar: async () => ({ buffer: Buffer.from('hola'), filePath: 'documents/nota.txt' })
    };
    botMod.resetRuntimeState();
    botMod.usarRedParaTests({ rol: 'nodo', cliente: clienteFalso });
    const r = await botMod.atenderUpdateRemoto({ bot: botInfo(WSL_ID, 'wsl_bot'), usuarios: [USUARIO], update: texto('/help', 30) });
    check('acepta el update enseguida', r.aceptado === true);
    check('lo atiende su createBot y la respuesta sale por la API acotada con ese bot y ese chat',
      await hasta(() => pedidosApi.some((x) => x.metodo === 'sendMessage' && x.bot === String(WSL_ID) && String(x.payload.chat_id) === USUARIO && /Comandos disponibles/.test(x.payload.text))));
    const ajeno = await botMod.atenderUpdateRemoto({ bot: botInfo(WSL_ID, 'wsl_bot'), usuarios: [USUARIO], update: { ...texto('/help', 31), message: { ...texto('/help', 31).message, from: { id: 999, is_bot: false, first_name: 'Otro' } } } });
    await esperar(100);
    check('segunda barrera: un usuario que el servidor no manda no se atiende', ajeno.aceptado === true && pedidosApi.filter((x) => /Comandos disponibles/.test(x.payload?.text || '')).length === 1);

    // Un InputFile va por api-archivo con sus bytes, y un error de Telegram llega como GrammyError.
    const { bots: _b } = {};
    const remoto = await botMod.atenderUpdateRemoto({ bot: botInfo(WSL_ID, 'wsl_bot'), usuarios: [USUARIO], update: texto('/queue', 32) });
    check('el mismo bot remoto se reusa', remoto.aceptado === true);
    const botRemoto = botMod.botRemotoParaTests(String(WSL_ID));
    let error = null;
    try { await botRemoto.api.sendVoice(Number(USUARIO), new InputFile(Buffer.from('OGGDATA'), 'nota.ogg')); } catch (err) { error = err; }
    check('replyWithVoice va por api-archivo con los bytes de toRaw()', archivos[0]?.metodo === 'sendVoice' && archivos[0].campo === 'voice' && archivos[0].buffer.toString() === 'OGGDATA' && archivos[0].filename === 'nota.ogg');
    check('un error de Telegram reenviado llega como GrammyError (el respaldo de voz a audio sigue andando)', error instanceof GrammyError && /VOICE_MESSAGES_FORBIDDEN/.test(error.description || ''));
    fallarVoz = false;
    await botRemoto.api.sendAudio(Number(USUARIO), new InputFile(Buffer.from('AUDIO'), 'nota.wav'));
    check('sendAudio también', archivos.at(-1).metodo === 'sendAudio' && archivos.at(-1).buffer.toString() === 'AUDIO');

    botMod.usarRedParaTests({ rol: 'solo' });
    await check('fuera de un nodo, atenderUpdateRemoto se niega', await botMod.atenderUpdateRemoto({ bot: botInfo(1, 'x'), update: texto('/help') }).then(() => false, () => true));
    botMod.resetRuntimeState();
  });

  await group('Permiso del nodo (§6.3, §11.1.9)', async () => {
    const { crearClienteNodo } = await imp('red/cliente-nodo.js');
    const { crearCanalWeb, CHAT_WEB_LOCAL } = await imp('web/canal.js');
    const srv = await imp('web/servidor.js');
    const { crearServidorNodos } = await imp('red/servidor-nodos.js');
    const { crearNucleoRemoto } = await imp('red/nucleo-remoto.js');
    const admin = await imp('red/admin.js');
    const canal = crearCanalWeb();
    const dirS = path.join(raiz, 'srv');
    const sn = crearServidorNodos({ dataDir: dirS, canal, chatId: CHAT_WEB_LOCAL, rpcTimeoutMs: 1500 });
    const web = srv.crearServidorWeb({ nucleo: { canal, chatId: CHAT_WEB_LOCAL }, token: 'k'.repeat(48), red: { servidorNodos: sn, nucleoRemoto: (id) => crearNucleoRemoto(sn.rpc, id) } });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${web.address().port}`;
    const { codigo } = admin.invitar(dirS);
    const { id } = await admin.unirse(path.join(raiz, 'nd'), base, codigo, { nombre: 'casa-wsl' });
    const nodos = JSON.parse(fs.readFileSync(path.join(dirS, 'nodos.json'), 'utf8'));
    check('emparejar asigna un alias de tres caracteres', /^[2-9A-HJ-NP-Z]{3}$/.test(nodos.nodos[0].alias || ''), nodos.nodos[0].alias);
    const recibidos = [];
    const arrancar = (permite) => {
      const c = crearClienteNodo({ dataDir: path.join(raiz, 'nd'), nucleo: {}, canal: null, chatId: CHAT_WEB_LOCAL, permitidos: new Set(), permite, onTelegramUpdate: async (d) => { recibidos.push(d); return { aceptado: true }; }, backoffMinMs: 30, entreSaludosMs: 30 });
      c.iniciar();
      return c;
    };
    let c = arrancar('operar');
    await hasta(() => sn.conectado(id) && sn.permiteDe(id) === 'operar');
    check('con operar, el nodo declara que no acepta Telegram', sn.aceptaTelegram(id) === false);
    const forzado = await sn.rpc(id, 'telegram-update', [{ bot: botInfo(WSL_ID, 'wsl_bot'), usuarios: [USUARIO], update: texto('/run x') }]);
    check('si el update le llega igual, el nodo lo rechaza', forzado.codigo === 403 && recibidos.length === 0, JSON.stringify(forzado));
    c.detener();
    await hasta(() => !sn.conectado(id));
    c = arrancar('ejecutar');
    await hasta(() => sn.conectado(id) && sn.permiteDe(id) === 'ejecutar');
    check('con ejecutar, lo declara', sn.aceptaTelegram(id) === true);
    const bien = await sn.rpc(id, 'telegram-update', [{ bot: botInfo(WSL_ID, 'wsl_bot'), usuarios: [USUARIO], update: texto('/status') }]);
    check('y el update llega al nodo', bien.aceptado === true && recibidos.length === 1 && recibidos[0].update.message.text === '/status');
    c.detener();
    web.close();
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
