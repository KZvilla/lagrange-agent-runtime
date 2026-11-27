/**
 * FEAT-218 S1 — Elegir el modelo según el pedido (los candidatos, la consigna, `sanear`, la cola y las repeticiones), la
 * segunda pasada (hires) por perfil, las LoRAs por modelo, `modeloAuto` en el turno, la galería y el contrato, y los
 * ajustes nuevos.
 *
 * Sin red, sin agy y sin ComfyUI: todo se inyecta.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat218-'));
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
const sondaVision = require('../mcp-server/imagenes/sonda-vision.js');

const PNG = sondaVision.pngSolido(8, [10, 200, 10]);
const copia = (o) => JSON.parse(JSON.stringify(o));
const hasta = async (cond, ms = 3000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); } return cond(); };
const config = (extra = {}, comfy = {}) => { const d = A.defectos(); return { ...d, ...extra, comfyui: { ...d.comfyui, ...comfy } }; };
const auto = { manual: () => false };
const DIR_SDXL = path.join(RAIZ, 'telegram-bridge', 'imagenes', 'plantillas', 'sdxl');

const WAI = 'WAI-Nsfw-Illustrious-17.safetensors';
const PONY = 'ponyDiffusionV6XL.safetensors';
const BASE = 'sd_xl_base_1.0.safetensors';
const CANDIDATOS = [{ archivo: WAI, para: 'anime' }, { archivo: PONY, para: 'pony y furry' }, { archivo: BASE, para: 'fotos reales' }];
const conCandidatos = (extra = {}, comfy = {}) => config({ orden: ['comfyui'], alma_la_ve: false, ...extra }, { candidatos: CANDIDATOS, ...comfy });

/** Un catálogo con esos checkpoints y los nodos de las plantillas sdxl (con la segunda pasada). */
const catalogo = (checkpoints) => ({
  checkpoints: checkpoints.map((valor) => ({ valor })), unets: [], clips: [], vaes: [], loras: [],
  nodos: new Set(['CheckpointLoaderSimple', 'KSampler', 'CLIPTextEncode', 'EmptyLatentImage', 'VAEDecode', 'SaveImage', 'LoraLoader', 'LoadImage', 'VAEEncode', 'ImageScale', 'LatentUpscaleBy'])
});

async function main() {
  const { datosDe, armarPedido, escalaConTope, crearComfyui } = await importar('telegram-bridge/imagenes/comfyui.js');
  const tareas = await importar('telegram-bridge/tareas.js');
  const { crearColaImagenes, camposDeImagen } = await importar('telegram-bridge/imagenes-cola.js');
  const { crearGaleria } = await importar('telegram-bridge/imagenes/galeria.js');
  const { ajustesV2 } = await importar('telegram-bridge/web/v2/ajustes.js');
  const { imagenesDe, turnoDe } = await importar('telegram-bridge/web/v2/productores.js');
  const { validar, revisarContrato } = await importar('telegram-bridge/web/v2/esquema.js');

  // ------------------------------------------------------------ perfiles
  await group('Perfiles: la segunda pasada y mismoArchivo', async () => {
    const sdxl = ['sdxl', 'sdxl-pony', 'sdxl-illustrious', 'sdxl-anything', 'sdxl-rapido'];
    check('los cinco sdxl traen muestreo.hires', sdxl.every((id) => P.PERFILES.get(id).muestreo.hires && P.PERFILES.get(id).muestreo.hires.escala === 1.5));
    check('el rápido: 0,4 y 4 pasos (un Lightning con 15 se quema)', P.PERFILES.get('sdxl-rapido').muestreo.hires.fuerza === 0.4 && P.PERFILES.get('sdxl-rapido').muestreo.hires.pasos === 4);
    check('los de Flux no la traen', ['flux', 'flux-fp8', 'flux-fill', 'flux-kontext'].every((id) => !P.PERFILES.get(id).muestreo.hires));
    const base = copia(P.PERFILES.get('sdxl'));
    const con = (h) => P.validarPerfil('mio', { ...base, muestreo: { ...base.muestreo, hires: h } });
    check('vale en el rango', con({ escala: 1.25, fuerza: 0.2, pasos: 1 }).ok && con({ escala: 2, fuerza: 0.8, pasos: 150 }).ok);
    check('fuera de rango, con su campo', con({ escala: 1.2, fuerza: 0.5, pasos: 10 }).campo === 'muestreo.hires.escala' && con({ escala: 1.5, fuerza: 0.9, pasos: 10 }).campo === 'muestreo.hires.fuerza' && con({ escala: 1.5, fuerza: 0.5, pasos: 1.5 }).campo === 'muestreo.hires.pasos');
    check('una clave de más no', con({ escala: 1.5, fuerza: 0.5, pasos: 10, x: 1 }).campo === 'muestreo.hires.x');
    check('null es «sin hires» y no queda la clave', con(null).ok && !('hires' in con(null).perfil.muestreo));
    const flux = copia(P.PERFILES.get('flux'));
    check('en Flux, no', P.validarPerfil('mio', { ...flux, muestreo: { ...flux.muestreo, hires: { escala: 1.5, fuerza: 0.5, pasos: 10 } } }).campo === 'muestreo.hires');
    check('hiresDe: los del perfil, o 1,5 / 0,5 / la mitad de los pasos', JSON.stringify(P.hiresDe(P.PERFILES.get('sdxl-pony'))) === '{"escala":1.5,"fuerza":0.5,"pasos":15}' && JSON.stringify(P.hiresDe({ muestreo: { pasos: 27 } })) === '{"escala":1.5,"fuerza":0.5,"pasos":14}');
    const img = (tabla) => ({ comfyui: { hires_de: tabla } });
    check('hiresActivo: solo con true y en sdxl', P.hiresActivo(img({ sdxl: true }), P.PERFILES.get('sdxl')) && !P.hiresActivo(img({}), P.PERFILES.get('sdxl')) && !P.hiresActivo(img({ flux: true }), P.PERFILES.get('flux')));
    check('mismoArchivo: «\\» y «/», y los bordes', P.mismoArchivo('SDXL\\a.safetensors', 'SDXL/a.safetensors') && P.mismoArchivo(' a.st ', 'a.st') && !P.mismoArchivo('a.st', 'b.st') && !P.mismoArchivo('', '') && !P.mismoArchivo(null, 'a'));
  });

  // -------------------------------------------------------- la plantilla
  await group('La plantilla sdxl/nueva-hires', async () => {
    const l = F.leerFlujo(path.join(DIR_SDXL, 'nueva-hires.json'), { caso: 'nueva' });
    check('se lee, con la salida y los 4 huecos', l.ok && l.ficha.salida === '9' && l.ficha.huecos.join() === '101,102,103,104', l.motivo);
    check('13 nodos: los 11 de nueva, LatentUpscaleBy y el segundo KSampler', Object.keys(l.flujo).length === 13 && l.flujo['10'].class_type === 'LatentUpscaleBy' && l.flujo['11'].class_type === 'KSampler' && JSON.stringify(l.flujo['8'].inputs.samples) === '["11",0]');
    check('los marcadores nuevos', ['hires_escala', 'hires_pasos', 'hires_fuerza'].every((m) => l.marcadores.includes(m)));
    check('hires_pasos es entero; la escala y la fuerza, decimales (en ENTEROS, 1,5 sería 2)', F.ENTEROS.has('hires_pasos') && !F.ENTEROS.has('hires_escala') && F.DECIMALES.has('hires_escala') && F.DECIMALES.has('hires_fuerza'));
    const disp = JSON.parse(fs.readFileSync(path.join(DIR_SDXL, 'nueva-hires.disposicion.json'), 'utf8'));
    const v = D.validarDisposicion(disp);
    check('su disposición vale y cubre los 13 nodos', v.ok && Object.keys(l.flujo).every((id) => Object.hasOwn(disp.nodos, id) && disp.nodos[id].tipo === l.flujo[id].class_type));
    check('su clave es plugin:sdxl/nueva-hires', D.delPlugin('plugin:sdxl/nueva-hires') !== null);
  });

  await group('plantillaDe y resolverFlujo con la casilla', async () => {
    const img = (hires) => config({}, { hires_de: hires });
    const pi = P.PERFILES.get('sdxl-illustrious');
    check('prendida: nueva-hires', F.plantillaDe(img({ 'sdxl-illustrious': true }), pi, 'nueva').nombre === 'sdxl/nueva-hires');
    check('apagada o sin entrada: nueva', F.plantillaDe(img({ 'sdxl-illustrious': false }), pi, 'nueva').nombre === 'sdxl/nueva' && F.plantillaDe(img({}), pi, 'nueva').nombre === 'sdxl/nueva');
    check('con { hires: false }: nueva', F.plantillaDe(img({ 'sdxl-illustrious': true }), pi, 'nueva', { hires: false }).nombre === 'sdxl/nueva');
    check('una variación no cambia', F.plantillaDe(img({ 'sdxl-illustrious': true }), pi, 'variacion').nombre === 'sdxl/variacion');
    const unet = { ...copia(pi), id: 'raro', carga: { tipo: 'unet' } };
    check('un sdxl con carga unet sigue sin plantilla', F.plantillaDe(img({ raro: true }), unet, 'nueva').motivo === 'no hay plantilla para esta carga');
    const propio = path.join(raiz, 'mio-nueva.json');
    fs.writeFileSync(propio, fs.readFileSync(path.join(DIR_SDXL, 'nueva.json')));
    // Con su ficha: sin ella, los marcadores de los huecos de LoRA no valen.
    fs.writeFileSync(path.join(raiz, 'mio-nueva.ficha.json'), fs.readFileSync(path.join(DIR_SDXL, 'nueva.ficha.json')));
    const conPropio = config({}, { hires_de: { 'sdxl-illustrious': true }, flujos: { 'sdxl-illustrious': { nueva: { archivo: propio } } } });
    const r = F.resolverFlujo(conPropio, pi, 'nueva');
    check('un flujo propio gana sobre la casilla', r.ok && r.propio && r.nombre === 'mio-nueva.json');
  });

  await group('leerJson: la caché por ruta y mtime', async () => {
    const ruta = path.join(raiz, 'cache.json');
    fs.writeFileSync(ruta, JSON.stringify({ 1: { class_type: 'SaveImage', inputs: { images: '{{prompt}}' } } }));
    const original = fs.readFileSync;
    let lecturas = 0;
    fs.readFileSync = function (...a) { if (a[0] === ruta) lecturas++; return original.apply(this, a); };
    try {
      F.leerFlujo(ruta, { caso: 'nueva' }); F.leerFlujo(ruta, { caso: 'nueva' }); F.leerFlujo(ruta, { caso: 'nueva' });
      check('tres lecturas del mismo archivo: una sola del disco', lecturas === 1, String(lecturas));
      const objA = F.leerFlujo(ruta, { caso: 'nueva' }).flujo; objA['1'].class_type = 'X';
      check('cada lectura da un objeto nuevo (tocarlo no ensucia la caché)', F.leerFlujo(ruta, { caso: 'nueva' }).flujo['1'].class_type === 'SaveImage');
      fs.writeFileSync(ruta, JSON.stringify({ 1: { class_type: 'SaveImage', inputs: { images: '{{prompt}}', x: 1 } } }));
      const t = new Date(Date.now() + 5000); fs.utimesSync(ruta, t, t);
      check('si el archivo cambia, se relee', F.leerFlujo(ruta, { caso: 'nueva' }).flujo['1'].inputs.x === 1 && lecturas === 2, String(lecturas));
    } finally { fs.readFileSync = original; }
  });

  // ------------------------------------------------------- armarPedido
  await group('armarPedido: la segunda pasada y el tope de 4 MP', async () => {
    const pi = P.PERFILES.get('sdxl-illustrious');
    const sec = config({}, { hires_de: { 'sdxl-illustrious': true } });
    const arma = (ancho, alto, logs = []) => armarPedido({ seccion: sec, caso: 'nueva', modelo: WAI, perfil: pi, pedido: { prompt: 'x', negativo: '', ancho, alto, semilla: 7 }, log: (m) => logs.push(m) });
    const a = arma(1088, 1088);
    const final = F.aplicarMarcadores(a.armado, a.datos);
    check('1088²: hires, con 1,5 y 15 pasos como números', a.ok && a.hires && final['10'].inputs.scale_by === 1.5 && final['11'].inputs.steps === 15 && final['11'].inputs.denoise === 0.5);
    check('el segundo KSampler, con la misma semilla y el modelo de los huecos', final['11'].inputs.seed === 7 && JSON.stringify(final['11'].inputs.model) === '["4",0]');
    const logs = [];
    check('1536²: 1,30, con su log', arma(1536, 1536, logs).datos.hires_escala === 1.3 && logs.some((l) => /1\.3×/.test(l)));
    check('2048×1216: 1,26', arma(2048, 1216).datos.hires_escala === 1.26);
    const logs2 = [];
    const g = arma(2048, 2048, logs2);
    check('2048² (un desde del taller): por debajo de 1,25 va con nueva, con su log', g.ok && !g.hires && g.resuelto.nombre === 'sdxl/nueva' && logs2.some((l) => /Sin hires/.test(l)));
    const tres = armarPedido({ seccion: sec, caso: 'nueva', modelo: WAI, perfil: pi, pedido: { prompt: 'x', ancho: 2048, alto: 2048 }, resolverFlujo: (s, p, c) => F.resolverFlujo(s, p, c) });
    check('un resolver de tres argumentos y 2048²: no manda la de hires', !tres.ok && tres.codigo === 'fallo-del-flujo', JSON.stringify({ ok: tres.ok, nombre: tres.resuelto && tres.resuelto.nombre }));
    check('escalaConTope', escalaConTope(1.5, 1088, 1088) === 1.5 && escalaConTope(1.5, 1536, 1536) === 1.3 && escalaConTope(1.25, 1024, 1024) === 1.25);
    const sinCasilla = armarPedido({ seccion: config(), caso: 'nueva', modelo: WAI, perfil: pi, pedido: { prompt: 'x', ancho: 1088, alto: 1088 } });
    check('sin la casilla: nueva y sin hires', sinCasilla.ok && !sinCasilla.hires && sinCasilla.resuelto.nombre === 'sdxl/nueva');
    const propio = path.join(raiz, 'mio-nueva.json');
    const conPropio = config({}, { hires_de: { 'sdxl-illustrious': true }, flujos: { 'sdxl-illustrious': { nueva: { archivo: propio } } } });
    const p = armarPedido({ seccion: conPropio, caso: 'nueva', modelo: WAI, perfil: pi, pedido: { prompt: 'x', ancho: 2048, alto: 2048 } });
    check('un flujo propio no recibe el tope', p.ok && !p.hires && p.resuelto.propio);
    const d = datosDe({ caso: 'nueva', modelo: WAI, perfil: P.PERFILES.get('sdxl-pony'), prompt: 'x', ancho: 1024, alto: 1024 });
    check('datosDe pone siempre los tres', d.hires_escala === 1.5 && d.hires_pasos === 15 && d.hires_fuerza === 0.5);
  });

  await group('generar: con hires, el triple de tiempo', async () => {
    // Un ComfyUI que nunca termina, con un reloj falso: cuánto esperó hasta dar «tiempo».
    const cuanto = async (hires) => {
      let t = 1_000_000;
      const inicio = t;
      const resp = (cuerpo) => ({ ok: true, status: 200, json: async () => cuerpo });
      const fetchImpl = async (url) => {
        const u = new URL(url);
        if (u.pathname === '/prompt') return resp({ prompt_id: 'p1', node_errors: {} });
        if (u.pathname === '/queue') return resp({ queue_running: [[0, 'p1']], queue_pending: [] });
        return resp({});
      };
      const sec = config({}, { tiempo_s: 10, hires_de: hires ? { 'sdxl-illustrious': true } : {} });
      const p = crearComfyui({ config: sec, catalogoDe: () => null, fetchImpl, ahora: () => t, esperar: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } });
      const r = await p.generar({ caso: 'nueva', modelo: WAI, perfil: P.PERFILES.get('sdxl-illustrious'), prompt: 'x', ancho: 1024, alto: 1024, destino: path.join(raiz, `tiempo-${hires}`) });
      return { codigo: r.codigo, ms: t - inicio };
    };
    const sin = await cuanto(false);
    const con = await cuanto(true);
    // Lo que sigue al tope (la espera de la cancelación) es igual en los dos: la diferencia es 2 × tiempo_s.
    check('con hires espera 20 s más que sin (10 s × 3 contra 10 s)', sin.codigo === 'tiempo' && con.codigo === 'tiempo' && con.ms - sin.ms === 20000, JSON.stringify({ sin, con }));
  });

  // ------------------------------------------------------------- casos
  await group('casos: usaModeloPrincipal, el modelo como opción y las LoRAs por modelo', async () => {
    const fill = config({}, { retoque: 'fill' });
    check('usaModeloPrincipal', C.usaModeloPrincipal(config(), 'nueva') && C.usaModeloPrincipal(config(), 'variacion') && C.usaModeloPrincipal(config(), 'retoque') && !C.usaModeloPrincipal(fill, 'retoque') && !C.usaModeloPrincipal(config(), 'edicion'));
    const cfg = config({}, { modelo_edicion: 'flux1-kontext.safetensors' });
    check('estadoComfyui con modelo: lo usa en nueva', C.estadoComfyui(cfg, 'nueva', null, { modelo: PONY }).modelo === PONY && C.estadoComfyui(cfg, 'nueva', null, { modelo: PONY }).perfil.id === 'sdxl-pony');
    check('…y lo ignora en edición', C.estadoComfyui(cfg, 'edicion', null, { modelo: PONY }).modelo === 'flux1-kontext.safetensors');
    const loras = (modelos) => config({}, { loras: [{ archivo: 'a.safetensors', clave: 'acuarela', familias: ['sdxl'], fuerza: 0.8, activo: true, ...(modelos ? { modelos } : {}) }] });
    check('sin modelos: con todos (como hoy)', C.lorasDe(loras(null), 'sdxl', WAI).length === 1 && C.lorasDe(loras(null), 'sdxl').length === 1);
    check('con modelos: solo con esos, «\\» igual a «/»', C.lorasDe(loras(['SDXL\\' + PONY]), 'sdxl', 'SDXL/' + PONY).length === 1 && C.lorasDe(loras([PONY]), 'sdxl', WAI).length === 0);
    check('con modelos y sin saber el modelo: no se ofrece (y no lanza)', C.lorasDe(loras([PONY]), 'sdxl').length === 0);
    const d = C.disponiblesDe(loras([PONY]), { ...auto, modelo: PONY });
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feat-218', 'consigna-2.25.1.json'), 'utf8'));
    const proyectar = (dd) => Object.fromEntries(Object.entries(dd).map(([k, v]) => [k, { proveedores: v.proveedores, afuera: v.afuera, motivo: v.motivo, perfil: v.perfil ? v.perfil.id : null, modelo: v.modelo ?? null, tope: v.tope, huecos: v.huecos, loras: v.loras, seguro: v.seguro }]));
    const distintosDisp = fx.casos.filter((k) => JSON.stringify(proyectar(C.disponiblesDe(fx.configs[k.nombre], { desdeFoto: k.desdeFoto, catalogo: null, manual: () => false }))) !== JSON.stringify(k.disponibles));
    check(`disponiblesDe sin modelo: lo mismo que ${fx.version} en los ${fx.casos.length} casos`, fx.version === '2.25.1' && fx.casos.length === 28 && distintosDisp.length === 0, distintosDisp.map((k) => k.nombre).join());
    check('disponiblesDe con modelo ofrece la LoRA de ese modelo', d.nueva.modelo === PONY && d.nueva.loras.length === 1 && C.disponiblesDe(loras([PONY]), auto).nueva.loras.length === 0);
  });

  await group('candidatosDe', async () => {
    const cands = C.candidatosDe(conCandidatos(), auto);
    check('tres candidatos con su clave y lo que pueden (sin foto, solo nueva)', cands && cands.map((c) => `${c.clave}:${c.puede.join('+')}`).join(' ') === 'wai-nsfw-illustrious-17:nueva ponydiffusionv6xl:nueva sd_xl_base_1.0:nueva');
    const conFoto = C.candidatosDe(conCandidatos(), { ...auto, desdeFoto: true });
    check('con foto: también variación y retoque', conFoto[0].puede.join() === 'nueva,variacion,retoque');
    check('la casilla apagada: no elige', C.candidatosDe(conCandidatos({}, { modelo_automatico: false }), auto) === null);
    check('menos de dos: no elige', C.candidatosDe(conCandidatos({}, { candidatos: [CANDIDATOS[0]] }), auto) === null);
    check('agy primero (y no en manual): no elige', C.candidatosDe(conCandidatos({ orden: ['antigravity', 'comfyui'] }), auto) === null);
    check('agy primero pero en manual: elige', Array.isArray(C.candidatosDe(conCandidatos({ orden: ['antigravity', 'comfyui'] }), { manual: () => true })));
    const cat = catalogo([WAI, BASE]);
    const sinPony = C.candidatosDe(conCandidatos(), { ...auto, catalogo: cat });
    check('uno que no está instalado no se lista', sinPony && sinPony.length === 2 && !sinPony.some((c) => c.archivo === PONY));
    const repetida = C.candidatosDe(conCandidatos({}, { candidatos: [{ archivo: 'a/x.safetensors', para: 'a' }, { archivo: 'b/x.safetensors', para: 'b' }] }), auto);
    check('dos con la misma clave: la segunda lleva -2', repetida && repetida[1].clave === 'x-2');
    const choca = C.candidatosDe(conCandidatos({}, { candidatos: [{ archivo: 'a/x.safetensors', para: 'a' }, { archivo: 'b/x.safetensors', para: 'b' }, { archivo: 'x-2.safetensors', para: 'c' }] }), auto);
    check('una clave natural que choca con una sufijada: todas distintas', choca && choca.map((c) => c.clave).join() === 'x,x-2,x-2-2', choca && choca.map((c) => c.clave).join());
    check('dos en la lista y uno solo instalado: no elige', C.candidatosDe(conCandidatos({}, { candidatos: [CANDIDATOS[0], CANDIDATOS[1]] }), { ...auto, catalogo: catalogo([WAI]) }) === null);
    // Un perfil propio que solo hace nueva, para un candidato que no retoca.
    const soloNueva = { ...copia(P.PERFILES.get('sdxl')), nombre: 'Solo nueva', casos: ['nueva'] };
    const mixta = conCandidatos({ perfiles_propios: { 'solo-nueva': soloNueva } }, { candidatos: [{ archivo: 'solo.safetensors', para: 'solo nuevas' }, { archivo: WAI, para: 'anime' }], perfil_de: { 'solo.safetensors': 'solo-nueva' } });
    const m = C.candidatosDe(mixta, { ...auto, desdeFoto: true });
    check('con foto, uno puede solo nueva y el otro todo: elige (nueva en común)', m && m[0].puede.join() === 'nueva' && m[1].puede.length === 3);
    const distintos = conCandidatos({ perfiles_propios: { 'solo-nueva': soloNueva, 'solo-var': { ...soloNueva, nombre: 'Solo var', casos: ['variacion'] } } }, { candidatos: [{ archivo: 'solo.safetensors', para: 'a' }, { archivo: 'var.safetensors', para: 'b' }], perfil_de: { 'solo.safetensors': 'solo-nueva', 'var.safetensors': 'solo-var' } });
    check('dos que pueden casos distintos, sin uno en común: no elige', C.candidatosDe(distintos, { ...auto, desdeFoto: true }) === null);
  });

  // ---------------------------------------------------------- consigna
  await group('La consigna', async () => {
    const cfg = conCandidatos();
    const disp = C.disponiblesDe(cfg, auto);
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feat-218', 'consigna-2.25.1.json'), 'utf8'));
    const distintas = fx.casos.filter((k) => {
      const dd = C.disponiblesDe(fx.configs[k.nombre], { desdeFoto: k.desdeFoto, catalogo: null, manual: () => false });
      return R.consigna(dd, k.opciones) !== k.consigna || R.consigna(dd, { ...k.opciones, candidatos: null }) !== k.consigna || R.consigna(dd, { ...k.opciones, candidatos: [] }) !== k.consigna;
    });
    check(`sin candidatos: byte por byte la de ${fx.version} (${fx.casos.length} casos; null y [] también)`, fx.version === '2.25.1' && distintas.length === 0, distintas.map((k) => `${k.nombre}/${k.desdeFoto}/${JSON.stringify(k.opciones)}`).join(' '));
    check('sin candidatos, la misma que antes (null o lista vacía)', R.consigna(disp, {}) === R.consigna(disp, { candidatos: null }) && R.consigna(disp, {}) === R.consigna(disp, { candidatos: [] }) && !R.consigna(disp, {}).includes('Models:'));
    const cands = C.candidatosDe(cfg, auto);
    const s = R.consigna(disp, { candidatos: cands });
    check('con candidatos: el bloque Models y el JSON con modelo', s.includes('\nModels:\n- "wai-nsfw-illustrious-17": anime. Can do: nueva.') && s.split('\n')[2].endsWith('"loras": [], "modelo": "<model key>"}.') && s.includes('Choose "modelo" from the list of models'));
    check('cada candidato con su perfil (Pony con source_, WAI con Danbooru)', s.includes('Model profile: Pony V6.') && s.includes('Model profile: Illustrious (WAI).') && s.includes('Model profile: SDXL.'));
    check('sin foto: variación sigue en «Not available now.»', /- variacion: [^\n]*Not available now\./.test(s) && !s.includes('When a photo is attached'));
    check('con foto: la línea del estilo de la foto', R.consigna(C.disponiblesDe(cfg, { ...auto, desdeFoto: true }), { candidatos: C.candidatosDe(cfg, { ...auto, desdeFoto: true }), conFoto: true }).includes('When a photo is attached'));
    // Dos candidatos con el mismo perfil y LoRAs distintas.
    const mismo = conCandidatos({}, {
      candidatos: [{ archivo: 'a-wai.safetensors', para: 'a' }, { archivo: 'b-wai.safetensors', para: 'b' }],
      loras: [{ archivo: 'l1.safetensors', clave: 'uno', familias: ['sdxl'], fuerza: 1, activo: true, modelos: ['a-wai.safetensors'] }, { archivo: 'l2.safetensors', clave: 'dos', familias: ['sdxl'], fuerza: 1, activo: true, modelos: ['b-wai.safetensors'] }]
    });
    const sm = R.consigna(C.disponiblesDe(mismo, auto), { candidatos: C.candidatosDe(mismo, auto) });
    const bloqueB = sm.split('- "b-wai":')[1] || '';
    check('el mismo perfil: una vez, y el segundo con su tope y sus LoRAs', sm.split('Model profile: Illustrious (WAI).').length === 2 && bloqueB.includes('Same profile as "a-wai".') && bloqueB.split('\nCases:')[0].includes('"dos"') && !bloqueB.split('\nCases:')[0].includes('"uno"') && /at most \d+ characters/.test(bloqueB));
    const cf = C.candidatosDe(cfg, { ...auto, desdeFoto: true });
    const sf = R.consigna(C.disponiblesDe(cfg, { ...auto, desdeFoto: true }), { candidatos: cf, conFoto: true });
    const topeWai = Math.min(...cf[0].puede.map((k) => cf[0].disponibles[k].tope));
    const bloqueWai = sf.split('- "wai-nsfw-illustrious-17":')[1].split('\n- "')[0];
    check('el tope del candidato: el mínimo de lo que puede', bloqueWai.includes(`has at most ${topeWai} characters.`), String(topeWai));
    // Un caso que solo puede agy: «Available.» también con candidatos. Los perfiles de todos solo hacen variaciones, así
    // que una nueva solo la hace agy (agy solo declara nueva).
    const sv = { ...copia(P.PERFILES.get('sdxl')), nombre: 'Solo var', casos: ['variacion'] };
    const conAgy = conCandidatos({ orden: ['comfyui', 'antigravity'], perfiles_propios: { 'solo-var': sv } }, { modelo: 'f.safetensors', candidatos: [{ archivo: 'a.safetensors', para: 'a' }, { archivo: 'b.safetensors', para: 'b' }], perfil_de: { 'f.safetensors': 'solo-var', 'a.safetensors': 'solo-var', 'b.safetensors': 'solo-var' } });
    const ka = C.candidatosDe(conAgy, { ...auto, desdeFoto: true });
    const sa = R.consigna(C.disponiblesDe(conAgy, { ...auto, desdeFoto: true }), { candidatos: ka });
    check('una nueva que solo puede agy: Available, y los candidatos solo variación', ka && ka.every((k) => k.puede.join() === 'variacion') && /- nueva: [^\n]*Available\./.test(sa));
    // Dos casos que ningún candidato cubre, con el mismo perfil: el bloque una vez.
    const sn = { ...copia(P.PERFILES.get('sdxl-illustrious')), nombre: 'Solo nueva', casos: ['nueva'] };
    const dos = conCandidatos({ perfiles_propios: { 'solo-nueva': sn } }, { candidatos: [{ archivo: 'a.safetensors', para: 'a' }, { archivo: 'b.safetensors', para: 'b' }], perfil_de: { 'a.safetensors': 'solo-nueva', 'b.safetensors': 'solo-nueva' } });
    const sd = R.consigna(C.disponiblesDe(dos, { ...auto, desdeFoto: true }), { candidatos: C.candidatosDe(dos, { ...auto, desdeFoto: true }) });
    const tramoCasos = sd.split('\nCases:\n')[1] || '';
    check('variación y retoque sin candidato, mismo perfil: el bloque una vez', tramoCasos.split('Model profile: SDXL.').length === 2 && tramoCasos.includes('Same profile as "variacion".'), tramoCasos.slice(0, 200));
    // Edición con Kontext: ningún candidato la cubre y conserva su bloque.
    const ed = conCandidatos({}, { modelo_edicion: 'flux1-kontext.safetensors' });
    const se = R.consigna(C.disponiblesDe(ed, { ...auto, desdeFoto: true }), { candidatos: C.candidatosDe(ed, { ...auto, desdeFoto: true }) });
    const tramoEd = se.split('- edicion:')[1] || '';
    check('edición con Kontext: Available y su perfil', /^[^\n]*Available\./.test(tramoEd) && tramoEd.includes('Model profile: Flux.1 Kontext') && tramoEd.includes('"instruccion" has at most'));
  });

  // ------------------------------------------------------------- sanear
  await group('sanear', async () => {
    const cfg = conCandidatos();
    const disp = C.disponiblesDe(cfg, auto);
    const cands = C.candidatosDe(cfg, auto);
    const r = R.sanear({ caso: 'nueva', prompt: 'source_furry, a fox', modelo: 'ponydiffusionv6xl' }, { disponibles: disp, candidatos: cands });
    check('una clave válida: entrega el archivo, no la clave', r.modelo === PONY && r.modeloAuto === true && !('modeloDescartado' in r));
    const r2 = R.sanear({ caso: 'nueva', prompt: 'x', modelo: 'no-existe' }, { disponibles: disp, candidatos: cands });
    check('una que no existe: el fijo, como si no eligiera (sin modeloDescartado)', !('modelo' in r2) && !('modeloAuto' in r2) && !('modeloDescartado' in r2));
    const r3 = R.sanear({ caso: 'nueva', prompt: 'x' }, { disponibles: disp, candidatos: cands });
    check('sin modelo: el fijo, sin nada', !('modelo' in r3) && !('modeloAuto' in r3) && !('modeloDescartado' in r3));
    // Un candidato sin pesos ni retoque.
    const sinPesos = { ...copia(P.PERFILES.get('sdxl')), nombre: 'Sin pesos', casos: ['nueva'], prompt: { ...copia(P.PERFILES.get('sdxl').prompt), pesos: false } };
    const c2 = conCandidatos({ perfiles_propios: { 'sin-pesos': sinPesos } }, { candidatos: [{ archivo: 'sp.safetensors', para: 'x' }, { archivo: WAI, para: 'anime' }], perfil_de: { 'sp.safetensors': 'sin-pesos' } });
    const d2 = C.disponiblesDe(c2, auto);
    const k2 = C.candidatosDe(c2, auto);
    const rp = R.sanear({ caso: 'nueva', prompt: '(red hat:1.3), a cat', modelo: 'sp' }, { disponibles: d2, candidatos: k2 });
    check('el prompt se limpia con las reglas del elegido (sin pesos)', rp.modelo === 'sp.safetensors' && rp.prompt === 'red hat, a cat', rp.prompt);
    const d2f = C.disponiblesDe(c2, { ...auto, desdeFoto: true });
    const k2f = C.candidatosDe(c2, { ...auto, desdeFoto: true });
    const rr = R.sanear({ caso: 'retoque', prompt: 'red hat', zona: 'the hat', modelo: 'sp' }, { disponibles: d2f, candidatos: k2f, desdeFoto: true });
    check('un elegido sin retoque y un retoque con zona: retoque con el fijo, sin bajar', rr.caso === 'retoque' && !rr.modeloAuto && rr.modeloDescartado === 'sp');
    const ed = conCandidatos({}, { modelo_edicion: 'flux1-kontext.safetensors' });
    const re = R.sanear({ caso: 'edicion', prompt: 'x', instruccion: 'make it red', modelo: 'ponydiffusionv6xl' }, { disponibles: C.disponiblesDe(ed, { ...auto, desdeFoto: true }), candidatos: C.candidatosDe(ed, { ...auto, desdeFoto: true }), desdeFoto: true });
    check('una edición con candidatos: sin modeloAuto', re.caso === 'edicion' && !re.modeloAuto);
  });

  // -------------------------------------------------------------- cola
  const clave = 'alya';
  const registro = { tarea: (id) => tareas.obtener(id), actualizar: (id, c) => tareas.actualizar(id, c) };
  const nuevaTarea = () => { const t = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave }, pedido: 'hola' }); tareas.actualizar(t.id, { estado: 'ok' }); return t.id; };
  const entrada = (id, n = 1) => (tareas.obtener(id).imagenes || []).find((e) => e.n === n);
  const prov = (id, fn = () => ({ ok: true })) => ({ id, vistos: [], async generar(op) { this.vistos.push(op); const r = await fn(op); if (!r.ok) return { proveedor: id, ...r }; const ruta = `${op.destino}.png`; fs.writeFileSync(ruta, PNG); return { ok: true, ruta, tipo: 'image/png', ancho: op.ancho, alto: op.alto, semilla: 5, proveedor: id, modelo: op.modelo || null }; } });
  const elige = (modelo, antes = () => {}) => ({ async refinar(o) { await antes(); return { ...R.sanear({ caso: 'nueva', prompt: 'x', modelo }, { disponibles: o.disponibles, candidatos: o.candidatos, desdeFoto: o.desdeFoto }), refinado: true, vistosCandidatos: o.candidatos }; }, sinRefinar: R.sinRefinar });
  const armar = ({ provs, cfg, ref, cat = null, enCache = null, logs = [], taller = null }) => crearColaImagenes({ registro, proveedor: (id) => provs[id] || null, leerConfig: cfg, refinador: ref, vision: { llamar: async () => ({ ok: false }) }, manual: () => false, catalogoDe: async () => cat, catalogoEnCache: () => enCache, log: (m) => logs.push(m), env: process.env, taller });
  const termina = (id, n = 1) => hasta(() => entrada(id, n) && entrada(id, n).estado !== 'generando');

  await group('La cola: el modelo elegido', async () => {
    const c = prov('comfyui');
    const id = nuevaTarea();
    const cola = armar({ provs: { comfyui: c }, cfg: () => conCandidatos(), ref: elige('ponydiffusionv6xl') });
    cola.encolar({ tareaId: id, clave, pedido: 'un zorro furry' });
    await termina(id);
    const e = entrada(id);
    const priv = indice.leer(clave, id, 1);
    check('el elegido llega a generar con su perfil', c.vistos[0].modelo === PONY && c.vistos[0].perfil.id === 'sdxl-pony');
    check('la entrada del turno (por el registro) dice modeloAuto', e.estado === 'lista' && e.modelo === PONY && e.modeloAuto === true);
    check('el índice guarda el modelo y modeloAuto', priv.modelo === PONY && priv.modeloAuto === true);
    // La galería.
    const g = crearGaleria({ cola, registro, leerConfig: () => conCandidatos() });
    const fila = g.listar({ alma: clave }).imagenes.find((i) => i.tareaId === id);
    check('la fila de la galería trae modeloAuto', fila && fila.modelo === PONY && fila.modeloAuto === true);
    // «Otra versión», con la casilla apagada después: el mismo modelo.
    let cfgActual = conCandidatos();
    const c2 = prov('comfyui');
    const cola2 = armar({ provs: { comfyui: c2 }, cfg: () => cfgActual, ref: elige('wai-nsfw-illustrious-17') });
    cfgActual = conCandidatos({}, { modelo_automatico: false, candidatos: [] });
    const o = cola2.otra(id, 1);
    check('otra versión se encola', o.ok, JSON.stringify(o));
    await termina(id, o.n);
    check('otra versión: el mismo modelo, aunque se apagó la casilla', c2.vistos[0] && c2.vistos[0].modelo === PONY && entrada(id, o.n).modeloAuto === true);
    // El modelo de antes ya no está instalado: el fijo.
    const c3 = prov('comfyui');
    const logs = [];
    const cola3 = armar({ provs: { comfyui: c3 }, cfg: () => conCandidatos(), ref: elige('x'), cat: catalogo([BASE]), logs });
    const o3 = cola3.otra(id, 1);
    await termina(id, o3.n);
    check('otra versión de una cuyo modelo ya no está: el fijo, sin modeloAuto, con su log', c3.vistos[0] && c3.vistos[0].modelo === BASE && entrada(id, o3.n).modeloAuto === false && logs.some((l) => /el modelo de antes ya no puede/.test(l)));
  });

  await group('La cola: cuando el elegido no vale al generar', async () => {
    // Sacan al elegido de la lista mientras refinaba.
    let cfgActual = conCandidatos();
    const c = prov('comfyui');
    const id = nuevaTarea();
    const logs = [];
    armar({ provs: { comfyui: c }, cfg: () => cfgActual, ref: elige('ponydiffusionv6xl', () => { cfgActual = conCandidatos({}, { candidatos: [CANDIDATOS[0], CANDIDATOS[2]] }); }), logs }).encolar({ tareaId: id, clave, pedido: 'x' });
    await termina(id);
    check('el elegido dejó de ser candidato: el fijo y su log', c.vistos[0].modelo === BASE && entrada(id).modeloAuto === false && logs.some((l) => /ya no está o no puede/.test(l)));
    // Borran a otro candidato: el elegido sigue.
    cfgActual = conCandidatos();
    const c2 = prov('comfyui');
    const id2 = nuevaTarea();
    armar({ provs: { comfyui: c2 }, cfg: () => cfgActual, ref: elige('ponydiffusionv6xl', () => { cfgActual = conCandidatos({}, { candidatos: [CANDIDATOS[1]] }); }) }).encolar({ tareaId: id2, clave, pedido: 'x' });
    await termina(id2);
    check('el otro candidato borrado: el elegido sigue', c2.vistos[0].modelo === PONY && entrada(id2).modeloAuto === true);
    // ComfyUI falla y la hace agy.
    const cae = prov('comfyui', () => ({ ok: false, codigo: 'no-responde' }));
    const agy = prov('antigravity');
    const id3 = nuevaTarea();
    armar({ provs: { comfyui: cae, antigravity: agy }, cfg: () => conCandidatos({ orden: ['comfyui', 'antigravity'] }), ref: elige('ponydiffusionv6xl') }).encolar({ tareaId: id3, clave, pedido: 'x' });
    await termina(id3);
    check('la hizo agy: sin modeloAuto', entrada(id3).proveedor === 'antigravity' && entrada(id3).modeloAuto === false && indice.leer(clave, id3, 1).modeloAuto === false);
    // Sin candidatos, la cola no pasa nada nuevo al refinador.
    let vistos = 'x';
    const id4 = nuevaTarea();
    armar({ provs: { comfyui: prov('comfyui') }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false }), ref: { async refinar(o) { vistos = o.candidatos; return { ...R.sanear({ caso: 'nueva', prompt: 'x' }, { disponibles: o.disponibles }), refinado: true }; }, sinRefinar: R.sinRefinar } }).encolar({ tareaId: id4, clave, pedido: 'x' });
    await termina(id4);
    check('sin candidatos: el refinador recibe null', vistos === null && entrada(id4).modeloAuto === false);
  });

  await group('La cola: primeroComfy con el modelo de una repetición', async () => {
    // El fijo solo hace variaciones: una nueva con él va a agy. El de la repetición (Pony) sí hace nuevas.
    const soloVar = { ...copia(P.PERFILES.get('sdxl')), nombre: 'Solo var', casos: ['variacion'] };
    const cfg = config({ orden: ['comfyui', 'antigravity'], alma_la_ve: false, perfiles_propios: { 'solo-var': soloVar } }, { modelo: 'fijo.safetensors', perfil_de: { 'fijo.safetensors': 'solo-var' } });
    const pc = (enCache) => armar({ provs: {}, cfg: () => cfg, ref: elige(null), enCache })._primeroComfy({ modelo: PONY }, cfg);
    check('sin el modelo de antes, el fijo: agy primero', armar({ provs: {}, cfg: () => cfg, ref: elige(null) })._primeroComfy({}, cfg) === false);
    check('con job.modelo que puede: ComfyUI primero', pc(null) === true);
    check('con job.modelo instalado según la caché: ComfyUI primero', pc(catalogo([PONY, 'fijo.safetensors'])) === true);
    check('con job.modelo que ya no está instalado (la caché lo dice): el fijo, agy primero', pc(catalogo(['fijo.safetensors'])) === false);
  });

  await group('La cola: el preparado del taller', async () => {
    let datos = null;
    const taller = { preparar: (d) => { datos = d; return { ok: true, id: 'p-0123456789abcdef' }; }, fallo: () => {} };
    const id = nuevaTarea();
    armar({ provs: { comfyui: prov('comfyui') }, cfg: () => conCandidatos(), ref: elige('ponydiffusionv6xl'), taller }).encolar({ tareaId: id, clave, pedido: 'x', destino: 'taller' });
    await hasta(() => datos !== null);
    check('el preparado lleva el elegido y modeloAuto', datos && datos.modelo === PONY && datos.perfil === 'sdxl-pony' && datos.modeloAuto === true);
  });

  // --------------------------------------------------- turno y contrato
  await group('modeloAuto en el turno y en el contrato', async () => {
    const e = tareas.normalizarImagen({ n: 1, estado: 'lista', modeloAuto: false });
    check('normalizarImagen conserva false (explícito)', e.modeloAuto === false && tareas.normalizarImagen({ n: 1, estado: 'lista', modeloAuto: 1 }).modeloAuto === true);
    check('camposDeImagen: false por defecto', camposDeImagen({ archivo: 'a', tipo: 'image/png', externo: false, sha256: 'x', proveedor: 'comfyui', bytes: 1 }).modeloAuto === false);
    check('imagenesDe lo emite', imagenesDe([{ n: 1, estado: 'lista', modeloAuto: true }])[0].modeloAuto === true && !('modeloAuto' in imagenesDe([{ n: 1, estado: 'lista' }])[0]));
    const c = JSON.parse(fs.readFileSync(path.join(RAIZ, 'telegram-bridge/web/contrato-v2.json'), 'utf8'));
    let ok = true;
    try { revisarContrato(c); } catch { ok = false; }
    let esquema = null;
    (function ver(o) { if (o && typeof o === 'object') { if (o.imagenes?.items?.properties?.casoPedido) esquema = o.imagenes; Object.values(o).forEach(ver); } })(c);
    check('el contrato conoce modeloAuto (boolean)', ok && esquema && esquema.items.properties.modeloAuto.type === 'boolean');
    const tm = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave: 'alya' }, pedido: 'hola' });
    tareas.actualizar(tm.id, { estado: 'ok', imagenes: [{ n: 1, estado: 'lista', proveedor: 'comfyui', modelo: PONY, modeloAuto: true }, { n: 2, estado: 'lista', proveedor: 'comfyui', modeloAuto: false }] });
    const turno = turnoDe(tareas.obtener(tm.id), { recorte: '…' });
    const malo = copia(turno); malo.imagenes[0].modeloAuto = 'si';
    check('un turno con modeloAuto (true y false) vale contra el contrato, y con un texto no', turno.imagenes[0].modeloAuto === true && turno.imagenes[1].modeloAuto === false && validar(c, 'turno', turno).length === 0 && validar(c, 'turno', malo).length > 0, JSON.stringify(validar(c, 'turno', turno)));
  });

  // ------------------------------------------------------------ ajustes
  await group('Ajustes: normalizar', async () => {
    const n = A.normalizar({ comfyui: { modelo_automatico: false, candidatos: CANDIDATOS, hires_de: { sdxl: true, 'sdxl-pony': false } } }).imagenes;
    check('defectos: casilla prendida, sin candidatos, sin hires', A.defectos().comfyui.modelo_automatico === true && A.defectos().comfyui.candidatos.length === 0 && Object.keys(A.defectos().comfyui.hires_de).length === 0);
    check('las tres claves llegan al runtime', n.comfyui.modelo_automatico === false && n.comfyui.candidatos.length === 3 && n.comfyui.hires_de.sdxl === true && P.hiresActivo(n, P.PERFILES.get('sdxl')));
    const mala = A.normalizar({ comfyui: { candidatos: [{ archivo: 'a', para: '' }], hires_de: { sdxl: 'si' } } });
    check('lo que no vale se ignora con su aviso', mala.imagenes.comfyui.candidatos.length === 0 && mala.invalidos.some((x) => /candidatos/.test(x.donde || x.campo || JSON.stringify(x))) && mala.imagenes.comfyui.hires_de.sdxl === undefined);
  });

  await group('Ajustes: aplicarImagenes', async () => {
    const tira = (f) => { try { f(); return null; } catch (e) { return e; } };
    const aplica = (pedido, datos = {}) => A.aplicarImagenes({ imagenes: datos }, pedido).imagenes;
    const ok = aplica({ comfyui: { modelo_automatico: true, candidatos: CANDIDATOS, hires_de: { 'sdxl-illustrious': true } } });
    check('guarda las tres', ok.comfyui.modelo_automatico === true && ok.comfyui.candidatos.length === 3 && ok.comfyui.hires_de['sdxl-illustrious'] === true);
    check('5 candidatos: 400', tira(() => aplica({ comfyui: { candidatos: [...CANDIDATOS, { archivo: 'd.st', para: 'd' }, { archivo: 'e.st', para: 'e' }] } })).campo === 'imagenes.comfyui.candidatos');
    check('«para qué sirve» vacío o de 201: 400', /para/.test(tira(() => aplica({ comfyui: { candidatos: [{ archivo: 'a.st', para: ' ' }] } })).campo) && /para/.test(tira(() => aplica({ comfyui: { candidatos: [{ archivo: 'a.st', para: 'x'.repeat(201) }] } })).campo));
    check('un archivo repetido: 400', /archivo/.test(tira(() => aplica({ comfyui: { candidatos: [{ archivo: 'a/x.st', para: 'a' }, { archivo: 'a\\x.st', para: 'b' }] } })).campo));
    check('hires de un perfil de Flux: 400, con true y con false', /hires_de\.flux/.test(tira(() => aplica({ comfyui: { hires_de: { flux: true } } })).campo) && /hires_de\.flux/.test(tira(() => aplica({ comfyui: { hires_de: { flux: false } } })).campo));
    const leido = A.normalizar(aplica({ comfyui: { modelo_automatico: false, candidatos: CANDIDATOS, hires_de: { 'sdxl-illustrious': true } } })).imagenes;
    check('guardar y leer: las tres vuelven igual', leido.comfyui.modelo_automatico === false && leido.comfyui.candidatos.length === 3 && leido.comfyui.hires_de['sdxl-illustrious'] === true);
    check('hires de un perfil que no existe: 400', /hires_de\.nope/.test(tira(() => aplica({ comfyui: { hires_de: { nope: true } } })).campo));
    // Las LoRAs de un Desktop viejo (sin `modelos`).
    const lora = { archivo: 'l.safetensors', clave: 'acuarela', familias: ['sdxl'], fuerza: 0.8, activo: true };
    const con = aplica({ comfyui: { loras: [{ ...lora, modelos: [PONY] }] } });
    const viejo = aplica({ comfyui: { loras: [{ ...lora, fuerza: 0.5 }] } }, con);
    check('un PATCH sin modelos conserva los de antes', viejo.comfyui.loras[0].fuerza === 0.5 && JSON.stringify(viejo.comfyui.loras[0].modelos) === JSON.stringify([PONY]));
    const sinRestriccion = aplica({ comfyui: { loras: [{ ...lora, modelos: null }] } }, con);
    check('modelos: null la saca', !('modelos' in sinRestriccion.comfyui.loras[0]));
    check('modelos con 11: 400', /modelos/.test(tira(() => aplica({ comfyui: { loras: [{ ...lora, modelos: Array.from({ length: 11 }, (_, i) => `m${i}.st`) }] } })).campo));
    // El hires de un perfil propio.
    const propio = { ...copia(P.PERFILES.get('sdxl')), nombre: 'Mío' };
    delete propio.id;
    const p1 = aplica({ perfiles_propios: { mio: propio } });
    check('un propio copiado de sdxl guarda su hires', p1.perfiles_propios.mio.muestreo.hires.pasos === 15);
    const sinHires = copia(propio); delete sinHires.muestreo.hires; sinHires.nombre = 'Otro nombre';
    const p2 = aplica({ perfiles_propios: { mio: sinHires } }, p1);
    check('sin muestreo.hires en el pedido: se conserva', p2.perfiles_propios.mio.nombre === 'Otro nombre' && p2.perfiles_propios.mio.muestreo.hires.pasos === 15);
    const conNull = copia(propio); conNull.muestreo.hires = null;
    const p3 = aplica({ perfiles_propios: { mio: conNull } }, p1);
    check('muestreo.hires: null lo saca', !('hires' in p3.perfiles_propios.mio.muestreo));
  });

  await group('Ajustes: lo que ve Desktop (v2)', async () => {
    const propio = { ...copia(P.PERFILES.get('sdxl')), nombre: 'Mío' };
    delete propio.id;
    const datos = { imagenes: { perfiles_propios: { mio: propio }, comfyui: { candidatos: CANDIDATOS, hires_de: { sdxl: true }, loras: [{ archivo: 'l.st', clave: 'a', familias: ['sdxl'], fuerza: 1, activo: true, modelos: [PONY] }] } } };
    const v = ajustesV2({ imagenes: A.leerImagenes(datos).imagenes }).imagenes;
    check('comfyuiV2: modelo_automatico (la señal), candidatos, hires_de y modelos', v.comfyui.modelo_automatico === true && v.comfyui.candidatos.length === 3 && v.comfyui.hires_de.sdxl === true && v.comfyui.loras[0].modelos[0] === PONY);
    const mio = v.perfiles_propios && v.perfiles_propios.mio;
    check('perfilImagenV2: muestreo.hires', mio && mio.muestreo.hires && mio.muestreo.hires.escala === 1.5 && mio.muestreo.hires.pasos === 15, JSON.stringify(mio && mio.muestreo));
  });

  for (const d of [raiz]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  report();
}

main().catch((err) => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {} console.error(err); process.exit(1); });
