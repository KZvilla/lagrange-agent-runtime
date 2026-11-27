/**
 * FEAT-218 S1.1 — La segunda pasada con un modelo de reescalado (`hires_modelo_de`, la plantilla
 * `sdxl/nueva-hires-modelo`), el método del latente (`muestreo.hires.metodo`), el catálogo con `upscalers`, y los tests del
 * camino entero que dejó la auditoría de S1 (la cola con LoRAs por modelo, las repeticiones de un retoque y `reintentar`).
 *
 * Sin red, sin agy y sin ComfyUI: todo se inyecta.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat218s11-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.LAGRANGE_ALMAS_DIR, { recursive: true });

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indice = require('../mcp-server/imagenes/indice.js');
const A = require('../mcp-server/lib/ajustes-imagenes.js');
const P = require('../mcp-server/imagenes/perfiles.js');
const F = require('../mcp-server/imagenes/flujos.js');
const C = require('../mcp-server/imagenes/casos.js');
const R = require('../mcp-server/imagenes/refinador.js');
const D = require('../mcp-server/imagenes/disposicion.js');
const catalogos = require('../mcp-server/imagenes/catalogo.js');
const sondaVision = require('../mcp-server/imagenes/sonda-vision.js');

const PNG = sondaVision.pngSolido(8, [10, 200, 10]);
const copia = (o) => JSON.parse(JSON.stringify(o));
const hasta = async (cond, ms = 3000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); } return cond(); };
const config = (extra = {}, comfy = {}) => { const d = A.defectos(); return { ...d, ...extra, comfyui: { ...d.comfyui, ...comfy } }; };
const DIR_SDXL = path.join(RAIZ, 'telegram-bridge', 'imagenes', 'plantillas', 'sdxl');

const WAI = 'WAI-Nsfw-Illustrious-17.safetensors';
const PONY = 'ponyDiffusionV6XL.safetensors';
const BASE = 'sd_xl_base_1.0.safetensors';
const US = '4x-UltraSharp.safetensors';
const PI = P.PERFILES.get('sdxl-illustrious');
/** Con la casilla prendida en Illustrious y, si se pide, con un modelo de reescalado. */
const conHires = (modelo = US, extra = {}) => config(extra, { hires_de: { 'sdxl-illustrious': true }, ...(modelo ? { hires_modelo_de: { 'sdxl-illustrious': modelo } } : {}) });

/** Las clases de todas las plantillas sdxl del plugin: un catálogo falso que puede todo lo de esa familia. */
const CLASES = new Set();
for (const f of fs.readdirSync(DIR_SDXL).filter((x) => /^[a-z0-9-]+\.json$/.test(x))) for (const n of Object.values(JSON.parse(fs.readFileSync(path.join(DIR_SDXL, f), 'utf8')))) CLASES.add(n.class_type);
const catalogo = (checkpoints, upscalers = null) => ({
  checkpoints: checkpoints.map((valor) => ({ valor })), unets: [], clips: [], vaes: [], loras: [], nodos: new Set(CLASES),
  ...(upscalers ? { upscalers: upscalers.map((valor) => ({ valor })) } : {})
});

async function main() {
  const { datosDe, armarPedido, esHiresDelPlugin, crearComfyui } = await importar('telegram-bridge/imagenes/comfyui.js');
  const tareas = await importar('telegram-bridge/tareas.js');
  const { crearColaImagenes } = await importar('telegram-bridge/imagenes-cola.js');
  const { ajustesV2 } = await importar('telegram-bridge/web/v2/ajustes.js');

  // ------------------------------------------------------------ perfiles
  await group('Perfiles: el método del latente y hiresModeloDe', async () => {
    const base = copia(P.PERFILES.get('sdxl'));
    const con = (h) => P.validarPerfil('mio', { ...base, muestreo: { ...base.muestreo, hires: h } });
    const ok = con({ escala: 1.5, fuerza: 0.5, pasos: 10, metodo: 'bislerp' });
    check('metodo de la lista: vale y se devuelve', ok.ok && ok.perfil.muestreo.hires.metodo === 'bislerp');
    check('metodo fuera de la lista: 400 con su campo', con({ escala: 1.5, fuerza: 0.5, pasos: 10, metodo: 'lanczos' }).campo === 'muestreo.hires.metodo');
    check('sin metodo: no aparece', !('metodo' in con({ escala: 1.5, fuerza: 0.5, pasos: 10 }).perfil.muestreo.hires));
    check('hiresDe: nearest-exact por defecto (con y sin muestreo.hires)', P.hiresDe(P.PERFILES.get('sdxl')).metodo === 'nearest-exact' && P.hiresDe({ muestreo: { pasos: 20 } }).metodo === 'nearest-exact' && P.hiresDe(ok.perfil).metodo === 'bislerp');
    check('los cinco métodos de LatentUpscaleBy', P.METODOS_LATENTE.join() === 'nearest-exact,bilinear,area,bicubic,bislerp');
    check('hiresModeloDe: el archivo, o vacío (y nunca en Flux)', P.hiresModeloDe(conHires(), PI) === US && P.hiresModeloDe(conHires(null), PI) === '' && P.hiresModeloDe(config({}, { hires_modelo_de: { flux: US } }), P.PERFILES.get('flux')) === '');
  });

  // -------------------------------------------------------- la plantilla
  await group('La plantilla sdxl/nueva-hires-modelo', async () => {
    const l = F.leerFlujo(path.join(DIR_SDXL, 'nueva-hires-modelo.json'), { caso: 'nueva' });
    check('se lee, con la salida 9 y los 4 huecos', l.ok && l.ficha.salida === '9' && l.ficha.huecos.join() === '101,102,103,104', l.motivo);
    check('17 nodos', Object.keys(l.flujo).length === 17);
    const clase = (c) => Object.entries(l.flujo).find(([, n]) => n.class_type === c);
    const [idUp] = clase('ImageUpscaleWithModel');
    const [idEsc, esc] = clase('ImageScale');
    const [idEnc, enc] = clase('VAEEncode');
    check('KSampler 3 → VAEDecode → modelo → ImageScale → VAEEncode → KSampler 11 → VAEDecode 8', JSON.stringify(l.flujo['8'].inputs.samples) === '["11",0]' && JSON.stringify(l.flujo['11'].inputs.latent_image) === `["${idEnc}",0]` && JSON.stringify(enc.inputs.pixels) === `["${idEsc}",0]` && JSON.stringify(esc.inputs.image) === `["${idUp}",0]`);
    check('ImageScale a hires_ancho × hires_alto, con lanczos', esc.inputs.width === '{{hires_ancho}}' && esc.inputs.height === '{{hires_alto}}' && esc.inputs.upscale_method === 'lanczos' && esc.inputs.crop === 'disabled');
    check('hires_ancho y hires_alto son enteros; hires_modelo y hires_metodo, texto', F.ENTEROS.has('hires_ancho') && F.ENTEROS.has('hires_alto') && !F.ENTEROS.has('hires_modelo') && !F.DECIMALES.has('hires_modelo') && !F.ENTEROS.has('hires_metodo') && !F.DECIMALES.has('hires_metodo'));
    const disp = JSON.parse(fs.readFileSync(path.join(DIR_SDXL, 'nueva-hires-modelo.disposicion.json'), 'utf8'));
    check('su disposición vale y cubre los 17 nodos', D.validarDisposicion(disp).ok && Object.keys(disp.nodos).length === 17 && Object.keys(l.flujo).every((id) => disp.nodos[id] && disp.nodos[id].tipo === l.flujo[id].class_type));
    check('su clave es plugin:sdxl/nueva-hires-modelo', D.delPlugin('plugin:sdxl/nueva-hires-modelo') !== null);
    const lat = F.leerFlujo(path.join(DIR_SDXL, 'nueva-hires.json'), { caso: 'nueva' });
    check('nueva-hires usa {{hires_metodo}}', lat.ok && lat.flujo['10'].inputs.upscale_method === '{{hires_metodo}}');
  });

  await group('plantillaDe y resolverFlujo', async () => {
    check('con modelo: nueva-hires-modelo', F.plantillaDe(conHires(), PI, 'nueva').nombre === 'sdxl/nueva-hires-modelo');
    check('{ conModelo: false } o sin entrada: nueva-hires', F.plantillaDe(conHires(), PI, 'nueva', { conModelo: false }).nombre === 'sdxl/nueva-hires' && F.plantillaDe(conHires(null), PI, 'nueva').nombre === 'sdxl/nueva-hires');
    check('con la casilla apagada (y el modelo elegido): nueva', F.plantillaDe(config({}, { hires_modelo_de: { 'sdxl-illustrious': US } }), PI, 'nueva').nombre === 'sdxl/nueva');
    check('{ hires: false }: nueva', F.plantillaDe(conHires(), PI, 'nueva', { hires: false }).nombre === 'sdxl/nueva');
    check('resolverFlujo reenvía conModelo (el resolver de siempre)', F.resolverFlujo(conHires(), PI, 'nueva').nombre === 'sdxl/nueva-hires-modelo' && F.resolverFlujo(conHires(), PI, 'nueva', { conModelo: false }).nombre === 'sdxl/nueva-hires');
    check('esHiresDelPlugin', esHiresDelPlugin({ nombre: 'sdxl/nueva-hires-modelo' }, PI) === 'modelo' && esHiresDelPlugin({ nombre: 'sdxl/nueva-hires' }, PI) === 'latente' && esHiresDelPlugin({ nombre: 'sdxl/nueva-hires', propio: true }, PI) === false && esHiresDelPlugin({ nombre: 'sdxl/nueva' }, PI) === false);
  });

  // ------------------------------------------------------- armarPedido
  await group('armarPedido con modelo', async () => {
    const arma = ({ sec = conHires(), ancho = 1088, alto = 1088, cat = null, logs = [], resolverFlujo, loras = [] } = {}) => armarPedido({ seccion: sec, caso: 'nueva', modelo: WAI, perfil: PI, pedido: { prompt: 'x', negativo: '', ancho, alto, semilla: 7 }, catalogo: cat, loras, log: (m) => logs.push(m), ...(resolverFlujo ? { resolverFlujo } : {}) });
    const a = arma();
    const final = F.aplicarMarcadores(a.armado, a.datos);
    const de = (c) => Object.values(final).find((n) => n.class_type === c);
    check('1088²: hires con modelo, a 1632², con el archivo', a.ok && a.hires === 'modelo' && de('ImageScale').inputs.width === 1632 && de('ImageScale').inputs.height === 1632 && de('UpscaleModelLoader').inputs.model_name === US);
    check('el segundo KSampler: la semilla, 15 pasos y 0,5 como números', final['11'].inputs.seed === 7 && final['11'].inputs.steps === 15 && final['11'].inputs.denoise === 0.5);
    const conLora = arma({ loras: [{ clave: 'a', archivo: 'a.safetensors', fuerza: 0.8 }] });
    const fl = F.aplicarMarcadores(conLora.armado, conLora.datos);
    // En la plantilla cruda, los dos KSampler y los clip toman del último hueco (104); con una LoRA usada, `puentear`
    // los pasa al único que queda (101). Si el segundo KSampler tomara de 4, la LoRA solo iría en la primera pasada.
    const cruda = F.leerFlujo(path.join(DIR_SDXL, 'nueva-hires-modelo.json'), { caso: 'nueva' }).flujo;
    const toman = (g, h) => ['3', '11'].every((id) => JSON.stringify(g[id].inputs.model) === `["${h}",0]`) && ['6', '7'].every((id) => JSON.stringify(g[id].inputs.clip) === `["${h}",1]`);
    check('los dos KSampler y los clip de 6 y 7 toman de 104 en la plantilla, y de 101 con una LoRA usada', toman(cruda, '104') && toman(fl, '101') && fl['101'].inputs.lora_name === 'a.safetensors');
    const lat = arma({ sec: conHires(null) });
    check('sin modelo: latente, con el método', lat.hires === 'latente' && F.aplicarMarcadores(lat.armado, lat.datos)['10'].inputs.upscale_method === 'nearest-exact');
    // Un método elegido llega al grafo final.
    const conBislerp = { ...copia(PI), muestreo: { ...copia(PI.muestreo), hires: { ...PI.muestreo.hires, metodo: 'bislerp' } } };
    const bl = armarPedido({ seccion: conHires(null), caso: 'nueva', modelo: WAI, perfil: conBislerp, pedido: { prompt: 'x', negativo: '', ancho: 1088, alto: 1088 } });
    check('bislerp en el perfil: llega al LatentUpscaleBy del grafo final', bl.hires === 'latente' && F.aplicarMarcadores(bl.armado, bl.datos)['10'].inputs.upscale_method === 'bislerp');
    // datosDe de un perfil sin muestreo.hires: nearest-exact.
    const sinH = copia(P.PERFILES.get('sdxl')); delete sinH.muestreo.hires;
    const dsh = datosDe({ caso: 'nueva', modelo: BASE, perfil: sinH, prompt: 'x', ancho: 1024, alto: 1024 });
    check('datosDe de un perfil sin muestreo.hires: nearest-exact, 1,5 y la mitad de los pasos', dsh.hires_metodo === 'nearest-exact' && dsh.hires_escala === 1.5 && dsh.hires_pasos === Math.max(1, Math.round(sinH.muestreo.pasos / 2)));
    // El catálogo con el archivo en otra forma: el valor exacto del catálogo.
    const cat = catalogo([WAI], ['ESRGAN\\' + US]);
    const enSub = arma({ sec: conHires('ESRGAN/' + US), cat });
    check('hires_modelo: el valor del catálogo («/» contra «\\»)', enSub.hires === 'modelo' && enSub.datos.hires_modelo === 'ESRGAN\\' + US);
    // El modelo no está: hires por latente, con el resolver de siempre.
    const logs = [];
    const falta = arma({ cat: catalogo([WAI], ['otro.pth']), logs });
    check('el modelo no está en el catálogo: nueva-hires, latente, con su log', falta.ok && falta.resuelto.nombre === 'sdxl/nueva-hires' && falta.hires === 'latente' && logs.some((l) => /no está: hires por latente/.test(l)));
    check('sin catálogo: la de modelo', arma({ cat: null }).hires === 'modelo');
    check('un catálogo sin la lista (viejo): la de modelo', arma({ cat: catalogo([WAI]) }).hires === 'modelo');
    const tres = (s, p, c) => F.resolverFlujo(s, p, c);
    const t3 = arma({ cat: catalogo([WAI], ['otro.pth']), resolverFlujo: tres });
    check('un resolver de tres argumentos y el modelo que no está: no se manda', !t3.ok && t3.codigo === 'fallo-del-flujo');
    const t4 = arma({ ancho: 2048, alto: 2048, resolverFlujo: tres });
    check('un desde de 2048² con modelo y un resolver de tres argumentos: no se manda (el predicado único)', !t4.ok && t4.codigo === 'fallo-del-flujo');
    const g = arma({ ancho: 2048, alto: 2048 });
    check('2048² con modelo y el resolver de siempre: va con nueva, sin hires', g.ok && !g.hires && g.resuelto.nombre === 'sdxl/nueva');
    const b = arma({ ancho: 2048, alto: 1216 });
    check('2048×1216 con modelo: 1,26 y el final a 2584×1536', b.hires === 'modelo' && b.datos.hires_escala === 1.26 && b.datos.hires_ancho === 2584 && b.datos.hires_alto === 1536);
    const propio = path.join(raiz, 'mio-nueva.json');
    fs.writeFileSync(propio, fs.readFileSync(path.join(DIR_SDXL, 'nueva.json')));
    fs.writeFileSync(path.join(raiz, 'mio-nueva.ficha.json'), fs.readFileSync(path.join(DIR_SDXL, 'nueva.ficha.json')));
    const conPropio = config({}, { hires_de: { 'sdxl-illustrious': true }, hires_modelo_de: { 'sdxl-illustrious': US }, flujos: { 'sdxl-illustrious': { nueva: { archivo: propio } } } });
    const pp = arma({ sec: conPropio, ancho: 2048, alto: 2048 });
    check('un flujo propio gana sobre el modelo y no recibe el tope', pp.ok && !pp.hires && pp.resuelto.propio);
    const d = datosDe({ caso: 'nueva', modelo: WAI, perfil: P.PERFILES.get('sdxl-pony'), prompt: 'x', ancho: 1024, alto: 1024 });
    check('datosDe sin sección: hires_modelo vacío, nearest-exact y el tamaño final', d.hires_modelo === '' && d.hires_metodo === 'nearest-exact' && d.hires_ancho === 1536 && d.hires_alto === 1536);
  });

  await group('generar: con modelo, el cuádruple de tiempo', async () => {
    const cuanto = async (sec) => {
      let t = 1_000_000;
      const inicio = t;
      const resp = (cuerpo) => ({ ok: true, status: 200, json: async () => cuerpo });
      const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/prompt') return resp({ prompt_id: 'p1', node_errors: {} });
        if (u.pathname === '/queue') return resp({ queue_running: [[0, 'p1']], queue_pending: [] });
        return resp({});
      };
      const p = crearComfyui({ config: { ...sec, comfyui: { ...sec.comfyui, tiempo_s: 10 } }, catalogoDe: () => null, fetchImpl, ahora: () => t, esperar: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } });
      const r = await p.generar({ caso: 'nueva', modelo: WAI, perfil: PI, prompt: 'x', ancho: 1024, alto: 1024, destino: path.join(raiz, 'tiempo') });
      return { codigo: r.codigo, ms: t - inicio };
    };
    const sin = await cuanto(config());
    const lat = await cuanto(conHires(null));
    const mod = await cuanto(conHires());
    check('latente: 20 s más que sin hires (×3); con modelo: 30 s más (×4)', [sin, lat, mod].every((x) => x.codigo === 'tiempo') && lat.ms - sin.ms === 20000 && mod.ms - sin.ms === 30000, JSON.stringify({ sin, lat, mod }));
  });

  // ------------------------------------------------------------ catálogo
  await group('El catálogo: upscalers', async () => {
    const info = { UpscaleModelLoader: { input: { required: { model_name: ['COMBO', { multiselect: false, options: [US, 'RealESRGAN_x4plus.pth'] }] } } }, KSampler: { input: { required: {} } } };
    const cat = catalogos.leerObjectInfo(info);
    check('la forma V3 ["COMBO", { options }]: upscalers con los archivos', cat.upscalers.map((x) => x.valor).join() === `${US},RealESRGAN_x4plus.pth`);
    check('la forma vieja [[...]] también', catalogos.leerObjectInfo({ UpscaleModelLoader: { input: { required: { model_name: [[US]] } } } }).upscalers[0].valor === US);
    check('publico entrega upscalers (y no nodos)', catalogos.publico(cat).upscalers.length === 2 && !('nodos' in catalogos.publico(cat)));
    // Lo que sostiene el reemplazo: faltantes no cuenta el archivo de reescalado.
    // Con WAI (Illustrious), el perfil que tiene la casilla y el modelo: el flujo es de verdad nueva-hires-modelo.
    const catHires = catalogo([WAI], ['otro.pth']);
    const e = C.estadoComfyui(conHires(), 'nueva', catHires, { modelo: WAI });
    check('estadoComfyui con nueva-hires-modelo, los nodos y sin el archivo de reescalado: puede', e.puede === true && e.resuelto && e.resuelto.nombre === 'sdxl/nueva-hires-modelo', JSON.stringify({ motivo: e.motivo, nombre: e.resuelto && e.resuelto.nombre }));
    const r = F.resolverFlujo(conHires(), PI, 'nueva');
    const f = F.faltantes(r, { modelo: WAI }, catHires);
    check('…y faltantes no lo nombra (ni archivos ni nodos)', r.nombre === 'sdxl/nueva-hires-modelo' && f.faltan.archivos.length === 0 && f.faltan.nodos.length === 0 && !JSON.stringify(f).includes(US), JSON.stringify(f));
  });

  // ------------------------------------------------------------ ajustes
  await group('Ajustes: hires_modelo_de y metodo', async () => {
    const tira = (fn) => { try { fn(); return null; } catch (e) { return e; } };
    const aplica = (pedido, datos = {}) => A.aplicarImagenes({ imagenes: datos }, pedido).imagenes;
    check('defectos: hires_modelo_de vacío', Object.keys(A.defectos().comfyui.hires_modelo_de).length === 0);
    const ok = aplica({ comfyui: { hires_modelo_de: { 'sdxl-illustrious': ` ${US} ` } } });
    check('guarda el archivo (recortado)', ok.comfyui.hires_modelo_de['sdxl-illustrious'] === US);
    check('Flux: 400', /hires_modelo_de\.flux/.test(tira(() => aplica({ comfyui: { hires_modelo_de: { flux: US } } })).campo));
    check('un perfil que no existe: 400', /hires_modelo_de\.nope/.test(tira(() => aplica({ comfyui: { hires_modelo_de: { nope: US } } })).campo));
    check('una ruta absoluta o con ..: 400', tira(() => aplica({ comfyui: { hires_modelo_de: { sdxl: 'C:/x.pth' } } })) && tira(() => aplica({ comfyui: { hires_modelo_de: { sdxl: '../x.pth' } } })));
    // Sin otras claves, la sección queda vacía y no vuelve nada.
    const sinEntrada = aplica({ comfyui: { hires_modelo_de: { 'sdxl-illustrious': null } } }, ok) || {};
    check('null saca la entrada', !(sinEntrada.comfyui && sinEntrada.comfyui.hires_modelo_de && 'sdxl-illustrious' in sinEntrada.comfyui.hires_modelo_de));
    check('se conserva con la casilla apagada', aplica({ comfyui: { hires_de: { 'sdxl-illustrious': false } } }, ok).comfyui.hires_modelo_de['sdxl-illustrious'] === US);
    const n = A.normalizar(ok).imagenes;
    check('normalizar: llega al runtime', n.comfyui.hires_modelo_de['sdxl-illustrious'] === US && A.normalizar({ comfyui: { hires_modelo_de: { sdxl: '/abs.pth' } } }).invalidos.some((x) => /hires_modelo_de/.test(JSON.stringify(x))));
    // El método en un perfil propio.
    const propio = { ...copia(P.PERFILES.get('sdxl')), nombre: 'Mío' };
    delete propio.id;
    propio.muestreo.hires = { escala: 1.5, fuerza: 0.5, pasos: 15, metodo: 'bicubic' };
    const p1 = aplica({ perfiles_propios: { mio: propio } });
    const releido = A.normalizar(p1).imagenes;
    check('guardar y releer: el método queda', p1.perfiles_propios.mio.muestreo.hires.metodo === 'bicubic' && releido.perfiles_propios.mio.muestreo.hires.metodo === 'bicubic');
    const sinMetodo = copia(propio); delete sinMetodo.muestreo.hires.metodo; sinMetodo.muestreo.hires.pasos = 20;
    const p2 = aplica({ perfiles_propios: { mio: sinMetodo } }, p1);
    check('los tres números sin metodo: se conserva el método', p2.perfiles_propios.mio.muestreo.hires.pasos === 20 && p2.perfiles_propios.mio.muestreo.hires.metodo === 'bicubic');
    const conNull = copia(propio); conNull.muestreo.hires.metodo = null;
    check('metodo: null lo saca', !('metodo' in aplica({ perfiles_propios: { mio: conNull } }, p1).perfiles_propios.mio.muestreo.hires));
    // Un método guardado que no vale (editado a mano): un PATCH sin metodo no lo copia, y guarda.
    const crudo = copia(p1); crudo.perfiles_propios.mio.muestreo.hires.metodo = 'raro';
    const p4 = tira(() => aplica({ perfiles_propios: { mio: sinMetodo } }, crudo)) || aplica({ perfiles_propios: { mio: sinMetodo } }, crudo);
    check('un método guardado que no vale no se copia: guarda sin él', p4 && p4.perfiles_propios && !('metodo' in p4.perfiles_propios.mio.muestreo.hires), p4 && p4.message);
    const sinHiresPedido = copia(propio); delete sinHiresPedido.muestreo.hires; sinHiresPedido.nombre = 'Sin hires en el pedido';
    let p5 = null;
    try { p5 = aplica({ perfiles_propios: { mio: sinHiresPedido } }, crudo); } catch (e) { p5 = e; }
    check('…y tampoco con un pedido sin muestreo.hires (un Desktop viejo): conserva los números sin el método', p5 && p5.perfiles_propios && p5.perfiles_propios.mio.muestreo.hires.pasos === 15 && !('metodo' in p5.perfiles_propios.mio.muestreo.hires), p5 && p5.message);
    const nz = A.normalizar({ comfyui: { hires_de: { flux: true, sdxl: true, nope: true }, hires_modelo_de: { flux: US, nope: US, 'sdxl-pony': US } } });
    check('normalizar: hires_de y hires_modelo_de solo de perfiles sdxl que existan, con su aviso', JSON.stringify(nz.imagenes.comfyui.hires_de) === '{"sdxl":true}' && JSON.stringify(nz.imagenes.comfyui.hires_modelo_de) === `{"sdxl-pony":"${US}"}` && nz.invalidos.length === 4);
    check('un método que no es: 400', /metodo/.test(tira(() => aplica({ perfiles_propios: { mio: { ...propio, muestreo: { ...propio.muestreo, hires: { ...propio.muestreo.hires, metodo: 'lanczos' } } } } })).campo));
    const v = ajustesV2({ imagenes: A.leerImagenes({ imagenes: { ...p1, comfyui: { hires_modelo_de: { 'sdxl-illustrious': US } } } }).imagenes }).imagenes;
    check('comfyuiV2: hires_modelo_de (la señal de 2.26.1)', v.comfyui.hires_modelo_de['sdxl-illustrious'] === US && esObjeto(ajustesV2({ imagenes: A.leerImagenes({ imagenes: {} }).imagenes }).imagenes.comfyui.hires_modelo_de));
    check('perfilImagenV2: el método', v.perfiles_propios.mio.muestreo.hires.metodo === 'bicubic');
  });

  // -------------------------------------------------------------- cola
  const clave = 'alya';
  const adjuntos = path.join(raiz, 'datos', 'adjuntos');
  fs.mkdirSync(adjuntos, { recursive: true });
  const foto = path.join(adjuntos, 'foto.png');
  fs.writeFileSync(foto, PNG);
  const registro = { tarea: (id) => tareas.obtener(id), actualizar: (id, c) => tareas.actualizar(id, c) };
  const nuevaTarea = () => { const t = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave }, pedido: 'hola' }); tareas.actualizar(t.id, { estado: 'ok' }); return t.id; };
  const entrada = (id, n = 1) => (tareas.obtener(id).imagenes || []).find((e) => e.n === n);
  const prov = (id, fn = () => ({ ok: true })) => ({ id, vistos: [], async generar(op) { this.vistos.push(op); const r = await fn(op); if (!r.ok) return { proveedor: id, ...r }; const ruta = `${op.destino}.png`; fs.writeFileSync(ruta, PNG); return { ok: true, ruta, tipo: 'image/png', ancho: op.ancho, alto: op.alto, semilla: 5, proveedor: id, modelo: op.modelo || null }; } });
  /** Un refinador que pide `caso` (con su zona si es retoque) y elige `modelo`. */
  const pide = (caso, modelo = null, extra = {}) => ({ async refinar(o) { return { ...R.sanear({ caso, prompt: 'red hat', zona: caso === 'retoque' ? 'the hat' : '', ...(modelo ? { modelo } : {}), ...extra }, { disponibles: o.disponibles, candidatos: o.candidatos, desdeFoto: o.desdeFoto }), refinado: true }; }, sinRefinar: R.sinRefinar });
  const armar = ({ provs, cfg, ref, cat = null, logs = [] }) => crearColaImagenes({ registro, proveedor: (id) => provs[id] || null, leerConfig: cfg, refinador: ref, vision: { llamar: async () => ({ ok: false }) }, manual: () => false, catalogoDe: async () => cat, catalogoEnCache: () => null, log: (m) => logs.push(m), env: process.env, dirAdjuntos: () => adjuntos });
  const termina = (id, n = 1) => hasta(() => entrada(id, n) && entrada(id, n).estado !== 'generando');
  const CANDIDATOS = [{ archivo: WAI, para: 'anime' }, { archivo: PONY, para: 'pony' }, { archivo: BASE, para: 'fotos' }];
  const conCandidatos = (extra = {}, comfy = {}) => config({ orden: ['comfyui'], alma_la_ve: false, ...extra }, { candidatos: CANDIDATOS, ...comfy });

  await group('La cola: una LoRA con modelos llega a generar', async () => {
    const loras = [{ archivo: 'base.safetensors', clave: 'base', familias: ['sdxl'], fuerza: 0.8, activo: true, modelos: [BASE] }, { archivo: 'pony.safetensors', clave: 'pony', familias: ['sdxl'], fuerza: 0.8, activo: true, modelos: [PONY] }];
    const c = prov('comfyui');
    const id = nuevaTarea();
    armar({ provs: { comfyui: c }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false }, { loras }), ref: pide('nueva', null, { loras: ['base', 'pony'] }) }).encolar({ tareaId: id, clave, pedido: 'x' });
    await termina(id);
    check('con el fijo (SDXL base): va la de base y no la de Pony', c.vistos[0] && c.vistos[0].modelo === BASE && c.vistos[0].loras.map((l) => l.clave).join() === 'base', JSON.stringify(c.vistos[0] && c.vistos[0].loras));
  });

  await group('La cola: las repeticiones de un retoque', async () => {
    // Un retoque elegido con Pony; después Pony ya no está instalado: «otra versión» va con el fijo y sigue siendo retoque.
    const c = prov('comfyui');
    const id = nuevaTarea();
    armar({ provs: { comfyui: c }, cfg: () => conCandidatos(), ref: pide('retoque', 'ponydiffusionv6xl') }).encolar({ tareaId: id, clave, pedido: 'x', desdeFoto: true, foto: { ruta: foto, segura: true } });
    await termina(id);
    check('el retoque salió con Pony', entrada(id).estado === 'lista' && entrada(id).caso === 'retoque' && c.vistos[0].modelo === PONY && entrada(id).modeloAuto === true, JSON.stringify(entrada(id)));
    const c2 = prov('comfyui');
    const logs = [];
    const o = armar({ provs: { comfyui: c2 }, cfg: () => conCandidatos(), ref: pide('retoque'), cat: catalogo([WAI, BASE]), logs }).otra(id, 1);
    check('otra versión se encola', o.ok, JSON.stringify(o));
    await termina(id, o.n);
    check('otra versión de un retoque cuyo modelo ya no está: el fijo, sigue en retoque, sin modeloAuto', c2.vistos[0] && c2.vistos[0].modelo === BASE && c2.vistos[0].caso === 'retoque' && entrada(id, o.n).modeloAuto === false, JSON.stringify(c2.vistos[0] && { m: c2.vistos[0].modelo, c: c2.vistos[0].caso }));
    // Un retoque con `fill`: el modelo es el de retoque, nunca el de una repetición.
    const fill = config({ orden: ['comfyui'], alma_la_ve: false }, { retoque: 'fill', modelo_retoque: 'flux1-fill-dev.safetensors', perfil_de: { 'flux1-fill-dev.safetensors': 'flux-fill' } });
    const c3 = prov('comfyui');
    const id3 = nuevaTarea();
    const cola3 = armar({ provs: { comfyui: c3 }, cfg: () => fill, ref: pide('retoque') });
    cola3.encolar({ tareaId: id3, clave, pedido: 'x', desdeFoto: true, foto: { ruta: foto, segura: true } });
    await termina(id3);
    const o3 = cola3.otra(id3, 1);
    await termina(id3, o3.n);
    check('la repetición de un retoque fill: con el modelo de retoque y sin modeloAuto', entrada(id3).caso === 'retoque' && c3.vistos.length === 2 && c3.vistos.every((v) => v.modelo === 'flux1-fill-dev.safetensors') && entrada(id3, o3.n).modeloAuto === false && entrada(id3, o3.n).modelo === 'flux1-fill-dev.safetensors', JSON.stringify(c3.vistos.map((v) => v.modelo)));
  });

  await group('La cola: reintentar una con modeloAuto que termina con el fijo', async () => {
    let falla = true;
    const c = prov('comfyui', () => (falla ? { ok: false, codigo: 'error' } : { ok: true }));
    const id = nuevaTarea();
    let cat = null;
    const cola = crearColaImagenes({ registro, proveedor: (x) => (x === 'comfyui' ? c : null), leerConfig: () => conCandidatos(), refinador: pide('nueva', 'ponydiffusionv6xl'), vision: { llamar: async () => ({ ok: false }) }, manual: () => false, catalogoDe: async () => cat, catalogoEnCache: () => null, log: () => {}, env: process.env, dirAdjuntos: () => adjuntos });
    cola.encolar({ tareaId: id, clave, pedido: 'x' });
    await termina(id);
    check('falló con Pony elegido', entrada(id).estado === 'error' && c.vistos[0].modelo === PONY, JSON.stringify(entrada(id)));
    falla = false;
    cat = catalogo([WAI, BASE]);
    const r = cola.reintentar(id, 1);
    check('reintentar se encola', r.ok, JSON.stringify(r));
    await hasta(() => entrada(id).estado === 'lista');
    check('reintentar sin Pony instalado: el fijo y modeloAuto false', c.vistos[1] && c.vistos[1].modelo === BASE && entrada(id).modeloAuto === false && indice.leer(clave, id, 1).modeloAuto === false, JSON.stringify(c.vistos[1] && c.vistos[1].modelo));
  });

  for (const d of [raiz]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  report();
}

function esObjeto(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

main().catch((err) => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {} console.error(err); process.exit(1); });
