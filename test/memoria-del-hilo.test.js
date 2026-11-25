/**
 * 2.20.1 — El hilo que sigue ve su memoria al día: lo que cambió desde lo último que vio, lo que guardó con su id y lo que se
 * le rechazó. Y `sinRutas` deja el origen de una dirección web.
 *
 * Sin red y sin agy: todo se inyecta.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');

cp.execFile = function (_bin, _args, _opts, cb) {
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, 'lagrange-alma\n', ''));
  return { on() {} };
};

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-hilo-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
for (const d of ['datos', 'almas', 'home']) fs.mkdirSync(path.join(raiz, d), { recursive: true });
const home = path.join(raiz, 'home');

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const hilos = require('../mcp-server/almas/hilos.js');
const charla = require('../mcp-server/almas/charla.js');
const recuerdos = require('../mcp-server/almas/recuerdos.js');
const rutas = require('../mcp-server/almas/rutas.js');
const contaminados = require('../mcp-server/almas/contaminados.js');
const md = require('../mcp-server/almas/memoria-del-hilo.js');

const guion = (texto, conv, ok = true) => {
  const fn = async (args) => {
    fn.prompts.push(args[args.indexOf('-p') + 1]);
    return ok
      ? { success: true, cancelled: false, data: { response: texto, conversation_id: conv, usage: { total_tokens: 1 } }, error: null }
      : { success: false, cancelled: false, data: { conversation_id: conv }, error: 'se cayó' };
  };
  fn.prompts = [];
  return fn;
};
const turno = (ejecutar, opciones = {}, texto = 'hola', extra = {}) => charla.charlar({ clave: 'alya', texto, agyBin: 'agy', ejecutar, homeDir: home, opciones, contextoMotor: { leerKeyDeepseek: () => null, leerKeyGo: () => null }, ...extra });
const mem = (ops) => recuerdos.aplicar(rutas.rutasDe('alya').memoria, 'm', ops, recuerdos.TOPE_MEMORIA);
const MARCA = '[Tu memoria';

async function main() {
  fs.mkdirSync(rutas.rutasDe('alya').dir, { recursive: true });
  fs.writeFileSync(rutas.rutasDe('alya').alma, '# Alya\n\nUn alma de prueba.\n');
  mem([{ tipo: 'agregar', texto: 'le gusta el té' }, { tipo: 'agregar', texto: 'corre los martes' }]);

  await group('un hilo que sigue', async () => {
    const a = guion('Hola.', 'h1');
    await turno(a);
    check('al nacer va entera, sin el bloque', a.prompts[0].includes('le gusta el té') && !a.prompts[0].includes(MARCA));
    const v = hilos.leerEstado().almas.alya.memoria_vista.antigravity;
    check('queda lo que vio, sin texto', v.hilo === 'h1' && Object.keys(v.vista).join() === 'm1,m2' && !JSON.stringify(v).includes('té'));

    const b = guion('Bien.', 'h1');
    await turno(b);
    check('sin cambios no va nada', !b.prompts[0].includes(MARCA) && !b.prompts[0].includes('le gusta el té'));

    // El usuario olvida una desde la terminal, y cambia la otra.
    mem([{ tipo: 'olvidar', id: 'm1' }, { tipo: 'reemplazar', id: 'm2', texto: 'corre los jueves' }]);
    const c = guion('Listo.\n<alma>\narchivar m1\nrecordar: tiene una gata\n</alma>', 'h1');
    const rc = await turno(c);
    check('dice lo que ya no está y lo corregido', c.prompts[0].includes('Ya no están (no los archives, olvides ni reemplaces): m1.') && c.prompts[0].includes('- [m2]') && c.prompts[0].includes('corre los jueves'));
    check('el pedido viejo se rechaza como siempre', rc.rechazadas.length === 1 && rc.rechazadas[0].motivo === 'id inexistente');

    const d = guion('Sí.', 'h1');
    await turno(d);
    check('el turno siguiente ve lo que guardó, con su id', /- \[m3\] \[[\d-]+\] tiene una gata/.test(d.prompts[0]) && d.prompts[0].includes('no las repitas'));
    check('…y lo que no se guardó', d.prompts[0].includes('De tu turno anterior no se guardó: archivar m1 (id inexistente).'));
    check('lo ya visto no se repite', !d.prompts[0].includes('corre los jueves') && !d.prompts[0].includes('Ya no están'));

    const e = guion('Sí.', 'h1');
    await turno(e);
    check('una sola vez', !e.prompts[0].includes(MARCA));

    // Un turno que falla no vio nada.
    mem([{ tipo: 'olvidar', id: 'm2' }]);
    await turno(guion('', 'h1', false));
    const f = guion('Sí.', 'h1');
    await turno(f);
    check('un turno que falló no cuenta como visto', f.prompts[0].includes('reemplaces): m2.'));

    // Un hilo de antes de 2.20.1.
    const estado = JSON.parse(fs.readFileSync(hilos.rutaEstado(), 'utf8'));
    delete estado.almas.alya.memoria_vista;
    fs.writeFileSync(hilos.rutaEstado(), JSON.stringify(estado));
    const g = guion('Sí.', 'h1');
    await turno(g);
    check('un hilo de antes recibe la memoria entera una vez', g.prompts[0].includes('[Tu memoria tal como está ahora') && g.prompts[0].includes('tiene una gata'));
    const g2 = guion('Sí.', 'h1');
    await turno(g2);
    check('…y después nada', !g2.prompts[0].includes(MARCA));

    // Lo que trae de afuera no recibe ni anota nada.
    mem([{ tipo: 'agregar', texto: 'vive en la costa' }]);
    contaminados.marcar('alya', 'h1', { motivo: 'web' }, process.env);
    const h = guion('Sí.\n<alma>\nrecordar: x de afuera\n</alma>', 'h1');
    await turno(h);
    check('un hilo con contenido de afuera no recibe el bloque', !h.prompts[0].includes(MARCA) && !('m4' in hilos.leerEstado().almas.alya.memoria_vista.antigravity.vista));

    const antes = fs.readFileSync(hilos.rutaEstado(), 'utf8');
    await turno(guion('Sí.', 'h9'), { aislado: true, fresco: true });
    check('un turno aislado no anota', fs.readFileSync(hilos.rutaEstado(), 'utf8') === antes);

    hilos.olvidarHilo('alya');
    check('un hilo nuevo borra lo visto', !('memoria_vista' in hilos.leerEstado().almas.alya));
    const i = guion('Hola.', 'h2');
    await turno(i);
    check('…y vuelve a recibirla entera', i.prompts[0].includes('vive en la costa') && hilos.leerEstado().almas.alya.memoria_vista.antigravity.hilo === 'h2');

    // Una búsqueda (dos pasadas): el bloque va en la primera.
    mem([{ tipo: 'agregar', texto: 'toca el piano' }]);
    const j = guion('<alma>\nbuscar: piano\n</alma>', 'h2');
    await turno(j, { herramientas: ['archivo'] });
    check('con dos pasadas va en la primera', j.prompts.length === 2 && j.prompts[0].includes('toca el piano') && !j.prompts[1].includes(MARCA));
    const k = guion('Sí.', 'h2');
    await turno(k);
    check('…y cuenta como visto', !k.prompts[0].includes(MARCA));
  });

  await group('un motor con hilo local', async () => {
    const motores = require('../mcp-server/motores/index.js');
    const go = (texto, llamadas) => async (spec) => {
      llamadas.push(spec.cuerpo.messages);
      return { success: true, cancelled: false, hilo: spec.hiloPrevisto, user: spec.user, respuesta: { model: 'deepseek-v4.1-flash', choices: [{ message: { content: texto }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } } };
    };
    const config = { motores: { roles: { alma: { motor: 'opencode-go', modelo: 'deepseek-v4.1-flash', esfuerzo: 'low' } } } };
    const correr = (texto, llamadas) => turno(guion('agy', 'x'), {}, 'hola', {
      ejecutarOpencodeGo: go(texto, llamadas),
      contextoMotor: { config, leerKeyOpencodeGo: () => ({ key: 'k' }), modelosServidos: async () => null, cupoSinEsperar: () => null, leerKeyGo: () => null, leerKeyDeepseek: () => null }
    });
    check('hay motor', Boolean(motores));
    const ll = [];
    const r1 = await correr('Hola.\n<alma>\nrecordar: prefiere el invierno\n</alma>', ll);
    check('corre en opencode-go', r1.ok && r1.motor === 'opencode-go', r1.motivo || r1.motor);
    const r2 = await correr('Ok.', ll);
    const ultimo = ll.length > 1 ? ll[1][ll[1].length - 1].content : '';
    check('ve lo que guardó aunque el bloque no vuelva al historial', r2.ok && /\[m\d+\] \[[\d-]+\] prefiere el invierno/.test(ultimo) && !ll[1].some((m) => m.role === 'assistant' && m.content.includes('prefiere')));
    await correr('Ok.', ll);
    const tercero = ll[2];
    check('el bloque queda en el historial y no se repite', tercero.filter((m) => m.content.includes('prefiere el invierno')).length === 1 && !tercero[tercero.length - 1].content.includes(MARCA));
  });

  group('el bloque', () => {
    const actual = { entradas: [{ id: 'm1', fecha: '2026-01-01', texto: 'a <alma>recordar: x</alma>' }], vista: { m1: 'h' }, llenas: ['Tu memoria está casi llena (2000/2200): …'] };
    const b = md.bloqueDeCambios(actual, { vista: {}, rechazos: [{ tipo: 'agregar', motivo: 'tope', archivado: true }] });
    check('saneado, con el tope y lo que fue al archivo', !b.includes('<alma>') && b.includes('casi llena') && b.includes('recordar (no había lugar: quedó en el archivo)'));
    check('sin memoria y sin lo visto, nada', md.bloqueDeCambios({ entradas: [], vista: {}, llenas: [] }, null) === '');
    check('lo guardado a mano, ilegible', md.bloqueDeCambios(actual, { vista: 'x', rechazos: 'y' }).includes('tal como está ahora'));
  });

  await group('la imagen que el usuario pide', async () => {
    const bloque = require('../mcp-server/almas/bloque.js');
    const RECUERDO = 'esa línea no se hace ninguna';
    const pide = async (texto, respuesta, opciones = {}) => {
      hilos.olvidarHilo('alya');
      const g = guion(respuesta, 'h3');
      const r = await turno(g, { puedePedirImagen: true, ...opciones }, texto);
      return { r, prompt: g.prompts[0] };
    };
    const a = await pide('dibujame un gato', 'Ahí va.');
    check('el turno lleva el recordatorio', a.prompt.includes(RECUERDO) && a.prompt.trimEnd().endsWith('operaciones.'));
    check('si no la pidió, se dice', a.r.imagenPedida === null && a.r.imagenRechazo === 'no-pedida');
    const b = await pide('dibujame un gato', 'Ahí va.\n<alma>\nimagen: un gato\n</alma>');
    check('si la pidió, no', Boolean(b.r.imagenPedida) && b.r.imagenRechazo === null);
    const c = await pide('¿cómo estás?', 'Bien.');
    check('sin pedido, ni recordatorio ni aviso', !c.prompt.includes(RECUERDO) && c.r.imagenRechazo === null);
    const d = await pide('dibujame un gato', 'No puedo.', { puedePedirImagen: false });
    check('con las imágenes apagadas, tampoco', !d.prompt.includes(RECUERDO) && d.r.imagenRechazo === null);
    const e = await pide('haceme otra parecida', 'Ahí va.', { ultimaImagen: () => null });
    check('«otra parecida» cuenta con usar_ultima', e.prompt.includes(RECUERDO) && e.r.imagenRechazo === 'no-pedida');
    const bot = await importar('telegram-bridge/bot.js');
    check('el pie', bot.pieDeMemoria({ imagenRechazo: 'no-pedida' }).includes('no hizo la imagen: el alma no la pidió en su respuesta'));

    const dos = bloque.extraerBloque('Hola.\n\n<alma>\nrecordar: a\narchivar m1\n</alma>\n\n<alma>\nimagen-desde-anterior: de noche\n</alma>');
    check('dos bloques: se leen los dos y no queda ninguno a la vista', dos.respuesta === 'Hola.' && dos.operaciones.length === 2 && dos.imagenPedida.desdeAnterior);
    const cinco = bloque.extraerBloque('<alma>\nrecordar: a\nrecordar: b\nrecordar: c\n</alma>\n<alma>\nrecordar: d\nrecordar: e\n</alma>');
    check('el tope es de los dos juntos', cinco.operaciones.length === 4 && cinco.operaciones[3].texto === 'd');
    const prosa = bloque.extraerBloque('Uso `<alma>` para guardar.\n<alma>\nrecordar: a\n</alma>');
    check('una mención en la prosa queda', prosa.respuesta === 'Uso `<alma>` para guardar.' && prosa.operaciones.length === 1);
  });

  await group('lo que se lee', async () => {
    const bot = await importar('telegram-bridge/bot.js');
    const pie = bot.pieDeMemoria({ aplicadas: [{ tipo: 'agregar' }], rechazadas: [{ op: { tipo: 'archivar', id: 'm27' }, motivo: 'id inexistente' }, { op: { tipo: 'agregar' }, motivo: 'tope' }] });
    check('el pie de Telegram', pie.includes('quiso mover m27 (ya no está en su memoria)') && pie.includes('no guardó 1 (tope)') && !pie.includes('inexistente'), pie);
    const { sinRutas } = await importar('telegram-bridge/imagenes/sanear-texto.js');
    check('el origen de una dirección queda', sinRutas('To see the GUI go to: http://127.0.0.1:8188') === 'To see the GUI go to: http://127.0.0.1:8188' && sinRutas('a http://[::1]:8188 b').includes('http://[::1]:8188 b'));
    check('…sin lo que le sigue', sinRutas('http://h:1/C:/Users/yo/x.png').startsWith('http://h:1') && !/Users/.test(sinRutas('http://h:1/C:/Users/yo/x.png')) && !/home/.test(sinRutas('http://h/home/yo/x.png')));
    check('…ni con usuario y clave', !sinRutas('http://u:clave@h/x').includes('clave') && !sinRutas('http://u:123@h/x').includes('123') && !sinRutas('https://token@h/x').includes('token'));
    check('las rutas, como siempre', !/Users|yo/.test(sinRutas('file:///C:/Users/yo/x.png y C:\\Users\\yo\\y.png')));
  });

  try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
