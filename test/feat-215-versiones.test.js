/**
 * FEAT-215 (parte B) — Cuál imagen es cuál y de cuál se parte: el número, el origen, las candidatas y la elegida, el bloque
 * (`imagen-desde #7`), la pregunta con varias versiones, varias ediciones, «Variar esta», «Partir de esta», la API y los ajustes.
 *
 * Sin red, sin agy y sin ComfyUI: todo se inyecta.
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

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat215b-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.LAGRANGE_COMFYUI_DIR = path.join(raiz, 'comfyui');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
for (const d of ['datos/adjuntos', 'almas', 'home']) fs.mkdirSync(path.join(raiz, d), { recursive: true });
const home = path.join(raiz, 'home');

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indice = require('../mcp-server/imagenes/indice.js');
const A = require('../mcp-server/lib/ajustes-imagenes.js');
const bloque = require('../mcp-server/almas/bloque.js');
const charla = require('../mcp-server/almas/charla.js');
const contaminados = require('../mcp-server/almas/contaminados.js');
const diario = require('../mcp-server/almas/diario.js');
const hilos = require('../mcp-server/almas/hilos.js');
const rutas = require('../mcp-server/almas/rutas.js');
const versiones = require('../mcp-server/almas/versiones.js');
const sondaVision = require('../mcp-server/imagenes/sonda-vision.js');

let tono = 0;
const png = () => sondaVision.pngSolido(8, [tono++ % 250, 70, 9]);
const hasta = async (cond, ms = 4000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); } return cond(); };
const tira = (fn) => { try { fn(); return null; } catch (err) { return err; } };
let reloj = Date.parse('2026-11-25T10:00:00Z');
const tic = () => new Date((reloj += 60000));

/** Una entrada lista en el índice, con su archivo. */
function entrada(tareaId, n, extra = {}, clave = 'alya') {
  const archivo = path.join(indice.dirImagenes(clave), `${tareaId}-${n}-1.png`);
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, png());
  indice.actualizar(clave, tareaId, n, () => ({ lista: true, hilo: 'h1', externo: false, archivo, sha256: indice.sha256(fs.readFileSync(archivo)), prompt: 'un faro', vista: 'v', vistaEstado: 'lista', vistaEntregada: false, creada: tic().toISOString(), intento: 1, ...extra }));
  return archivo;
}
const limpiar = (clave = 'alya') => { fs.rmSync(indice.dirImagenes(clave), { recursive: true, force: true }); indice.listar(clave); };

const guion = (texto, conv = 'h1') => {
  const fn = async (args) => { fn.prompts.push(args[args.indexOf('-p') + 1]); return { success: true, cancelled: false, data: { response: texto, conversation_id: conv, usage: { total_tokens: 1 } }, error: null }; };
  fn.prompts = [];
  return fn;
};
const turno = (ejecutar, opciones = {}, texto = 'hola') => charla.charlar({
  clave: 'alya', texto, agyBin: 'agy', ejecutar, homeDir: home, opciones: { puedePedirImagen: true, fotoCuenta: true, ...opciones },
  contextoMotor: { leerKeyDeepseek: () => null, leerKeyGo: () => null }
});
const im = (linea, texto = 'Va.') => `${texto}\n<alma>\n${linea}\n</alma>`;

async function main() {
  fs.mkdirSync(rutas.rutasDe('alya').dir, { recursive: true });
  fs.writeFileSync(rutas.rutasDe('alya').alma, '# Alya\n\nUn alma de prueba.\n');
  const bot = await importar('telegram-bridge/bot.js');
  const { crearColaImagenes } = await importar('telegram-bridge/imagenes-cola.js');
  const { crearGaleria } = await importar('telegram-bridge/imagenes/galeria.js');
  const productores = await importar('telegram-bridge/web/v2/productores.js');
  const tareas = await importar('telegram-bridge/tareas.js');
  const { rutasMutacionV2 } = await importar('telegram-bridge/web/v2/mutaciones.js');

  await group('el número', () => {
    limpiar();
    entrada('t_aaaa1', 1); entrada('t_aaaa2', 1); entrada('t_aaaa3', 1, { lista: false });
    check('las de antes, por fecha y una sola vez', indice.numerar('alya').map((x) => x.num).join() === '1,2' && indice.leer('alya', 't_aaaa1', 1).num === 1 && indice.leer('alya', 't_aaaa2', 1).num === 2 && indice.numerar('alya').length === 0);
    check('una sin terminar no gasta número', indice.leer('alya', 't_aaaa3', 1).num === undefined);
    check('el siguiente', indice.tomarNumero('alya') === 3);
    indice.actualizar('alya', 't_aaaa2', 1, (p) => ({ ...p, num: 3 }));
    indice.borrar('alya', 't_aaaa2', 1);
    check('borrar el mayor no lo reusa', indice.tomarNumero('alya') === 4);
    fs.writeFileSync(path.join(indice.dirImagenes('alya'), 'contador.json'), '{roto');
    indice.actualizar('alya', 't_aaaa1', 1, (p) => ({ ...p, num: 9 }));
    check('con el contador roto sigue del mayor', indice.tomarNumero('alya') === 10);
    check('el contador no es una imagen', indice.listar('alya').every((e) => e.tareaId.startsWith('t_')));
    const a = indice.porNumero('alya', 9);
    check('por número', a && a.tareaId === 't_aaaa1' && indice.porNumero('alya', 77) === null);
    fs.rmSync(a.ruta);
    check('sin su archivo, no', indice.porNumero('alya', 9) === null);
  });

  await group('cuál es cuál', () => {
    check('la pedida por el alma', versiones.rotulo({ num: 7, origen: 'alma' }) === 'Imagen #7, tuya');
    check('otra versión', versiones.rotulo({ num: 8, origen: 'version', deNum: 7, baseNum: 5 }) === 'Imagen #8, tuya · otra versión de la #7 (mismo pedido, otra semilla): la pidió el usuario por su cuenta · partió de la #5');
    check('una variación: su base es la misma', versiones.rotulo({ num: 9, origen: 'variante', deNum: 8, baseNum: 8 }) === 'Imagen #9, tuya · una variación de la #8: la pidió el usuario por su cuenta');
    check('una de antes', versiones.rotulo({ origen: 'alma' }) === 'Tu imagen');
    check('el grupo', versiones.avisoDeGrupos([{ num: 7, origen: 'alma' }, { num: 8, origen: 'version', deNum: 7 }, { num: 9, origen: 'version', deNum: 8 }]) === '[Las #7, #8 y #9 son versiones del mismo pedido: una sola corrida, no 3.]');
    check('una variación no es del grupo, ni dos pedidos', versiones.avisoDeGrupos([{ num: 7, origen: 'alma' }, { num: 8, origen: 'variante', deNum: 7 }, { num: 9, origen: 'alma' }]) === '');
    for (const t of ['la 7', '#8', 'sobre la #7', 'la primera', 'la segunda', 'la última', 'las dos', 'ambas', 'a todas', '8', 'la versión 7']) check(`nombra una: «${t}»`, versiones.nombraVersion(t, [7, 8]) === true);
    for (const t of ['la 9', 'hola', 'tengo 7 gatos', 'la tercera', 'qué lindo']) check(`…«${t}» no`, versiones.nombraVersion(t, [7, 8]) === false);
  });

  await group('entre cuáles se elige', () => {
    limpiar();
    const nums = (hs = ['h1']) => indice.candidatas('alya', hs).lista.map((e) => e.num).join();
    entrada('t_bbbb1', 1, { num: 1 });
    check('una sola', nums() === '1');
    entrada('t_bbbb1', 2, { num: 2, origen: 'version', deNum: 1 });
    check('con otra versión, las dos', nums() === '1,2');
    entrada('t_bbbb2', 1, { num: 3 });
    check('el pedido nuevo del alma deja atrás las de antes', nums() === '3');
    entrada('t_bbbb1', 3, { num: 4, origen: 'version', deNum: 1 });
    check('una versión de una vieja cuenta si es posterior', nums() === '3,4');
    entrada('t_bbbb3', 1, { num: 5 }); entrada('t_bbbb3', 2, { num: 6 });
    check('las varias de un mismo turno del alma', nums() === '5,6');
    entrada('t_bbbb4', 1, { num: 7, hilo: 'h2', origen: 'variante' });
    check('solo una del usuario en un hilo', nums(['h2']) === '7');
    check('el primer hilo que tenga', nums([null, 'h9', 'h2', 'h1']) === '7');
    fs.rmSync(indice.porNumero('alya', 6).ruta);
    check('sin archivo no cuenta', nums() === '5');
    entrada('t_bbbb5', 1, { num: 8, lista: false });
    check('sin terminar tampoco', nums() === '5');

    entrada('t_bbbb3', 3, { num: 9, origen: 'version', deNum: 5 });
    indice.elegir('alya', 't_bbbb3', 1, true, process.env, tic());
    const elegida = () => { const e = indice.candidatas('alya', ['h1']).elegida; return e ? e.num : null; };
    check('la elegida', elegida() === 5);
    indice.elegir('alya', 't_bbbb3', 3, true, process.env, tic());
    check('una sola por hilo', elegida() === 9 && indice.listar('alya').filter((e) => e.elegida).length === 1);
    indice.elegir('alya', 't_bbbb4', 1, true, process.env, tic());
    check('…y otra en otro hilo', elegida() === 9 && indice.candidatas('alya', ['h2']).elegida.num === 7);
    indice.elegir('alya', 't_bbbb3', 1, false, process.env, tic());
    check('desmarcar una que no es la elegida no toca la elegida', elegida() === 9);
    indice.elegir('alya', 't_bbbb3', 3, false, process.env, tic());
    check('desmarcar', elegida() === null && indice.candidatas('alya', ['h2']).elegida.num === 7);
    indice.elegir('alya', 't_bbbb1', 1, true, process.env, tic());
    check('puede ser una que no es candidata', elegida() === 1);
    entrada('t_bbbb6', 1, { num: 10 });
    check('con una más nueva que la marca, vence', elegida() === null);
  });

  await group('el bloque', () => {
    const n = (l) => { const x = bloque.parsearImagen(l); return x && x.nums ? x.nums.join('+') : x && 'sin'; };
    check('#7', n('imagen-desde #7: de noche') === '7' && bloque.parsearImagen('imagen-desde #7: de noche').texto === 'de noche');
    for (const l of ['imagen-desde #7 #8: x', 'imagen-desde #7, #8: x', 'imagen-desde #7 y #8: x', 'imagen-desde 7 8: x', 'Imagen-Desde #7,#8 : x']) check(`dos: ${l}`, n(l) === '7+8');
    check('repetido', n('imagen-desde #7 #7: x') === '7');
    check('las otras, como siempre', n('imagen-desde-foto: x') === 'sin' && n('imagen-desde-anterior: x') === 'sin' && n('imagen: la #7 de noche') === 'sin');
    check('no es una línea', bloque.parsearImagen('imagen-desde: x') === null && bloque.parsearImagen('imagen-desde #: x') === null && bloque.parsearImagen('imagen-desde la 7: x') === null && bloque.parsearImagen('imagen-desde #0: x') === null);
    const larga = `imagen-desde ${'#1 '.repeat(4000)}x`;
    const t0 = Date.now();
    bloque.parsearImagen(larga);
    for (const l of [`imagen-desde #7${' '.repeat(60)}x`, `imagen-desde #7${' '.repeat(5000)}x`, `imagen-desde ${'7 '.repeat(60)}x`, `imagen-desde ${'1'.repeat(90)}x`, `imagen-desde #7 ${'y '.repeat(50)}:x`, `imagen-desde ${'1'.repeat(119)}x: c`, `imagen-desde ${'1 '.repeat(59)}x: c`, `imagen-desde ${'12'.repeat(59)} x: c`, `imagen-desde ${'#1 y '.repeat(23)}x: c`]) bloque.parsearImagen(l);
    check('una línea armada no cuelga', Date.now() - t0 < 300, String(Date.now() - t0));
    check('con «, y» y espacios de más', n('imagen-desde  #7 ,  #8,  y #9 :  x') === '7+8+9');
    const c = (v) => bloque.instruccionDeCierre({ puedePedirImagen: true, puedePedirAnterior: true, versiones: v });
    check('la consigna', c({ porNumero: true, varias: true, sinElegir: [7, 8], elegida: null }).includes('imagen-desde #7: <qué cambiar>') && c({ porNumero: true, varias: true, sinElegir: [7, 8] }).includes('sin elegir: #7, #8.') && c({ porNumero: true, varias: true, sinElegir: [7, 8] }).includes('si dice todas, todos'));
    check('sin varias', !c({ porNumero: true, varias: false, sinElegir: [7, 8] }).includes('todas') && !c({ porNumero: true, varias: false, sinElegir: [] }).includes('una edición por cada una'));
    check('con la elegida', c({ porNumero: true, varias: true, sinElegir: [], elegida: 8 }).includes('El usuario eligió partir de la #8'));
    check('sin nada, la de antes', c(null) === bloque.instruccionDeCierre({ puedePedirImagen: true, puedePedirAnterior: true }));
  });

  await group('el turno', async () => {
    limpiar();
    const r1 = entrada('t_cccc1', 1, { num: 7 });
    const r2 = entrada('t_cccc1', 2, { num: 8, origen: 'version', deNum: 7 });
    const config = (extra = {}) => ({ ...A.defectos(), ...extra });
    const op = (extra = {}, opciones = {}) => {
      const c = config(extra);
      return { versiones: bot.versionesDelTurno('alya', c), ...(c.usar_ultima ? { ultimaImagen: (k, hs) => { const u = indice.ultimaImagen(k, hs); return u && { ...u, segura: u.externo === false }; } } : {}), ...opciones };
    };
    const nuevo = () => { hilos.olvidarHilo('alya'); hilos.registrarTurno('alya', { conversationId: 'h1' }); };
    nuevo();
    const g = guion(im('imagen-desde-anterior: de noche'));
    const a = await turno(g, op(), 'haceme otra parecida, de noche');
    check('con dos versiones no se hace, y dice entre cuáles', a.imagenPedida === null && a.imagenRechazo === 'cual-version' && a.imagenCandidatas.join() === '7,8');
    check('la consigna lo avisa', g.prompts[0].includes('varias versiones sin elegir: #7, #8') && g.prompts[0].includes('imagen-desde #7'));
    const q = await turno(guion('¿Sobre la #7 o la #8?'), op(), 'haceme otra parecida, de noche');
    check('si preguntó, el pie no dice que la omitió', q.imagenRechazo === 'cual-version');
    const g2 = guion(im('imagen-desde #7: de noche'));
    const b = await turno(g2, op(), 'la primera');
    check('responder «la primera» lleva el recordatorio', g2.prompts[0].includes('esa línea no se hace ninguna'));
    check('por su número', b.imagenPedida.foto.ruta === r1 && b.imagenPedida.baseFija && b.imagenPedida.desde.join() === '7' && b.imagenPedida.bases.length === 1 && b.imagenPedida.desdeFoto);
    const g3 = guion('Ajá.');
    const n = await turno(g3, op(), 'la segunda');
    check('…pero no vale como pedido', n.imagenRechazo === null);
    const u = await turno(guion(im('imagen-desde-anterior: x')), op({ varias_versiones: 'ultima' }), 'otra parecida');
    check('con «usar la última», esa', u.imagenPedida.foto.ruta === r2 && u.imagenPedida.desdeAnterior && u.imagenPedida.desde.join() === '8');
    indice.actualizar('alya', 't_cccc1', 1, (p) => ({ ...p, num: undefined }));
    const sn = await turno(guion(im('imagen-desde-anterior: x')), op(), 'otra parecida');
    check('una candidata sin número igual hace preguntar', sn.imagenRechazo === 'cual-version' && sn.imagenCandidatas.join() === '8');
    indice.actualizar('alya', 't_cccc1', 1, (p) => ({ ...p, num: 7 }));
    indice.elegir('alya', 't_cccc1', 1, true, process.env, tic());
    const e = await turno(guion(im('imagen-desde-anterior: x')), op(), 'otra parecida');
    check('con una elegida, esa', e.imagenPedida.foto.ruta === r1 && e.imagenPedida.desde.join() === '7');
    const ep = await turno(guion(im('imagen-desde-anterior: x')), op({ partir: false }), 'otra parecida');
    check('con «Partir de esta» apagado la marca no cuenta', ep.imagenRechazo === 'cual-version');
    indice.elegir('alya', 't_cccc1', 1, false, process.env, tic());

    const d = await turno(guion(im('imagen-desde #7 #8: sumá un gato')), op(), 'a las dos sumales un gato');
    check('a las dos', d.imagenPedida.bases.map((x) => x.num).join() === '7,8' && d.imagenPedida.bases[1].foto.ruta === r2 && d.imagenPedida.foto.ruta === r1);
    check('el diario', diario.ultimas('alya', 3).some((x) => x.imagen && x.imagen.desde && x.imagen.desde.join() === '7,8'));
    const sf = await turno(guion(im('imagen-desde #7: x')), op({}, { fotoCuenta: false }), 'la 7');
    check('por número la base no se pierde, con foto_cuenta apagado', sf.imagenPedida.baseFija === true);
    const d2 = await turno(guion(im('imagen-desde #7 #8: sumá un gato')), op({ varias_bases: false }), 'a las dos');
    check('con varias apagado no se hacen', d2.imagenPedida === null && d2.imagenRechazo === 'una-por-turno');
    const no = await turno(guion(im('imagen-desde #99: x')), op(), 'la 99');
    check('un número que no está', no.imagenPedida === null && no.imagenRechazo === 'sin-esa-imagen');
    const sinUlt = await turno(guion(im('imagen-desde #7: x')), op({ usar_ultima: false }), 'la 7');
    check('con usar_ultima apagado no hay números', sinUlt.imagenRechazo === 'sin-anterior' && bot.versionesDelTurno('alya', config({ usar_ultima: false })) === null);
    const foto = path.join(raiz, 'datos', 'adjuntos', 'f.png');
    fs.writeFileSync(foto, png());
    const cf = await turno(guion(im('imagen-desde #7: x')), op({}, { imagen: { ruta: foto, segura: true, origen: 'marcada' } }), 'con esta');
    check('la foto del turno gana', cf.imagenPedida.foto.ruta === foto && cf.imagenPedida.baseFija);

    // De afuera.
    const rx = entrada('t_cccc2', 1, { num: 9, externo: true });
    nuevo();
    const x1 = await turno(guion(im('imagen-desde #9: x')), op(), 'contame algo');
    check('una de afuera, sin pedirla, no', x1.imagenPedida === null && x1.imagenRechazo === 'hilo-externo');
    const x2 = await turno(guion(im('imagen-desde #7 #9: x')), op(), 'dibujame otra imagen');
    check('pedida, sí; y con una sola de afuera el turno cuenta como de afuera', x2.imagenPedida.bases.length === 2 && x2.externo.join() === 'imagen' && x2.bloqueado.length > 0 && rx);
    const x3 = await turno(guion(im('imagen-desde #7: x')), op(), 'la primera');
    check('en un hilo de afuera, «la primera» no alcanza', x3.imagenPedida === null && contaminados.contaminado('alya', 'h1', process.env));
    const viejo = await turno(guion(im('imagen-desde-anterior: x'), 'h7'), { fresco: true, ultimaImagen: () => ({ ruta: r1, externo: false, segura: true }) }, 'otra parecida');
    check('sin versiones (otro que llama), como antes', viejo.imagenPedida.foto.ruta === r1 && viejo.imagenPedida.desde === undefined);
  });

  await group('lo que ve el alma', async () => {
    limpiar();
    entrada('t_dddd1', 1, { num: 7, vista: 'un perro y un gato' });
    entrada('t_dddd1', 2, { num: 8, origen: 'version', deNum: 7, vista: 'dos gatos' });
    hilos.olvidarHilo('alya'); hilos.registrarTurno('alya', { conversationId: 'h5' });
    const pend = indice.vistasPendientes('alya', 'h1');
    const g = guion('Bien.', 'h5');
    await turno(g, { vistasPendientes: () => pend }, 'mirá');
    check('descriptas, con su nombre', g.prompts[0].includes('[Imagen #7, tuya. Lo que salió (descripción') && g.prompts[0].includes('[Imagen #8, tuya · otra versión de la #7') && g.prompts[0].includes('son versiones del mismo pedido: una sola corrida, no 2'));
  });

  await group('la cola', async () => {
    limpiar();
    let config = { ...A.defectos(), orden: ['comfyui'], alma_la_ve: false };
    const registros = new Map();
    const registro = {
      tarea: (id) => registros.get(id),
      actualizar: (id, cambios) => { const t = { ...registros.get(id), ...(cambios.imagenes ? { imagenes: cambios.imagenes.map(tareas.normalizarImagen) } : {}) }; registros.set(id, t); return t; }
    };
    const pedidos = [];
    const cambios = [];
    const refinador = {
      refinar: async (x) => { pedidos.push(x); return { prompt: `p ${pedidos.length}`, negativo: '', proporcion: '1:1', zona: '', instruccion: '', loras: [], caso: x.foto ? 'variacion' : 'nueva', casoPedido: x.foto ? 'variacion' : 'nueva', refinado: true, cambio: null, fuerza: null }; },
      sinRefinar: () => ({ prompt: 'x', negativo: '', proporcion: '1:1', zona: '', instruccion: '', loras: [], caso: 'nueva', casoPedido: 'nueva' })
    };
    const generados = [];
    let falla = false;
    const cola = crearColaImagenes({
      registro, leerConfig: () => config, refinador, vision: { llamar: async () => ({ ok: false }) }, catalogoDe: async () => null, dirAdjuntos: () => path.join(raiz, 'datos', 'adjuntos'),
      alCambiar: (c) => cambios.push(c), ahora: tic,
      proveedor: () => ({ generar: async (g) => { generados.push(g); if (falla) return { ok: false, codigo: 'error' }; const r = `${g.destino}.png`; fs.writeFileSync(r, png()); return { ok: true, ruta: r, tipo: 'image/png', ancho: 1024, alto: 1024, semilla: 1 }; } })
    });
    const tarea = (id) => registros.set(id, { id, sujeto: { tipo: 'alma', clave: 'alya' }, imagenes: [] });
    const lista = (id, n) => hasta(() => (registros.get(id).imagenes.find((i) => i.n === n) || {}).estado === 'lista');
    const e = (id, n) => registros.get(id).imagenes.find((i) => i.n === n);
    tarea('t_eeee1');
    const envios = [];
    cola.encolar({ tareaId: 't_eeee1', clave: 'alya', hilo: 'h1', pedido: 'un faro', mensaje: '', desdeFoto: false, foto: null, externo: false, envio: (x) => envios.push(x) });
    await lista('t_eeee1', 1);
    check('la del alma lleva su número', e('t_eeee1', 1).num === 1 && e('t_eeee1', 1).origen === 'alma' && indice.leer('alya', 't_eeee1', 1).num === 1);
    await hasta(() => envios.length === 1);
    check('el envío también', envios[0].num === 1);
    cola.otra('t_eeee1', 1);
    await lista('t_eeee1', 2);
    check('otra versión', e('t_eeee1', 2).num === 2 && e('t_eeee1', 2).origen === 'version' && e('t_eeee1', 2).deNum === 1 && e('t_eeee1', 2).baseNum === undefined);
    const r = cola.variar('t_eeee1', 2);
    await lista('t_eeee1', 3);
    check('variar parte de esa, sin su prompt', r.ok && e('t_eeee1', 3).origen === 'variante' && e('t_eeee1', 3).deNum === 2 && e('t_eeee1', 3).baseNum === 2 && e('t_eeee1', 3).num === 3);
    const p = pedidos[pedidos.length - 1];
    check('…el refinador la mira', p.pedido.startsWith('Otra parecida a esta') && p.base === 'fija' && p.foto.ruta === indice.porNumero('alya', 2).ruta && p.foto.segura === true);
    check('…y no contamina', indice.leer('alya', 't_eeee1', 3).externo === false);
    config = { ...config, variar: false };
    check('apagada', cola.variar('t_eeee1', 1).codigo === 'apagada');
    config = { ...config, variar: true };
    check('una que no está', cola.variar('t_eeee1', 9).codigo === 'no-existe');
    cola.variar('t_eeee1', 1);
    await lista('t_eeee1', 4);
    check('el tope del turno', cola.variar('t_eeee1', 1).codigo === 'tope-turno');
    check('un pedido nuevo con un adjunto que es suyo, por sus bytes', await (async () => {
      const adj = path.join(raiz, 'datos', 'adjuntos', 'copia.png');
      fs.copyFileSync(indice.porNumero('alya', 2).ruta, adj);
      tarea('t_eeee2');
      cola.encolar({ tareaId: 't_eeee2', clave: 'alya', hilo: 'h1', pedido: 'x', mensaje: '', desdeFoto: true, baseFija: true, foto: { ruta: adj, segura: true }, externo: false });
      await lista('t_eeee2', 1);
      return e('t_eeee2', 1).baseNum === 2;
    })());
    tarea('t_eeee3');
    entrada('t_eeee3', 1, { num: 50, externo: true });
    registros.get('t_eeee3').imagenes = [{ n: 1, estado: 'lista', num: 50 }];
    cola.variar('t_eeee3', 1);
    await lista('t_eeee3', 2);
    check('variar una de afuera hereda lo de afuera', indice.leer('alya', 't_eeee3', 2).externo === true && pedidos[pedidos.length - 1].foto.segura === false);
    // Reintentar conserva.
    falla = true;
    cola.otra('t_eeee3', 1);
    await hasta(() => e('t_eeee3', 3) && e('t_eeee3', 3).estado === 'error');
    check('una que falla no gasta número', e('t_eeee3', 3).num === undefined && e('t_eeee3', 3).origen === 'version');
    falla = false;
    const ultimo = indice.listar('alya').reduce((m, x) => Math.max(m, x.num || 0), 0);
    cola.reintentar('t_eeee3', 3);
    await lista('t_eeee3', 3);
    check('reintentada, conserva de dónde salió', e('t_eeee3', 3).num === ultimo + 1 && e('t_eeee3', 3).origen === 'version' && e('t_eeee3', 3).deNum === 50);

    // Partir de esta.
    const x1 = cola.partir('alya', 't_eeee1', 1, true);
    check('partir de esta', x1.ok && e('t_eeee1', 1).elegida === true && cambios.includes('alya'));
    cola.partir('alya', 't_eeee1', 2, true);
    check('una sola', e('t_eeee1', 1).elegida === false || e('t_eeee1', 1).elegida === undefined ? e('t_eeee1', 2).elegida === true : false);
    tarea('t_eeee4');
    cola.encolar({ tareaId: 't_eeee4', clave: 'alya', hilo: 'h1', pedido: 'otro', mensaje: '', desdeFoto: false, foto: null, externo: false });
    await lista('t_eeee4', 1);
    check('una nueva la desmarca', !e('t_eeee1', 2).elegida && indice.candidatas('alya', ['h1']).elegida === null);
    check('sin hilo, sin imagen, apagada', cola.partir('alya', 't_zzzz9', 1, true).codigo === 'no-existe' && (entrada('t_eeee5', 1, { hilo: null }), cola.partir('alya', 't_eeee5', 1, true).codigo === 'sin-hilo') && ((config = { ...config, partir: false }), cola.partir('alya', 't_eeee1', 1, true).codigo === 'apagada'));
    config = { ...config, partir: true };
    indice.actualizar('alya', 't_eeee2', 1, (p) => ({ ...p, num: undefined }));
    cola.alArrancar(['alya']);
    check('al arrancar no renumera, y lo que faltaba se ve también en el turno', indice.leer('alya', 't_eeee1', 1).num === 1 && indice.leer('alya', 't_eeee2', 1).num > 1 && e('t_eeee2', 1).num === indice.leer('alya', 't_eeee2', 1).num);

    // La galería.
    cola.partir('alya', 't_eeee4', 1, true);
    const galeria = crearGaleria({ cola, registro, leerConfig: () => config });
    const fila = galeria.listar({}).imagenes.find((f) => f.tareaId === 't_eeee1' && f.n === 3);
    check('la galería', fila.num === 3 && fila.origen === 'variante' && fila.deNum === 2 && fila.baseNum === 2 && fila.elegida === false && galeria.listar({}).imagenes.find((f) => f.tareaId === 't_eeee4').elegida === true);
    config = { ...config, partir: false };
    check('…sin marcas si está apagado', galeria.listar({}).imagenes.every((f) => f.elegida === false));
    config = { ...config, partir: true };

    // La API.
    const llamadas = [];
    const r2 = rutasMutacionV2({ nucleo: {}, cola: {}, ctx: {}, chatTerminal: 'x', registro: { obtener: (id) => registros.get(id) }, idem: { porId: () => null, extras: () => ({}) }, conGaleria: true, imagenes: { galeria, variar: (t, n) => { llamadas.push(['variar', t, n]); return cola.variar(t, n); }, partir: (...a) => { llamadas.push(a); return cola.partir(...a); } } });
    const ir = async (metodo, url, cuerpo = {}) => { for (const x of r2) { const m = x.metodo === metodo && x.patron.exec(url); if (m) return x.fn({ p: m.slice(1), cuerpo, url: new URL(`http://x${url}`) }); } return null; };
    check('POST …:partir', (await ir('POST', '/api/v2/imagenes/alya/t_eeee4/1:partir', { elegida: false })).ok === true && !e('t_eeee4', 1).elegida);
    check('…con su cuerpo', (await ir('POST', '/api/v2/imagenes/alya/t_eeee4/1:partir', {})).codigo === 400 && (await ir('POST', '/api/v2/imagenes/alya/t_zzzz9/1:partir', { elegida: true })).codigo === 404 && (await ir('POST', '/api/v2/imagenes/..%2f/t_eeee4/1:partir', { elegida: true })).codigo === 400);
    const v = await ir('POST', '/api/v2/turnos/t_eeee4/imagenes/1:variar');
    check('POST …:variar', v.ok === true && v.n === 2);
    await lista('t_eeee4', 2);
    config = { ...config, variar: false };
    const va = await ir('POST', '/api/v2/turnos/t_eeee4/imagenes/1:variar');
    check('…apagada', va.codigo === 409 && va.motivo === 'apagada' && /Variar/.test(va.error));
  });

  await group('lo que se ve', async () => {
    const pie = (t) => bot.pieDeMemoria(t);
    check('desde cuál', pie({ imagenPedida: { texto: 'x', desde: [8] } }).includes('🖼️ va a hacer una imagen · desde la #8'));
    check('varias', pie({ imagenPedida: { texto: 'x', desde: [7, 8], bases: [{}, {}] } }).includes('🖼️ va a hacer 2 imágenes · desde las #7 y #8'));
    check('sin número, como antes', pie({ imagenPedida: { texto: 'x' } }).includes('🖼️ va a hacer una imagen\n') || pie({ imagenPedida: { texto: 'x' } }).endsWith('🖼️ va a hacer una imagen'));
    check('cuál', pie({ imagenRechazo: 'cual-version', imagenCandidatas: [7, 8] }).includes('hay varias versiones (#7 y #8): decile sobre cuál'));
    check('un número que no está', pie({ imagenRechazo: 'sin-esa-imagen' }).includes('no hay ninguna imagen con ese número'));
    const m = productores.memoriaDe({ imagen: { pedida: 'x', rechazo: null, desde: [7, 'x', -1, 8], candidatas: [] } });
    check('memoria.imagen', m.imagen.desde.join() === '7,8' && m.imagen.candidatas === undefined);
    const i = productores.imagenesDe([{ n: 1, estado: 'lista', num: 7, origen: 'version', deNum: 6, baseNum: 5, elegida: true }, { n: 2, estado: 'lista', num: 'x', origen: 'otro', elegida: 'si' }]);
    check('turno.imagenes', i[0].num === 7 && i[0].origen === 'version' && i[0].deNum === 6 && i[0].baseNum === 5 && i[0].elegida === true && ['num', 'origen', 'elegida'].every((k) => i[1][k] === undefined));
    const mandados = [];
    const api = { sendPhoto: async (chat, f, o) => { mandados.push(o.caption); return { message_id: 1 }; }, sendMessage: async () => ({}) };
    const ref = { bot: 1, chat: 2 };
    const envio = bot.crearEnvioImagen(ref, 2, { tareaId: 't_ffff1', clave: null, api });
    const f = path.join(raiz, 'x.png');
    fs.writeFileSync(f, png());
    await envio({ ok: true, n: 1, num: 41, ruta: f, caso: 'nueva' });
    await envio({ ok: true, n: 2, ruta: f, caso: 'variacion' });
    check('el pie de la imagen', mandados.join('|') === '🖼️ #41 · nueva|🖼️ 2 · variación');
    const resp = (caption) => bot.imagenRespondida({ message: { reply_to_message: { message_id: 99, photo: [{}], caption, from: { id: 5 } } }, me: { id: 5 }, chat: { id: 2 } }, { leerConfig: () => A.defectos() });
    check('responder a los dos pies', resp('🖼️ #41 · nueva')?.perdida === true && resp('🖼️ 1 · nueva')?.perdida === true && resp('hola') === null);
    check('la capacidad', bot.capacidadesV2().capacidades.versiones === true);
    // De quién es la foto.
    const yo = { clave: 'alya', tareaId: 't_ffff2', n: 1, externo: false };
    entrada('t_ffff2', 1, { num: 12 });
    const ft = (clave, de) => bot.fotoDelTurno({ ruta: f, segura: false }, A.defectos(), { clave, reconocer: () => de, reconocerTelegram: () => null });
    check('suya, con su número', ft('alya', yo).num === 12 && !ft('alya', yo).deOtra);
    check('de otra alma: segura, pero no suya', ft('bruno', yo).deOtra === true && ft('bruno', yo).segura === true && ft('bruno', yo).num === undefined);
  });

  await group('los ajustes', async () => {
    const ajustesV2 = fs.readFileSync(path.join(RAIZ, 'telegram-bridge/web/v2/ajustes.js'), 'utf8');
    const d = A.defectos();
    check('de fábrica', d.variar && d.partir && d.varias_bases && d.varias_versiones === 'preguntar');
    check('normalizar', A.normalizar({ varias_versiones: 'ultima' }).imagenes.varias_versiones === 'ultima' && A.normalizar({ varias_versiones: 'x' }).imagenes.varias_versiones === 'preguntar');
    const aplicar = (pedido) => { const datos = {}; A.aplicarImagenes(datos, pedido); return datos; };
    check('un valor malo da 400', tira(() => aplicar({ varias_versiones: 'x' }))?.campo === 'imagenes.varias_versiones' && tira(() => aplicar({ partir: 'si' }))?.campo === 'imagenes.partir');
    check('en la API', ['variar', 'partir', 'varias_bases', 'varias_versiones', 'vision_propia'].every((k) => new RegExp(`'${k}'`).test(ajustesV2)));
    const contrato = JSON.parse(fs.readFileSync(path.join(RAIZ, 'telegram-bridge/web/contrato-v2.json'), 'utf8'));
    const todo = JSON.stringify(contrato);
    check('en el contrato', ['"num"', '"deNum"', '"baseNum"', '"elegida"', '"candidatas"', '"versiones"'].every((k) => todo.includes(k)));
  });

  try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
