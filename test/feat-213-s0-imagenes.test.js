/**
 * FEAT-213 S0 — Partir de una imagen y la galería: el índice y sus rutas, lo externo heredado, la base que no se pierde, la
 * fuerza según el cambio, `imagen-desde-anterior`, responder a una imagen, la cola que espera a ComfyUI, el tope por alma, la
 * galería (listar, bajar, borrar, la referencia) y los ajustes nuevos.
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

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat213-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.LAGRANGE_COMFYUI_DIR = path.join(raiz, 'comfyui');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
for (const d of ['datos/adjuntos', 'almas']) fs.mkdirSync(path.join(raiz, d), { recursive: true });

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indice = require('../mcp-server/imagenes/indice.js');
const A = require('../mcp-server/lib/ajustes-imagenes.js');
const C = require('../mcp-server/imagenes/casos.js');
const R = require('../mcp-server/imagenes/refinador.js');
const codigos = require('../mcp-server/imagenes/codigos.js');
const flags = require('../mcp-server/imagenes/comfyui-flags.js');
const bloque = require('../mcp-server/almas/bloque.js');
const hilos = require('../mcp-server/almas/hilos.js');
const semilla = require('../mcp-server/almas/semilla.js');
const charla = require('../mcp-server/almas/charla.js');
const contaminados = require('../mcp-server/almas/contaminados.js');
const { pideImagen } = require('../mcp-server/almas/pide-imagen.js');
const sondaVision = require('../mcp-server/imagenes/sonda-vision.js');

const PNG = sondaVision.pngSolido(8, [200, 10, 10]);
let tono = 0;
const otroPng = () => sondaVision.pngSolido(8, [tono++ % 250, 99, 3]);
const hasta = async (cond, ms = 4000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); } return cond(); };
const config = (extra = {}, comfy = {}) => { const d = A.defectos(); return { ...d, ...extra, comfyui: { ...d.comfyui, ...comfy } }; };
const tira = (fn) => { try { fn(); return null; } catch (err) { return err; } };

async function main() {
  const tareas = await importar('telegram-bridge/tareas.js');
  const { crearColaImagenes } = await importar('telegram-bridge/imagenes-cola.js');
  const bot = await importar('telegram-bridge/bot.js');
  const { crearGaleria, leerCursor } = await importar('telegram-bridge/imagenes/galeria.js');
  const { imagenesDe } = await importar('telegram-bridge/web/v2/productores.js');
  const ajustesV2 = await importar('telegram-bridge/web/v2/ajustes.js');
  const esquema = await importar('telegram-bridge/web/v2/esquema.js');
  const contrato = esquema.cargarContrato();

  const clave = 'alya';
  const registro = { tarea: (id) => tareas.obtener(id), actualizar: (id, c) => tareas.actualizar(id, c) };
  const nuevaTarea = (k = clave) => { const t = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave: k }, pedido: 'hola' }); tareas.actualizar(t.id, { estado: 'ok' }); return t.id; };
  const entrada = (id, n = 1) => (tareas.obtener(id).imagenes || []).find((e) => e.n === n);
  const prov = (id, fn = () => ({ ok: true })) => ({ id, vistos: [], async generar(op) { this.vistos.push(op); const r = await fn(op); if (!r.ok) return { proveedor: id, ...r }; const ruta = `${op.destino}.png`; fs.writeFileSync(ruta, r.bytes || otroPng()); return { ok: true, ruta, tipo: 'image/png', ancho: op.ancho, alto: op.alto, semilla: 5, proveedor: id, modelo: op.modelo || null }; } });
  const refina = (salida) => ({ vistos: [], async refinar(o) { this.vistos.push(o); const s = R.sanear(salida, { disponibles: o.disponibles, desdeFoto: o.desdeFoto, base: o.base, fuerzaAutomatica: o.fuerzaAutomatica }); return { ...s, refinado: true }; }, sinRefinar: R.sinRefinar });
  const adjuntos = path.join(raiz, 'datos', 'adjuntos');
  const foto = path.join(adjuntos, 'foto.png'); fs.writeFileSync(foto, PNG);
  const armar = ({ provs, cfg = () => config({ orden: Object.keys(provs), alma_la_ve: false }), ref = refina({ caso: 'nueva', prompt: 'x' }), ...extra }) => crearColaImagenes({
    registro, proveedor: (id) => provs[id] || null, leerConfig: cfg, refinador: ref, vision: { llamar: async () => ({ ok: false }) }, manual: () => false, catalogoDe: async () => null,
    log: () => {}, env: process.env, dirAdjuntos: () => adjuntos, ...extra
  });
  const termina = (id, n = 1) => hasta(() => entrada(id, n) && entrada(id, n).estado !== 'generando');
  const haz = async (op = {}, job = {}) => { const id = nuevaTarea(); const cola = armar({ provs: { comfyui: prov('comfyui') }, ...op }); cola.encolar({ tareaId: id, clave, pedido: 'x', ...job }); await termina(id); return { id, cola, e: entrada(id), priv: indice.leer(clave, id, 1) }; };
  // Una imagen lista en el índice, como la deja la cola (o como la dejaba antes de 2.20).
  let nImg = 0;
  const poner = (extra = {}, k = clave) => {
    const id = `t_img${String(nImg++).padStart(4, '0')}`;
    const archivo = path.join(indice.dirImagenes(k), `${id}-1-1.png`);
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    const bytes = otroPng();
    fs.writeFileSync(archivo, bytes);
    indice.actualizar(k, id, 1, () => ({ archivo, tipo: 'image/png', lista: true, intento: 1, externo: false, sha256: indice.sha256(bytes), prompt: 'a cat', caso: 'nueva', creada: new Date(Date.UTC(2026, 0, 1) + nImg * 1000).toISOString(), telegram: { sha256: null, envio: `e${nImg}` }, ...extra }));
    return { id, archivo, bytes };
  };

  // ------------------------------------------------------------- el índice
  await group('El índice: la lista en memoria y las rutas', async () => {
    const k = 'indice';
    const a = poner({}, k); const b = poner({}, k);
    check('lista de la más vieja a la más nueva', indice.listar(k).map((e) => e.tareaId).join() === `${a.id},${b.id}`);
    indice.actualizar(k, a.id, 1, (p) => ({ ...p, creada: '2030-01-01T00:00:00Z' }));
    check('una escritura se ve y reordena', indice.listar(k).at(-1).tareaId === a.id);
    indice.borrar(k, b.id, 1);
    check('un borrado se ve', indice.listar(k).length === 1);
    fs.writeFileSync(indice.rutaIndice(k, 't_afuera1', 1), '{"archivo":"x","creada":"2020"}');
    const t = new Date(Date.now() + 5000); fs.utimesSync(indice.dirIndice(k), t, t);
    check('lo que escribe otro se ve por la fecha de la carpeta', indice.listar(k).length === 2);
    fs.writeFileSync(indice.rutaIndice(k, 't_roto1', 1), '{');
    fs.utimesSync(indice.dirIndice(k), new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    check('un índice corrupto se saltea', indice.listar(k).length === 2);
    const l = indice.listar(k); l.pop();
    check('la lista que devuelve es una copia', indice.listar(k).length === 2);
    const dir = indice.dirImagenes(k);
    check('rutaDentroDe: adentro sí; afuera, relativa y la carpeta misma, no', indice.rutaDentroDe(dir, a.archivo) !== null && indice.rutaDentroDe(dir, foto) === null && indice.rutaDentroDe(dir, 'x.png') === null && indice.rutaDentroDe(dir, dir) === null && indice.rutaDentroDe(dir, path.join(dir, '..', '..', 'x.png')) === null);
    check('una que no existe se mira por su carpeta', indice.rutaDentroDe(dir, path.join(dir, 'no.png')) !== null);
    const enlace = path.join(dir, 'enlace');
    let hayEnlace = true;
    try { fs.symlinkSync(adjuntos, enlace, 'junction'); } catch { hayEnlace = false; }
    check('un enlace que sale de la carpeta no vale', !hayEnlace || indice.rutaDentroDe(dir, path.join(enlace, 'foto.png')) === null);
    if (hayEnlace) fs.rmSync(enlace, { recursive: false, force: true });
    check('fotoPermitida: adjuntos y las imágenes de un alma', indice.fotoPermitida(foto, { dirAdjuntos: adjuntos }) !== null && indice.fotoPermitida(a.archivo, { dirAdjuntos: adjuntos }) !== null && indice.fotoPermitida(path.join(raiz, 'x.png'), { dirAdjuntos: adjuntos }) === null);
  });

  await group('Telegram: la terna y la única escritura', async () => {
    const a = poner(); const b = poner();
    indice.anotarTelegram(clave, a.id, 1, indice.leer(clave, a.id, 1).telegram.envio, { mensaje: { bot: '1', chat: 5, id: 77 } });
    indice.anotarTelegram(clave, a.id, 1, indice.leer(clave, a.id, 1).telegram.envio, { sha256: 's1' });
    const t = indice.leer(clave, a.id, 1).telegram;
    check('el mensaje y el sha se funden', t.sha256 === 's1' && t.mensaje.id === 77);
    const envioB = indice.leer(clave, b.id, 1).telegram.envio;
    indice.anotarTelegram(clave, b.id, 1, envioB, { sha256: 's2' });
    indice.anotarTelegram(clave, b.id, 1, envioB, { mensaje: { bot: '1', chat: 6, id: 77 } });
    check('…en el otro orden también', indice.leer(clave, b.id, 1).telegram.sha256 === 's2' && indice.leer(clave, b.id, 1).telegram.mensaje.chat === 6);
    check('un envío viejo no escribe', indice.anotarTelegram(clave, b.id, 1, 'otro', { sha256: 'mal' }) === false && indice.leer(clave, b.id, 1).telegram.sha256 === 's2');
    check('porMensaje: la terna exacta', indice.porMensaje({ bot: '1', chat: 5, id: 77 }).entrada.tareaId === a.id && indice.porMensaje({ bot: '1', chat: 6, id: 77 }).entrada.tareaId === b.id && indice.porMensaje({ bot: '2', chat: 5, id: 77 }) === null && indice.porMensaje({ bot: '1', chat: 5, id: 78 }) === null);
    // Al mandarla.
    const enviados = [];
    const api = { async sendPhoto(_c, _f, o) { enviados.push(o.caption); if (this.falla) throw new Error('x'); return { message_id: 900, photo: [{ file_id: 'f', width: 9, height: 9 }] }; }, async sendDocument(_c, _f, o) { enviados.push(o.caption); return { message_id: 901, document: {} }; }, async sendMessage() { return {}; } };
    const d = poner(); const envioD = indice.leer(clave, d.id, 1).telegram.envio;
    const env = (op) => bot.crearEnvioImagen({ bot: '9', chat: 3 }, 3, { tareaId: d.id, clave, api, cola: { invalidarMapas() {} }, descargar: async () => Buffer.from('j'), leerConfig: () => config({ reconocer_telegram: false }), ...op });
    await env()({ ok: true, n: 1, ruta: d.archivo, idEnvio: envioD, caso: 'retoque' });
    check('el pie dice el caso', enviados[0] === '🖼️ 1 · retoque');
    check('se anota aunque reconocer_telegram esté apagado', indice.porMensaje({ bot: '9', chat: 3, id: 900 })?.entrada.tareaId === d.id);
    api.falla = true;
    await env()({ ok: true, n: 1, ruta: d.archivo, idEnvio: envioD });
    check('…y con un envío como documento', indice.porMensaje({ bot: '9', chat: 3, id: 901 })?.entrada.tareaId === d.id && indice.porMensaje({ bot: '9', chat: 3, id: 900 }) === null);
    check('/otra encuentra el mensaje en el índice (sobrevive a un reinicio)', bot.imagenDelMensaje('1', 5, 77)?.tareaId === a.id);
  });

  // ------------------------------------------------------------- lo externo
  await group('Lo externo se hereda', async () => {
    const deAfuera = await haz({ ref: refina({ caso: 'variacion', prompt: 'x' }) }, { desdeFoto: true, foto: { ruta: foto, segura: false } });
    const segura = await haz({ ref: refina({ caso: 'variacion', prompt: 'x' }) }, { desdeFoto: true, foto: { ruta: foto, segura: true } });
    check('el índice lo guarda', deAfuera.priv.externo === true && segura.priv.externo === false);
    const rec = (cola) => ({ reconocer: (b) => cola.reconocer(b), reconocerTelegram: (b) => cola.reconocerTelegram(b) });
    check('una imagen hecha desde una foto de afuera no vuelve como segura', bot.fotoDelTurno({ ruta: deAfuera.priv.archivo }, config(), rec(deAfuera.cola)).segura === false);
    check('…ni después de un reinicio', bot.fotoDelTurno({ ruta: deAfuera.priv.archivo }, config(), rec(armar({ provs: {} }))).segura === false);
    check('la segura sí, sin reiniciar', bot.fotoDelTurno({ ruta: segura.priv.archivo }, config(), rec(segura.cola)).origen === 'reconocida');
    check('…y después de un reinicio', bot.fotoDelTurno({ ruta: segura.priv.archivo }, config(), rec(armar({ provs: {} }))).origen === 'reconocida');
    const vieja = poner({ externo: undefined });
    check('lo desconocido cuenta como externo', bot.fotoDelTurno({ ruta: vieja.archivo }, config(), rec(armar({ provs: {} }))).segura === false);
    check('la marca a mano manda', bot.fotoDelTurno({ ruta: deAfuera.priv.archivo, segura: true }, config(), rec(deAfuera.cola)).origen === 'marcada');
    // Por el otro mapa.
    const jpg = path.join(adjuntos, 'vuelta.jpg'); fs.writeFileSync(jpg, 'jpeg de afuera');
    indice.anotarTelegram(clave, deAfuera.id, 1, deAfuera.priv.telegram.envio, { sha256: indice.sha256(Buffer.from('jpeg de afuera')) });
    check('…y por el JPEG de Telegram tampoco', bot.fotoDelTurno({ ruta: jpg }, config(), rec(armar({ provs: {} }))).segura === false);
    check('con fotos_seguras apagado no hay foto segura, ni a mano', bot.fotoDelTurno({ ruta: segura.priv.archivo, segura: true }, config({ fotos_seguras: false }), rec(segura.cola)).segura === false);
  });

  // ------------------------------------------------------------- la base
  await group('La base no se pierde (foto_cuenta)', async () => {
    const conBase = { desdeFoto: true, baseFija: true, foto: { ruta: foto, segura: true } };
    const r = refina({ caso: 'nueva', prompt: 'x' });
    const v = await haz({ ref: r }, conBase);
    check('un «nueva» del refinador sube a variación', v.e.caso === 'variacion' && v.e.casoPedido === 'variacion' && r.vistos[0].base === 'fija');
    const agy = prov('antigravity');
    const sinC = await haz({ provs: { comfyui: prov('comfyui', () => ({ ok: false, codigo: 'no-responde' })), antigravity: agy }, ref: refina({ caso: 'variacion', prompt: 'x' }) }, conBase);
    check('ComfyUI apagado: sin-base, y no sale una nueva de agy', sinC.e.codigo === 'sin-base' && agy.vistos.length === 0 && sinC.e.mensaje === codigos.CODIGOS_ENTRADA['sin-base']);
    const soloAgy = await haz({ provs: { antigravity: agy } }, conBase);
    check('solo agy: sin-base', soloAgy.e.codigo === 'sin-base' && agy.vistos.length === 0);
    const sinRef = await haz({ cfg: () => config({ orden: ['comfyui'], refinar: false, alma_la_ve: false }) }, conBase);
    check('sin refinador también parte de la foto', sinRef.e.caso === 'variacion');
    const viejo = await haz({ provs: { comfyui: prov('comfyui', () => ({ ok: false, codigo: 'no-responde' })), antigravity: prov('antigravity') }, ref: refina({ caso: 'nueva', prompt: 'x' }) }, { desdeFoto: true, foto: { ruta: foto, segura: true } });
    check('foto_cuenta apagado (sin base fija): como antes, la hace agy', viejo.e.estado === 'lista' && viejo.e.caso === 'nueva');
    // La foto que puede no usarse.
    const rn = refina({ caso: 'nueva', prompt: 'x' });
    const gato = await haz({ ref: rn }, { desdeFoto: false, fotoOpcional: true, foto: { ruta: foto, segura: true } });
    check('imagen: con foto, el refinador puede elegir nueva', gato.e.caso === 'nueva' && gato.e.desdeFoto === false && gato.e.fotoIgnorada === false && rn.vistos[0].base === 'opcional');
    const vo = await haz({ ref: refina({ caso: 'variacion', prompt: 'x' }) }, { desdeFoto: false, fotoOpcional: true, foto: { ruta: foto, segura: true } });
    check('…o partir de ella', vo.e.caso === 'variacion' && vo.e.desdeFoto === true);
    const sinR = await haz({ cfg: () => config({ orden: ['comfyui'], refinar: false, alma_la_ve: false }) }, { desdeFoto: false, fotoOpcional: true, foto: { ruta: foto, segura: true } });
    check('…y sin refinador que elija, la foto cuenta', sinR.e.caso === 'variacion' && sinR.e.desdeFoto === true);
    const ve = await haz({ ref: refina({ caso: 'nueva', prompt: 'x' }) }, { desdeFoto: false, fotoOpcional: true, foto: { ruta: foto, segura: false } });
    check('con una de afuera, la imagen es externa aunque salga nueva', ve.priv.externo === true);
    const c2 = prov('comfyui');
    armar({ provs: { comfyui: c2 }, ref: refina({}) }).otra(gato.id, 1); await termina(gato.id, 2);
    check('Otra versión de la que no usó la foto, sin foto', c2.vistos[0].caso === 'nueva' && c2.vistos[0].foto === null);
    const c3 = prov('comfyui');
    armar({ provs: { comfyui: c3 }, ref: refina({}) }).otra(vo.id, 1); await termina(vo.id, 2);
    check('…y de la que sí, con ella', c3.vistos[0].caso === 'variacion' && Boolean(c3.vistos[0].foto));
    const c4 = prov('comfyui');
    armar({ provs: { comfyui: c4 }, ref: refina({}) }).reintentar(sinC.id, 1); await hasta(() => entrada(sinC.id).estado === 'lista');
    check('Reintentar la de base fija la conserva', c4.vistos[0].caso === 'variacion' && indice.leer(clave, sinC.id, 1).baseFija === true);
    // La consigna.
    const disp = C.disponiblesDe(config(), { desdeFoto: true, catalogo: null, manual: () => false });
    check('la consigna lo dice', /never choose "nueva"/.test(R.consigna(disp, { base: 'fija' })) && /may not be about it/.test(R.consigna(disp, { base: 'opcional' })) && !/never choose "nueva"/.test(R.consigna(disp)));
    check('el retoque se ciñe a la zona', /only the thing that fills that part/.test(R.consigna(disp)) && !/right around it/.test(R.consigna(disp)));
    // Una base de afuera de las carpetas.
    const afuera = path.join(raiz, 'ajena.png'); fs.writeFileSync(afuera, PNG);
    const mala = await haz({}, { desdeFoto: true, foto: { ruta: afuera, segura: true } });
    check('una foto fuera de las carpetas de siempre no se lee', mala.e.codigo === 'foto-perdida');
  });

  await group('La fuerza según el cambio', async () => {
    check('SDXL: 0,45, 0,6 y 0,8', C.fuerzaDeCambio('leve', 0.6) === 0.45 && C.fuerzaDeCambio('medio', 0.6) === 0.6 && C.fuerzaDeCambio('fuerte', 0.6) === 0.8);
    check('los bordes', C.fuerzaDeCambio('leve', 0.2) === 0.1 && C.fuerzaDeCambio('fuerte', 0.9) === 0.95);
    check('un perfil con 0 o 1 no se ajusta, ni un cambio que no vale', C.fuerzaDeCambio('fuerte', 1) === null && C.fuerzaDeCambio('leve', 0) === null && C.fuerzaDeCambio('enorme', 0.6) === null);
    const base = { desdeFoto: true, foto: { ruta: foto, segura: true } };
    const c = prov('comfyui');
    const f = await haz({ provs: { comfyui: c }, ref: refina({ caso: 'variacion', prompt: 'x', cambio: 'fuerte', fuerza: 0.11 }) }, base);
    check('llega al proveedor, al turno y al índice (y la del modelo se ignora)', c.vistos[0].fuerza === 0.8 && f.e.cambio === 'fuerte' && f.e.fuerza === 0.8 && f.priv.fuerza === 0.8);
    check('y a la v2', imagenesDe([{ ...f.e }])[0].fuerza === 0.8 && imagenesDe([{ ...f.e, cambio: 'raro', fuerza: 3 }])[0].cambio === undefined);
    const o = prov('comfyui');
    armar({ provs: { comfyui: o }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false, fuerza_automatica: false }), ref: refina({}) }).otra(f.id, 1); await termina(f.id, 2);
    check('Otra versión repite la misma', o.vistos[0].fuerza === 0.8 && entrada(f.id, 2).cambio === 'fuerte');
    const ap = prov('comfyui');
    const a = await haz({ provs: { comfyui: ap }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false, fuerza_automatica: false }), ref: refina({ caso: 'variacion', prompt: 'x', cambio: 'fuerte' }) }, base);
    check('apagada: la del perfil, sin cambio', ap.vistos[0].fuerza === null && !('cambio' in a.e) && !('fuerza' in a.e));
    const rt = prov('comfyui');
    const re = await haz({ provs: { comfyui: rt }, ref: refina({ caso: 'retoque', prompt: 'x', zona: 'hat', cambio: 'fuerte' }) }, base);
    check('no vale para retoque', re.e.caso === 'retoque' && rt.vistos[0].fuerza === null && !('cambio' in re.e));
    const sr = prov('comfyui');
    await haz({ provs: { comfyui: sr }, cfg: () => config({ orden: ['comfyui'], refinar: false, alma_la_ve: false }) }, base);
    check('sin refinador: la del perfil', sr.vistos[0].fuerza === null);
    const p1 = C.ajustarAlCaso({ prompt: 'x', cambio: 'medio' }, 'variacion', { ...C.disponiblesDe(config(), { desdeFoto: true, manual: () => false }).variacion, perfil: { ...C.disponiblesDe(config(), { desdeFoto: true, manual: () => false }).variacion.perfil, muestreo: { fuerza: 1 } } });
    check('con fuerza 1 el cambio queda en null', p1.cambio === null && p1.fuerza === null);
    const disp = C.disponiblesDe(config(), { desdeFoto: true, manual: () => false });
    check('la consigna pide cambio solo si está prendida', /"cambio"/.test(R.consigna(disp, { fuerzaAutomatica: true })) && !/"cambio"/.test(R.consigna(disp)));
  });

  // ------------------------------------------------------------- el alma
  await group('La línea y lo que pide el usuario', async () => {
    const x = bloque.extraerBloque('hola\n<alma>\nimagen-desde-anterior: de noche\n</alma>');
    check('imagen-desde-anterior se reconoce', x.imagenPedida.desdeAnterior === true && x.imagenPedida.desdeFoto === false && x.imagenPedida.texto === 'de noche');
    check('…y no se confunde con las otras', bloque.parsearImagen('imagen-desde-foto: a').desdeFoto === true && bloque.parsearImagen('imagen: a').desdeAnterior === false && bloque.parsearImagen('imagen-desde-otra: a') === null);
    check('la consigna la ofrece solo si se puede', /imagen-desde-anterior/.test(bloque.instruccionDeCierre({ puedePedirImagen: true, puedePedirAnterior: true })) && !/imagen-desde-anterior/.test(bloque.instruccionDeCierre({ puedePedirImagen: true })));
    for (const t of ['cambiale el faro', 'hacela de noche', 'sacá el barco', 'poné una luna', 'ahora agregá gaviotas', '¿podés cambiar el cielo?', 'otra parecida', 'borrale el texto', 'quiero que cambies el faro', '¿me lo cambiás?', 'haceme de noche', 'hacé que sea de noche', 'change the sky', 'Dejala más oscura']) check(`responde a una imagen: «${t}» la pide`, pideImagen(t, { respondeImagen: true }) === true);
    for (const t of ['qué linda', 'me pone contento', 'no le cambies nada', 'jaja', 'gracias, me encanta', 'el faro me hace acordar a casa', 'no la cambies, está perfecta', 'nunca cambiala', 'dejame pensarlo', 'turn on the lights']) check(`…«${t}» no`, pideImagen(t, { respondeImagen: true }) === false);
    for (const t of ['otra parecida', 'haceme otra igual pero de noche', 'repetí la anterior', 'una como la anterior', 'otra versión']) check(`usar_ultima: «${t}» la pide`, pideImagen(t, { usarUltima: true }) === true);
    for (const t of ['la anterior me gustó más', 'cambiale el faro', 'no quiero otra parecida']) check(`…«${t}» no`, pideImagen(t, { usarUltima: true }) === false);
    check('sin los interruptores, lo de antes', pideImagen('otra parecida') === false && pideImagen('cambiale el faro') === false && pideImagen('dibujame un gato') === true);
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feat213-home-'));
  semilla.sembrar('alya', { name: 'Alya', description: 'x', personality: 'y', language: 'es' }, {});
  const guion = (texto, conv) => { const llamadas = []; const fn = async (args) => { llamadas.push(args[args.indexOf('-p') + 1]); return { success: true, cancelled: false, data: { response: texto, conversation_id: conv, usage: { total_tokens: 1 } }, error: null }; }; fn.llamadas = llamadas; return fn; };
  const turno = (ejecutar, opciones = {}, texto = 'hola') => charla.charlar({ clave: 'alya', texto, agyBin: 'agy', ejecutar, homeDir: home, opciones: { fresco: true, puedePedirImagen: true, fotoCuenta: true, ...opciones }, contextoMotor: { leerKeyDeepseek: () => null, leerKeyGo: () => null } });
  const ANTERIOR = 'ok\n<alma>\nimagen-desde-anterior: de noche\n</alma>';
  const IMAGEN = 'ok\n<alma>\nimagen: un gato\n</alma>';
  const DESDE_FOTO = 'ok\n<alma>\nimagen-desde-foto: de noche\n</alma>';
  const ultima = (u) => (clv, hs) => (hs.length ? u : null);
  const DENTRO = { tareaId: 't_x', n: 1, ruta: foto, externo: false, segura: true };
  const FUERA = { ...DENTRO, externo: true, segura: false };

  await group('charlar: la última del hilo', async () => {
    const conHilo = (c) => hilos.registrarTurno('alya', { conversationId: c });
    conHilo('conv-a');
    const g = guion(ANTERIOR, 'conv-a');
    const t = await turno(g, { fresco: false, ultimaImagen: ultima(DENTRO) });
    check('se ofrece, y la imagen parte de ella', /imagen-desde-anterior/.test(g.llamadas[0]) && t.imagenPedida.desdeFoto === true && t.imagenPedida.baseFija === true && t.imagenPedida.desdeAnterior === true && t.imagenPedida.foto.segura === true, JSON.stringify(t.imagenPedida || t.motivo));
    check('una de adentro no contamina', !t.bloqueado);
    const sin = await turno(guion(ANTERIOR, 'conv-a'), { fresco: false, ultimaImagen: () => null });
    check('sin ninguna: sin-anterior', sin.imagenPedida === null && sin.imagenRechazo === 'sin-anterior');
    const g2 = guion(ANTERIOR, 'conv-a');
    const ap = await turno(g2, { fresco: false });
    check('apagado: no se ofrece y se rechaza aunque la escriba', !/imagen-desde-anterior/.test(g2.llamadas[0]) && ap.imagenRechazo === 'sin-anterior');
    const df = await turno(guion(DESDE_FOTO, 'conv-a'), { fresco: false, ultimaImagen: ultima(DENTRO) });
    check('imagen-desde-foto sin foto usa la última', df.imagenPedida.desdeAnterior === true);
    const df2 = await turno(guion(DESDE_FOTO, 'conv-a'), { fresco: false });
    check('…y sin usar_ultima, sin-foto', df2.imagenRechazo === 'sin-foto');
    const df3 = await turno(guion(DESDE_FOTO, 'conv-a'), { fresco: false, fotoCuenta: false });
    check('con foto_cuenta apagado, la nueva de siempre', df3.imagenPedida && df3.imagenPedida.desdeFoto === false && df3.imagenPedida.foto === null);
    // De afuera.
    const g3 = guion(ANTERIOR, 'conv-b'); conHilo('conv-b');
    const ex = await turno(g3, { fresco: false, ultimaImagen: ultima(FUERA) }, 'qué linda');
    check('una de afuera no se ofrece si no la pidió, y se rechaza', !/imagen-desde-anterior/.test(g3.llamadas[0]) && ex.imagenRechazo === 'hilo-externo' && !contaminados.contaminado('alya', 'conv-b', process.env));
    const g4 = guion(ANTERIOR, 'conv-b');
    const ex2 = await turno(g4, { fresco: false, ultimaImagen: ultima(FUERA) }, 'haceme otra parecida');
    check('si la pidió, se ofrece, se usa y contamina el hilo', /imagen-desde-anterior/.test(g4.llamadas[0]) && ex2.imagenPedida?.foto.segura === false && ex2.bloqueado && contaminados.contaminado('alya', 'conv-b', process.env), JSON.stringify(ex2.imagenRechazo));
    const g5 = guion(ANTERIOR, 'conv-d'); conHilo('conv-d');
    const ns = await turno(g5, { fresco: false, ultimaImagen: ultima({ ...DENTRO, segura: false }) }, 'haceme otra parecida');
    check('con fotos_seguras apagado, una propia cuenta como de afuera', Boolean(ns.imagenPedida) && ns.bloqueado && contaminados.contaminado('alya', 'conv-d', process.env));
    // El hilo que venció solo.
    const est = hilos.rutaEstado ? hilos.rutaEstado() : path.join(process.env.LAGRANGE_ALMAS_DIR, 'estado.json');
    const o = JSON.parse(fs.readFileSync(est, 'utf8')); o.almas.alya.conversation_id = 'conv-vieja'; o.almas.alya.ultimo_turno = '2020-01-01T00:00:00Z'; fs.writeFileSync(est, JSON.stringify(o));
    let pedidos = [];
    await turno(guion(ANTERIOR, 'conv-nueva'), { fresco: false, ultimaImagen: (c, hs) => { pedidos.push(hs.join()); return DENTRO; } });
    check('un hilo que venció solo: valen las del anterior', pedidos[0] === 'conv-vieja' && pedidos[1] === 'conv-nueva,conv-vieja', pedidos.join(' | '));
    fs.writeFileSync(est, JSON.stringify(o)); pedidos = [];
    await turno(guion(ANTERIOR, 'conv-fresca'), { fresco: true, ultimaImagen: (c, hs) => { pedidos.push(hs.join()); return null; } });
    check('con /charla nuevo no', pedidos.join(' | ') === ' | conv-fresca', pedidos.join(' | '));
    // Con foto en el turno.
    const cf = await turno(guion(ANTERIOR, 'conv-c'), { ultimaImagen: ultima(DENTRO), imagen: { ruta: foto, segura: true, origen: 'marcada' } }, 'mirá');
    check('con foto en el turno vale como desde-foto', cf.imagenPedida.foto.ruta === foto && cf.imagenPedida.baseFija === true && !cf.imagenPedida.desdeAnterior);
    const im = await turno(guion(IMAGEN, 'conv-c'), { imagen: { ruta: foto, segura: true, origen: 'marcada' } }, 'mirá');
    check('imagen: con foto la recibe, sin fijarla', im.imagenPedida.fotoOpcional === true && im.imagenPedida.desdeFoto === false && !im.imagenPedida.baseFija);
    const im2 = await turno(guion(IMAGEN, 'conv-c'), { fotoCuenta: false, imagen: { ruta: foto, segura: true, origen: 'marcada' } }, 'mirá');
    check('…apagado, como antes', !im2.imagenPedida.fotoOpcional && im2.imagenPedida.desdeFoto === false);
    // Responder en un hilo de afuera.
    contaminados.marcar('alya', 'conv-sucia', { motivo: 'web' }, process.env); conHilo('conv-sucia');
    const resp = (txt) => turno(guion(DESDE_FOTO, 'conv-sucia'), { fresco: false, imagen: { ruta: foto, segura: false, origen: null, respuesta: true } }, txt);
    check('responder «cambiale el faro» en un hilo de afuera vale', Boolean((await resp('cambiale el faro')).imagenPedida));
    check('…y «qué linda» no', (await resp('qué linda')).imagenRechazo === 'hilo-externo');
    const noResp = await turno(guion(DESDE_FOTO, 'conv-sucia'), { fresco: false, imagen: { ruta: foto, segura: false, origen: null } }, 'cambiale el faro');
    check('…y sin responder a una imagen tampoco', noResp.imagenRechazo === 'hilo-externo');
  });

  await group('El bot: responder a una imagen, el pie y el detalle', async () => {
    const a = poner(); indice.anotarTelegram(clave, a.id, 1, indice.leer(clave, a.id, 1).telegram.envio, { mensaje: { bot: '50', chat: 7, id: 10 } });
    const otra = poner({}, 'otra'); indice.anotarTelegram('otra', otra.id, 1, indice.leer('otra', otra.id, 1).telegram.envio, { mensaje: { bot: '50', chat: 7, id: 11 } });
    const ctx = (id, extra = {}) => ({ chat: { id: 7 }, me: { id: 50 }, message: { reply_to_message: { message_id: id, from: { id: 50 }, photo: [{}], caption: '🖼️ 1', ...extra } } });
    const on = { leerConfig: () => config() };
    const r = bot.imagenRespondida(ctx(10), on);
    check('el archivo original de esa imagen', r.clave === 'alya' && r.imagen.respuesta === true && r.imagen.segura === false && fs.realpathSync(r.imagen.ruta) === fs.realpathSync(a.archivo));
    check('en el bot de un alma, la de otra no se conoce', bot.imagenRespondida(ctx(11), { ...on, clave: 'alya' }).perdida === true && bot.imagenRespondida(ctx(11), on).clave === 'otra');
    check('una que no está en el índice: perdida', bot.imagenRespondida(ctx(99), on).perdida === true && bot.imagenRespondida(ctx(99, { caption: '🖼️ 2 · variación' }), on).perdida === true);
    check('un mensaje que no es una imagen del bot: nada', bot.imagenRespondida(ctx(99, { caption: 'hola' }), on) === null && bot.imagenRespondida(ctx(99, { from: { id: 8 } }), on) === null && bot.imagenRespondida(ctx(99, { photo: undefined, text: 'x' }), on) === null && bot.imagenRespondida({ chat: { id: 7 }, message: {} }, on) === null);
    check('apagado: nada', bot.imagenRespondida(ctx(10), { leerConfig: () => config({ responder_usa_imagen: false }) }) === null);
    // Recién mandada y sin anotar en el índice: por el mapa en memoria.
    const tm = nuevaTarea(); const arch = path.join(indice.dirImagenes(clave), 'm.png'); fs.writeFileSync(arch, PNG);
    indice.actualizar(clave, tm, 1, () => ({ archivo: arch, lista: true, externo: false, telegram: { envio: 'z' } }));
    await bot.crearEnvioImagen({ bot: '50', chat: 7 }, 7, { tareaId: tm, api: { sendPhoto: async () => ({ message_id: 55 }) } })({ ok: true, n: 1, ruta: arch });
    check('por el mapa en memoria también', indice.porMensaje({ bot: '50', chat: 7, id: 55 }) === null && bot.imagenRespondida(ctx(55), on).clave === 'alya');
    fs.rmSync(a.archivo);
    check('sin su archivo: perdida, con su alma', bot.imagenRespondida(ctx(10), on).perdida === true);
    check('fotoDelTurno conserva que es una respuesta', bot.fotoDelTurno({ ruta: otra.archivo, segura: false, respuesta: true }, config(), { reconocer: () => null, reconocerTelegram: () => null }).respuesta === true);
    const pie = (t) => bot.pieDeMemoria({ aplicadas: [], rechazadas: [], ...t });
    check('el pie: la imagen perdida y los motivos nuevos', /no sé de qué imagen/.test(pie({ imagenPerdida: true })) && /ninguna imagen anterior/.test(pie({ imagenRechazo: 'sin-anterior' })) && /ninguna foto/.test(pie({ imagenRechazo: 'sin-foto' })));
    const turnoV = { tareaId: 't1', estado: 'ok' };
    check('el contrato: detalle, opcional, con rechazo null', esquema.validar(contrato, 'turno', { ...turnoV }).every((e) => !/detalle/.test(e)) && contrato.agregados.turno && JSON.stringify(contrato).includes('"detalle"'));
    const { memoriaDe } = await importar('telegram-bridge/web/v2/productores.js').then((m) => ({ memoriaDe: m.memoriaDe }));
    if (memoriaDe) {
      const m = memoriaDe({ imagen: { pedida: null, rechazo: null, detalle: 'sin-anterior' } });
      check('memoriaDe deja pasar el detalle', m.imagen.detalle === 'sin-anterior' && m.imagen.rechazo === null);
    }
  });

  // ------------------------------------------------------------- la cola y ComfyUI
  await group('La cola espera a ComfyUI sin frenar a las demás', async () => {
    const arr = { carpeta: 'C:\\x', automatico: true, apagar_min: 20, espera_s: 120, flags: [] };
    const cfg = (extra = {}, a = arr) => () => config({ orden: ['comfyui', 'antigravity'], alma_la_ve: false, ...extra }, { arranque: a });
    const comfyFalso = () => { const o = { vivo: false, veces: 0, usos: 0, soltar: null, comprobar: async () => (o.vivo ? 'ok' : 'no-responde'), levantar: () => { o.veces++; return (o.promesa ||= new Promise((r) => { o.soltar = (v) => { o.vivo = v; r({ ok: v }); }; })); }, anotarUso: () => { o.usos++; } }; return o; };
    {
      const comfy = comfyFalso(); const c = prov('comfyui'); const ag = prov('antigravity');
      const cola = armar({ provs: { comfyui: c, antigravity: ag }, cfg: cfg(), comfy });
      const ids = [nuevaTarea(), nuevaTarea()];
      for (const id of ids) cola.encolar({ tareaId: id, clave, pedido: 'x' });
      await hasta(() => cola._esperando.size === 2);
      check('esperan aparte, con su mensaje', cola._pendientes.length === 0 && entrada(ids[0]).estado === 'generando' && entrada(ids[0]).mensaje === 'Levantando ComfyUI…' && cola.estadoDeImagenes().pendientes === 2 && cola.tieneAbiertas(ids[0]));
      check('el uso se anota', comfy.usos === 2);
      comfy.soltar(true);
      for (const id of ids) await termina(id);
      check('cuando responde, se hacen con ComfyUI', ids.every((id) => entrada(id).estado === 'lista' && entrada(id).proveedor === 'comfyui') && entrada(ids[0]).mensaje === null);
    }
    {
      // Cuatro esperando y una que va a agy.
      const comfy = comfyFalso(); let orden = ['comfyui', 'antigravity'];
      const cola = armar({ provs: { comfyui: prov('comfyui'), antigravity: prov('antigravity') }, cfg: () => config({ orden, alma_la_ve: false }, { arranque: arr }), comfy });
      const ids = Array.from({ length: 4 }, () => nuevaTarea());
      for (const id of ids) { cola.encolar({ tareaId: id, clave, pedido: 'x' }); await hasta(() => cola._esperando.size === ids.indexOf(id) + 1); }
      orden = ['antigravity', 'comfyui'];
      const deAgy = nuevaTarea();
      cola.encolar({ tareaId: deAgy, clave, pedido: 'x' });
      await termina(deAgy);
      check('con cuatro esperando, una de agy sale', entrada(deAgy).estado === 'lista' && entrada(deAgy).proveedor === 'antigravity');
      orden = ['comfyui', 'antigravity'];
      const quinta = nuevaTarea();
      cola.encolar({ tareaId: quinta, clave, pedido: 'x' });
      await termina(quinta);
      check('una quinta que espera a ComfyUI: cola-llena', entrada(quinta).codigo === 'cola-llena');
      check('cancelar corta la espera de esa', cola.cancelarImagenes({ tareaId: ids[0] }) === 1 && entrada(ids[0]).codigo === 'cancelada' && cola._esperando.size === 3);
      comfy.soltar(false);
      for (const id of ids.slice(1)) await termina(id);
      check('si no levanta, siguen con el próximo', ids.slice(1).every((id) => entrada(id).proveedor === 'antigravity' && entrada(id).estado === 'lista'));
      check('la cancelada no se hizo', entrada(ids[0]).estado === 'error');
    }
    for (const [que, a] of [['automatico apagado', { ...arr, automatico: false }], ['sin carpeta', { ...arr, carpeta: null }]]) {
      const comfy = comfyFalso();
      const r = await haz({ provs: { comfyui: prov('comfyui'), antigravity: prov('antigravity') }, cfg: cfg({}, a), comfy });
      check(`${que}: no lo levanta y la hace agy`, comfy.veces === 0 && r.e.proveedor === 'antigravity');
    }
    {
      const comfy = { ...comfyFalso(), comprobar: async () => 'otro-programa' }; const c = prov('comfyui');
      const r = await haz({ provs: { comfyui: c }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false }, { arranque: arr }), comfy });
      check('otro programa en el puerto no recibe nada', c.vistos.length === 0 && r.e.codigo === 'sin-proveedor' && /otro programa/.test(r.e.mensaje), JSON.stringify(r.e));
    }
    {
      const comfy = comfyFalso(); const cola = armar({ provs: { comfyui: prov('comfyui') }, cfg: cfg({ orden: ['comfyui'] }), comfy });
      const id = nuevaTarea(); cola.encolar({ tareaId: id, clave, pedido: 'x' }); await hasta(() => cola._esperando.size === 1);
      check('apagar a la fuerza corta las que lo esperan', cola.cortarLasDeComfy() === 1 && entrada(id).codigo === 'comfyui-apagado');
      comfy.soltar(true);
    }
    {
      // Una refinando, una pendiente que va a ComfyUI y una de agy.
      let soltar; const esp = new Promise((r) => { soltar = r; });
      let orden = ['comfyui', 'antigravity'];
      const ref = { async refinar(o) { await esp; return { ...R.sanear({ caso: 'nueva', prompt: 'x' }, { disponibles: o.disponibles }), refinado: true }; }, sinRefinar: R.sinRefinar };
      const c = prov('comfyui'); const ag = prov('antigravity');
      const cola = armar({ provs: { comfyui: c, antigravity: ag }, cfg: () => config({ orden, alma_la_ve: false }), ref });
      const [a, b] = [nuevaTarea(), nuevaTarea()];
      cola.encolar({ tareaId: a, clave, pedido: 'x' }); cola.encolar({ tareaId: b, clave, pedido: 'x' });
      await hasta(() => cola._pendientes.length === 1);
      check('cuentan la que refina y la pendiente', cola.lasDeComfy().length === 2);
      orden = ['antigravity', 'comfyui'];
      check('las que van a agy no', cola.lasDeComfy().length === 0);
      const op = { fotoOpcional: true, foto: { ruta: foto, segura: true } };
      Object.assign(cola._pendientes[0], op);
      check('…ni una con una foto que puede no usarse', cola.lasDeComfy().length === 0);
      delete cola._pendientes[0].foto; delete cola._pendientes[0].fotoOpcional;
      orden = ['comfyui', 'antigravity'];
      check('a la fuerza terminan las dos en error, y nadie gasta agy', cola.cortarLasDeComfy() === 2 && entrada(a).codigo === 'comfyui-apagado' && entrada(b).codigo === 'comfyui-apagado');
      soltar(); await new Promise((r) => setTimeout(r, 50));
      check('…tampoco después', c.vistos.length === 0 && ag.vistos.length === 0 && entrada(a).estado === 'error');
    }
  });

  // ------------------------------------------------------------- el tope
  await group('El tope por alma', async () => {
    const k = 'tope';
    const hazTope = async (tope, extra = {}) => { const id = nuevaTarea(k); const c = armar({ provs: { comfyui: prov('comfyui') }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false, tope_por_alma: tope }), ...extra }); c.encolar({ tareaId: id, clave: k, pedido: 'x' }); await termina(id); return id; };
    const viejas = Array.from({ length: 5 }, () => poner({}, k));
    await hazTope(0);
    check('0 = no podar nunca', indice.listar(k).length === 6);
    await hazTope(10);
    check('por debajo del tope no borra', indice.listar(k).length === 7);
    await hazTope(3, { fotosEnUso: () => [viejas[0].archivo] });
    const quedan = indice.listar(k).map((e) => e.tareaId);
    check('poda las más viejas y saltea la que un turno está usando', quedan.length === 3 && quedan.includes(viejas[0].id) && fs.existsSync(viejas[0].archivo) && !fs.existsSync(viejas[1].archivo));
    const ajeno = path.join(raiz, 'ajeno.png'); fs.writeFileSync(ajeno, PNG);
    const k2 = 'tope2';
    poner({ archivo: ajeno, creada: '2000-01-01T00:00:00Z' }, k2); poner({}, k2);
    const id = nuevaTarea(k2); armar({ provs: { comfyui: prov('comfyui') }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false, tope_por_alma: 1 }) }).encolar({ tareaId: id, clave: k2, pedido: 'x' }); await termina(id);
    check('podar saltea una que apunta afuera: ni el archivo ni la entrada', fs.existsSync(ajeno) && indice.listar(k2).length === 2 && indice.listar(k2)[0].archivo === ajeno);
  });

  // ------------------------------------------------------------- la galería
  await group('La galería: listar y bajar', async () => {
    const k1 = 'gala'; const k2 = 'galb';
    const ids = Array.from({ length: 7 }, (_, i) => poner({ prompt: i === 3 ? 'a LIGHTHOUSE at night' : 'a cat', caso: i % 2 ? 'variacion' : 'nueva', hilo: 'h-secreto', vista: 'vista-secreta', vistaOrden: false, fotoRuta: 'C:\\Users\\yo\\x.png', bytes: 100, proveedor: 'comfyui', modelo: 'm.safetensors', ancho: 10, alto: 20, cambio: 'leve', fuerza: 0.45, lorasUsadas: [{ clave: 'a', fuerza: 0.5 }] }, i < 5 ? k1 : k2).id);
    const cambios = [];
    let cfg = config({ tope_por_alma: 9 });
    const cola = armar({ provs: {} });
    const g = crearGaleria({ cola, registro, leerConfig: () => cfg, alCambiar: (c) => cambios.push(c) });
    const p1 = g.listar({ alma: k1, limite: '2' });
    const p2 = g.listar({ alma: k1, limite: '2', antes: p1.siguiente });
    const p3 = g.listar({ alma: k1, limite: '2', antes: p2.siguiente });
    check('de la más nueva a la más vieja, por páginas', [...p1.imagenes, ...p2.imagenes, ...p3.imagenes].map((i) => i.tareaId).join() === ids.slice(0, 5).reverse().join() && p3.siguiente === null, JSON.stringify(p3.siguiente));
    const todas = g.listar({});
    check('todas las almas, con el resumen', todas.imagenes.filter((i) => [k1, k2].includes(i.alma)).length === 7 && todas.resumen[k1].n === 5 && todas.resumen[k1].bytes === ids.slice(0, 5).reduce((s, id) => s + fs.statSync(indice.leer(k1, id, 1).archivo).size, 0) && todas.resumen[k2].tope === 9);
    const f = g.listar({ alma: k1, busca: 'lighthouse' });
    check('busca en el prompt, sin mayúsculas', f.imagenes.length === 1 && f.imagenes[0].tareaId === ids[3]);
    check('filtra por caso', g.listar({ alma: k1, caso: 'variacion' }).imagenes.length === 2);
    const fila = f.imagenes[0];
    check('la fila', fila.proveedor === 'comfyui' && fila.ancho === 10 && fila.bytes === fs.statSync(indice.leer(k1, ids[3], 1).archivo).size && fila.cambio === 'leve' && fila.fuerza === 0.45 && fila.loras[0].fuerza === 0.5 && fila.externo === false && fila.segura === true && fila.enRegistro === false && fila.intento === 1);
    const crudo = JSON.stringify(todas);
    check('nunca rutas, hilo, mensaje ni vista', !crudo.includes('secret') && !crudo.includes('Users') && !crudo.includes('archivo') && !crudo.includes('telegram'));
    cfg = config({ fotos_seguras: false });
    check('segura sale de los ajustes', g.listar({ alma: k1 }).imagenes[0].segura === false);
    cfg = config();
    for (const [que, q] of [['alma', { alma: '../x' }], ['caso', { caso: 'raro' }], ['cursor', { antes: 'zzz' }], ['límite', { limite: '101' }], ['límite 0', { limite: '0' }]]) check(`un ${que} que no vale: 400`, g.listar(q).ok === false && g.listar(q).codigo === 400);
    check('el cursor es opaco', leerCursor(p1.siguiente).tareaId === ids[3] && leerCursor('bm8') === null);
    check('con miles en el mismo instante no se repite ni se pierde ninguna', (() => {
      const k = 'empate'; for (let i = 0; i < 9; i++) poner({ creada: '2026-05-05T00:00:00.000Z' }, k);
      const vistas = []; let antes = null;
      do { const p = g.listar({ alma: k, limite: '2', antes }); vistas.push(...p.imagenes.map((i) => i.tareaId)); antes = p.siguiente; } while (antes);
      return vistas.length === 9 && new Set(vistas).size === 9;
    })());
    // Una de antes de 2.20.
    const v = poner({ externo: undefined, proveedor: undefined, caso: undefined }, 'viejas');
    const fv = g.listar({ alma: 'viejas' }).imagenes[0];
    check('una de antes: medidas del PNG, tamaño del archivo y lo demás en null', fv.ancho === 8 && fv.alto === 8 && fv.bytes === v.bytes.length && fv.proveedor === null && fv.caso === null && fv.externo === true && fv.segura === false);
    check('los bytes por su lugar', g.bytes('viejas', v.id, 1).bytes.equals(v.bytes) && g.bytes('viejas', 't_noexiste', 1).ok === false && g.bytes('..', v.id, 1).codigo === 400 && g.bytes(k1, v.id, 1).ok === false);
    const ajeno = path.join(raiz, 'secreto.png'); fs.writeFileSync(ajeno, PNG);
    const mala = poner({ archivo: ajeno }, 'viejas');
    check('una entrada que apunta afuera no se lista ni se baja', g.listar({ alma: 'viejas' }).imagenes.length === 1 && g.bytes('viejas', mala.id, 1).ok === false && g.referencia({ alma: 'viejas', tareaId: mala.id, n: 1, intento: 1 }).ok === false);
    fs.rmSync(v.archivo);
    check('sin su archivo no es una fila', g.listar({ alma: 'viejas' }).imagenes.length === 0);
    check('el resumen no cuenta la que apunta afuera', crearGaleria({ cola, registro, leerConfig: () => cfg }).listar({}).resumen.viejas === undefined);
    const falla = await haz({ provs: { comfyui: prov('comfyui', () => ({ ok: false, codigo: 'error' })) } });
    check('una fallida no es una fila', !g.listar({ alma: clave, limite: '100' }).imagenes.some((i) => i.tareaId === falla.id));
    check('la referencia: el archivo original', g.referencia({ alma: k1, tareaId: ids[0], n: 1, intento: 1 }).ok === true && g.referencia({ alma: k1, tareaId: ids[0], n: 1, intento: 2 }).codigo === 409 && g.referencia({ alma: k1, tareaId: 't_nada1', n: 1, intento: 1 }).codigo === 404 && g.referencia('x').codigo === 400);
  });

  await group('La galería: borrar', async () => {
    const hecha = await haz();
    const cambios = [];
    let enUso = [];
    const cola = armar({ provs: { comfyui: prov('comfyui') }, fotosEnUso: () => enUso });
    const g = crearGaleria({ cola, registro, leerConfig: () => config(), alCambiar: (c) => cambios.push(c) });
    const una = (extra = {}) => g.borrar([{ alma: clave, tareaId: hecha.id, n: 1, intento: 1, ...extra }]).resultados[0].resultado;
    check('otro intento: cambio', una({ intento: 2 }) === 'cambio' && fs.existsSync(hecha.priv.archivo));
    check('otra alma: no-existe', una({ alma: 'otra' }) === 'no-existe');
    enUso = [hecha.priv.archivo];
    check('con un turno que la usa: ocupada', una() === 'ocupada');
    enUso = [];
    check('la reconoce antes', cola.reconocer(fs.readFileSync(hecha.priv.archivo))?.tareaId === hecha.id);
    const bytes = fs.readFileSync(hecha.priv.archivo);
    check('borrada: archivo, índice y la entrada del turno', una() === 'borrada' && !fs.existsSync(hecha.priv.archivo) && indice.leer(clave, hecha.id, 1) === null && entrada(hecha.id).estado === 'borrada' && entrada(hecha.id).mensaje === 'La borraste.');
    check('…sale de los mapas y avisa una vez', cola.reconocer(bytes) === null && cambios.join() === clave);
    check('otra vez: no-existe', una() === 'no-existe');
    check('Otra versión y Reintentar de una borrada: ya no está', cola.otra(hecha.id, 1).codigo === 'no-existe' && cola.reintentar(hecha.id, 1).codigo === 'no-existe');
    check('hasta 100, con su forma', g.borrar([]).codigo === 400 && g.borrar('x').codigo === 400 && g.borrar([{ alma: clave }]).codigo === 400 && g.borrar(Array.from({ length: 101 }, () => ({ alma: clave, tareaId: 't_abcd', n: 1, intento: 1 }))).codigo === 400);
    // La base de una en curso.
    const b = poner(); let soltar; const esp = new Promise((r) => { soltar = r; });
    const lenta = prov('comfyui', async () => { await esp; return { ok: true }; });
    const cola2 = armar({ provs: { comfyui: lenta }, ref: refina({ caso: 'variacion', prompt: 'x' }) });
    const g2 = crearGaleria({ cola: cola2, registro, leerConfig: () => config() });
    const id = nuevaTarea(); cola2.encolar({ tareaId: id, clave, pedido: 'x', desdeFoto: true, foto: { ruta: b.archivo, segura: true } });
    await hasta(() => lenta.vistos.length);
    check('la base de una en curso: ocupada', g2.borrar([{ alma: clave, tareaId: b.id, n: 1, intento: 1 }]).resultados[0].resultado === 'ocupada');
    soltar(); await termina(id); await hasta(() => cola2.estadoDeImagenes().enCurso === 0);
    check('…y al terminar se puede', g2.borrar([{ alma: clave, tareaId: b.id, n: 1, intento: 1 }]).resultados[0].resultado === 'borrada');
    // Borrar contra un Reintento, y la que apunta afuera.
    const h2 = await haz();
    indice.actualizar(clave, h2.id, 1, (p) => ({ ...p, intento: 2 }));
    check('un Reintento que ganó: cambio', crearGaleria({ cola: h2.cola, registro, leerConfig: () => config() }).borrar([{ alma: clave, tareaId: h2.id, n: 1, intento: 1 }]).resultados[0].resultado === 'cambio');
    const ajeno = path.join(raiz, 'ajeno2.png'); fs.writeFileSync(ajeno, PNG);
    const mala = poner({ archivo: ajeno });
    check('una que apunta afuera no se borra', g.borrar([{ alma: clave, tareaId: mala.id, n: 1, intento: 1 }]).resultados[0].resultado === 'no-existe' && fs.existsSync(ajeno));
    // Las vistas.
    const conVista = poner({ hilo: 'hv', vista: 'un gato', vistaEntregada: false });
    g.borrar([{ alma: clave, tareaId: conVista.id, n: 1, intento: 1 }]);
    check('no queda en las vistas ni como la última del hilo', indice.vistasPendientes(clave, 'hv').length === 0 && indice.ultimaImagen(clave, ['hv']) === null);
  });

  await group('La última del hilo, desde el índice', async () => {
    const a = poner({ hilo: 'hu' }); const b = poner({ hilo: 'hu', externo: true }); poner({ hilo: 'hu', lista: false });
    check('la última lista por fecha', indice.ultimaImagen(clave, ['hu']).tareaId === b.id && indice.ultimaImagen(clave, ['hu']).externo === true);
    fs.rmSync(b.archivo);
    check('con su archivo', indice.ultimaImagen(clave, ['hu']).tareaId === a.id && indice.ultimaImagen(clave, ['hu']).externo === false);
    check('el primero de los hilos que tenga', indice.ultimaImagen(clave, ['nada', null, 'hu']).tareaId === a.id && indice.ultimaImagen(clave, ['nada']) === null);
    check('lo desconocido cuenta como externo', (() => { poner({ hilo: 'hx', externo: undefined }); return indice.ultimaImagen(clave, ['hx']).externo === true; })());
  });

  // ------------------------------------------------------------- las rutas v2
  await group('API v2: la galería, la referencia y ComfyUI', async () => {
    const { rutasMutacionV2 } = await importar('telegram-bridge/web/v2/mutaciones.js');
    const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
    const { crearIdempotencia } = await importar('telegram-bridge/web/v2/idempotencia.js');
    const real = crearNucleoWeb({ canal: {}, bot: { almasDisponibles: () => [{ clave: 'alya', voz: 'Alya' }] } });
    const a = poner();
    const despachos = [];
    const galeria = crearGaleria({ cola: armar({ provs: {} }), registro, leerConfig: () => config() });
    const llamadas = [];
    const comfy = { estado: async () => ({ estado: 'apagado' }), levantar: async () => ({ ok: true }), apagar: async (f) => { llamadas.push(['apagar', f]); return f ? { ok: true } : { ok: false, codigo: 'ocupado', motivo: 'ComfyUI está haciendo una imagen.' }; }, reiniciar: async () => ({ ok: false, codigo: 'ajeno', motivo: 'x' }), flags: async () => ({ ok: false, motivo: 'no hay' }), registro: () => ['l'] };
    const base = { nucleo: { sujetos: async () => ({ almas: [{ clave: 'alya', voz: 'Alya' }], agentes: [] }), validarFoto: (c, b) => real.validarFoto(c, b), validarPieDeFoto: (c, b) => real.validarPieDeFoto(c, b), guardarFoto: () => { throw new Error('no tenía que guardar'); } }, cola: { dispatchCharla: async (_c, o) => { const t = tareas.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'x' }); despachos.push(o); o.alEncolar(t.id); return { ok: true }; } }, ctx: {}, chatTerminal: 'x', registro: tareas, idem: crearIdempotencia({ registro: tareas }), recorte: '' };
    const rutas = rutasMutacionV2({ ...base, imagenes: { galeria }, comfy, conGaleria: true });
    const llamar = (metodo, ruta, cuerpo = {}, tabla = rutas) => { const u = new URL(`http://x${ruta}`); const r = tabla.find((x) => x.metodo === metodo && x.patron.test(u.pathname)); return r.fn({ p: r.patron.exec(u.pathname).slice(1).map(decodeURIComponent), cuerpo, url: u }); };
    const l = await llamar('GET', '/api/v2/imagenes?alma=alya&limite=100');
    check('GET /imagenes', l.ok && l.imagenes.some((i) => i.tareaId === a.id) && l.resumen.alya.n > 0);
    check('GET /imagenes con un filtro que no vale: 400 con su campo', (await llamar('GET', '/api/v2/imagenes?limite=abc')).campo === 'limite');
    check('los bytes', (await llamar('GET', `/api/v2/imagenes/alya/${a.id}/1`)).binario.equals(a.bytes) && (await llamar('GET', '/api/v2/imagenes/alya/t_nada1/1')).codigo === 404);
    const idc = (n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
    const ref = { alma: 'alya', tareaId: a.id, n: 1, intento: 1 };
    const r1 = await llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: idc(1), referencia: ref, texto: 'mirá' });
    check('la referencia despacha el archivo original, sin copiarlo y sin marcar', r1.ok !== false && fs.realpathSync(despachos[0].imagen.ruta) === fs.realpathSync(a.archivo) && despachos[0].imagen.segura === false && despachos[0].texto === 'mirá');
    await llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: idc(1), referencia: ref });
    check('un reenvío no despacha otra vez', despachos.length === 1);
    await llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: idc(2), referencia: ref, segura: true });
    check('segura: true es la marca del usuario', despachos[1].imagen.segura === true);
    check('la referencia con base64: 400', (await llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: idc(3), referencia: ref, base64: 'AA' })).codigo === 400);
    check('una que no está: 404', (await llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: idc(4), referencia: { ...ref, tareaId: 't_nada1' } })).codigo === 404 && despachos.length === 2);
    const grande = poner(); fs.writeFileSync(grande.archivo, Buffer.alloc(12 * 1024 * 1024));
    await llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: idc(5), referencia: { ...ref, tareaId: grande.id } });
    check('una de 12 MB pasa', despachos.length === 3);
    const enorme = poner(); fs.writeFileSync(enorme.archivo, Buffer.alloc(21 * 1024 * 1024));
    check('una de 21 MB no: 413', (await llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: idc(6), referencia: { ...ref, tareaId: enorme.id } })).codigo === 413);
    const bo = await llamar('POST', '/api/v2/imagenes:borrar', { imagenes: [{ ...ref, tareaId: enorme.id }] });
    check('POST imagenes:borrar', bo.ok && bo.resultados[0].resultado === 'borrada');
    check('GET /comfyui', (await llamar('GET', '/api/v2/comfyui')).estado === 'apagado');
    const oc = await llamar('POST', '/api/v2/comfyui:apagar');
    check('apagar ocupado: 409 con su motivo', oc.codigo === 409 && oc.motivo === 'ocupado');
    check('con forzar lo hace', (await llamar('POST', '/api/v2/comfyui:apagar', { forzar: true })).ok === true && llamadas[1][1] === true && (await llamar('POST', '/api/v2/comfyui:apagar', { forzar: 'si' })).codigo === 400);
    check('reiniciar uno ajeno: 409', (await llamar('POST', '/api/v2/comfyui:reiniciar')).motivo === 'ajeno');
    check('levantar, registro y flags', (await llamar('POST', '/api/v2/comfyui:levantar')).ok && (await llamar('GET', '/api/v2/comfyui/registro')).lineas[0] === 'l' && (await llamar('GET', '/api/v2/comfyui/flags')).codigo === 409);
    const nodo = rutasMutacionV2({ ...base, imagenes: { galeria }, comfy: null, conGaleria: false });
    check('en un nodo: 503', (await llamar('GET', '/api/v2/imagenes', {}, nodo)).codigo === 503 && (await llamar('POST', '/api/v2/imagenes:borrar', {}, nodo)).codigo === 503 && (await llamar('GET', '/api/v2/comfyui', {}, nodo)).codigo === 503 && (await llamar('POST', '/api/v2/sujetos/alya/fotos', { idCliente: idc(7), referencia: ref }, nodo)).codigo === 503);
    // Los eventos, con su esquema.
    const { crearAlmacenEventos } = await importar('telegram-bridge/web/v2/almacen-eventos.js');
    const { crearProductoresLectura } = await importar('telegram-bridge/web/v2/lecturas.js');
    const almacen = crearAlmacenEventos({ arranque: 'x' }); const vistos = [];
    let estado = { estado: 'apagado', nuestro: false, otraConfiguracion: false, desde: null, cola: null, mensaje: null, sePuede: true, motivo: null, instalacion: 'portable' };
    const pr = crearProductoresLectura({ almacen, nucleo: { claude: async () => ({}) }, arranque: 'x', comfy: { estado: async () => estado }, intervaloSaludMs: 100000 });
    await pr.publicarComfy();
    const baja = almacen.suscribir(['salud', 'sujeto:*'], (e) => vistos.push(e));
    await pr.publicarComfy(); await pr.publicarComfy();
    estado = { ...estado, estado: 'levantando' }; await pr.publicarComfy();
    almacen.publicar('sujeto:alya', 'imagenes.cambio', { alma: 'alya' });
    baja(); pr.cerrar();
    const deComfy = vistos.filter((e) => e.tipo === 'comfyui.estado');
    check('comfyui.estado: solo si cambió, y vale contra el contrato', deComfy.length === 2 && deComfy.every((e) => esquema.validar(contrato, 'evento:comfyui.estado', e.datos).length === 0 && esquema.validar(contrato, 'evento', e).length === 0));
    check('imagenes.cambio vale contra el contrato', vistos.filter((e) => e.tipo === 'imagenes.cambio').every((e) => esquema.validar(contrato, 'evento:imagenes.cambio', e.datos).length === 0));
    const caps = bot.capacidadesV2({ leerConfig: () => config() });
    check('las capacidades', caps.capacidades.galeria === true && typeof caps.capacidades.comfyuiProceso === 'boolean' && esquema.validar(contrato, 'capacidades', caps).length === 0);
    check('el contrato sigue en 2.x', /^2\./.test(contrato.version));
  });

  // ------------------------------------------------------------- los ajustes
  await group('Los ajustes nuevos', async () => {
    const d = A.defectos();
    check('por defecto: todo prendido, 500, 20 minutos y 120 segundos, sin carpeta', ['responder_usa_imagen', 'usar_ultima', 'foto_cuenta', 'fuerza_automatica'].every((k) => d[k] === true) && d.tope_por_alma === 500 && d.comfyui.arranque.carpeta === null && d.comfyui.arranque.automatico === true && d.comfyui.arranque.apagar_min === 20 && d.comfyui.arranque.espera_s === 120 && d.comfyui.arranque.flags.length === 0);
    let datos = A.aplicarImagenes({}, { usar_ultima: false, tope_por_alma: 0, comfyui: { arranque: { carpeta: 'C:\\ComfyUI', apagar_min: 0, flags: [{ flag: '--lowvram' }, { flag: '--reserve-vram', valor: 1.5 }] } } });
    datos = A.aplicarImagenes(datos, { comfyui: { arranque: { espera_s: 60 } } });
    const i = A.leerSeccion(datos).imagenes;
    const carpetaOk = process.platform === 'win32' ? i.comfyui.arranque.carpeta === 'C:\\ComfyUI' : true;
    check('se guardan y se funden campo por campo', i.usar_ultima === false && i.tope_por_alma === 0 && carpetaOk && i.comfyui.arranque.apagar_min === 0 && i.comfyui.arranque.espera_s === 60 && i.comfyui.arranque.flags[1].valor === '1.5');
    const otras = A.leerSeccion(A.aplicarImagenes(datos, { comfyui: { arranque: { flags: [] } } })).imagenes.comfyui.arranque;
    check('flags va entera', otras.flags.length === 0 && otras.espera_s === 60);
    check('arranque: null vuelve a lo de siempre', A.aplicarImagenes(datos, { comfyui: { arranque: null } }).imagenes.comfyui === undefined);
    for (const [que, p] of [['tope negativo', { tope_por_alma: -1 }], ['tope enorme', { tope_por_alma: 10001 }], ['carpeta de red', { comfyui: { arranque: { carpeta: '\\\\otro\\x' } } }], ['carpeta relativa', { comfyui: { arranque: { carpeta: 'x' } } }], ['minutos de más', { comfyui: { arranque: { apagar_min: 1441 } } }], ['espera corta', { comfyui: { arranque: { espera_s: 9 } } }], ['una clave de más', { comfyui: { arranque: { exe: 'x' } } }], ['--listen', { comfyui: { arranque: { flags: [{ flag: '--listen', valor: '0.0.0.0' }] } } }], ['una --front-end', { comfyui: { arranque: { flags: [{ flag: '--front-end-root', valor: 'x' }] } } }], ['un valor que es otra flag', { comfyui: { arranque: { flags: [{ flag: '--cache-lru', valor: '--listen' }] } } }], ['un salto de línea', { comfyui: { arranque: { flags: [{ flag: '--cache-lru', valor: '1\n--listen' }] } } }], ['una repetida', { comfyui: { arranque: { flags: [{ flag: '--cpu' }, { flag: '--cpu' }] } } }], ['una con espacios', { comfyui: { arranque: { flags: [{ flag: '--cpu --listen' }] } } }], ['41 flags', { comfyui: { arranque: { flags: Array.from({ length: 41 }, (_, n) => ({ flag: `--a${n}` })) } } }]]) check(`${que}: 400`, Boolean(tira(() => A.aplicarImagenes({}, p))));
    const tol = A.leerSeccion({ imagenes: { tope_por_alma: 'x', comfyui: { arranque: { carpeta: 'x', apagar_min: -3, flags: [{ flag: '--port', valor: '1' }] } } } });
    check('la lectura tolerante cae a lo de siempre, con aviso', tol.imagenes.tope_por_alma === 500 && tol.imagenes.comfyui.arranque.carpeta === null && tol.imagenes.comfyui.arranque.apagar_min === 20 && tol.imagenes.comfyui.arranque.flags.length === 0 && tol.avisos.length === 4, tol.avisos.join(' | '));
    const v = ajustesV2.ajustesV2({ imagenes: A.leerImagenes(datos).imagenes }).imagenes;
    check('la v2 los muestra', v.usar_ultima === false && v.responder_usa_imagen === true && v.tope_por_alma === 0 && v.comfyui.arranque.espera_s === 60 && v.comfyui.arranque.flags[0].flag === '--lowvram' && v.comfyui.arranque.flags[0].valor === null);
    const guardado = []; const nucleo = { guardarAjustes: async (p) => { guardado.push(p); return { ok: true, guardado: true }; } };
    const comfy = { validarArranque: async (a) => (a.flags && a.flags.some((x) => x.flag === '--no-existe') ? { ok: false, campo: '.flags.0.flag', motivo: 'no está en esa versión.' } : { ok: true }) };
    const r400 = await ajustesV2.guardarAjustesV2(nucleo, { imagenes: { versionSeccion: 'x', comfyui: { arranque: { flags: [{ flag: '--no-existe' }] } } } }, { comfy });
    check('una flag que esa versión no tiene: 400 antes del núcleo', r400.codigo === 400 && r400.campo === 'imagenes.comfyui.arranque.flags.0.flag' && guardado.length === 0);
    const ok = await ajustesV2.guardarAjustesV2(nucleo, { imagenes: { versionSeccion: 'x', tope_por_alma: 5, comfyui: { arranque: { flags: [{ flag: '--cpu' }] } } } }, { comfy });
    check('las demás llegan al núcleo', ok.ok && guardado.length === 1 && guardado[0].imagenes.tope_por_alma === 5);
    check('las flags: nombres y valores', flags.comoArgumento({ flag: '--a', valor: 'x y' }) === '--a=x y' && flags.comoArgumento({ flag: '--a', valor: null }) === '--a');
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
