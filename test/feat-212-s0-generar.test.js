/**
 * FEAT-212 S0 — La generación: el grafo final de cada plantilla con su perfil, los LoRAs, la máscara y sus errores, la
 * cola (casos, bajada, repetir, proveedores), el reconocimiento por Telegram, el turno y el contrato.
 *
 * Sin red, sin agy y sin ComfyUI: todo se inyecta.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat212-generar-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.LAGRANGE_ALMAS_DIR, { recursive: true });

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indice = require('../mcp-server/imagenes/indice.js');
const codigos = require('../mcp-server/imagenes/codigos.js');
const A = require('../mcp-server/lib/ajustes-imagenes.js');
const P = require('../mcp-server/imagenes/perfiles.js');
const F = require('../mcp-server/imagenes/flujos.js');
const C = require('../mcp-server/imagenes/casos.js');
const R = require('../mcp-server/imagenes/refinador.js');
const sondaVision = require('../mcp-server/imagenes/sonda-vision.js');

const PNG = sondaVision.pngSolido(8, [200, 10, 10]);
const hasta = async (cond, ms = 3000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); } return cond(); };
const config = (extra = {}, comfy = {}) => { const d = A.defectos(); return { ...d, ...extra, comfyui: { ...d.comfyui, ...comfy } }; };

/** Un PNG de `ancho`×`alto` con `marcados` píxeles en `valor` y el resto en negro. */
function png(ancho, alto, marcados, { valor = 255, tipo = 0, bits = 8, filtro = 0, entrelazado = 0, canales = { 0: 1, 2: 3, 4: 2, 6: 4 }[tipo] } = {}) {
  const crcTabla = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTabla[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const trozo = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'latin1'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4); ihdr[8] = bits; ihdr[9] = tipo; ihdr[12] = entrelazado;
  const fila = ancho * canales;
  const px = Buffer.alloc(fila * alto);
  for (let i = 0; i < marcados; i++) for (let c = 0; c < canales; c++) px[i * canales + c] = canales === 4 && c === 3 ? 255 : valor;
  const crudo = Buffer.alloc((fila + 1) * alto);
  for (let y = 0; y < alto; y++) {
    crudo[y * (fila + 1)] = filtro;
    for (let x = 0; x < fila; x++) {
      const v = px[y * fila + x];
      const a = x >= canales ? px[y * fila + x - canales] : 0;
      const b = y > 0 ? px[(y - 1) * fila + x] : 0;
      const c = x >= canales && y > 0 ? px[(y - 1) * fila + x - canales] : 0;
      const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      crudo[y * (fila + 1) + 1 + x] = (v - [0, a, b, (a + b) >> 1, paeth][filtro]) & 0xff;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo('IHDR', ihdr), trozo('IDAT', zlib.deflateSync(crudo)), trozo('IEND', Buffer.alloc(0))]);
}
const MASCARA_OK = png(256, 256, 655);

/** Un ComfyUI falso que entrega la imagen y la máscara. */
function comfyFalso({ mascara = MASCARA_OK, error = null, conMascara = true } = {}) {
  const pedidos = [];
  const resp = (cuerpo, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => cuerpo, arrayBuffer: async () => (Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from('')) });
  const outputs = { 9: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] }, ...(conMascara ? { 21: { images: [{ filename: 'm.png', subfolder: '', type: 'temp' }] } } : {}) };
  const fetchImpl = async (url, op = {}) => {
    const u = new URL(url);
    pedidos.push({ ruta: u.pathname, query: u.search, cuerpo: typeof op.body === 'string' ? JSON.parse(op.body) : null });
    if (u.pathname === '/upload/image') return resp({ name: 'subida.png', subfolder: '' });
    if (u.pathname === '/prompt') return resp({ prompt_id: 'p1', node_errors: {} });
    if (u.pathname.startsWith('/history/')) {
      return resp({ p1: error
        ? { status: { status_str: 'error', completed: false, messages: [['execution_start', {}], ['execution_error', { node_type: 'X', exception_message: 'boom', ...error }]] }, outputs: conMascara ? { 21: outputs[21] } : {} }
        : { status: { status_str: 'success', completed: true }, outputs } });
    }
    if (u.pathname === '/view') return resp(u.search.includes('m.png') ? mascara : PNG);
    if (u.pathname === '/queue') return resp({ queue_running: [], queue_pending: [] });
    return resp({});
  };
  return { fetchImpl, pedidos, grafo: () => pedidos.find((x) => x.ruta === '/prompt')?.cuerpo.prompt };
}
const reloj = () => { let t = 1e6; return { ahora: () => t, esperar: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); } }; };

async function main() {
  const { crearComfyui, probarComfyui } = await importar('telegram-bridge/imagenes/comfyui.js');
  const mascaras = await importar('telegram-bridge/imagenes/mascara.js');
  const { sinRutas } = await importar('telegram-bridge/imagenes/sanear-texto.js');
  const { crearColaImagenes } = await importar('telegram-bridge/imagenes-cola.js');
  const tareas = await importar('telegram-bridge/tareas.js');
  const tmp = path.join(raiz, 'tmp'); fs.mkdirSync(tmp);
  const foto = path.join(tmp, 'foto.png'); fs.writeFileSync(foto, PNG);
  let nDestino = 0;
  const generar = (cfg, caso, perfilId, extra = {}, falso = comfyFalso(), log = () => {}, cat = null) => {
    const perfil = P.perfil(cfg, perfilId);
    return crearComfyui({ config: cfg, fetchImpl: falso.fetchImpl, catalogoDe: () => cat, log, ...reloj() }).generar({
      caso, modelo: 'modelo.safetensors', perfil, prompt: 'a cat', negativo: 'ugly', ancho: perfil.medidas['3:4'][0], alto: perfil.medidas['3:4'][1], semilla: 7,
      foto: caso === 'nueva' ? null : foto, zona: 'the hat', instruccion: 'change the hat', destino: path.join(tmp, `d${nDestino++}`), ...extra
    });
  };

  await group('El grafo final de cada plantilla, con los valores de su perfil', async () => {
    for (const [id, p] of P.PERFILES) {
      for (const caso of p.casos) {
        for (const motor of caso === 'retoque' ? ['florence2', 'sam2'] : ['florence2']) {
          const f = comfyFalso();
          const r = await generar(config({}, { mascara: motor }), caso, id, {}, f);
          const g = f.grafo() || {};
          const ks = Object.values(g).find((n) => n.class_type === 'KSampler')?.inputs || {};
          const m = p.muestreo;
          const que = `${id}/${caso}${caso === 'retoque' ? `/${motor}` : ''}`;
          check(`${que}: sale`, r.ok, JSON.stringify(r));
          check(`${que}: sin marcadores sueltos`, F.marcadoresDe(g).size === 0);
          check(`${que}: pasos, cfg, sampler y scheduler del perfil`, ks.steps === m.pasos && ks.cfg === m.cfg && typeof ks.cfg === 'number' && ks.sampler_name === m.sampler && ks.scheduler === m.scheduler);
          if (caso === 'variacion' || caso === 'retoque') check(`${que}: la fuerza del perfil para ese caso`, ks.denoise === (caso === 'retoque' ? m.fuerzaRetoque : m.fuerza));
          if (m.guia !== null) check(`${que}: la guía`, Object.values(g).find((n) => n.class_type === 'FluxGuidance').inputs.guidance === m.guia);
          if (caso === 'nueva') { const l = Object.values(g).find((n) => /Latent(Image)?$/.test(n.class_type) && n.inputs.width); check(`${que}: las medidas`, l.inputs.width === p.medidas['3:4'][0] && l.inputs.height === p.medidas['3:4'][1]); }
          if (p.carga.tipo === 'unet') check(`${que}: unet, clips y vae`, g[4].inputs.unet_name === 'modelo.safetensors' && g[13].inputs.clip_name1 === p.carga.clip1 && g[14].inputs.vae_name === p.carga.vae);
          else check(`${que}: el checkpoint`, g[4].inputs.ckpt_name === 'modelo.safetensors');
          if (caso === 'retoque') check(`${que}: la zona`, JSON.stringify(g).includes('"the hat"'));
          if (caso === 'edicion') check(`${que}: la instrucción`, JSON.stringify(g).includes('"change the hat"'));
          check(`${que}: sin LoRAs, los huecos se puentean`, !Object.values(g).some((n) => /^LoraLoader/.test(n.class_type)));
          const ids = new Set(Object.keys(g));
          check(`${que}: ningún enlace queda colgado`, Object.values(g).every((n) => Object.values(n.inputs).every((v) => !Array.isArray(v) || ids.has(String(v[0])))));
        }
      }
    }
  });

  await group('LoRAs: puentear, chequear y sustituir', async () => {
    const L = (n) => Array.from({ length: n }, (_, i) => ({ clave: `c${i}`, archivo: `l${i}.safetensors`, fuerza: 0.6 }));
    for (const n of [0, 1, 4]) {
      const f = comfyFalso();
      const r = await generar(config(), 'nueva', 'sdxl', { loras: L(n) }, f);
      const g = f.grafo();
      const lo = Object.values(g).filter((x) => x.class_type === 'LoraLoader');
      check(`${n} LoRAs en SDXL`, r.ok && lo.length === n && lo.every((x) => x.inputs.strength_model === 0.6 && x.inputs.strength_clip === 0.6) && r.loras.length === n, JSON.stringify(r));
      check(`${n} LoRAs: el modelo llega al sampler por la cadena`, JSON.stringify(g[3].inputs.model) === JSON.stringify(n ? [String(100 + n), 0] : ['4', 0]) && JSON.stringify(g[6].inputs.clip) === JSON.stringify(n ? [String(100 + n), 1] : ['4', 1]));
    }
    const f = comfyFalso();
    await generar(config(), 'nueva', 'flux', { loras: L(2) }, f);
    check('LoraLoaderModelOnly se puentea solo por model', f.grafo()[3].inputs.model[0] === '102' && f.grafo()[6].inputs.clip[0] === '13');
    const logs = [];
    const g2 = comfyFalso();
    const r2 = await generar(config(), 'nueva', 'sdxl', { loras: L(2) }, g2, (l) => logs.push(l), { loras: [{ valor: 'l1.safetensors' }] });
    check('con catálogo, uno que no está se saltea y se avisa', r2.loras.length === 1 && r2.loras[0].clave === 'c1' && g2.grafo()[101].inputs.lora_name === 'l1.safetensors' && logs.some((l) => l.includes('c0')));
    const g3 = comfyFalso();
    await generar(config(), 'nueva', 'sdxl', { loras: L(2) }, g3);
    const g4 = comfyFalso();
    const win = { checkpoints: [{ valor: 'SDXL\\m.safetensors' }], unets: [], clips: [], vaes: [], loras: [{ valor: 'a\\l0.safetensors' }] };
    const r4 = await generar(config(), 'nueva', 'sdxl', { modelo: 'SDXL/m.safetensors', loras: [{ clave: 'c0', archivo: 'a/l0.safetensors', fuerza: 1 }] }, g4, () => {}, win);
    check('con `/` en Ajustes va el nombre exacto que lista ComfyUI', r4.ok && g4.grafo()[4].inputs.ckpt_name === 'SDXL\\m.safetensors' && Object.values(g4.grafo()).some((x) => x.inputs.lora_name === 'a\\l0.safetensors'));
    const conProto = JSON.parse('{"__proto__":{"class_type":"Nota","inputs":{}},"11":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["4",0]}},"3":{"class_type":"KSampler","inputs":{"model":["11",0]}}}');
    const pu = F.puentear(conProto, ['11'], 0);
    check('puentear no pierde un nodo llamado __proto__', Object.keys(pu).join() === '3,__proto__' && pu[3].inputs.model[0] === '4');
    check('sin catálogo no se saltea ninguno', Object.values(g3.grafo()).filter((x) => x.class_type === 'LoraLoader').length === 2);
  });

  await group('Marcadores: el chequeo antes de mandar', async () => {
    const propio = (nombre, textos, nodos = {}) => { const r = path.join(tmp, nombre); fs.writeFileSync(r, JSON.stringify({ 4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{modelo}}' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: textos } }, 9: { class_type: 'SaveImage', inputs: {} }, ...nodos })); return config({}, { flujos: { sdxl: { nueva: { archivo: r, salida: null } } } }); };
    const f1 = comfyFalso();
    const r1 = await generar(propio('u.json', '{{prompt}} {{unet}}'), 'nueva', 'sdxl', {}, f1);
    check('un marcador que el perfil no da frena con flujo-marcador', r1.codigo === 'flujo-marcador' && r1.extra.marcador === 'unet' && !f1.grafo());
    check('…y su texto', codigos.mensajeDe('flujo-marcador', r1.extra) === 'El flujo usa {{unet}} y este caso no lo da.');
    const r2 = await generar(propio('g.json', '{{prompt}}', { 15: { class_type: 'FluxGuidance', inputs: { guidance: '{{guia}}' } } }), 'nueva', 'sdxl', {});
    check('un decimal null también', r2.codigo === 'flujo-marcador' && r2.extra.marcador === 'guia');
    const r3 = await generar(propio('a.json', '{{prompt}}', { 5: { class_type: 'EmptyLatentImage', inputs: { width: '{{ancho}}' } } }), 'nueva', 'sdxl', { ancho: undefined });
    check('un entero undefined también', r3.codigo === 'flujo-marcador' && r3.extra.marcador === 'ancho');
    const f4 = comfyFalso();
    const r4 = await generar(config(), 'nueva', 'sdxl', { prompt: 'a {{hello}} and {{modelo}}' }, f4);
    check('un prompt con llaves no frena ni se sustituye', r4.ok && f4.grafo()[6].inputs.text === 'a {{hello}} and {{modelo}}');
    const viejo = path.join(tmp, 'v.json');
    fs.writeFileSync(viejo, JSON.stringify({ 4: { class_type: 'UNETLoader', inputs: { unet_name: '{{modelo}}' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}} {{fuerza}}' } }, 9: { class_type: 'SaveImage', inputs: {} } }));
    const f5 = comfyFalso();
    const r5 = await generar(config({}, { flujos: { flux: { nueva: { archivo: viejo, salida: '9' } } } }), 'nueva', 'flux', {}, f5);
    check('un flujo de 2.18 con UNETLoader y {{modelo}} genera', r5.ok && f5.grafo()[4].inputs.unet_name === 'modelo.safetensors');
    const soloPrompt = path.join(tmp, 'kp.json');
    fs.writeFileSync(soloPrompt, JSON.stringify({ 4: { class_type: 'UNETLoader', inputs: { unet_name: '{{unet}}' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, 10: { class_type: 'LoadImage', inputs: { image: '{{foto}}' } }, 9: { class_type: 'SaveImage', inputs: {} } }));
    const f6 = comfyFalso();
    await generar(config({}, { flujos: { 'flux-kontext': { edicion: { archivo: soloPrompt, salida: '9' } } } }), 'edicion', 'flux-kontext', {}, f6);
    check('un flujo de edición solo con {{prompt}} recibe la instrucción', f6.grafo()[6].inputs.text === 'change the hat' && f6.grafo()[10].inputs.image === 'subida.png');
  });

  await group('La máscara: el lector PNG', () => {
    const { leerPng, chequearMascara, parteMarcada } = mascaras;
    for (const tipo of [0, 2, 6]) for (const filtro of [0, 1, 2, 3, 4]) check(`tipo ${tipo}, filtro ${filtro}`, Math.abs(parteMarcada(png(64, 64, 1000, { tipo, filtro })) - 1000 / 4096) < 1e-9);
    check('todo negro: vacía', chequearMascara(png(256, 256, 0)) === 'vacia');
    check('un píxel de ruido: vacía', chequearMascara(png(256, 256, 1)) === 'vacia');
    check('1 %: ok', chequearMascara(png(256, 256, 655)) === 'ok');
    for (const l of [256, 512]) check(`${l}: 0,04 % vacía y 0,06 % ok`, chequearMascara(png(l, l, Math.floor(l * l * 0.0004))) === 'vacia' && chequearMascara(png(l, l, Math.ceil(l * l * 0.0006))) === 'ok');
    check('gris 127 no cuenta y 128 sí', chequearMascara(png(256, 256, 655, { valor: 127 })) === 'vacia' && chequearMascara(png(256, 256, 655, { valor: 128 })) === 'ok');
    check('toda blanca: cubre', chequearMascara(png(256, 256, 65536)) === 'cubre');
    check('16 bits, entrelazado o gris con alfa: ilegible', ['ilegible', 'ilegible', 'ilegible'].join() === [png(8, 8, 1, { bits: 16 }), png(8, 8, 1, { entrelazado: 1 }), png(8, 8, 1, { tipo: 4 })].map(chequearMascara).join());
    const enorme = png(8, 8, 1); enorme.writeUInt32BE(20000, 16); enorme.writeUInt32BE(20000, 20);
    check('20000×20000 se rechaza antes de descomprimir', leerPng(enorme) === null);
    const bomba = Buffer.concat([png(8, 8, 0).subarray(0, 33), (() => { const d = zlib.deflateSync(Buffer.alloc(40 * 1024 * 1024)); const h = Buffer.alloc(8); h.writeUInt32BE(d.length); h.write('IDAT', 4, 'latin1'); return Buffer.concat([h, d, Buffer.alloc(4)]); })()]);
    check('una bomba de compresión se corta', leerPng(bomba) === null);
    // Las salidas reales del nodo de Florence-2 (ComfyUI 0.46): la zona que está y una que no está, que el modelo inventa.
    const real = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'feat-212', n));
    check('la máscara real de Florence-2 se lee', Math.abs(parteMarcada(real('mascara-florence2.png')) - 0.00665) < 0.0001 && chequearMascara(real('mascara-florence2.png')) === 'ok');
    check('una zona inventada también marca algo: el chequeo no la distingue', chequearMascara(real('mascara-florence2-inventada.png')) === 'ok');
    check('basura y un PNG cortado: ilegible', chequearMascara(Buffer.from('hola')) === 'ilegible' && chequearMascara(MASCARA_OK.subarray(0, 60)) === 'ilegible');
  });

  await group('El retoque: la zona y los fallos', async () => {
    const d = config();
    const ret = (falso, cfg = d, log) => generar(cfg, 'retoque', 'sdxl', {}, falso, log);
    const bien = await ret(comfyFalso());
    check('con la zona encontrada sigue', bien.ok && !bien.sinChequeoZona);
    check('las medidas son las del archivo, no las pedidas', bien.ancho === 8 && bien.alto === 8);
    const vacia = await ret(comfyFalso({ mascara: png(256, 256, 0) }));
    check('vacía: zona-no-encontrada, sin dejar el temporal', vacia.codigo === 'zona-no-encontrada' && !fs.existsSync(path.join(tmp, `d${nDestino - 1}.png`)));
    check('…con su texto', codigos.mensajeDe(vacia.codigo, vacia.extra) === 'No encontré «the hat» en la foto.');
    const cubre = await ret(comfyFalso({ mascara: png(256, 256, 65536) }));
    check('toda blanca: el otro texto', codigos.mensajeDe(cubre.codigo, cubre.extra) === 'La máscara de «the hat» cubre toda la foto.');
    const logs = [];
    const ileg = await ret(comfyFalso({ mascara: png(8, 8, 1, { bits: 16 }) }), d, (l) => logs.push(l));
    check('ilegible: sigue, sin chequeo y con aviso', ileg.ok && ileg.sinChequeoZona === true && logs.some((l) => /sin chequeo/.test(l)));
    let leidos = 0;
    const sinFin = comfyFalso();
    const crudo = sinFin.fetchImpl;
    sinFin.fetchImpl = async (u, o) => (String(u).includes('m.png') ? new Response(new ReadableStream({ pull(c) { leidos += 65536; c.enqueue(new Uint8Array(65536)); if (leidos > 50 * 65536) c.close(); } })) : crudo(u, o));
    const cortada = await ret(sinFin);
    check('una máscara enorme se corta mientras llega', cortada.ok && cortada.sinChequeoZona === true && leidos < 10 * 65536, String(leidos));
    check('más de 256 KB es ilegible', (await ret(comfyFalso({ mascara: Buffer.alloc(300 * 1024) }))).sinChequeoZona === true);
    const apagado = comfyFalso({ mascara: png(256, 256, 0) });
    check('chequeo_zona apagado: no se baja la máscara', (await ret(apagado, config({}, { chequeo_zona: false }))).ok && !apagado.pedidos.some((p) => p.query.includes('m.png')));
    const l2 = [];
    const masc = await ret(comfyFalso({ conMascara: false, error: { node_id: '31', node_type: 'Florence2Run', exception_message: 'the hat https://x.y/?t=abc C:\\Users\\yo\\m.pt' } }), d, (l) => l2.push(l));
    check('un fallo en la rama de máscara: mascara-fallo', masc.codigo === 'mascara-fallo' && codigos.mensajeDe(masc.codigo, masc.extra) === 'Falló el nodo de máscara (Florence2Run).');
    check('…y el detalle no viaja; en el log, sin rutas', !JSON.stringify(masc).includes('http') && l2.some((l) => l.includes('Florence2Run')) && !l2.some((l) => l.includes('Users')));
    const sinChequeo = await ret(comfyFalso({ conMascara: false, error: { node_id: '31', node_type: 'Florence2Run' } }), config({}, { chequeo_zona: false }));
    check('con chequeo_zona apagado, la rama de máscara también da mascara-fallo', sinChequeo.codigo === 'mascara-fallo');
    check('el propio nodo de salida de la máscara', (await ret(comfyFalso({ conMascara: false, error: { node_id: '21', node_type: 'PreviewImage' } }))).codigo === 'mascara-fallo');
    check('un fallo en el sampler: fallo-del-flujo', (await ret(comfyFalso({ error: { node_id: '3', node_type: 'KSampler' } }))).codigo === 'fallo-del-flujo');
    check('cargar la foto no es la máscara', (await ret(comfyFalso({ conMascara: false, error: { node_id: '10', node_type: 'LoadImage' } }))).codigo === 'fallo-del-flujo');
    check('si falla después y la máscara estaba vacía, esa es la causa', (await ret(comfyFalso({ mascara: png(256, 256, 0), error: { node_id: '40', node_type: 'InpaintCropImproved' } }))).codigo === 'zona-no-encontrada');
    check('los textos entran en 200', ['zona-no-encontrada'].every((c) => codigos.mensajeDe(c, { zona: 'z'.repeat(500), cubre: true }).length <= 200) && codigos.mensajeDe('mascara-fallo', { clase: '<b>Raro</b> nodo' }) === 'Falló el nodo de máscara (bRarobnodo).');
    check('sinRutas', sinRutas("ENOENT: 'C:\\Users\\yo\\x.png' y /home/yo/x.png").includes('<ruta>') && !/Users|home/.test(sinRutas("ENOENT: 'C:\\Users\\yo\\x.png' y /home/yo/x.png")));
  });

  await group('Probar: lo de antes más el catálogo y los casos', async () => {
    const info = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors']] } } }, KSampler: { input: { required: { sampler_name: [['euler']], scheduler: [['karras']] } } } };
    for (const n of ['CLIPTextEncode', 'EmptyLatentImage', 'VAEDecode', 'VAEEncode', 'SaveImage', 'LoadImage', 'ImageScale']) info[n] = {};
    const fetchImpl = async (u) => (new URL(u).pathname === '/system_stats' ? new Response(JSON.stringify({ system: {}, devices: [{ vram_free: 5 }] })) : new Response(JSON.stringify(info)));
    require('../mcp-server/imagenes/catalogo.js').olvidarParaTests();
    const r = await probarComfyui({ url: 'http://127.0.0.1:8188', fetchImpl, config: config() });
    check('ok, codigo, mensaje y vramLibre como antes', r.ok && r.codigo === 'ok' && r.mensaje === 'ComfyUI responde.' && r.vramLibre === 5);
    check('el estado de cada caso', r.casos.nueva.estado === 'disponible' && r.casos.retoque.estado === 'faltan' && r.casos.retoque.faltan.nodos.includes('Florence2Run') && r.casos.edicion.motivo === 'falta el modelo');
    check('el catálogo, sin los nodos', r.catalogo.checkpoints[0].valor === 'sd_xl_base_1.0.safetensors' && !('nodos' in r.catalogo));
    const sin = await probarComfyui({ url: 'http://127.0.0.1:8188', fetchImpl: async (u) => { if (new URL(u).pathname === '/system_stats') return new Response('{"system":{},"devices":[]}'); throw new Error('x'); }, config: config() });
    check('sin /object_info: sin-catalogo, nunca «faltan»', sin.ok && sin.catalogo === null && Object.values(sin.casos).every((c) => c.estado === 'sin-catalogo' && c.faltan.nodos.length === 0));
    require('../mcp-server/imagenes/catalogo.js').olvidarParaTests();
    const cae = await probarComfyui({ url: 'http://127.0.0.1:8188', fetchImpl: async () => { throw new Error('x'); }, config: config() });
    check('caído: lo de antes', !cae.ok && cae.codigo === 'no-responde' && !('casos' in cae));
  });

  // --------------------------------------------------------------- la cola
  const clave = 'alya';
  const registro = { tarea: (id) => tareas.obtener(id), actualizar: (id, c) => tareas.actualizar(id, c) };
  const nuevaTarea = () => { const t = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave }, pedido: 'hola' }); tareas.actualizar(t.id, { estado: 'ok' }); return t.id; };
  const entrada = (id, n = 1) => (tareas.obtener(id).imagenes || []).find((e) => e.n === n);
  const prov = (id, fn = () => ({ ok: true })) => ({ id, vistos: [], async generar(op) { this.vistos.push(op); const r = await fn(op); if (!r.ok) return { proveedor: id, ...r }; const ruta = `${op.destino}.png`; fs.writeFileSync(ruta, r.bytes || PNG); return { ok: true, ruta, tipo: 'image/png', ancho: op.ancho, alto: op.alto, semilla: 5, proveedor: id, modelo: op.modelo || null, ...(r.extra || {}) }; } });
  const refina = (salida) => ({ veces: 0, async refinar(o) { this.veces++; if (typeof salida === 'function') return salida(o); const s = R.sanear(salida, { disponibles: o.disponibles, desdeFoto: o.desdeFoto }); return { ...s, refinado: true }; }, sinRefinar: R.sinRefinar });
  const armar = ({ provs, cfg = () => config({ orden: Object.keys(provs), alma_la_ve: false }), ref = refina({ caso: 'nueva', prompt: 'x' }), manual = () => false, cat = null, log = () => {} }) => crearColaImagenes({ registro, proveedor: (id) => provs[id] || null, leerConfig: cfg, refinador: ref, vision: { llamar: async () => ({ ok: false }) }, manual, catalogoDe: async () => cat, log, env: process.env });
  const conFoto = { desdeFoto: true, foto: { ruta: foto, segura: true } };
  const termina = (id, n = 1) => hasta(() => entrada(id, n) && entrada(id, n).estado !== 'generando');

  await group('La cola: el caso, su modelo y su perfil', async () => {
    const tres = () => config({ orden: ['comfyui'], alma_la_ve: false }, { modelo_edicion: 'flux1-kontext.safetensors', modelo_retoque: 'flux1-fill.safetensors', retoque: 'fill' });
    const pide = async (salida, cfg = tres, extra = conFoto) => { const c = prov('comfyui', () => ({ ok: true, extra: { loras: [{ clave: 'acuarela', fuerza: 0.8 }], sinChequeoZona: true } })); const id = nuevaTarea(); armar({ provs: { comfyui: c }, cfg, ref: refina(salida) }).encolar({ tareaId: id, clave, pedido: 'x', ...extra }); await termina(id); return { c, id, e: entrada(id), op: c.vistos[0], priv: indice.leer(clave, id, 1) }; };
    const ed = await pide({ caso: 'edicion', prompt: 'p', instruccion: 'make it red' });
    check('edición: Kontext, su perfil y la instrucción', ed.op.caso === 'edicion' && ed.op.modelo === 'flux1-kontext.safetensors' && ed.op.perfil.id === 'flux-kontext' && ed.op.instruccion === 'make it red' && ed.e.perfil === 'flux-kontext' && ed.e.instruccion === 'make it red');
    const ret = await pide({ caso: 'retoque', prompt: 'p', zona: 'the hat' });
    check('retoque: Fill, su perfil y la zona', ret.op.modelo === 'flux1-fill.safetensors' && ret.op.perfil.id === 'flux-fill' && ret.op.zona === 'the hat' && ret.e.zona === 'the hat');
    check('el turno lleva los LoRAs y el sin chequeo', JSON.stringify(ret.e.loras) === JSON.stringify([{ clave: 'acuarela', fuerza: 0.8 }]) && ret.e.sinChequeoZona === true);
    const nu = await pide({ caso: 'nueva', prompt: 'p', proporcion: '16:9' }, tres, {});
    check('nueva: el principal, sin foto, con las medidas del perfil', nu.op.perfil.id === 'sdxl' && nu.op.foto === null && nu.op.ancho === 1344 && nu.op.alto === 768 && nu.e.caso === 'nueva');
    check('el índice guarda lo que hace falta para repetirla', ret.priv.caso === 'retoque' && ret.priv.zona === 'the hat' && ret.priv.perfil === 'flux-fill' && ed.priv.instruccion === 'make it red');
    const bajo = await pide({ caso: 'retoque', prompt: 'p', zona: 'the hat' }, () => config({ orden: ['comfyui'], alma_la_ve: false }, { retoque: 'no' }));
    check('retoque apagado: el turno dice los dos', bajo.e.casoPedido === 'retoque' && bajo.e.caso === 'variacion' && bajo.op.caso === 'variacion');
    const id = nuevaTarea();
    const c = prov('comfyui');
    armar({ provs: { comfyui: c }, cfg: () => config({ orden: ['comfyui'], refinar: false, alma_la_ve: false }) }).encolar({ tareaId: id, clave, pedido: 'un gato' });
    check('mientras genera no trae caso', entrada(id).estado === 'generando' && !('caso' in entrada(id)));
    await termina(id);
    check('sin refinador configurado también sale', entrada(id).estado === 'lista' && entrada(id).prompt === 'un gato');
  });

  await group('La cola: proveedores y errores', async () => {
    const corre = async (o, pedido = {}) => { const id = nuevaTarea(); armar(o).encolar({ tareaId: id, clave, pedido: 'x', ...pedido }); await termina(id); return entrada(id); };
    const cae = () => prov('comfyui', () => ({ ok: false, codigo: 'no-responde' }));
    const agy = prov('antigravity');
    const v = await corre({ provs: { comfyui: cae(), antigravity: agy }, ref: refina({ caso: 'variacion', prompt: 'x' }) }, conFoto);
    check('variación con ComfyUI caído y agy en el orden: solo-comfyui, sin bajar a nueva', v.codigo === 'solo-comfyui' && agy.vistos.length === 0 && v.caso === 'variacion');
    const m = await corre({ provs: { comfyui: cae(), antigravity: agy }, manual: () => true });
    check('nueva con agy en manual: sin-proveedor nombra a los dos', m.codigo === 'sin-proveedor' && m.mensaje === 'ComfyUI no responde; agy está en modo manual.', m.mensaje);
    const sinModelo = { checkpoints: [], unets: [], clips: [], vaes: [], loras: [], nodos: new Set(['CheckpointLoaderSimple', 'KSampler', 'CLIPTextEncode', 'EmptyLatentImage', 'VAEDecode', 'SaveImage']) };
    const q = await corre({ provs: { comfyui: cae(), antigravity: agy }, manual: () => true, cat: sinModelo });
    check('ComfyUI sin el modelo y agy en manual: sin-proveedor nombra a los dos', q.codigo === 'sin-proveedor' && q.mensaje === 'ComfyUI no tiene lo que necesita para esto; agy está en modo manual.', q.mensaje);
    const soloC = await corre({ provs: { comfyui: cae() }, cat: sinModelo });
    check('solo ComfyUI, sin el modelo: sin-caso con el motivo', soloC.codigo === 'sin-caso' && soloC.mensaje === 'No hay ningún flujo disponible para este pedido (falta el modelo).', soloC.mensaje);
    // El catálogo de verdad, con la caché fría: un solo /object_info para las dos miradas de la cola.
    const catReal = require('../mcp-server/imagenes/catalogo.js');
    catReal.olvidarParaTests();
    const info = { KSampler: { input: { required: { sampler_name: [['euler']], scheduler: [['simple']] } } }, CheckpointLoaderSimple: { input: { required: { ckpt_name: [['flux1-dev-fp8.safetensors']] } } } };
    for (const n of ['CLIPTextEncode', 'EmptySD3LatentImage', 'EmptyLatentImage', 'VAEDecode', 'SaveImage', 'FluxGuidance', 'ConditioningZeroOut']) info[n] = {};
    let pedidosCat = 0;
    const cf = prov('comfyui'); const idF = nuevaTarea();
    crearColaImagenes({ registro, proveedor: () => cf, leerConfig: () => config({ orden: ['comfyui'], alma_la_ve: false }, { modelo: 'flux1-dev-fp8.safetensors' }), refinador: refina({ caso: 'nueva', prompt: 'x' }), vision: { llamar: async () => ({ ok: false }) }, manual: () => false, catalogoDe: (u) => catReal.catalogoDe(u, { fetchImpl: async () => { pedidosCat++; return new Response(JSON.stringify(info)); } }), env: process.env }).encolar({ tareaId: idF, clave, pedido: 'x' });
    await termina(idF);
    check('con la caché fría: un solo /object_info y flux-fp8', pedidosCat === 1 && cf.vistos[0] && cf.vistos[0].perfil.id === 'flux-fp8', `${pedidosCat} ${JSON.stringify(entrada(idF).mensaje || null)}`);
    catReal.olvidarParaTests();
    for (const orden of [['comfyui', 'antigravity'], ['antigravity', 'comfyui']]) {
      const a = prov('antigravity');
      const e = await corre({ provs: { comfyui: cae(), antigravity: a }, cfg: () => config({ orden, alma_la_ve: false }), cat: sinModelo });
      check(`${orden.join()}: sin el modelo de ComfyUI, la hace agy`, e.estado === 'lista' && e.proveedor === 'antigravity' && !e.perfil);
    }
    const largo = 'palabra '.repeat(220).trim();
    const flux = () => config({ orden: ['comfyui', 'antigravity'], alma_la_ve: false }, { modelo: 'flux1-dev.safetensors' });
    const c = cae(); const a = prov('antigravity');
    const e = await corre({ provs: { comfyui: c, antigravity: a }, cfg: flux, ref: refina({ caso: 'nueva', prompt: largo }) });
    check('ComfyUI recibe el prompt entero y agy de respaldo, 900', c.vistos[0].prompt.length > 1700 && a.vistos[0].prompt.length <= 900 && e.prompt.length > 1700);
    const marc = await corre({ provs: { comfyui: prov('comfyui', () => ({ ok: false, codigo: 'flujo-marcador', extra: { marcador: 'x' } })) } });
    check('los datos de un error llegan a su texto', marc.mensaje === 'El flujo usa {{x}} y este caso no lo da.');
    // Lo que se apaga mientras refina vale para esta imagen.
    let orden = ['comfyui', 'antigravity'];
    const lento = (fn) => ({ async refinar(o) { await new Promise((r) => setTimeout(r, 20)); fn(); return { ...R.sanear({ caso: 'retoque', prompt: 'x', zona: 'z' }, { disponibles: o.disponibles, desdeFoto: o.desdeFoto }), refinado: true }; }, sinRefinar: R.sinRefinar });
    const c2 = prov('comfyui'); const a2 = prov('antigravity');
    const s = await corre({ provs: { comfyui: c2, antigravity: a2 }, cfg: () => config({ orden, alma_la_ve: false }), ref: lento(() => { orden = ['antigravity']; }) });
    check('un proveedor sacado del orden durante el refinador', s.proveedor === 'antigravity' && c2.vistos.length === 0);
    let retoque = 'crop-stitch';
    const c3 = prov('comfyui');
    const t = await corre({ provs: { comfyui: c3 }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false }, { retoque }), ref: lento(() => { retoque = 'no'; }) }, conFoto);
    check('una opción apagada durante el refinador baja el caso', t.caso === 'variacion' && t.casoPedido === 'retoque' && c3.vistos[0].caso === 'variacion');
  });

  await group('Repetir: /otra y Reintentar', async () => {
    const tira = { async refinar() { throw new Error('no tenía que refinar'); }, sinRefinar() { throw new Error('tampoco'); } };
    const cfgEd = () => config({ orden: ['comfyui'], alma_la_ve: false }, { modelo_edicion: 'flux1-kontext.safetensors' });
    for (const [caso, salida] of [['retoque', { caso: 'retoque', prompt: 'p', zona: 'the hat' }], ['edicion', { caso: 'edicion', instruccion: 'make it red' }]]) {
      const id = nuevaTarea();
      armar({ provs: { comfyui: prov('comfyui') }, cfg: cfgEd, ref: refina(salida) }).encolar({ tareaId: id, clave, pedido: 'x', ...conFoto });
      await termina(id);
      // Otra cola: como después de un reinicio.
      const c = prov('comfyui');
      const r = armar({ provs: { comfyui: c }, cfg: cfgEd, ref: tira }).otra(id, 1);
      await termina(id, 2);
      check(`/otra de ${caso} después de un reinicio, sin refinar`, r.ok && entrada(id, 2).estado === 'lista' && c.vistos[0].caso === caso && (caso === 'retoque' ? c.vistos[0].zona === 'the hat' : c.vistos[0].instruccion === 'make it red'), JSON.stringify(entrada(id, 2)));
      const id2 = nuevaTarea();
      armar({ provs: { comfyui: prov('comfyui', () => ({ ok: false, codigo: 'no-responde' })) }, cfg: cfgEd, ref: refina(salida) }).encolar({ tareaId: id2, clave, pedido: 'x', ...conFoto });
      await termina(id2);
      check(`un ${caso} que falla: solo-comfyui`, entrada(id2).codigo === 'solo-comfyui');
      const c2 = prov('comfyui');
      armar({ provs: { comfyui: c2 }, cfg: cfgEd, ref: tira }).reintentar(id2, 1);
      await hasta(() => entrada(id2).estado === 'lista');
      check(`…y Reintentar repite el ${caso} sin refinar`, entrada(id2).estado === 'lista' && c2.vistos[0].caso === caso);
    }
    for (const k of ['retoque', 'mascara']) {
      const id = nuevaTarea();
      armar({ provs: { comfyui: prov('comfyui') }, cfg: cfgEd, ref: refina({ caso: 'retoque', prompt: 'p', zona: 'the hat' }) }).encolar({ tareaId: id, clave, pedido: 'x', ...conFoto });
      await termina(id);
      const c = prov('comfyui');
      armar({ provs: { comfyui: c }, cfg: () => config({ orden: ['comfyui'], alma_la_ve: false }, { [k]: 'no' }), ref: tira }).otra(id, 1);
      await termina(id, 2);
      check(`/otra de un retoque con ${k}: "no" va como variación con el mismo prompt`, c.vistos[0]?.caso === 'variacion' && c.vistos[0].prompt === 'p' && entrada(id, 2).casoPedido === 'retoque');
    }
    const id = nuevaTarea();
    armar({ provs: { comfyui: prov('comfyui', () => ({ ok: false, codigo: 'zona-no-encontrada', extra: { zona: 'the hat' } })) }, cfg: cfgEd, ref: refina({ caso: 'retoque', prompt: 'p', zona: 'the hat' }) }).encolar({ tareaId: id, clave, pedido: 'x', ...conFoto });
    await termina(id);
    check('zona-no-encontrada en el turno', entrada(id).mensaje === 'No encontré «the hat» en la foto.');
    const c = prov('comfyui');
    armar({ provs: { comfyui: c }, cfg: cfgEd, ref: tira }).reintentar(id, 1);
    await hasta(() => entrada(id).estado === 'lista');
    check('Reintentar después va como variación, sin zona y sin refinar', c.vistos[0].caso === 'variacion' && c.vistos[0].zona === '' && c.vistos[0].prompt === 'p' && entrada(id).casoPedido === 'retoque' && !entrada(id).zona);
    // Una entrada de 2.18.5 no tiene caso.
    const v = nuevaTarea();
    tareas.actualizar(v, { imagenes: [{ n: 1, estado: 'lista', pedido: 'x', prompt: 'viejo', negativo: 'n', desdeFoto: true }] });
    indice.actualizar(clave, v, 1, () => ({ prompt: 'viejo', negativo: 'n', proporcion: '4:3', fotoRuta: foto, archivo: foto, sha256: 's', creada: '2026-01-01T00:00:00Z' }));
    const cv = prov('comfyui');
    armar({ provs: { comfyui: cv }, cfg: cfgEd, ref: tira }).otra(v, 1);
    await termina(v, 2);
    check('/otra de una entrada de 2.18.5 no refina y va como variación', cv.vistos[0]?.caso === 'variacion' && cv.vistos[0].prompt === 'viejo' && cv.vistos[0].ancho === 1152);
    const vacia = nuevaTarea();
    tareas.actualizar(vacia, { imagenes: [{ n: 1, estado: 'error', pedido: 'x', codigo: 'error' }] });
    indice.actualizar(clave, vacia, 1, () => ({ caso: 'nueva', prompt: '' }));
    const rf = refina({ caso: 'nueva', prompt: 'nuevo' });
    armar({ provs: { comfyui: prov('comfyui') }, cfg: cfgEd, ref: rf }).reintentar(vacia, 1);
    await hasta(() => entrada(vacia).estado === 'lista');
    check('con caso pero sin prompt sí refina', rf.veces === 1 && entrada(vacia).prompt === 'nuevo');
  });

  // --------------------------------------------------------------- Telegram
  const bot = await importar('telegram-bridge/bot.js');
  await group('Telegram: el sha del JPEG que devuelve', async () => {
    const JPEG = Buffer.from('un jpeg recomprimido');
    const cola = armar({ provs: { comfyui: prov('comfyui') } });
    const id = nuevaTarea();
    const avisos = [];
    cola.encolar({ tareaId: id, clave, pedido: 'x', envio: async (x) => avisos.push(x) });
    await termina(id); await hasta(() => avisos.length);
    const p0 = indice.leer(clave, id, 1);
    check('al encolar queda el envio y el aviso lo lleva', p0.telegram.envio === avisos[0].idEnvio && p0.telegram.sha256 === null);
    const leerCfg = (x = {}) => () => config(x);
    const api = { photo: [{ file_id: 'chica', width: 90, height: 90 }, { file_id: 'grande', width: 1280, height: 1280 }], async sendPhoto() { if (this.falla) throw new Error("ENOENT 'C:\\Users\\yo\\x.png'"); return { message_id: 1, photo: this.photo }; }, async sendDocument() { return { message_id: 2, document: {} }; }, async sendMessage() { return {}; } };
    const bajadas = [];
    const envia = async (op = {}, extra = {}) => { let ok = null; const e = bot.crearEnvioImagen({ bot: 'x', chat: 1 }, 1, { tareaId: id, clave, api, cola, leerConfig: leerCfg(), descargar: async (f) => { bajadas.push(f); return JPEG; }, alTerminar: (v) => { ok = v; }, ...op }); await e({ ok: true, n: 1, ruta: foto, idEnvio: p0.telegram.envio, ...extra }); await hasta(() => ok !== null); return ok; };
    check('baja la foto más grande y guarda el sha', await envia() === true && bajadas.join() === 'grande' && indice.leer(clave, id, 1).telegram.sha256 === indice.sha256(JPEG));
    check('el sha original no se toca', indice.leer(clave, id, 1).sha256 === p0.sha256 && cola.reconocer(PNG)?.tareaId === id);
    check('reconocerTelegram lo reconoce; reconocer no', cola.reconocerTelegram(JPEG)?.tareaId === id && cola.reconocer(JPEG) === null && cola.reconocerTelegram(PNG) === null);
    const jpg = path.join(tmp, 'vuelta.jpg'); fs.writeFileSync(jpg, JPEG);
    const rec = { reconocer: (b) => cola.reconocer(b), reconocerTelegram: (b) => cola.reconocerTelegram(b) };
    check('fotoDelTurno: reconocida, sin campos nuevos', JSON.stringify(Object.keys(bot.fotoDelTurno({ ruta: jpg }, config(), rec))) === JSON.stringify(['ruta', 'segura', 'origen']) && bot.fotoDelTurno({ ruta: jpg }, config(), rec).origen === 'reconocida');
    check('con reconocer_telegram apagado no', bot.fotoDelTurno({ ruta: jpg }, config({ reconocer_telegram: false }), rec).segura === false);
    check('con reconocer_propias apagado tampoco', bot.fotoDelTurno({ ruta: jpg }, config({ reconocer_propias: false }), rec).segura === false);
    bajadas.length = 0;
    await envia({ leerConfig: leerCfg({ reconocer_telegram: false }) });
    await envia({ leerConfig: leerCfg({ reconocer_propias: false }) });
    check('apagado al mandar: no baja nada', bajadas.length === 0);
    // La ventana de la descarga: hasta que termina, la foto que vuelve es de afuera.
    let sol; const esp = new Promise((r) => { sol = r; });
    const OTRO = Buffer.from('otro jpeg'); const jpg2 = path.join(tmp, 'vuelta2.jpg'); fs.writeFileSync(jpg2, OTRO);
    const lenta = envia({ descargar: async () => { await esp; return OTRO; } });
    check('un reenvío antes de que termine la descarga es de afuera', bot.fotoDelTurno({ ruta: jpg2 }, config(), rec).segura === false);
    sol();
    check('…y cuando termina se reconoce', await lenta === true && bot.fotoDelTurno({ ruta: jpg2 }, config(), rec).origen === 'reconocida');
    await envia();
    bajadas.length = 0;
    for (const ph of [undefined, []]) { api.photo = ph; await envia(); }
    check('sin photo no baja y /otra sigue andando', bajadas.length === 0 && bot.imagenDelMensaje('x', 1, 1)?.n === 1);
    api.photo = [{ file_id: 'f', width: 1, height: 1 }];
    api.falla = true;
    const warn = console.warn; const avisosLog = []; console.warn = (l) => avisosLog.push(l);
    await envia();
    check('con sendDocument no baja nada, y el log va sin la ruta', bajadas.length === 0 && avisosLog.some((l) => l.includes('sendPhoto falló')) && !avisosLog.some((l) => l.includes('Users')));
    api.falla = false;
    avisosLog.length = 0;
    const falla = await envia({ descargar: async () => { throw new Error('https://api.telegram.org/file/bot123456:AAAA/photos/x.jpg'); } });
    check('una descarga que falla: texto fijo, sin token ni photos/', falla === false && avisosLog.length === 1 && avisosLog[0] === '[imagenes] no se pudo bajar la foto para el reconocimiento');
    // Una descarga vieja no pega su sha sobre un Reintento.
    const viejo = await envia({}, { idEnvio: 'otro-intento' });
    check('el envio de otro intento no escribe', viejo === false);
    tareas.actualizar(id, { imagenes: [{ ...entrada(id), estado: 'error', codigo: 'error' }] });
    let soltar; const espera = new Promise((r) => { soltar = r; });
    const enVuelo = envia({ descargar: async () => { await espera; return Buffer.from('vieja'); } });
    cola.reintentar(id, 1);
    await hasta(() => entrada(id).estado === 'lista');
    soltar();
    check('una descarga en vuelo no pega el sha viejo al Reintento', await enVuelo === false && indice.leer(clave, id, 1).telegram.sha256 === null && indice.leer(clave, id, 1).telegram.envio !== p0.telegram.envio);
    check('el Reintento soltó el sha anterior', cola.reconocerTelegram(JPEG) === null);
    // El lock tomado: ni frena ni lanza.
    const lock = `${indice.rutaIndice(clave, id, 1)}.lock`;
    const env2 = indice.leer(clave, id, 1).telegram.envio;
    fs.writeFileSync(lock, '');
    avisosLog.length = 0;
    const t0 = Date.now();
    let tic = 0; const intervalo = setInterval(() => { tic++; }, 10);
    const conLock = await bot.anotarShaDeTelegram({ clave, tareaId: id, n: 1, idEnvio: env2, fileId: 'f', descargar: async () => JPEG, cola, esperaMs: 60 });
    clearInterval(intervalo);
    check('con el índice ocupado se pierde el sha, sin frenar el proceso', conLock === false && tic >= 3 && Date.now() - t0 < 1500 && avisosLog.some((l) => l.includes('índice ocupado')));
    const t1 = Date.now();
    check('borrar con el lock tomado vuelve en el acto', indice.borrar(clave, id, 1, {}) === false && Date.now() - t1 < 200);
    fs.rmSync(lock);
    check('borrar no toca una entrada distinta', indice.borrar(clave, id, 1, { sha256: 'otro', envio: env2 }) === false && indice.borrar(clave, id, 1, { sha256: indice.leer(clave, id, 1).sha256, envio: 'otro' }) === false && Boolean(indice.leer(clave, id, 1)));
    check('borrar acepta el env y borra la que es', indice.borrar(clave, id, 1, { sha256: indice.leer(clave, id, 1).sha256, envio: env2, env: process.env }) === true && indice.leer(clave, id, 1) === null);
    console.warn = warn;
    // /otra: la fábrica recibe la clave y la n.
    const id3 = nuevaTarea();
    cola.encolar({ tareaId: id3, clave, pedido: 'x' }); await termina(id3);
    const fabrica = [];
    cola.otra(id3, 1, { crearEnvio: (k, n) => { fabrica.push([k, n]); return async (x) => fabrica.push(x.idEnvio); } });
    await termina(id3, 2); await hasta(() => fabrica.length === 2);
    check('/otra crea el envío con la clave y la n nueva', JSON.stringify(fabrica[0]) === JSON.stringify([clave, 2]) && fabrica[1] === indice.leer(clave, id3, 2).telegram.envio);
    check('el cuerpo con tope corta', await bot.leerConTope(new Response('x'.repeat(50)), 10).then(() => false, () => true) && (await bot.leerConTope(new Response('hola'), 10)).toString() === 'hola');
    const nodo = armar({ provs: { comfyui: prov('comfyui') } });
    nodo.alArrancar([]);
    const construir = indice.construirMapaTelegram; let leyo = 0;
    indice.construirMapaTelegram = (...a) => { leyo++; return construir(...a); };
    nodo.reconocerTelegram(JPEG);
    indice.construirMapaTelegram = construir;
    check('un nodo sin almas no lee el directorio por el sha de Telegram', leyo === 0);
    const fuente = fs.readFileSync(path.join(RAIZ, 'telegram-bridge/bot.js'), 'utf8');
    check('la descarga dura 10 s y pesa 10 MB', /AbortSignal\.timeout\(10 \* 1000\)/.test(fuente) && /TOPE_DESCARGA_FOTO = 10 \* 1024 \* 1024/.test(fuente));
  });

  await group('El turno y el contrato', async () => {
    const { imagenesDe } = await importar('telegram-bridge/web/v2/productores.js');
    const t = tareas.crear({ carril: 'alma', origen: 'telegram', sujeto: { tipo: 'alma', clave }, pedido: 'x' });
    const loras = Array.from({ length: 6 }, (_, i) => ({ clave: `c${i}`, fuerza: 1 }));
    tareas.actualizar(t.id, { imagenes: [{ n: 1, estado: 'lista', caso: 'retoque', casoPedido: 'edicion', zona: 'z'.repeat(300), instruccion: 'i'.repeat(3000), prompt: 'p'.repeat(3000), negativo: 'n'.repeat(900), perfil: 'sdxl', loras, sinChequeoZona: true }, { n: 2, estado: 'generando', caso: null, loras: 'x' }] });
    const [a, b] = tareas.obtener(t.id).imagenes;
    check('los topes en el registro', a.zona.length === 120 && a.instruccion.length === 2000 && a.prompt.length === 2000 && a.negativo.length === 500 && a.loras.length === 4);
    check('una generando sin caso no lo trae', !('caso' in b) && !('loras' in b));
    const pub = imagenesDe([a, b]);
    check('la proyección', pub[0].caso === 'retoque' && pub[0].casoPedido === 'edicion' && pub[0].perfil === 'sdxl' && pub[0].sinChequeoZona === true && pub[0].loras.length === 4 && !('caso' in pub[1]));
    const c = JSON.parse(fs.readFileSync(path.join(RAIZ, 'telegram-bridge/web/contrato-v2.json'), 'utf8'));
    check('el contrato sigue en 2.0', c.version === '2.0');
    const { validar, revisarContrato } = await importar('telegram-bridge/web/v2/esquema.js');
    const { turnoDe } = await importar('telegram-bridge/web/v2/productores.js');
    let esquema = null;
    (function ver(o) { if (o && typeof o === 'object') { if (o.imagenes?.items?.properties?.casoPedido) esquema = o.imagenes; Object.values(o).forEach(ver); } })(c);
    check('el contrato conoce los campos nuevos', esquema && esquema.items.properties.prompt.maxLength === 2000 && esquema.items.properties.loras.type === 'array');
    const turno = turnoDe(tareas.obtener(t.id), { recorte: '…' });
    let valido = true;
    try { revisarContrato(c); } catch { valido = false; }
    check('el contrato es válido y valida el turno entero', valido && validar(c, 'turno', turno).length === 0, JSON.stringify(validar(c, 'turno', turno)));
  });

  report();
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});
