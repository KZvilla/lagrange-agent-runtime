/**
 * FEAT-214 S0 — El taller: armar el flujo una sola vez, abrir (desde una imagen, una plantilla o un preparado), mirar el
 * historial de ComfyUI (por la carpeta de la sesión o por la ventana), quedarse con una imagen (y reabrirla), las plantillas
 * propias, «Que lo prepare el alma», los ajustes, las rutas v2 y el contrato.
 *
 * Sin red y sin ComfyUI: un ComfyUI falso con su historial, su cola y sus archivos.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat214-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.LAGRANGE_COMFYUI_DIR = path.join(raiz, 'comfyui');
process.env.LAGRANGE_TALLER_DIR = path.join(raiz, 'taller');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
for (const d of ['datos/adjuntos', 'almas/alya', 'almas/bananero']) fs.mkdirSync(path.join(raiz, d), { recursive: true });

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indice = require('../mcp-server/imagenes/indice.js');
const A = require('../mcp-server/lib/ajustes-imagenes.js');
const F = require('../mcp-server/imagenes/flujos.js');
const P = require('../mcp-server/imagenes/perfiles.js');
const catalogo = require('../mcp-server/imagenes/catalogo.js');
const versiones = require('../mcp-server/almas/versiones.js');
const sondaVision = require('../mcp-server/imagenes/sonda-vision.js');

const MODELO = 'sd_xl_base_1.0.safetensors';
let tono = 0;
const png = () => sondaVision.pngSolido(8, [tono++ % 250, 40, 90]);
const adjuntos = path.join(raiz, 'datos', 'adjuntos');
const config = (taller = {}, comfy = {}) => { const d = A.defectos(); return { ...d, taller: { ...d.taller, ...taller }, comfyui: { ...d.comfyui, ...comfy } }; };

// El catálogo con todos los nodos de las plantillas SDXL y el modelo.
const clases = new Set();
// FEAT-218 — Y las de hires (LatentUpscaleBy, y en S1.1 UpscaleModelLoader, ImageUpscaleWithModel, ImageScale, VAEEncode).
for (const f of ['nueva', 'variacion', 'retoque-florence2', 'edicion', 'retoque-a-mano', 'nueva-hires', 'nueva-hires-modelo']) {
  const ruta = path.join(F.DIR_PLANTILLAS, 'sdxl', `${f}.json`);
  if (fs.existsSync(ruta)) for (const n of Object.values(JSON.parse(fs.readFileSync(ruta, 'utf8')))) clases.add(n.class_type);
}
const info = Object.fromEntries([...clases, 'PreviewImage'].map((c) => [c, { input: { required: {} } }]));
info.CheckpointLoaderSimple.input.required.ckpt_name = [[MODELO]];
// FEAT-218 — Una LoRA instalada, para las plantillas del plugin con LoRAs por modelo.
if (info.LoraLoader) info.LoraLoader.input.required.lora_name = [['acuarela.safetensors']];
// FEAT-218 S1.1 — Un modelo de reescalado instalado (en la forma V3 del combo).
if (info.UpscaleModelLoader) info.UpscaleModelLoader.input.required.model_name = ['COMBO', { options: ['4x-UltraSharp.safetensors'] }];
const CATALOGO = catalogo.leerObjectInfo(info);

/** Un ComfyUI falso: guarda lo subido, sirve el historial, la cola y los archivos por `/view`. */
function comfyFalso() {
  const c = { subidos: new Map(), historia: {}, cola: { queue_running: [], queue_pending: [] }, archivos: new Map(), pedidos: [], caido: false, n: 0 };
  c.fetch = async (url, op = {}) => {
    const u = new URL(url);
    c.pedidos.push(`${op.method || 'GET'} ${u.pathname}${u.search}`);
    if (c.caido) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (u.pathname === '/upload/image') {
      const f = op.body.get('image');
      const nombre = `subida-${c.n++}.png`;
      c.subidos.set(nombre, Buffer.from(await f.arrayBuffer()));
      c.archivos.set(`input//${nombre}`, c.subidos.get(nombre));
      return json({ name: nombre, subfolder: '', type: 'input' });
    }
    if (u.pathname === '/history') return json(c.historia);
    if (u.pathname === '/queue') return json(c.cola);
    if (u.pathname === '/view') {
      const k = `${u.searchParams.get('type')}/${u.searchParams.get('subfolder') || ''}/${u.searchParams.get('filename')}`;
      const b = c.archivos.get(k);
      return b ? { ok: true, status: 200, body: null, arrayBuffer: async () => b } : { ok: false, status: 404 };
    }
    return { ok: false, status: 404 };
  };
  /** Una entrada terminada del historial, con sus salidas puestas en `/view`. */
  c.correr = (pid, grafo, { clientId = 'web-1', salidas = [], error = false } = {}) => {
    const outputs = {};
    for (const s of salidas) {
      const b = s.bytes || png();
      c.archivos.set(`${s.type || 'output'}/${s.subfolder || ''}/${s.filename}`, b);
      (outputs[s.nodo || '9'] ||= { images: [] }).images.push({ filename: s.filename, subfolder: s.subfolder || '', type: s.type || 'output' });
    }
    c.historia[pid] = { prompt: [c.n++, pid, grafo, { client_id: clientId }, ['9']], outputs, status: error ? { status_str: 'error', completed: false, messages: [['execution_error', { node_id: '3', node_type: 'KSampler', exception_message: 'C:\\secreto\\ruta falló' }]] } : { status_str: 'success', completed: true, messages: [] } };
  };
  return c;
}

const procesoFalso = (estado = 'ok') => ({ e: estado, usos: 0, levantados: 0, comprobar: async function () { return this.e; }, levantar: function () { this.levantados++; return this.promesa === undefined ? null : this.promesa; }, estado: async () => ({ mensaje: 'Elegí la carpeta de ComfyUI.' }), anotarUso: function () { this.usos++; } });

async function main() {
  const { crearTaller, nombreRemoto, TITULO_MASCARA } = await importar('telegram-bridge/imagenes/taller.js');
  const { crearComfyui, armarPedido } = await importar('telegram-bridge/imagenes/comfyui.js');
  const { crearColaImagenes, camposDeImagen } = await importar('telegram-bridge/imagenes-cola.js');
  const { crearGaleria } = await importar('telegram-bridge/imagenes/galeria.js');
  const tareas = await importar('telegram-bridge/tareas.js');
  const esquema = await importar('telegram-bridge/web/v2/esquema.js');
  const contrato = esquema.cargarContrato();

  const registro = { tarea: (id) => tareas.obtener(id), actualizar: (id, c) => tareas.actualizar(id, c) };
  let nImg = 0;
  /** Una imagen lista en el índice, como la deja la cola. */
  const poner = (extra = {}, clave = 'alya') => {
    const id = `t_img${String(nImg++).padStart(4, '0')}`;
    const archivo = path.join(indice.dirImagenes(clave), `${id}-1-1.png`);
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    const bytes = png();
    fs.writeFileSync(archivo, bytes);
    indice.actualizar(clave, id, 1, () => ({ archivo, tipo: 'image/png', lista: true, intento: 1, externo: false, sha256: indice.sha256(bytes), prompt: 'a lighthouse', negativo: 'blurry', caso: 'nueva', perfil: 'sdxl', proveedor: 'comfyui', modelo: MODELO, proporcion: '1:1', semilla: 77, num: nImg, creada: new Date(Date.UTC(2026, 0, 1) + nImg * 1000).toISOString(), ...extra }));
    return { id, archivo, bytes, ref: { alma: clave, tareaId: id, n: 1, intento: 1 } };
  };
  const foto = path.join(adjuntos, 'base.png');
  fs.writeFileSync(foto, png());

  let cfg = config();
  const armar = (extra = {}) => {
    const comfy = extra.comfy || comfyFalso();
    const proceso = extra.proceso || procesoFalso();
    const eventos = [];
    const podadas = [];
    let invalidadas = 0;
    const t = crearTaller({
      leerConfig: () => cfg, proceso, dirAdjuntos: () => adjuntos, fetchImpl: comfy.fetch, catalogoDe: () => (extra.sinCatalogo ? null : CATALOGO),
      ...(extra.pedirCatalogo ? { pedirCatalogo: extra.pedirCatalogo } : {}),
      cola: { podar: (c, a) => podadas.push([c, a]), invalidarMapas: () => { invalidadas++; } }, publicar: (tema, tipo, datos) => eventos.push({ tema, tipo, datos }),
      tiempos: { vuelta: 1e9, levantar: 50, ...(extra.tiempos || {}) }, ...(extra.dir ? { dir: extra.dir } : {})
    });
    return { t, comfy, proceso, eventos, podadas, invalidadas: () => invalidadas };
  };
  const ventana = 'v-aaaaaaaaaaaaaaaa';
  const otraVentana = 'v-bbbbbbbbbbbbbbbb';

  // ------------------------------------------------------------- flujos
  await group('formaDeGrafo y la plantilla del taller', () => {
    const r = F.resolverPlantillaTaller(P.perfil({}, 'sdxl'), 'retoque-a-mano');
    check('«Retoque a mano» se carga sin pasar por plantillaDe', r.ok && r.nombre === 'sdxl/retoque-a-mano' && r.marcadores.includes('foto'));
    check('con un perfil de otra familia, «solo con un perfil SDXL»', F.resolverPlantillaTaller(P.perfil({}, 'flux'), 'retoque-a-mano').motivo === 'solo con un perfil SDXL');
    check('otro nombre no es del taller', !F.resolverPlantillaTaller(P.perfil({}, 'sdxl'), '../nueva').ok);
    check('el envoltorio de graphToPrompt se rechaza', /mandá output/.test(F.formaDeGrafo({ workflow: {}, output: r.flujo }).motivo));
    check('un nodo sin inputs se rechaza', !F.formaDeGrafo({ 1: { class_type: 'KSampler' }, 2: { class_type: 'SaveImage', inputs: {} } }).ok);
    check('un nodo sin class_type se rechaza', !F.formaDeGrafo({ 1: { class_type: 'SaveImage', inputs: {} }, 2: { inputs: {} } }).ok);
    check('sin SaveImage ni PreviewImage se rechaza', /SaveImage/.test(F.formaDeGrafo({ 1: { class_type: 'KSampler', inputs: {} } }).motivo));
    const grande = { 1: { class_type: 'SaveImage', inputs: { x: 'a'.repeat(2.2 * 1024 * 1024) } } };
    check('más de 2 MB se rechaza', /2 MB/.test(F.formaDeGrafo(grande).motivo));
    check('un grafo real sin marcadores vale', F.formaDeGrafo({ 3: { class_type: 'KSampler', inputs: { seed: 5 } }, 9: { class_type: 'PreviewImage', inputs: {} } }).ok);
    check('leerFlujo usa la misma forma', F.leerFlujo(path.join(F.DIR_PLANTILLAS, 'sdxl', 'nueva.json')).ok);
    const sinInputs = path.join(raiz, 'sin-inputs.json');
    fs.writeFileSync(sinInputs, JSON.stringify({ 1: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, 2: { class_type: 'KSampler' }, 9: { class_type: 'SaveImage', inputs: {} } }));
    check('leerFlujo también rechaza un nodo sin inputs', /inputs/.test(F.leerFlujo(sinInputs).motivo || ''));
  });

  await group('El flujo se arma una sola vez: el /prompt de generar no cambia', async () => {
    const perfil = P.perfil({}, 'sdxl');
    for (const caso of ['nueva', 'variacion', 'retoque']) {
      const comfy = comfyFalso();
      let cuerpo = null;
      const fetch = async (url, op = {}) => {
        const u = new URL(url);
        if (u.pathname === '/prompt') { cuerpo = JSON.parse(op.body); return { ok: true, json: async () => ({ prompt_id: 'p1' }) }; }
        if (u.pathname.startsWith('/history')) { comfy.correr('p1', {}, { salidas: [{ filename: 'x.png', nodo: cuerpo && Object.keys(cuerpo.prompt).find((k) => cuerpo.prompt[k].class_type === 'SaveImage') }] }); return { ok: true, json: async () => comfy.historia }; }
        if (u.pathname === '/queue') return { ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) };
        return comfy.fetch(url, op);
      };
      const c = config({}, { mascara: 'florence2' });
      const g = crearComfyui({ config: c, fetchImpl: fetch, catalogoDe: () => CATALOGO, esperar: async () => {}, idCliente: () => 'fijo' });
      const destino = path.join(raiz, `gen-${caso}`);
      await g.generar({ caso, modelo: MODELO, perfil, prompt: 'a red cup', negativo: 'blurry', ancho: 1024, alto: 1024, semilla: 42, foto: caso === 'nueva' ? null : foto, zona: 'the cup', destino });
      const a = armarPedido({ seccion: c, caso, modelo: MODELO, perfil, catalogo: CATALOGO, pedido: { prompt: 'a red cup', negativo: 'blurry', ancho: 1024, alto: 1024, semilla: 42, zona: 'the cup' } });
      const esperado = F.aplicarMarcadores(a.armado, { ...a.datos, ...(caso === 'nueva' ? {} : { foto: 'subida-0.png' }) });
      check(`${caso}: el mismo flujo, con el client_id inyectado`, cuerpo && cuerpo.client_id === 'fijo' && JSON.stringify(cuerpo.prompt) === JSON.stringify(esperado));
    }
  });

  // ------------------------------------------------------------- abrir
  await group('Abrir desde una imagen', async () => {
    cfg = config();
    const { t, comfy } = armar();
    const a = poner({ caso: 'variacion', fotoRuta: foto, externo: false });
    const r = await t.abrir({ alma: 'alya', ventana, desde: a.ref, idCliente: 'pedido-0001' });
    check('abre con url, nombre y grafo', r.ok && /^s-[a-z0-9]{16}$/.test(r.sesion) && r.url === 'http://127.0.0.1:8188' && /variación de alya #/.test(r.nombre));
    const salva = Object.values(r.grafo).filter((n) => n.class_type === 'SaveImage');
    check('cada SaveImage a la carpeta de la sesión', salva.length > 0 && salva.every((n) => n.inputs.filename_prefix === `lagrange-taller/${r.sesion}/img`));
    check('la base se subió y el grafo la usa', comfy.subidos.size === 1 && Object.values(r.grafo).some((n) => n.class_type === 'LoadImage' && n.inputs.image === 'subida-0.png'));
    check('con su prompt y su semilla', JSON.stringify(r.grafo).includes('a lighthouse') && Object.values(r.grafo).some((n) => n.class_type === 'KSampler' && n.inputs.seed === 77));
    const [c1, c2] = await Promise.all([t.abrir({ alma: 'alya', ventana, desde: a.ref, idCliente: 'pedido-0002' }), t.abrir({ alma: 'alya', ventana, desde: a.ref, idCliente: 'pedido-0002' })]);
    check('dos reintentos a la vez: una sola sesión', c1.ok && c1.sesion === c2.sesion);
    const med = poner({ ancho: 896, alto: 1152, proporcion: '3:4' });
    const rm = await t.abrir({ alma: 'alya', ventana, desde: med.ref });
    check('rearma con las medidas del índice', Object.values(rm.grafo).some((n) => n.class_type === 'EmptyLatentImage' && n.inputs.width === 896 && n.inputs.height === 1152));
    const subidasAntes = comfy.subidos.size;
    check('reintentar el mismo pedido da la misma sesión', (await t.abrir({ alma: 'alya', ventana, desde: a.ref, idCliente: 'pedido-0001' })).sesion === r.sesion && comfy.subidos.size === subidasAntes);
    check('un intento viejo: 409 cambio', (await t.abrir({ alma: 'alya', ventana, desde: { ...a.ref, intento: 2 } })).motivo === 'cambio');
    const b = poner({ caso: 'variacion', fotoRuta: path.join(adjuntos, 'no-esta.png') });
    check('la base borrada: 409 base-perdida', (await t.abrir({ alma: 'alya', ventana, desde: b.ref })).motivo === 'base-perdida');
    const afuera = path.join(raiz, 'afuera.png'); fs.writeFileSync(afuera, png());
    check('la base fuera de sus carpetas: 409 base-perdida', (await t.abrir({ alma: 'alya', ventana, desde: poner({ caso: 'variacion', fotoRuta: afuera }).ref })).motivo === 'base-perdida');
    const pesada = path.join(adjuntos, 'pesada.png');
    fs.writeFileSync(pesada, Buffer.alloc(21 * 1024 * 1024));
    check('una base de más de 20 MB también desde una imagen: 413', (await t.abrir({ alma: 'alya', ventana, desde: poner({ caso: 'variacion', fotoRuta: pesada }).ref })).status === 413);
    fs.rmSync(pesada, { force: true });
    check('una de agy: 409 sin-flujo', (await t.abrir({ alma: 'alya', ventana, desde: poner({ proveedor: 'antigravity', perfil: null }).ref })).motivo === 'sin-flujo');
    check('un perfil que ya no está: 409 sin-flujo', (await t.abrir({ alma: 'alya', ventana, desde: poner({ perfil: 'no-existe' }).ref })).motivo === 'sin-flujo');
    check('ids que no valen: 400', (await t.abrir({ alma: 'alya', ventana: 'v-../x', desde: a.ref })).status === 400 && (await t.abrir({ alma: '../x', ventana, desde: a.ref })).status === 400
      && (await t.abrir({ alma: 'alya', ventana, desde: { ...a.ref, tareaId: '..' } })).status === 400 && (await t.abrir({ alma: 'alya', ventana })).status === 400);
    check('un alma que no existe: 400', (await t.abrir({ alma: 'nadie', ventana, desde: a.ref })).status === 400);
    cfg = config({ activo: false });
    check('con el taller apagado: 409', (await t.abrir({ alma: 'alya', ventana, desde: a.ref })).motivo === 'apagado');
    cfg = config({}, { url: 'http://192.168.1.5:8188' });
    check('ComfyUI que no es de esta máquina: 409', (await t.abrir({ alma: 'alya', ventana, desde: a.ref })).motivo === 'no-loopback');
    cfg = config();
    t.parar();
  });

  await group('Abrir con ComfyUI caído', async () => {
    const p1 = procesoFalso('no-responde');
    const { t } = armar({ proceso: p1 });
    const a = poner();
    check('sin carpeta (o sin automático): 503 sin-comfy', (await t.abrir({ alma: 'alya', ventana, desde: a.ref })).motivo === 'sin-comfy');
    cfg = config({}, { arranque: { ...A.defectos().comfyui.arranque, carpeta: 'C:\\ComfyUI', automatico: true } });
    check('levantar no puede (null): 503 con el mensaje del estado', (await t.abrir({ alma: 'alya', ventana, desde: a.ref })).mensaje === 'Elegí la carpeta de ComfyUI.');
    p1.promesa = new Promise(() => {});
    const r = await t.abrir({ alma: 'alya', ventana, desde: a.ref });
    check('levanta y no termina en el tope: 503 levantando', r.motivo === 'levantando' && p1.levantados === 2);
    p1.promesa = Promise.resolve({ ok: true });
    const p2 = { ...p1, comprobar: async () => (p2.vueltas++ ? 'ok' : 'no-responde'), vueltas: 0 };
    const { t: t2 } = armar({ proceso: p2 });
    check('levanta y responde: abre', (await t2.abrir({ alma: 'alya', ventana, desde: a.ref })).ok);
    const levantadosAntes = p1.levantados;
    check('una referencia inválida da 400 sin levantar ComfyUI', (await t.abrir({ alma: 'alya', ventana, desde: { ...a.ref, tareaId: '..' } })).status === 400 && (await t.abrir({ alma: 'alya', ventana, preparado: 'p-..' })).status === 400 && (await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:x', base: a.ref })).status === 400 && p1.levantados === levantadosAntes);
    cfg = config();
    t.parar(); t2.parar();
  });

  await group('Abrir una plantilla', async () => {
    const { t } = armar();
    const { t: sinCat } = armar({ sinCatalogo: true });
    const lista = t.plantillas();
    check('las del perfil, «Retoque a mano» y su disponible', lista.ok && ['plugin:nueva', 'plugin:variacion', 'plugin:retoque', 'plugin:edicion', 'plugin:retoque-a-mano'].every((id) => lista.plantillas.some((p) => p.id === id))
      && lista.plantillas.find((p) => p.id === 'plugin:nueva').disponible && lista.plantillas.find((p) => p.id === 'plugin:retoque-a-mano').disponible);
    check('edición sin modelo: apagada con su motivo', lista.plantillas.find((p) => p.id === 'plugin:edicion').disponible === false && Boolean(lista.plantillas.find((p) => p.id === 'plugin:edicion').motivo));
    cfg = config({}, { mascara: 'no', retoque: 'no' });
    const conRetoqueApagado = t.plantillas().plantillas;
    check('con el retoque apagado en Ajustes, «Retoque a mano» sigue', conRetoqueApagado.find((x) => x.id === 'plugin:retoque').disponible === false && conRetoqueApagado.find((x) => x.id === 'plugin:retoque-a-mano').disponible === true);
    cfg = config();
    check('sin catálogo, todas apagadas: «ComfyUI no respondió»', sinCat.plantillas().plantillas.every((p) => !p.disponible && /no respondió/.test(p.motivo)));
    const n = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('nueva: sin base, el prompt vacío', n.ok && Object.values(n.grafo).some((x) => x.class_type === 'CLIPTextEncode' && x.inputs.text === ''));
    check('variación sin base: 400', (await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:variacion' })).status === 400);
    const b = poner({ externo: true });
    const v = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:retoque-a-mano', base: b.ref });
    check('retoque a mano con su base', v.ok && Object.values(v.grafo).some((x) => x.class_type === 'LoadImage' && /^subida-/.test(x.inputs.image)));
    check('y con la fuerza de un retoque', Object.values(v.grafo).some((x) => x.class_type === 'KSampler' && x.inputs.denoise === P.perfil({}, 'sdxl').muestreo.fuerzaRetoque));
    const alta = poner({ ancho: 896, alto: 1152, proporcion: '3:4' });
    const va = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:variacion', base: alta.ref });
    const ra = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:retoque-a-mano', base: alta.ref });
    check('con una base 3:4, las medidas de su proporción', Object.values(va.grafo).some((n) => n.inputs.width === 896 && n.inputs.height === 1152) && Object.values(ra.grafo).some((n) => n.inputs.output_target_width === 896 && n.inputs.output_target_height === 1152));
    const sinProp = poner({ ancho: 1400, alto: 800, proporcion: null });
    const vs = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:variacion', base: sinProp.ref });
    check('sin proporción, la más cercana a sus medidas', Object.values(vs.grafo).some((n) => n.inputs.width === 1344 && n.inputs.height === 768));
    const enorme = poner();
    fs.writeFileSync(enorme.archivo, Buffer.alloc(21 * 1024 * 1024));
    check('una base de más de 20 MB: 413', (await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:variacion', base: enorme.ref })).status === 413);
    check('una plantilla que no es: 400', (await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:../x' })).status === 400 && (await t.abrir({ alma: 'alya', ventana, plantilla: 'propia:../../x' })).status === 400);
    check('sin catálogo no abre', (await sinCat.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' })).motivo === 'no-disponible');
    t.parar(); sinCat.parar();
  });

  // ------------------------------------------------------------- mirar
  await group('Lo que vuelve: el historial', async () => {
    const { t, comfy, eventos } = armar();
    comfy.correr('viejo', { 9: { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } } }, { salidas: [{ filename: 'viejo.png' }] });
    const a = poner({ externo: false, caso: 'variacion', fotoRuta: foto });
    const r = await t.abrir({ alma: 'alya', ventana, desde: a.ref });
    const s = r.sesion;
    // Una de la sesión por su carpeta, con la máscara que pintó el usuario en el nodo de la base.
    const conMascara = JSON.parse(JSON.stringify(r.grafo));
    const nodoBase = Object.keys(conMascara).find((k) => conMascara[k].class_type === 'LoadImage');
    conMascara[nodoBase].inputs.image = 'clipspace/clipspace-mask-1.png [input]';
    comfy.archivos.set('input/clipspace/clipspace-mask-1.png', png());
    comfy.correr('p-prefijo', conMascara, { salidas: [{ filename: 'img_00001_.png', subfolder: `lagrange-taller/${s}` }, { filename: 'img_00002_.png', subfolder: `lagrange-taller/${s}`, nodo: '20' }] });
    // Una que solo coincide por la ventana (una vista previa), con un LoadImage que la sesión no subió.
    t.sigue(s, { clientId: 'cli-ventana-1' });
    comfy.correr('p-vista', { 1: { class_type: 'LoadImage', inputs: { image: 'otra.png' } }, 2: { class_type: 'PreviewImage', inputs: {} } }, { clientId: 'cli-ventana-1', salidas: [{ filename: 'ComfyUI_temp_1.png', type: 'temp', nodo: '2' }] });
    comfy.correr('p-ajena', { 9: { class_type: 'SaveImage', inputs: { filename_prefix: 'yo' } } }, { clientId: 'otro', salidas: [{ filename: 'ajena.png' }] });
    comfy.correr('p-error', { 9: { class_type: 'SaveImage', inputs: { filename_prefix: `lagrange-taller/${s}/img` } } }, { error: true });
    await t._vuelta();
    const e = t.estado(s);
    const listas = e.imagenes.filter((i) => i.estado === 'lista');
    check('las dos de la sesión (dos salidas del mismo prompt), sin la vieja ni la ajena', listas.length === 2 && new Set(listas.map((i) => i.id)).size === 2);
    check('la máscara pintada en el nodo de la base no la vuelve externa', listas.every((i) => i.externo === false));
    check('la entrada con error, sin el mensaje crudo', e.imagenes.some((i) => i.estado === 'error' && i.error.clase === 'KSampler' && !/secreto/.test(JSON.stringify(i.error))));
    const v = t.estado(`v-${ventana.slice(2)}`);
    check('la vista previa va a lo de la ventana, externa por el LoadImage ajeno', v.ok && v.imagenes.length === 1 && v.imagenes[0].externo === true);
    check('los eventos taller.imagen', eventos.filter((x) => x.tipo === 'taller.imagen' && x.tema === 'salud').length === 4 && eventos.every((x) => esquema.validar(contrato, `evento:${x.tipo}`, x.datos).length === 0));
    check('la máscara se bajó en la misma vuelta', comfy.pedidos.some((x) => /\/view\?filename=clipspace-mask-1\.png&subfolder=clipspace&type=input/.test(x)));
    check('los bytes de una', t.bytes(s, listas[0].id).ok && t.bytes(s, 'img-..').status === 400 && t.bytes(s, 'img-zzzzzzzzzzzzzzzz').status === 404);
    check('un id de sesión con ..: 400', t.estado('s-../..').status === 400 && t.estado('%2e%2e').status === 400);
    await t._vuelta();
    check('otra vuelta no las repite', t.estado(s).imagenes.length === 3);
    // Un nombre remoto con .. no se baja.
    comfy.correr('p-escape', { 9: { class_type: 'SaveImage', inputs: { filename_prefix: `lagrange-taller/${s}/img` } } }, { salidas: [{ filename: '../../x.png', subfolder: `lagrange-taller/${s}` }] });
    await t._vuelta();
    check('un filename con .. se saltea', t.estado(s).imagenes.length === 3 && nombreRemoto('../../x.png') === null && nombreRemoto('a/b.png').subfolder === 'a');
    check('ni una unidad detrás de una barra', ['sub/C:x.png', 'C:/x.png', 'sub/C:/x.png', '/x.png', 'a/./b.png'].every((x) => nombreRemoto(x) === null) && nombreRemoto('x.png', 'C:') === null);
    // La cola de ComfyUI: lo que se está haciendo.
    comfy.cola.queue_running = [[1, 'p-corre', { 9: { class_type: 'SaveImage', inputs: { filename_prefix: `lagrange-taller/${s}/img` } } }, { client_id: 'x' }, []]];
    await t._vuelta();
    check('enCurso por la cola', t.estado(s).enCurso.includes('p-corre'));
    comfy.cola.queue_running = [];
    // ComfyUI que se cae y vuelve.
    comfy.caido = true;
    await t._vuelta();
    check('caído: sinComfy, sin romper', t.estado(s).sinComfy === true);
    t.parar();
  });

  await group('2.23.1: los nodos de las plantillas con nombre, y la máscara de control no va a la tira', async () => {
    const { t, comfy } = armar();
    const n = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    const titulo = (g, f) => Object.values(g).filter(f).map((x) => x._meta && x._meta.title);
    check('nueva: Prompt y Negativo, sin aviso de zona', titulo(n.grafo, (x) => x.class_type === 'CLIPTextEncode').sort().join('|') === 'Negativo|Prompt' && !n.aviso);
    const b = poner({ externo: false });
    const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:retoque', base: b.ref });
    check('retoque: abre', r.ok);
    const mascara = Object.keys(r.grafo).find((k) => r.grafo[k].class_type === 'PreviewImage');
    check('la vista previa de la máscara se llama así', r.grafo[mascara]._meta.title === TITULO_MASCARA);
    check('el nodo de la zona, «Zona a retocar»', Object.values(r.grafo).some((x) => x._meta && /^Zona a retocar/.test(x._meta.title) && Object.values(x.inputs).includes('')));
    check('la base, «Imagen de base»', titulo(r.grafo, (x) => x.class_type === 'LoadImage').join() === 'Imagen de base');
    check('sin zona, la barra lo avisa', /Zona a retocar/.test(r.aviso || ''));
    check('ningún marcador quedó en un título', !JSON.stringify(r.grafo).includes('{{'));
    const s = r.sesion;
    comfy.correr('p-retoque', r.grafo, { salidas: [{ filename: 'img_00001_.png', subfolder: `lagrange-taller/${s}` }, { filename: 'ComfyUI_temp_m.png', type: 'temp', nodo: mascara }] });
    // Una vista previa del usuario (otro título) sí vuelve.
    const propio = { ...JSON.parse(JSON.stringify(r.grafo)), 77: { class_type: 'PreviewImage', inputs: {}, _meta: { title: 'Mi vista' } } };
    comfy.correr('p-retoque-2', propio, { salidas: [{ filename: 'ComfyUI_temp_u.png', type: 'temp', nodo: '77' }, { filename: 'ComfyUI_temp_m2.png', type: 'temp', nodo: mascara }] });
    await t._vuelta();
    const listas = t.estado(s).imagenes.filter((i) => i.estado === 'lista');
    check('el resultado y la vista previa del usuario; la de la máscara, no', listas.length === 2 && comfy.pedidos.some((x) => /ComfyUI_temp_u.png/.test(x)) && !comfy.pedidos.some((x) => /ComfyUI_temp_m2?.png/.test(x)));
    t.parar();
  });

  await group('Con mirar apagado no se pregunta el historial', async () => {
    cfg = config({ mirar: false });
    const { t, comfy } = armar();
    const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    comfy.correr('pm', r.grafo, { salidas: [{ filename: 'm.png', subfolder: `lagrange-taller/${r.sesion}` }] });
    await t._vuelta();
    check('ni al abrir ni en la vuelta', r.ok && !comfy.pedidos.some((x) => /\/history/.test(x)) && t.estado(r.sesion).imagenes.length === 0);
    cfg = config();
    t.parar();
  });

  await group('Si el historial no responde al abrir, no se abre', async () => {
    const comfy = comfyFalso();
    const f = comfy.fetch;
    let falla = true;
    comfy.fetch = async (url, op) => (falla && /\/history/.test(url) ? { ok: false, status: 500, json: async () => ({}) } : f(url, op));
    const { t } = armar({ comfy });
    const b = poner({ caso: 'variacion', fotoRuta: foto });
    const r = await t.abrir({ alma: 'alya', ventana, desde: b.ref });
    check('503 sin-comfy, sin subir la base', r.status === 503 && r.motivo === 'sin-comfy' && comfy.subidos.size === 0);
    falla = false;
    check('cuando responde, abre', (await t.abrir({ alma: 'alya', ventana, desde: b.ref })).ok);
    t.parar();
  });

  await group('Dos sesiones de dos almas en la misma ventana', async () => {
    const { t, comfy } = armar();
    const a = await t.abrir({ alma: 'alya', ventana: otraVentana, plantilla: 'plugin:nueva' });
    const b = await t.abrir({ alma: 'bananero', ventana: otraVentana, plantilla: 'plugin:nueva' });
    comfy.correr('pa', a.grafo, { salidas: [{ filename: 'a.png', subfolder: `lagrange-taller/${a.sesion}` }] });
    comfy.correr('pb', b.grafo, { salidas: [{ filename: 'b.png', subfolder: `lagrange-taller/${b.sesion}` }] });
    await t._vuelta();
    check('cada una a su sesión', t.estado(a.sesion).imagenes.length === 1 && t.estado(b.sesion).imagenes.length === 1);
    t.parar();
  });

  // FEAT-218 — Reabrir una imagen con una LoRA que ya no va con su modelo: se saltea.
  await group('Abrir desde una imagen: las LoRAs por modelo', async () => {
    const lora = (modelos) => config({}, { loras: [{ archivo: 'acuarela.safetensors', clave: 'acuarela', familias: ['sdxl'], fuerza: 0.8, activo: true, modelos }] });
    const abre = async (modelos) => {
      cfg = lora(modelos);
      const { t } = armar({ sinCatalogo: true });
      const r = await t.abrir({ alma: 'alya', ventana, desde: poner({ caso: 'nueva', lorasUsadas: [{ clave: 'acuarela', fuerza: 0.8 }] }).ref });
      t.parar();
      return r;
    };
    const va = await abre([MODELO]);
    check('con su modelo en la lista: la LoRA va', va.ok && JSON.stringify(va.grafo).includes('acuarela.safetensors'));
    const no = await abre(['otro.safetensors']);
    check('con otro modelo en la lista: se saltea', no.ok && !JSON.stringify(no.grafo).includes('acuarela.safetensors'));
    cfg = config();
  });

  // FEAT-218 — Una plantilla del plugin: las LoRAs, con el modelo en uso (el fijo).
  await group('Una plantilla del plugin: las LoRAs por modelo', async () => {
    const abre = async (modelos) => {
      cfg = config({}, { loras: [{ archivo: 'acuarela.safetensors', clave: 'acuarela', familias: ['sdxl'], fuerza: 0.8, activo: true, modelos }] });
      const { t } = armar();
      const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
      t.parar();
      return r;
    };
    const va = await abre([MODELO]);
    check('con el modelo fijo en la lista: la LoRA va', va.ok && JSON.stringify(va.grafo).includes('acuarela.safetensors'), va.ok ? '' : String(va.mensaje || va.codigo));
    const no = await abre(['otro.safetensors']);
    check('con otro modelo en la lista: se saltea', no.ok && !JSON.stringify(no.grafo).includes('acuarela.safetensors'));
    cfg = config();
  });

  // ------------------------------------------------------------- quedar
  // FEAT-218 — «Nueva» del taller sigue la casilla de hires, también con un modelo de reescalado.
  await group('«Nueva» del taller con la casilla de hires', async () => {
    const abre = async (comfy) => {
      cfg = config({}, comfy);
      const { t } = armar();
      const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
      t.parar();
      return r;
    };
    const clases = (g) => Object.values(g).map((n) => n.class_type);
    const lat = await abre({ hires_de: { sdxl: true } });
    check('con la casilla: la segunda pasada por latente', lat.ok && clases(lat.grafo).includes('LatentUpscaleBy') && !clases(lat.grafo).includes('UpscaleModelLoader'), lat.ok ? '' : String(lat.mensaje));
    const mod = await abre({ hires_de: { sdxl: true }, hires_modelo_de: { sdxl: '4x-UltraSharp.safetensors' } });
    const esc = mod.ok && Object.values(mod.grafo).find((n) => n.class_type === 'ImageScale');
    check('con un modelo: nueva-hires-modelo, a 1536²', mod.ok && clases(mod.grafo).includes('UpscaleModelLoader') && esc && esc.inputs.width === 1536 && esc.inputs.height === 1536, mod.ok ? '' : String(mod.mensaje));
    const sin = await abre({});
    check('sin la casilla: nueva, como siempre', sin.ok && !clases(sin.grafo).includes('LatentUpscaleBy') && clases(sin.grafo).filter((c) => c === 'KSampler').length === 1);
    cfg = config();
  });

  // FEAT-218 — Un desde de una imagen grande con la casilla: por encima de 4 MP no hay hires.
  await group('Abrir desde una imagen de 2048² con la casilla de hires', async () => {
    cfg = config({}, { hires_de: { sdxl: true }, hires_modelo_de: { sdxl: '4x-UltraSharp.safetensors' } });
    const { t } = armar({ sinCatalogo: true });
    const r = await t.abrir({ alma: 'alya', ventana, desde: poner({ caso: 'nueva', ancho: 2048, alto: 2048 }).ref });
    t.parar();
    const clases = r.ok ? Object.values(r.grafo).map((n) => n.class_type) : [];
    check('va con nueva, sin segunda pasada', r.ok && !clases.includes('LatentUpscaleBy') && !clases.includes('UpscaleModelLoader') && clases.filter((c) => c === 'KSampler').length === 1, r.ok ? '' : String(r.mensaje));
    cfg = config();
  });

  // FEAT-218 — El modelo que eligió el refinador, del preparado hasta quedar.
  await group('Un preparado con modeloAuto, hasta quedar', async () => {
    const x = armar();
    const { t, comfy } = x;
    const tm = tareas.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'hola' });
    const p = t.preparar({ tareaId: tm.id, n: 1, clave: 'alya', caso: 'nueva', casoPedido: 'nueva', perfil: 'sdxl', modelo: MODELO, modeloAuto: true, prompt: 'a red fox', negativo: '', proporcion: '1:1', ancho: 1024, alto: 1024, zona: '', instruccion: '', loras: [], cambio: null, fuerza: null, semilla: null, base: null, externo: false, hilo: null });
    const ab = await t.abrir({ alma: 'alya', ventana, preparado: p.id });
    check('se abre', ab.ok, ab.ok ? '' : String(ab.mensaje));
    comfy.correr('pm', ab.grafo, { salidas: [{ filename: 'm.png', subfolder: `lagrange-taller/${ab.sesion}` }] });
    await t._vuelta();
    const img = t.estado(ab.sesion).imagenes[0];
    const q = await t.quedar(ab.sesion, img.id, { alma: 'alya' });
    const e = q.ok ? indice.leer('alya', q.tareaId, 1) : {};
    check('quedar guarda el modelo y modeloAuto: true', q.ok && e.modelo === MODELO && e.modeloAuto === true, JSON.stringify({ ok: q.ok, modelo: e.modelo, auto: e.modeloAuto }));
    t.parar();
  });

  await group('Quedármela: a la galería, con su grafo, y reabrirla', async () => {
    const x = armar();
    const { t, comfy } = x;
    const base = poner({ externo: true, caso: 'variacion', fotoRuta: foto });
    const r = await t.abrir({ alma: 'alya', ventana, desde: base.ref });
    comfy.correr('pq', r.grafo, { salidas: [{ filename: 'q.png', subfolder: `lagrange-taller/${r.sesion}` }] });
    await t._vuelta();
    const img = t.estado(r.sesion).imagenes[0];
    check('la base de la sesión viva está en uso, y anotó uso de ComfyUI', t.fotosEnUso().some((f) => fs.realpathSync(f) === fs.realpathSync(foto)) && x.proceso.usos > 0);
    const q = await t.quedar(r.sesion, img.id, { alma: 'alya' });
    check('queda con su tareaId del taller y su número', q.ok && /^t_taller[a-f0-9]{16}$/.test(q.tareaId) && Number.isInteger(q.num));
    const e = indice.leer('alya', q.tareaId, 1);
    check('el índice: origen taller, sin hilo ni vista, externo heredado', e.origen === 'taller' && e.hilo === null && e.vistaEstado === null && e.externo === true && e.lista === true && e.sha256 && e.proveedor === 'comfyui');
    check('FEAT-218: el modelo con que se armó la sesión (desde) pasa al índice, sin modeloAuto', e.modelo === MODELO && e.modeloAuto === false);
    check('los mismos campos que la cola', Object.keys(camposDeImagen({ archivo: 'x', tipo: 'image/png', externo: false, sha256: 's', proveedor: 'comfyui', bytes: 1 })).every((k) => Object.hasOwn(e, k)));
    check('poda esa alma sin la recién guardada, e invalida el mapa', x.podadas.some(([c, a]) => c === 'alya' && a.tareaId === q.tareaId) && x.invalidadas() === 1);
    const gal = crearGaleria({ cola: { avisarAfuera: () => {}, bytesDelIndice: () => ({ ok: true }) }, registro, leerConfig: () => cfg });
    const l = gal.listar({ alma: 'alya', caso: 'taller' });
    check('la galería la muestra con «Del taller» (200)', l.ok && l.imagenes.some((i) => i.tareaId === q.tareaId && i.origen === 'taller') && l.imagenes.every((i) => i.origen === 'taller'));
    check('y no con el filtro de su caso', !gal.listar({ alma: 'alya', caso: 'variacion' }).imagenes.some((i) => i.tareaId === q.tareaId));
    check('no es la última del alma ni una vista', indice.ultimaImagen('alya', [null]) === null && versiones.rotulo({ origen: 'taller', num: 3 }) === 'Imagen #3 · la hizo el usuario en el taller');
    check('quedársela otra vez: 409', (await t.quedar(r.sesion, img.id, { alma: 'alya' })).status === 409);
    // Reabrirla: el mismo grafo, con sus archivos vueltos a subir aunque ComfyUI ya no los tenga.
    comfy.archivos.clear();
    const antes = comfy.subidos.size;
    const re = await t.abrir({ alma: 'alya', ventana, desde: { alma: 'alya', tareaId: q.tareaId, n: 1, intento: 1 } });
    const sinPrefijo = (g) => JSON.stringify(Object.fromEntries(Object.entries(g).map(([k, n]) => [k, { ...n, inputs: { ...n.inputs, filename_prefix: undefined, image: undefined } }])));
    check('reabrir da el mismo grafo, con los archivos subidos de nuevo', re.ok && sinPrefijo(re.grafo) === sinPrefijo(r.grafo) && comfy.subidos.size === antes + 1 && !re.aviso);
    // Borrarla borra también su grafo.
    const cola = crearColaImagenes({ registro, proveedor: () => null, leerConfig: () => cfg, log: () => {}, env: process.env, dirAdjuntos: () => adjuntos });
    const dirF = e.flujo;
    check('borrarla borra su grafo', fs.existsSync(dirF) && cola.borrarImagen({ clave: 'alya', tareaId: q.tareaId, n: 1, intento: 1 }) === 'borrada' && !fs.existsSync(dirF));
    check('una imagen del taller no tiene Otra versión ni Reintentar (sin turno)', cola.otra(q.tareaId, 1).codigo === 'no-existe');
    t.parar();
  });

  await group('La poda con tope 1 no borra la recién guardada', async () => {
    cfg = config();
    cfg.tope_por_alma = 1;
    const vieja = poner({}, 'bananero');
    const cola = crearColaImagenes({ registro, proveedor: () => null, leerConfig: () => cfg, log: () => {}, env: process.env, dirAdjuntos: () => adjuntos });
    const { t, comfy } = armar();
    const tl = crearTaller({ leerConfig: () => cfg, proceso: procesoFalso(), dirAdjuntos: () => adjuntos, fetchImpl: comfy.fetch, catalogoDe: () => CATALOGO, cola, tiempos: { vuelta: 1e9 } });
    const r = await tl.abrir({ alma: 'bananero', ventana, plantilla: 'plugin:nueva' });
    comfy.correr('pt', r.grafo, { salidas: [{ filename: 't.png', subfolder: `lagrange-taller/${r.sesion}` }] });
    await tl._vuelta();
    const q = await tl.quedar(r.sesion, tl.estado(r.sesion).imagenes[0].id, { alma: 'bananero' });
    const quedan = indice.listar('bananero').map((x) => x.tareaId);
    check('queda la nueva; la vieja se podó', quedan.includes(q.tareaId) && !quedan.includes(vieja.id));
    cfg = config();
    t.parar(); tl.parar();
  });

  await group('Lo externo: un LoadImage cambiado y una plantilla propia', async () => {
    const { t, comfy } = armar();
    const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    const cambiado = { ...r.grafo, 50: { class_type: 'LoadImage', inputs: { image: 'cualquiera.png' } } };
    comfy.correr('pc', cambiado, { salidas: [{ filename: 'c.png', subfolder: `lagrange-taller/${r.sesion}` }] });
    comfy.correr('pl', r.grafo, { salidas: [{ filename: 'l.png', subfolder: `lagrange-taller/${r.sesion}` }] });
    await t._vuelta();
    const imgs = t.estado(r.sesion).imagenes;
    check('del plugin sin base: limpia; con un LoadImage que la sesión no subió: externa', imgs.filter((i) => i.externo).length === 1 && imgs.filter((i) => !i.externo).length === 1);
    const g = t.guardarPlantilla({ nombre: 'Mi faro', grafo: r.grafo });
    check('guardar como plantilla', g.ok && /^propia:[a-z0-9]{16}$/.test(g.id));
    check('el envoltorio y un nombre vacío: 400', t.guardarPlantilla({ nombre: 'x', grafo: { workflow: {}, output: r.grafo } }).status === 400 && t.guardarPlantilla({ nombre: '', grafo: r.grafo }).status === 400);
    const p = await t.abrir({ alma: 'alya', ventana, plantilla: g.id });
    comfy.correr('pp', p.grafo, { salidas: [{ filename: 'p.png', subfolder: `lagrange-taller/${p.sesion}` }] });
    await t._vuelta();
    check('lo que sale de una propia es externo', t.estado(p.sesion).imagenes.every((i) => i.externo));
    check('aparece en la lista', t.plantillas().plantillas.some((x) => x.id === g.id && x.nombre === 'Mi faro' && x.disponible));
    const g3 = t.guardarPlantilla({ nombre: 'Con base', grafo: { ...r.grafo, 50: { class_type: 'LoadImage', inputs: { image: 'vieja.png' } } } });
    check('una propia con LoadImage, sin base: 400 base', (await t.abrir({ alma: 'alya', ventana, plantilla: g3.id })).motivo === 'base');
    const conB = await t.abrir({ alma: 'alya', ventana, plantilla: g3.id, base: poner().ref });
    check('y con base, el LoadImage la usa', conB.ok && /^subida-/.test(conB.grafo[50].inputs.image));
    const sinModelo = JSON.parse(JSON.stringify(r.grafo));
    for (const n of Object.values(sinModelo)) if (n.class_type === 'CheckpointLoaderSimple') n.inputs.ckpt_name = 'otro-modelo.safetensors';
    const g2 = t.guardarPlantilla({ nombre: 'Sin modelo', grafo: sinModelo });
    check('una propia con un modelo que ComfyUI no tiene: falta el modelo', t.plantillas().plantillas.some((x) => x.id === g2.id && !x.disponible && x.motivo === 'falta el modelo'));
    check('borrarla, y un id que no es: 400', t.borrarPlantilla({ id: g.id }).ok && t.borrarPlantilla({ id: 'propia:../../x' }).status === 400 && t.borrarPlantilla({ id: g.id }).status === 404);
    t.parar();
  });

  await group('Si ComfyUI perdió el historial: su carpeta de salida', async () => {
    const carpeta = path.join(raiz, 'ComfyUI_portable');
    for (const f of ['python_embeded/python.exe', 'ComfyUI/main.py']) { fs.mkdirSync(path.dirname(path.join(carpeta, f)), { recursive: true }); fs.writeFileSync(path.join(carpeta, f), ''); }
    cfg = config({}, { arranque: { ...A.defectos().comfyui.arranque, carpeta } });
    const { t } = armar();
    const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    const salida = path.join(carpeta, 'ComfyUI', 'output', 'lagrange-taller', r.sesion);
    fs.mkdirSync(salida, { recursive: true });
    fs.writeFileSync(path.join(salida, 'img_00001_.png'), png());
    fs.writeFileSync(path.join(salida, 'nueva.png'), png());
    const viejo = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(path.join(salida, 'img_00001_.png'), viejo, viejo);
    await t._vuelta();
    const imgs = t.estado(r.sesion).imagenes;
    check('lo de hace más de un minuto se lee de ComfyUI/output (portable), como externo', imgs.length === 1 && imgs[0].externo === true);
    cfg = config({}, { arranque: { ...A.defectos().comfyui.arranque, carpeta, flags: [{ flag: '--output-directory', valor: path.join(raiz, 'otra-salida') }] } });
    const { t: t2 } = armar();
    const r2 = await t2.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    const otra = path.join(raiz, 'otra-salida', 'lagrange-taller', r2.sesion);
    fs.mkdirSync(otra, { recursive: true });
    fs.writeFileSync(path.join(otra, 'x.png'), png());
    fs.utimesSync(path.join(otra, 'x.png'), viejo, viejo);
    await t2._vuelta();
    check('con --output-directory, esa carpeta', t2.estado(r2.sesion).imagenes.length === 1);
    cfg = config();
    t.parar(); t2.parar();
  });

  await group('2.26.3 — Lo que pesa más de 20 MB queda como fallo, y la salida de ComfyUI se limpia', async () => {
    const carpeta = path.join(raiz, 'ComfyUI_grandes');
    for (const f of ['python_embeded/python.exe', 'ComfyUI/main.py']) { fs.mkdirSync(path.dirname(path.join(carpeta, f)), { recursive: true }); fs.writeFileSync(path.join(carpeta, f), ''); }
    const salidaComfy = path.join(carpeta, 'ComfyUI', 'output', 'lagrange-taller');
    cfg = config({}, { arranque: { ...A.defectos().comfyui.arranque, carpeta } });
    const dir = path.join(raiz, 'taller-grandes');
    const { t, comfy } = armar({ dir, tiempos: { disco: 0 } });
    const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    const grande = Buffer.alloc(20 * 1024 * 1024 + 1);
    comfy.correr('g1', r.grafo, { salidas: [{ filename: 'g1.png', subfolder: `lagrange-taller/${r.sesion}`, bytes: grande }] });
    await t._vuelta();
    let imgs = t.estado(r.sesion).imagenes;
    const e = imgs.length === 1 ? imgs[0] : null;
    check('desde el historial: una tarjeta de fallo, no nada', !!e && e.estado === 'error' && !!e.error && e.error.codigo === 'grande');
    check('el fallo dice el tope y dónde quedó', !!e && /20 MB/.test(e.error.mensaje) && e.error.mensaje.includes(`lagrange-taller/${r.sesion}/g1.png`));
    check('no se copió nada a la sesión', fs.readdirSync(path.join(dir, 'sesiones', r.sesion)).every((f) => !/^img-.*\.png$/.test(f)));
    // El mismo archivo en el disco de ComfyUI (más de un minuto atrás): no se anota dos veces.
    fs.mkdirSync(path.join(salidaComfy, r.sesion), { recursive: true });
    const viejo = new Date(Date.now() - 5 * 60 * 1000);
    fs.writeFileSync(path.join(salidaComfy, r.sesion, 'g1.png'), grande);
    fs.utimesSync(path.join(salidaComfy, r.sesion, 'g1.png'), viejo, viejo);
    await t._vuelta();
    check('la del historial no vuelve a anotarse desde el disco', t.estado(r.sesion).imagenes.length === 1);
    // Uno grande que solo está en el disco: un fallo, una sola vez.
    fs.writeFileSync(path.join(salidaComfy, r.sesion, 'solo-disco.png'), grande);
    fs.utimesSync(path.join(salidaComfy, r.sesion, 'solo-disco.png'), viejo, viejo);
    await t._vuelta();
    await t._vuelta();
    imgs = t.estado(r.sesion).imagenes;
    check('desde el disco: un fallo grande, una sola vez', imgs.length === 2 && imgs.filter((i) => i.error && i.error.codigo === 'grande' && i.error.mensaje.includes('solo-disco.png')).length === 1);
    const id = imgs[0].id;
    check('el fallo se puede descartar', t.descartar(r.sesion, id).ok);
    await t.cerrar(r.sesion, { resto: 'descartar' });
    t.parar();

    // Una sesión cerrada hace más de 7 días, una carpeta huérfana vieja, una reciente y una de ventana.
    const viejaSesion = () => {
      const f = path.join(dir, 'sesiones', r.sesion, 'sesion.json');
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      s.abierta = false; s.ultimaSenal = Date.now() - 8 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(f, JSON.stringify(s));
      fs.mkdirSync(path.join(salidaComfy, r.sesion), { recursive: true });
    };
    const huerfanaVieja = path.join(salidaComfy, 's-dddddddddddddddd');
    const huerfanaNueva = path.join(salidaComfy, 's-eeeeeeeeeeeeeeee');
    const deVentana = path.join(salidaComfy, 'v-ffffffffffffffff');
    const otraCosa = path.join(salidaComfy, 'mis-cosas');
    for (const d of [huerfanaVieja, huerfanaNueva, deVentana, otraCosa]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'x.png'), png()); }
    const hace8 = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const d of [huerfanaVieja, deVentana, otraCosa]) fs.utimesSync(d, hace8, hace8);

    // Apagado: no se toca nada de ComfyUI.
    viejaSesion();
    cfg = config({ limpiar_salida: false }, { arranque: { ...A.defectos().comfyui.arranque, carpeta } });
    const apagado = crearTaller({ leerConfig: () => cfg, proceso: procesoFalso(), fetchImpl: comfy.fetch, catalogoDe: () => CATALOGO, dir, tiempos: { vuelta: 1e9 } });
    check('apagado: la sesión vieja se borra del plugin', apagado.estado(r.sesion).status === 404 && !fs.existsSync(path.join(dir, 'sesiones', r.sesion)));
    check('apagado: su carpeta en ComfyUI queda', fs.existsSync(path.join(salidaComfy, r.sesion)));
    check('apagado: la huérfana vieja queda', fs.existsSync(huerfanaVieja));
    apagado.parar();

    // Prendido (por defecto): la de la sesión y la huérfana vieja; nada más.
    fs.mkdirSync(path.join(dir, 'sesiones', r.sesion), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sesiones', r.sesion, 'sesion.json'), JSON.stringify({ id: r.sesion, ventana, alma: 'alya', imagenes: {}, abierta: false, ultimaSenal: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
    cfg = config({}, { arranque: { ...A.defectos().comfyui.arranque, carpeta } });
    check('limpiar_salida viene prendido', cfg.taller.limpiar_salida === true);
    const prendido = crearTaller({ leerConfig: () => cfg, proceso: procesoFalso(), fetchImpl: comfy.fetch, catalogoDe: () => CATALOGO, dir, tiempos: { vuelta: 1e9 } });
    check('prendido: la carpeta de la sesión vieja se borra de ComfyUI', !fs.existsSync(path.join(salidaComfy, r.sesion)));
    check('prendido: la huérfana de más de 7 días también', !fs.existsSync(huerfanaVieja));
    check('prendido: la huérfana reciente queda', fs.existsSync(huerfanaNueva));
    check('prendido: lo de la ventana (v-) y lo que no es una sesión no se tocan', fs.existsSync(deVentana) && fs.existsSync(otraCosa));
    prendido.parar();
    cfg = config();
  });

  await group('2.26.3 — limpiar_salida en los ajustes', async () => {
    const { ajustesV2 } = await importar('telegram-bridge/web/v2/ajustes.js');
    check('en los defectos, prendido', A.defectos().taller.limpiar_salida === true);
    const r = A.normalizar({ taller: { limpiar_salida: false } });
    check('se normaliza un false', r.imagenes.taller.limpiar_salida === false);
    check('un valor que no es booleano avisa', A.normalizar({ taller: { limpiar_salida: 'si' } }).avisos.some((a) => /limpiar_salida/.test(a)));
    check('el PATCH la guarda y rechaza lo que no es booleano', A.aplicarImagenes({ imagenes: {} }, { taller: { limpiar_salida: false } }).imagenes.taller.limpiar_salida === false && (() => { try { A.aplicarImagenes({}, { taller: { limpiar_salida: 'no' } }); return false; } catch (e) { return /true o false/.test(e.message); } })());
    check('la vista v2: prendida si falta, y la guardada si está', ajustesV2({ imagenes: { taller: {} } }).imagenes.taller.limpiar_salida === true && ajustesV2({ imagenes: { taller: { limpiar_salida: false } } }).imagenes.taller.limpiar_salida === false);
  });

  // ------------------------------------------------------------- ciclo de vida
  await group('Sigue, se cierra, se reabre y se cierra con resto', async () => {
    const dir = path.join(raiz, 'taller-ciclo');
    const x = armar({ dir, tiempos: { senal: 60 } });
    const { t, comfy } = x;
    const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('sigue con su clientId', t.sigue(r.sesion, { clientId: 'cli-1' }).ok && t.sigue(r.sesion, { clientId: 'mal id!' }).status === 400);
    comfy.correr('c1', r.grafo, { salidas: [{ filename: 'c1.png', subfolder: `lagrange-taller/${r.sesion}` }] });
    await t._vuelta();
    await new Promise((ok) => setTimeout(ok, 80));
    await t._vuelta();
    check('sin señal se cierra sola, sin borrar nada', t.estado(r.sesion).abierta === false && t.estado(r.sesion).imagenes.length === 1);
    check('sigue sobre una cerrada: 410', t.sigue(r.sesion).status === 410);
    const id = t.estado(r.sesion).imagenes[0].id;
    check('quedársela vale sobre una cerrada', (await t.quedar(r.sesion, id, { alma: 'alya' })).ok);
    const re = await t.abrir({ alma: 'alya', ventana, reabrir: r.sesion });
    check('reabrir es la misma sesión', re.ok && re.sesion === r.sesion && t.estado(r.sesion).abierta);
    // Un daemon nuevo la retoma desde el disco.
    const y = crearTaller({ leerConfig: () => cfg, proceso: procesoFalso(), fetchImpl: comfy.fetch, catalogoDe: () => CATALOGO, dir, tiempos: { vuelta: 1e9 } });
    comfy.correr('c2', r.grafo, { salidas: [{ filename: 'c2.png', subfolder: `lagrange-taller/${r.sesion}` }] });
    await y._vuelta();
    check('tras reiniciar, sigue mirando con lo visto', y.estado(r.sesion).imagenes.filter((i) => i.estado === 'lista').length === 1 && y.estado(r.sesion).imagenes.length === 2);
    comfy.correr('c3', r.grafo, { error: true });
    await y._vuelta();
    const c = await y.cerrar(r.sesion, { resto: 'descartar' });
    check('cerrar con resto descartar se lleva también las que fallaron', c.ok && y.estado(r.sesion).imagenes.every((i) => !['lista', 'error'].includes(i.estado)) && y.estado(r.sesion).abierta === false);
    // Una sesión guardada con una ventana que no vale no se carga.
    const mala = path.join(dir, 'sesiones', 's-cccccccccccccccc');
    fs.mkdirSync(mala, { recursive: true });
    fs.writeFileSync(path.join(mala, 'sesion.json'), JSON.stringify({ id: 's-cccccccccccccccc', ventana: 'v-../../../../x', imagenes: {}, abierta: true }));
    const z = crearTaller({ leerConfig: () => cfg, proceso: procesoFalso(), fetchImpl: comfy.fetch, catalogoDe: () => CATALOGO, dir, tiempos: { vuelta: 1e9 } });
    check('una sesión con una ventana que no vale no se carga', z.estado('s-cccccccccccccccc').status === 404);
    z.parar();
    check('resto inválido: 400', (await y.cerrar(r.sesion, { resto: 'x' })).status === 400);
    check('las bases de las vivas están en uso', Array.isArray(y.fotosEnUso()));
    t.parar(); y.parar();
  });

  await group('Lo que termina después de cerrar sigue esa decisión', async () => {
    const { t, comfy } = armar();
    const a = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    const b = await t.abrir({ alma: 'alya', ventana: otraVentana, plantilla: 'plugin:nueva' });
    const viva = await t.abrir({ alma: 'alya', ventana: otraVentana, plantilla: 'plugin:nueva' });
    check('cerrar una con descartar', (await t.cerrar(a.sesion, { resto: 'descartar' })).ok);
    comfy.correr('tarde-a', a.grafo, { salidas: [{ filename: 'ta.png', subfolder: `lagrange-taller/${a.sesion}` }] });
    comfy.correr('tarde-b', b.grafo, { salidas: [{ filename: 'tb.png', subfolder: `lagrange-taller/${b.sesion}` }] });
    await t._vuelta();
    const ea = t.estado(a.sesion).imagenes;
    check('la que llegó tarde se descarta', ea.length === 1 && ea[0].estado === 'descartada' && t.bytes(a.sesion, ea[0].id).status === 404);
    check('la otra sesión no cambia', t.estado(b.sesion).imagenes.length === 1 && t.estado(b.sesion).imagenes[0].estado === 'lista');
    check('cerrar otra con quedar', (await t.cerrar(b.sesion, { resto: 'quedar', alma: 'alya' })).ok);
    comfy.correr('tarde-q', b.grafo, { salidas: [{ filename: 'tq.png', subfolder: `lagrange-taller/${b.sesion}` }] });
    await t._vuelta();
    const eb = t.estado(b.sesion).imagenes;
    check('con quedar, la que llegó tarde va a la galería', eb.length === 2 && eb.every((i) => i.estado === 'quedada'));
    const re = await t.abrir({ alma: 'alya', ventana, reabrir: a.sesion });
    comfy.correr('tras-reabrir', a.grafo, { salidas: [{ filename: 'tr.png', subfolder: `lagrange-taller/${a.sesion}` }] });
    await t._vuelta();
    check('reabierta, lo nuevo queda para decidir', re.ok && t.estado(a.sesion).imagenes.some((i) => i.estado === 'lista') && t.estado(viva.sesion).ok);
    t.parar();
  });

  // ------------------------------------------------------------- preparados
  await group('«Que lo prepare el alma»: la cola deja un preparado', async () => {
    const { t, eventos } = armar();
    const nuevaTarea = () => { const x = tareas.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'hola' }); tareas.actualizar(x.id, { estado: 'ok' }); return x.id; };
    const entrada = (id) => (tareas.obtener(id).imagenes || [])[0];
    const hasta = async (cond) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 5)); return cond(); };
    const refinador = { refinar: async () => ({ caso: 'nueva', prompt: 'a lighthouse in the snow', negativo: '', proporcion: '1:1', zona: '', instruccion: '', loras: [], refinado: true }), sinRefinar: (p) => ({ caso: 'nueva', prompt: p, negativo: '', proporcion: '1:1', zona: '', instruccion: '', loras: [] }) };
    const generados = [];
    const cola = crearColaImagenes({
      registro, proveedor: (id) => ({ id, generar: async () => { generados.push(id); return { ok: false, codigo: 'error' }; } }), leerConfig: () => ({ ...cfg, orden: ['comfyui', 'antigravity'], alma_la_ve: false }),
      refinador, vision: { llamar: async () => ({ ok: false }) }, manual: () => false, catalogoDe: async () => CATALOGO, log: () => {}, env: process.env, dirAdjuntos: () => adjuntos,
      taller: { preparar: (d) => t.preparar(d), fallo: (x) => t.fallo(x) }
    });
    const id = nuevaTarea();
    cola.encolar({ tareaId: id, clave: 'alya', pedido: 'un faro en la nieve', destino: 'taller' });
    await hasta(() => entrada(id) && entrada(id).estado !== 'generando');
    check('la entrada queda en error para-el-taller, sin generar', entrada(id).estado === 'error' && entrada(id).codigo === 'para-el-taller' && entrada(id).mensaje === 'Quedó para el taller.' && generados.length === 0);
    const p = t.preparadoDe(id);
    check('el preparado se recupera por el turno, y su evento', p.ok && /^p-[a-z0-9]{16}$/.test(p.preparado.id) && eventos.some((x) => x.tipo === 'taller.preparado' && x.tema === 'sujeto:alya' && esquema.validar(contrato, 'evento:taller.preparado', x.datos).length === 0));
    const ab = await t.abrir({ alma: 'alya', ventana, preparado: p.preparado.id });
    check('abrir el preparado con su prompt refinado', ab.ok && JSON.stringify(ab.grafo).includes('a lighthouse in the snow'));
    const otra = await t.abrir({ alma: 'alya', ventana, preparado: p.preparado.id, idCliente: 'taller-otro-pedido-1' });
    check('2.23.3: otro «Abrir» en la misma ventana trae la misma sesión, no una vacía', otra.ok && otra.sesion === ab.sesion);
    const ab2 = await t.abrir({ alma: 'alya', ventana: otraVentana, preparado: p.preparado.id });
    const semillaDe = (g) => Object.values(g).find((n) => n.class_type === 'KSampler').inputs.seed;
    check('en otra ventana, otra sesión con la misma semilla', ab2.ok && ab2.sesion !== ab.sesion && Number.isInteger(semillaDe(ab.grafo)) && semillaDe(ab.grafo) === semillaDe(ab2.grafo));
    await t.cerrar(ab.sesion, { resto: 'descartar' });
    const ab3 = await t.abrir({ alma: 'alya', ventana, preparado: p.preparado.id });
    check('cerrada la primera, se abre de nuevo', ab3.ok && ab3.sesion !== ab.sesion);
    check('un preparado que no es: 400/404', (await t.abrir({ alma: 'alya', ventana, preparado: 'p-../x' })).status === 400 && (await t.abrir({ alma: 'alya', ventana, preparado: 'p-zzzzzzzzzzzzzzzz' })).status === 404);
    // Solo agy: no hay taller.
    const id2 = nuevaTarea();
    const colaAgy = crearColaImagenes({ registro, proveedor: () => null, leerConfig: () => ({ ...cfg, orden: ['antigravity'], alma_la_ve: false }), refinador, vision: { llamar: async () => ({ ok: false }) }, manual: () => false, catalogoDe: async () => null, log: () => {}, env: process.env, dirAdjuntos: () => adjuntos, taller: { preparar: (d) => t.preparar(d), fallo: (x) => t.fallo(x) } });
    colaAgy.encolar({ tareaId: id2, clave: 'alya', pedido: 'x', destino: 'taller' });
    await hasta(() => entrada(id2) && entrada(id2).estado !== 'generando');
    const otraVez = crearTaller({ leerConfig: () => cfg, proceso: procesoFalso(), fetchImpl: comfyFalso().fetch, catalogoDe: () => CATALOGO, tiempos: { vuelta: 1e9 } });
    check('el fallo sobrevive a un reinicio', otraVez.preparadoDe(id2).ok && otraVez.preparadoDe(id2).preparado.ok === false);
    // Un preparado de hace más de 2 horas ya no vale.
    const ruta = path.join(process.env.LAGRANGE_TALLER_DIR, 'preparados', `${p.preparado.id}.json`);
    const o = JSON.parse(fs.readFileSync(ruta, 'utf8')); o.creada = new Date(Date.now() - 3 * 3600 * 1000).toISOString(); fs.writeFileSync(ruta, JSON.stringify(o));
    check('un preparado vencido ya no vale', otraVez.preparadoDe(id).status === 404 && (await otraVez.abrir({ alma: 'alya', ventana, preparado: p.preparado.id })).status === 404);
    otraVez.parar();
    check('si solo puede agy: sin-proveedor, y el fallo se recupera', entrada(id2).codigo === 'sin-proveedor' && t.preparadoDe(id2).preparado.ok === false && t.preparadoDe('t_nada1').status === 404 && t.preparadoDe('..').status === 400);
    t.parar();
  });

  // ------------------------------------------------------------- ajustes, rutas y contrato
  await group('Los ajustes del taller', async () => {
    const n = A.normalizar({ taller: { activo: false, mirar: 'si', al_cerrar: 'quedar' } });
    check('normalizar: lo que vale, y un aviso por lo que no', n.imagenes.taller.activo === false && n.imagenes.taller.mirar === true && n.imagenes.taller.al_cerrar === 'quedar' && n.avisos.some((x) => /taller\.mirar/.test(x)));
    check('por defecto: todo prendido, al cerrar preguntar', JSON.stringify(A.defectos().taller) === JSON.stringify({ activo: true, abrir_en_taller: true, prepara_alma: true, mirar: true, disposicion_plugin: true, limpiar_salida: true, al_cerrar: 'preguntar' }));
    const g = A.aplicarImagenes({ imagenes: { taller: { mirar: false } } }, { taller: { activo: false } });
    check('aplicar: campo por campo', g.imagenes.taller.mirar === false && g.imagenes.taller.activo === false);
    const mal = (p) => { try { A.aplicarImagenes({}, p); return null; } catch (err) { return err.message; } };
    check('aplicar: un al_cerrar o un campo que no vale, error', /Al cerrar/.test(mal({ taller: { al_cerrar: 'x' } })) && /no está permitido/.test(mal({ taller: { otro: true } })) && /true o false/.test(mal({ taller: { activo: 1 } })));
    const { ajustesV2 } = await importar('telegram-bridge/web/v2/ajustes.js');
    void ajustesV2;
  });

  await group('Las rutas v2 del taller y el turno con taller', async () => {
    const { rutasMutacionV2 } = await importar('telegram-bridge/web/v2/mutaciones.js');
    const { crearIdempotencia } = await importar('telegram-bridge/web/v2/idempotencia.js');
    const { t } = armar();
    const despachos = [];
    const base = { nucleo: { sujetos: async () => ({ almas: [{ clave: 'alya', voz: 'Alya' }], agentes: [] }) }, cola: { dispatchCharla: async (_c, o) => { const x = tareas.crear({ carril: 'alma', origen: 'web', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'x' }); despachos.push(o); o.alEncolar(x.id); return { ok: true }; } }, ctx: {}, chatTerminal: 'x', registro: tareas, idem: crearIdempotencia({ registro: tareas }), recorte: '' };
    const rutas = rutasMutacionV2({ ...base, imagenes: {}, taller: () => t });
    const llamar = (metodo, ruta, cuerpo = {}) => { const u = new URL(`http://x${ruta}`); const r = rutas.find((x) => x.metodo === metodo && x.patron.test(u.pathname)); return r ? r.fn({ p: r.patron.exec(u.pathname).slice(1).map(decodeURIComponent), cuerpo, url: u }) : null; };
    const idc = (n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
    await llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: idc(1), texto: 'haceme un faro', taller: true });
    check('el turno pasa taller a la charla', despachos[0] && despachos[0].taller === true);
    check('taller que no es booleano: 400', (await llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: idc(2), texto: 'x', taller: 'si' })).codigo === 400);
    await llamar('POST', '/api/v2/sujetos/alya/turnos', { idCliente: idc(3), texto: 'hola' });
    check('sin taller, nada', despachos[1] && despachos[1].taller === undefined);
    const ab = await llamar('POST', '/api/v2/taller:abrir', { alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('POST /taller:abrir', ab.ok && /^s-/.test(ab.sesion));
    check('GET /taller/plantillas y GET /taller/<sesion>', (await llamar('GET', '/api/v2/taller/plantillas')).ok && (await llamar('GET', `/api/v2/taller/${ab.sesion}`)).ok);
    check('un %2e%2e en la sesión: 400', (await llamar('GET', '/api/v2/taller/s-%2e%2e')).codigo === 400 && (await llamar('POST', `/api/v2/taller/${ab.sesion}/img-%2e%2e:quedar`, { alma: 'alya' })).codigo === 400);
    check('un error del taller lleva su motivo', (await llamar('POST', '/api/v2/taller:abrir', { alma: 'alya', ventana })).motivo === 'forma');
    check('POST :sigue', (await llamar('POST', `/api/v2/taller/${ab.sesion}:sigue`, { clientId: 'c-1' })).ok);
    const dt = await llamar('GET', '/api/v2/turnos/t_tallerabc123/imagenes/1');
    check('las rutas de una imagen del taller: 409 del-taller', dt.codigo === 409 && dt.motivo === 'del-taller');
    const sinT = rutasMutacionV2({ ...base, imagenes: {}, taller: null });
    const r503 = sinT.find((x) => x.metodo === 'GET' && x.patron.test('/api/v2/taller/plantillas'));
    check('sin taller en el proceso: 503', (await r503.fn({ p: [], cuerpo: {}, url: new URL('http://x/api/v2/taller/plantillas') })).codigo === 503);
    t.parar();
  });

  await group('El bot: el pie, Apagar con el taller abierto y la capacidad', async () => {
    const bot = await importar('telegram-bridge/bot.js');
    const pie = bot.pieDeMemoria({ imagenPedida: { texto: 'un faro' }, taller: true, aplicadas: [] });
    check('el pie dice «para el taller», no que va a hacer una imagen', /🛠 para el taller/.test(pie) && !/va a hacer/.test(pie));
    check('sin línea de imagen: «no preparó ninguna imagen»', /no preparó ninguna imagen/.test(bot.pieDeMemoria({ taller: true, aplicadas: [] })));
    check('sin taller, como siempre', /va a hacer una imagen/.test(bot.pieDeMemoria({ imagenPedida: { texto: 'x' }, aplicadas: [] })));
    bot.usarTallerParaTests({ abiertas: () => 1, parar() {} });
    const v2 = bot.comfyuiV2();
    const ap = await v2.apagar(true);
    const re = await v2.reiniciar(true);
    check('Apagar y Reiniciar con el taller abierto: ocupado, también con forzar', ap.ok === false && ap.codigo === 'ocupado' && re.codigo === 'ocupado');
    bot.usarTallerParaTests(null);
    const caps = bot.capacidadesV2({ leerConfig: () => cfg });
    check('la capacidad taller, válida en el contrato', caps.capacidades.taller === true && esquema.validar(contrato, 'capacidades', caps).length === 0);
    const { ajustesV2 } = await importar('telegram-bridge/web/v2/ajustes.js');
    const a = ajustesV2({ imagenes: { taller: { activo: false, al_cerrar: 'x' } } });
    check('la vista v2: campo por campo, con lo que falta prendido', a.imagenes.taller.activo === false && a.imagenes.taller.mirar === true && a.imagenes.taller.al_cerrar === 'preguntar');
  });

  await group('2.25.1: sin el catálogo en la caché, el taller lo pide', async () => {
    // Nadie generó ni probó en 5 minutos: la caché está vacía, pero ComfyUI contesta.
    const pedidos = [];
    const { t } = armar({ sinCatalogo: true, pedirCatalogo: async (url) => { pedidos.push(url); return CATALOGO; } });
    const lista = await t.listarPlantillas();
    check('la lista pide el catálogo y las plantillas quedan disponibles', lista.ok && pedidos.length === 1 && lista.plantillas.find((p) => p.id === 'plugin:nueva').disponible && !lista.plantillas.some((p) => /no respondió/.test(p.motivo || '')));
    check('a la URL de ComfyUI de la config', pedidos[0] === cfg.comfyui.url);
    const n = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('abrir una plantilla también lo pide (no 409 «ComfyUI no respondió»)', n.ok && pedidos.length === 2);
    t.parar();
    // ComfyUI no contesta de verdad: «ComfyUI no respondió», como antes.
    const { t: caido } = armar({ sinCatalogo: true, pedirCatalogo: async () => null });
    check('sin respuesta: todas apagadas con su motivo', (await caido.listarPlantillas()).plantillas.every((p) => !p.disponible && /no respondió/.test(p.motivo)));
    caido.parar();
    // Un pedido que lanza o que tarda más que el tope: tampoco cuelga la lista (la terminal espera 10 s).
    const { t: lanza } = armar({ sinCatalogo: true, pedirCatalogo: () => { throw new Error('x'); } });
    check('un pedido que lanza: null, sin romper', (await lanza.listarPlantillas()).plantillas.every((p) => !p.disponible));
    lanza.parar();
    const { t: lento } = armar({ sinCatalogo: true, pedirCatalogo: () => new Promise((ok) => setTimeout(() => ok(CATALOGO), 2000)), tiempos: { catalogo: 30 } });
    const t0 = Date.now();
    const l = await lento.listarPlantillas();
    check('uno más lento que el tope: corta y dice que no respondió', Date.now() - t0 < 1500 && l.plantillas.every((p) => !p.disponible && /no respondió/.test(p.motivo)));
    lento.parar();
    // Con el catálogo en la caché no se pide nada.
    const otros = [];
    const { t: conCache } = armar({ pedirCatalogo: async (u) => { otros.push(u); return CATALOGO; } });
    check('con caché, no pide', (await conCache.listarPlantillas()).plantillas.find((p) => p.id === 'plugin:nueva').disponible && otros.length === 0);
    conCache.parar();
    // El daemon le pasa el pedido de verdad y la ruta usa listarPlantillas.
    const botSrc = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'bot.js'), 'utf8');
    const rutas = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'web', 'v2', 'mutaciones.js'), 'utf8');
    check('bot.js: pedirCatalogo con catalogo.catalogoDe', /pedirCatalogo: \(url\) => imgCatalogo\(\)\.catalogoDe\(url\)/.test(botSrc));
    check('la ruta GET de plantillas usa listarPlantillas', rutas.includes('tl.listarPlantillas()'));
  });

  await group('El contrato: la capacidad y los dos eventos', () => {
    check('capacidades.taller es opcional y booleana', contrato.agregados.capacidades.properties.capacidades.properties.taller.type === 'boolean');
    check('los dos tipos en el enum y en eventos', ['taller.imagen', 'taller.preparado'].every((x) => contrato.agregados.evento.properties.tipo.enum.includes(x) && contrato.eventos[x]));
    check('un evento que no encaja se rechaza', esquema.validar(contrato, 'evento:taller.imagen', { sesion: 's', id: 'i', estado: 'otro' }).length > 0);
    check('el contrato sigue bien formado', (() => { try { esquema.revisarContrato(contrato); return true; } catch { return false; } })());
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
