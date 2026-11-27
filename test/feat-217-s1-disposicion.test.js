/**
 * FEAT-217 S1 — La disposición de los nodos en el taller: la forma y los topes, la clave de cada flujo, la del usuario
 * (en `disposiciones/` y dentro de una plantilla propia), la del plugin y su casilla, las rutas v2 y las disposiciones que
 * trae el plugin.
 *
 * Sin red y sin ComfyUI: el mismo ComfyUI falso que el test de FEAT-214.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat217-'));
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.LAGRANGE_COMFYUI_DIR = path.join(raiz, 'comfyui');
process.env.LAGRANGE_TALLER_DIR = path.join(raiz, 'taller');
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
for (const d of ['datos/adjuntos', 'almas/alya']) fs.mkdirSync(path.join(raiz, d), { recursive: true });

const { check, group, report } = require('./lib/assert');
const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indice = require('../mcp-server/imagenes/indice.js');
const A = require('../mcp-server/lib/ajustes-imagenes.js');
const F = require('../mcp-server/imagenes/flujos.js');
const D = require('../mcp-server/imagenes/disposicion.js');
const catalogo = require('../mcp-server/imagenes/catalogo.js');
const sondaVision = require('../mcp-server/imagenes/sonda-vision.js');

const MODELO = 'sd_xl_base_1.0.safetensors';
let tono = 0;
const png = () => sondaVision.pngSolido(8, [tono++ % 250, 40, 90]);
const adjuntos = path.join(raiz, 'datos', 'adjuntos');
const dirTaller = path.join(raiz, 'taller');
const config = (taller = {}, comfy = {}) => { const d = A.defectos(); return { ...d, taller: { ...d.taller, ...taller }, comfyui: { ...d.comfyui, ...comfy } }; };

const clases = new Set();
for (const f of ['nueva', 'variacion', 'retoque-florence2', 'retoque-a-mano']) {
  for (const n of Object.values(JSON.parse(fs.readFileSync(path.join(F.DIR_PLANTILLAS, 'sdxl', `${f}.json`), 'utf8')))) clases.add(n.class_type);
}
const info = Object.fromEntries([...clases, 'PreviewImage'].map((c) => [c, { input: { required: {} } }]));
info.CheckpointLoaderSimple.input.required.ckpt_name = [[MODELO]];
const CATALOGO = catalogo.leerObjectInfo(info);

function comfyFalso() {
  const c = { subidos: new Map(), n: 0 };
  c.fetch = async (url, op = {}) => {
    const u = new URL(url);
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (u.pathname === '/upload/image') {
      const nombre = `subida-${c.n++}.png`;
      c.subidos.set(nombre, Buffer.from(await op.body.get('image').arrayBuffer()));
      return json({ name: nombre, subfolder: '', type: 'input' });
    }
    if (u.pathname === '/history') return json({});
    if (u.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    return { ok: false, status: 404 };
  };
  return c;
}
const procesoFalso = () => ({ comprobar: async () => 'ok', levantar: () => null, estado: async () => ({}), anotarUso() {} });

/** Una disposición válida con `n` nodos (ids 1..n). */
const conNodos = (n, extra = {}) => ({ nodos: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), { tipo: 'KSampler', pos: [i * 10, 20], tam: [300, 200], ...extra }])) });

async function main() {
  const { crearTaller, TOPE_DISPOSICIONES } = await importar('telegram-bridge/imagenes/taller.js');
  const { rutasMutacionV2, TOPE_DISPOSICION_CUERPO } = await importar('telegram-bridge/web/v2/mutaciones.js');
  const { ajustesV2 } = await importar('telegram-bridge/web/v2/ajustes.js');

  let nImg = 0;
  const poner = (extra = {}) => {
    const id = `t_img${String(nImg++).padStart(4, '0')}`;
    const archivo = path.join(indice.dirImagenes('alya'), `${id}-1-1.png`);
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    const bytes = png();
    fs.writeFileSync(archivo, bytes);
    indice.actualizar('alya', id, 1, () => ({ archivo, tipo: 'image/png', lista: true, intento: 1, externo: false, sha256: indice.sha256(bytes), prompt: 'un faro', negativo: '', caso: 'nueva', perfil: 'sdxl', proveedor: 'comfyui', modelo: MODELO, proporcion: '1:1', semilla: 7, num: nImg, creada: new Date(Date.UTC(2026, 0, 1) + nImg * 1000).toISOString(), ...extra }));
    return { alma: 'alya', tareaId: id, n: 1, intento: 1 };
  };

  let cfg = config();
  const armar = () => crearTaller({ leerConfig: () => cfg, proceso: procesoFalso(), dirAdjuntos: () => adjuntos, fetchImpl: comfyFalso().fetch, catalogoDe: () => CATALOGO, tiempos: { vuelta: 1e9, levantar: 50 } });
  const ventana = 'v-aaaaaaaaaaaaaaaa';
  const delPluginNueva = D.delPlugin('plugin:sdxl/nueva');
  const mia = { nodos: { 3: { tipo: 'KSampler', pos: [900, 100], tam: [320, 280], plegado: true, color: '#223', fondo: '#335' } }, grupos: [{ titulo: 'Muestreo', caja: [850, 50, 420, 420], color: '#3f789e', letra: 24 }], vista: { zoom: 0.8, desplazamiento: [-100, 40] } };

  // ------------------------------------------------------------- la forma
  await group('validarDisposicion: la forma y los topes', () => {
    const v = D.validarDisposicion(mia);
    check('una completa vale y sale igual', v.ok && JSON.stringify(v.disposicion) === JSON.stringify(mia));
    check('{} no vale', !D.validarDisposicion({}).ok);
    check('una que solo trae vista no vale', !D.validarDisposicion({ vista: { zoom: 1, desplazamiento: [0, 0] } }).ok);
    check('solo un grupo, sí', D.validarDisposicion({ grupos: [{ titulo: '', caja: [0, 0, 10, 10] }] }).ok);
    check('un campo de más, con su campo', D.validarDisposicion({ ...mia, otro: 1 }).campo === 'disposicion.otro' && D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], modo: 4 } } }).campo === 'disposicion.nodos.3.modo');
    check('el campo que falló: disposicion.nodos.3.pos', D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], pos: [1] } } }).campo === 'disposicion.nodos.3.pos');
    for (const [k, x] of [['NaN', NaN], ['Infinity', Infinity], ['texto', '1'], ['fuera de rango', 2e6]]) {
      check(`pos con ${k}: no vale`, !D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], pos: [x, 0] } } }).ok);
    }
    check('tam negativo o de más de 100.000: no vale', !D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], tam: [-1, 1] } } }).ok && !D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], tam: [1, 100001] } } }).ok);
    check('zoom de 0,1 a 10', !D.validarDisposicion({ ...mia, vista: { zoom: 0.05, desplazamiento: [0, 0] } }).ok && !D.validarDisposicion({ ...mia, vista: { zoom: 11, desplazamiento: [0, 0] } }).ok);
    check('letra entera de 8 a 200', !D.validarDisposicion({ grupos: [{ ...mia.grupos[0], letra: 7 }] }).ok && !D.validarDisposicion({ grupos: [{ ...mia.grupos[0], letra: 12.5 }] }).ok);
    check('colores: # y de 3 a 8 hexadecimales', !D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], color: 'rgba(0,0,0,1)' } } }).ok && !D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], fondo: '#12' } } }).ok);
    check('un título de grupo con salto de línea: no vale', !D.validarDisposicion({ grupos: [{ ...mia.grupos[0], titulo: 'a\nb' }] }).ok);
    check('plegado tiene que ser booleano', !D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], plegado: 1 } } }).ok);
    check('un tipo vacío no vale', !D.validarDisposicion({ nodos: { 3: { ...mia.nodos[3], tipo: '' } } }).ok);
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      const d = JSON.parse(`{"nodos":{"${k}":{"tipo":"KSampler","pos":[0,0],"tam":[1,1]}}}`);
      check(`el id reservado ${k}: no vale`, !D.validarDisposicion(d).ok);
    }
    check('ids con punto, con barra o de texto: valen (como en un flujo)', D.validarDisposicion({ nodos: { '3.1': mia.nodos[3], 'a/b': mia.nodos[3], 'x:y': mia.nodos[3] } }).ok);
    check('un id de más de 100 caracteres no vale', !D.validarDisposicion({ nodos: { ['x'.repeat(101)]: mia.nodos[3] } }).ok);
    check('300 nodos valen; 301, no', D.validarDisposicion(conNodos(300)).ok && !D.validarDisposicion(conNodos(301)).ok);
    check('100 grupos valen; 101, no', D.validarDisposicion({ grupos: Array(100).fill(mia.grupos[0]) }).ok && !D.validarDisposicion({ grupos: Array(101).fill(mia.grupos[0]) }).ok);
    // Por bytes: títulos multibyte (ñ ocupa 2 bytes), hasta cerca de 256 KB.
    // Con caracteres de 3 bytes (世): 100 grupos de título largo y después nodos de id y tipo largos, dentro de los topes de
    // cantidad, hasta pasar `bytes`.
    const grande = (bytes) => {
      const d = { grupos: [], nodos: {} };
      const pesa = () => Buffer.byteLength(JSON.stringify(d));
      while (pesa() < bytes && d.grupos.length < 100) d.grupos.push({ titulo: '世'.repeat(200), caja: [0, 0, 1, 1] });
      let i = 0;
      while (pesa() < bytes && i < 300) d.nodos[`${++i}${'世'.repeat(90)}`] = { tipo: '世'.repeat(200), pos: [0, 0], tam: [1, 1] };
      return d;
    };
    const de70 = grande(70 * 1024);
    check('una de más de 64 KB vale', Buffer.byteLength(JSON.stringify(de70)) > 64 * 1024 && D.validarDisposicion(de70).ok);
    const de256 = grande(254 * 1024);
    check('una de casi 256 KB (multibyte) vale', Buffer.byteLength(JSON.stringify(de256)) <= 256 * 1024 && de256.nodos && D.validarDisposicion(de256).ok);
    const deMas = grande(257 * 1024);
    check('una de más de 256 KB no vale, aunque tenga menos de 256 K caracteres', JSON.stringify(deMas).length < 256 * 1024 && Buffer.byteLength(JSON.stringify(deMas)) > 256 * 1024 && /256 KB/.test(D.validarDisposicion(deMas).motivo || ''));
  });

  // ------------------------------------------------------------- las claves
  await group('Las claves', () => {
    check('flujo: C:/x.json y c:/x.json dan la misma clave (path.win32)', D.claveDeFlujo('C:/x.json', path.win32) === D.claveDeFlujo('c:/x.json', path.win32) && D.claveDeFlujo('C:/x.json', path.win32) === 'flujo:c:\\x.json');
    check('flujo: se normaliza con resolve', D.claveDeFlujo('C:\\a\\..\\b\\x.json', path.win32) === 'flujo:c:\\b\\x.json' && D.claveDeFlujo('/a/../b/X.json', path.posix) === 'flujo:/b/X.json');
    check('flujo: una ruta relativa o con controles, null', D.claveDeFlujo('x.json', path.win32) === null && D.claveDeFlujo('C:/x\u0000.json', path.win32) === null);
    check('validarClave: las tres formas', D.validarClave('plugin:sdxl/nueva') === 'plugin:sdxl/nueva' && D.validarClave('propia:abcdefabcdef0123') === 'propia:abcdefabcdef0123' && D.validarClave(D.claveDeFlujo(path.join(raiz, 'x.json'))) !== null);
    check('validarClave: lo que no vale, null', ['plugin:../../x', 'plugin:sdxl/../nueva', 'plugin:SDXL/nueva', 'plugin:sdxl', 'propia:../x', 'propia:ABC', 'flujo:x.json', 'otra:1', '', null, 3].every((k) => D.validarClave(k) === null));
    check('una clave flujo: que no está normalizada no vale', process.platform !== 'win32' || D.validarClave('flujo:C:\\x.json') === null);
    check('claveDeResuelto: del plugin y propio', D.claveDeResuelto({ ok: true, propio: false, nombre: 'sdxl/retoque-florence2' }) === 'plugin:sdxl/retoque-florence2' && D.claveDeResuelto({ ok: true, propio: true, archivo: 'C:/Flujos/Mio.json' }, path.win32) === 'flujo:c:\\flujos\\mio.json' && D.claveDeResuelto({ ok: false }) === null);
  });

  // ------------------------------------------------------------- las del plugin
  await group('Las disposiciones que trae el plugin', () => {
    const fams = fs.readdirSync(F.DIR_PLANTILLAS).filter((x) => fs.statSync(path.join(F.DIR_PLANTILLAS, x)).isDirectory());
    let cuantas = 0;
    for (const fam of fams) {
      for (const f of fs.readdirSync(path.join(F.DIR_PLANTILLAS, fam)).filter((x) => x.endsWith('.disposicion.json'))) {
        const archivo = f.replace(/\.disposicion\.json$/, '');
        const clave = `plugin:${fam}/${archivo}`;
        const crudo = JSON.parse(fs.readFileSync(path.join(F.DIR_PLANTILLAS, fam, f), 'utf8'));
        const v = D.validarDisposicion(crudo);
        const plantilla = JSON.parse(fs.readFileSync(path.join(F.DIR_PLANTILLAS, fam, `${archivo}.json`), 'utf8'));
        const malos = v.ok ? Object.entries(v.disposicion.nodos).filter(([id, n]) => !Object.hasOwn(plantilla, id) || plantilla[id].class_type !== n.tipo).map(([id]) => id) : ['no vale'];
        check(`${clave}: vale, sin vista, y cada tipo es el class_type de su plantilla`, v.ok && !crudo.vista && !malos.length && D.delPlugin(clave) !== null, malos.join(', '));
        check(`${clave}: cubre todos los nodos de la plantilla cruda (con los huecos de LoRA)`, v.ok && Object.keys(plantilla).every((id) => Object.hasOwn(v.disposicion.nodos, id)));
        cuantas++;
      }
    }
    check('son 10', cuantas === 10);
    check('las retoque-sam2 no traen (sus nodos no estaban en el ComfyUI de la medición)', D.delPlugin('plugin:sdxl/retoque-sam2') === null && D.delPlugin('plugin:flux-fill/retoque-sam2') === null);
  });

  // ------------------------------------------------------------- el taller
  await group('Abrir: la clave de cada origen y la del plugin', async () => {
    cfg = config();
    const t = armar();
    const n = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('plantilla del plugin: plugin:sdxl/nueva, con la del plugin', n.ok && n.disposicion.clave === 'plugin:sdxl/nueva' && JSON.stringify(n.disposicion.guardada) === JSON.stringify(delPluginNueva) && n.disposicion.deUsuario === false && JSON.stringify(n.disposicion.delPlugin) === JSON.stringify(delPluginNueva));
    const b = poner();
    const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:retoque-a-mano', base: b });
    check('retoque a mano: plugin:sdxl/retoque-a-mano', r.ok && r.disposicion.clave === 'plugin:sdxl/retoque-a-mano' && r.disposicion.guardada !== null);
    const de = await t.abrir({ alma: 'alya', ventana, desde: poner() });
    check('desde una imagen generada: la de su plantilla', de.ok && de.disposicion.clave === 'plugin:sdxl/nueva');
    const ret = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:retoque', base: b });
    check('retoque: plugin:sdxl/retoque-<mascara>', ret.ok && ret.disposicion.clave === `plugin:sdxl/retoque-${cfg.comfyui.mascara}`);
    check('el estado dice lo mismo', JSON.stringify(t.estado(n.sesion).disposicion) === JSON.stringify(n.disposicion));
    // Lo que preparó un alma: la clave de su plantilla.
    const pr = t.preparar({ clave: 'alya', tareaId: 't_prep0001', caso: 'nueva', perfil: 'sdxl', modelo: MODELO, prompt: 'un faro', negativo: '', ancho: 1024, alto: 1024, loras: [] });
    const ap = await t.abrir({ alma: 'alya', ventana: 'v-cccccccccccccccc', preparado: pr.id });
    check('un preparado: plugin:sdxl/nueva, con la del plugin', ap.ok && ap.disposicion.clave === 'plugin:sdxl/nueva' && ap.disposicion.guardada !== null);
    // Una imagen que se quedó del taller, con su propio flujo: sin clave (§7).
    const dirF = path.join(indice.dirImagenes('alya'), 'flujos', 't_tallerfijo0001-1');
    fs.mkdirSync(dirF, { recursive: true });
    fs.writeFileSync(path.join(dirF, 'grafo.json'), JSON.stringify(n.grafo));
    fs.writeFileSync(path.join(dirF, 'archivos.json'), '{}');
    const kept = await t.abrir({ alma: 'alya', ventana, desde: poner({ origen: 'taller', flujo: dirF, caso: null }) });
    check('una imagen que se quedó del taller: clave null, sin disposición', kept.ok && kept.disposicion.clave === null && kept.disposicion.guardada === null && kept.disposicion.deUsuario === false && kept.disposicion.delPlugin === null);
    check('y guardarle una da 409 sin-clave', t.guardarDisposicion(kept.sesion, { disposicion: mia }).motivo === 'sin-clave');
    cfg = config({ disposicion_plugin: false });
    const sin = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('con la casilla apagada: la clave sí, la del plugin no', sin.ok && sin.disposicion.clave === 'plugin:sdxl/nueva' && sin.disposicion.guardada === null && sin.disposicion.delPlugin === null);
    check('y el estado de una sesión abierta antes, tampoco', t.estado(n.sesion).disposicion.guardada === null);
    cfg = config();
    t.parar();
  });

  await group('Un perfil con su propio flujo para «nueva»: flujo:<ruta>, sin la del plugin', async () => {
    const propio = path.join(raiz, 'Flujos', 'Mi-Nueva.json');
    fs.mkdirSync(path.dirname(propio), { recursive: true });
    // Un flujo propio no puede usar los marcadores de LoRA: la plantilla sin sus huecos.
    const r = F.leerFlujo(path.join(F.DIR_PLANTILLAS, 'sdxl', 'nueva.json'));
    fs.writeFileSync(propio, JSON.stringify(F.puentear(r.flujo, r.ficha.huecos, 0)));
    cfg = config({}, { flujos: { sdxl: { nueva: { archivo: propio } } } });
    const t = armar();
    const esperada = D.claveDeFlujo(propio);
    const n = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('la clave sale del flujo que se cargó, no del pedido', n.ok && n.disposicion.clave === esperada && n.disposicion.delPlugin === null && n.disposicion.guardada === null);
    const fila = t.plantillas().plantillas.find((p) => p.id === 'plugin:nueva');
    check('su fila: disposicionDelPlugin false', fila.disposicionDelPlugin === false && fila.conDisposicion === false);
    check('guardar la suya', (await t.guardarDisposicion(n.sesion, { disposicion: mia })).clave === esperada);
    check('y la fila lo dice', t.plantillas().plantillas.find((p) => p.id === 'plugin:nueva').conDisposicion === true);
    const otra = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('al reabrir, la suya', otra.disposicion.deUsuario === true && JSON.stringify(otra.disposicion.guardada) === JSON.stringify(mia));
    t.borrarDisposicion(otra.sesion);
    cfg = config();
    t.parar();
  });

  await group('Guardar y borrar la del usuario de una plantilla del plugin', async () => {
    cfg = config();
    const t = armar();
    const n = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    const g = t.guardarDisposicion(n.sesion, { disposicion: mia });
    check('guardar: { ok, clave }', g.ok && g.clave === 'plugin:sdxl/nueva');
    const ruta = path.join(dirTaller, 'disposiciones', `${crypto.createHash('sha1').update('plugin:sdxl/nueva').digest('hex').slice(0, 16)}.json`);
    const enDisco = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    check('en disposiciones/<sha1[0:16]>.json, con { clave, disposicion, guardada }', enDisco.clave === 'plugin:sdxl/nueva' && JSON.stringify(enDisco.disposicion) === JSON.stringify(mia) && typeof enDisco.guardada === 'string');
    const e = t.estado(n.sesion).disposicion;
    check('el estado: la del usuario manda y delPlugin sigue', e.deUsuario === true && JSON.stringify(e.guardada) === JSON.stringify(mia) && JSON.stringify(e.delPlugin) === JSON.stringify(delPluginNueva));
    check('la fila: conDisposicion y disposicionDelPlugin', (() => { const f = t.plantillas().plantillas.find((p) => p.id === 'plugin:nueva'); return f.conDisposicion === true && f.disposicionDelPlugin === true; })());
    const otra = await t.abrir({ alma: 'alya', ventana, desde: poner() });
    check('una imagen generada con esa plantilla abre con la del usuario', otra.disposicion.deUsuario === true);
    cfg = config({ disposicion_plugin: false });
    check('con la casilla apagada, la del usuario sigue', t.estado(n.sesion).disposicion.deUsuario === true);
    const b0 = t.borrarDisposicion(n.sesion);
    check('borrar con la casilla apagada: delPlugin null', b0.ok && JSON.stringify(b0.borrada) === JSON.stringify(mia) && b0.delPlugin === null && !fs.existsSync(ruta));
    cfg = config();
    t.guardarDisposicion(n.sesion, { disposicion: mia });
    const b1 = t.borrarDisposicion(n.sesion);
    check('borrar: { ok, borrada, delPlugin }', b1.ok && JSON.stringify(b1.borrada) === JSON.stringify(mia) && JSON.stringify(b1.delPlugin) === JSON.stringify(delPluginNueva));
    check('después vuelve la del plugin', t.estado(n.sesion).disposicion.deUsuario === false && JSON.stringify(t.estado(n.sesion).disposicion.guardada) === JSON.stringify(delPluginNueva));
    check('borrar sin nada guardado: borrada null', t.borrarDisposicion(n.sesion).borrada === null);
    const mala = t.guardarDisposicion(n.sesion, { disposicion: { nodos: { 3: { ...mia.nodos[3], pos: [NaN, 0] } } } });
    check('una que no vale: 400 con su campo', mala.ok === false && mala.status === 400 && mala.campo === 'disposicion.nodos.3.pos');
    check('{} no se guarda ni tapa la del plugin', t.guardarDisposicion(n.sesion, { disposicion: {} }).status === 400 && t.estado(n.sesion).disposicion.deUsuario === false);
    check('sesión que no es: 400; que no está: 404', t.guardarDisposicion('s-../x', { disposicion: mia }).status === 400 && t.guardarDisposicion('s-0000000000000000', { disposicion: mia }).status === 404);
    // Corrupto y demasiado grande: cuentan como que no están.
    fs.writeFileSync(ruta, '{no es json');
    check('un archivo corrupto cuenta como que no está', t.estado(n.sesion).disposicion.deUsuario === false && t.estado(n.sesion).disposicion.guardada !== null);
    fs.writeFileSync(ruta, JSON.stringify({ clave: 'plugin:sdxl/nueva', disposicion: mia, relleno: 'x'.repeat(301 * 1024) }));
    check('uno de más de 300 KB no se lee', t.estado(n.sesion).disposicion.deUsuario === false);
    fs.writeFileSync(ruta, JSON.stringify({ clave: 'plugin:sdxl/otra', disposicion: mia }));
    check('uno con otra clave (otro archivo con el mismo nombre) no se usa', t.estado(n.sesion).disposicion.deUsuario === false);
    fs.writeFileSync(ruta, JSON.stringify({ clave: 'plugin:sdxl/nueva', disposicion: { vista: { zoom: 1, desplazamiento: [0, 0] } } }));
    check('uno que solo trae vista no tapa la del plugin', t.estado(n.sesion).disposicion.deUsuario === false && t.estado(n.sesion).disposicion.guardada !== null);
    fs.rmSync(ruta, { force: true });
    t.parar();
  });

  await group('El tope de 200 disposiciones', async () => {
    cfg = config();
    const t = armar();
    const n = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check('guardar la de nueva', t.guardarDisposicion(n.sesion, { disposicion: mia }).ok);
    const dir = path.join(dirTaller, 'disposiciones');
    for (let i = 0; fs.readdirSync(dir).length < TOPE_DISPOSICIONES; i++) fs.writeFileSync(path.join(dir, `${crypto.createHash('sha1').update(`relleno-${i}`).digest('hex').slice(0, 16)}.json`), '{}');
    check('con 200, volver a guardar una que ya existe vale', t.guardarDisposicion(n.sesion, { disposicion: mia }).ok);
    const r = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:retoque-a-mano', base: poner() });
    const tope = t.guardarDisposicion(r.sesion, { disposicion: mia });
    check('una clave nueva: 409 tope', tope.status === 409 && tope.motivo === 'tope');
    fs.rmSync(dir, { recursive: true, force: true });
    t.parar();
  });

  await group('Una plantilla propia: la disposición va dentro de su archivo', async () => {
    cfg = config();
    const t = armar();
    const grafo = JSON.parse(fs.readFileSync(path.join(F.DIR_PLANTILLAS, 'sdxl', 'nueva.json'), 'utf8'));
    const g = t.guardarPlantilla({ nombre: 'Mía', grafo, disposicion: mia });
    check('guardar como plantilla con su disposición', g.ok && !g.sinDisposicion);
    const archivo = path.join(dirTaller, 'plantillas', `${g.id.slice(7)}.json`);
    check('dentro del archivo: { nombre, grafo, disposicion, creada }', JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(archivo, 'utf8')))) === JSON.stringify(['nombre', 'grafo', 'disposicion', 'creada']));
    check('su fila dice conDisposicion, sin disposicionDelPlugin', (() => { const f = t.plantillas().plantillas.find((p) => p.id === g.id); return f.conDisposicion === true && f.disposicionDelPlugin === undefined; })());
    const a = await t.abrir({ alma: 'alya', ventana, plantilla: g.id });
    check('al abrirla: su clave, la suya y deUsuario', a.ok && a.disposicion.clave === g.id && a.disposicion.deUsuario === true && JSON.stringify(a.disposicion.guardada) === JSON.stringify(mia) && a.disposicion.delPlugin === null);
    cfg = config({ disposicion_plugin: false });
    check('con la casilla apagada, la suya sigue', t.estado(a.sesion).disposicion.deUsuario === true);
    cfg = config();
    const otra = { nodos: { 3: { ...mia.nodos[3], pos: [1, 2] } } };
    check('guardar otra la reemplaza en el archivo', t.guardarDisposicion(a.sesion, { disposicion: otra }).ok && JSON.stringify(JSON.parse(fs.readFileSync(archivo, 'utf8')).disposicion) === JSON.stringify(otra));
    const b = t.borrarDisposicion(a.sesion);
    check('borrarla saca el campo y deja el resto', b.ok && JSON.stringify(b.borrada) === JSON.stringify(otra) && b.delPlugin === null && JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(archivo, 'utf8')))) === JSON.stringify(['nombre', 'grafo', 'creada']));
    check('después: sin disposición', t.estado(a.sesion).disposicion.guardada === null && t.plantillas().plantillas.find((p) => p.id === g.id).conDisposicion === false);
    const grande = t.guardarPlantilla({ nombre: 'Enorme', grafo, disposicion: conNodos(350) });
    check('una de 350 nodos: la plantilla se guarda igual, sin disposición', grande.ok && grande.sinDisposicion === true && /se guardó sin ella/.test(grande.motivo) && !Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dirTaller, 'plantillas', `${grande.id.slice(7)}.json`), 'utf8')), 'disposicion'));
    // El peor caso: un grafo de casi 2 MB (el tope de formaDeGrafo) con una disposición grande. Entra en los 2,5 MB con que
    // se lee: se guarda con ella, y guardarle otra después la deja legible.
    const relleno = (bytes) => ({ ...grafo, 999: { class_type: 'Note', inputs: { text: 'x'.repeat(bytes) } } });
    const enorme = conNodos(300, { tipo: '世'.repeat(200) });
    const borde = t.guardarPlantilla({ nombre: 'Borde', grafo: relleno(2 * 1024 * 1024 - 20 * 1024), disposicion: enorme });
    const archivoBorde = () => path.join(dirTaller, 'plantillas', borde.id.slice(7) + '.json');
    check('al borde: se guarda con su disposición y se sigue viendo', borde.ok && !borde.sinDisposicion && fs.statSync(archivoBorde()).size > 2 * 1024 * 1024 && t.plantillas().plantillas.find((p) => p.id === borde.id).conDisposicion === true);
    const ab = await t.abrir({ alma: 'alya', ventana, plantilla: borde.id });
    const otraGrande = conNodos(300, { tipo: '界'.repeat(200) });
    check('guardarle otra después: sigue legible', ab.ok && t.guardarDisposicion(ab.sesion, { disposicion: otraGrande }).ok && t.estado(ab.sesion).disposicion.deUsuario === true && fs.statSync(archivoBorde()).size <= 2.5 * 1024 * 1024);
    check('sin disposición en el pedido, como antes', (() => { const s = t.guardarPlantilla({ nombre: 'Sola', grafo }); return s.ok && s.sinDisposicion === undefined; })());
    fs.rmSync(archivo, { force: true });
    check('borrada la plantilla: guardar y borrar dan 404', t.guardarDisposicion(a.sesion, { disposicion: mia }).status === 404 && t.borrarDisposicion(a.sesion).status === 404);
    const pesada = t.guardarPlantilla({ nombre: 'Pesada', grafo });
    fs.writeFileSync(path.join(dirTaller, 'plantillas', `${pesada.id.slice(7)}.json`), JSON.stringify({ nombre: 'Pesada', grafo, relleno: 'x'.repeat(Math.round(2.6 * 1024 * 1024)) }));
    check('una plantilla propia de más de 2,5 MB no se lee', !t.plantillas().plantillas.some((p) => p.id === pesada.id) && (await t.abrir({ alma: 'alya', ventana, plantilla: pesada.id })).status === 404);
    t.parar();
  });

  await group('Una clave editada a mano en sesion.json queda en null', async () => {
    cfg = config();
    const t = armar();
    const n = await t.abrir({ alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    t.parar();
    const archivo = path.join(dirTaller, 'sesiones', n.sesion, 'sesion.json');
    const s = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    check('la sesión guarda su clave', s.clave === 'plugin:sdxl/nueva');
    fs.writeFileSync(archivo, JSON.stringify({ ...s, clave: 'plugin:../../x' }));
    const t2 = armar();
    check('al cargar: clave null, sin disposición', t2.estado(n.sesion).disposicion.clave === null && t2.estado(n.sesion).disposicion.guardada === null);
    const sc = t2.guardarDisposicion(n.sesion, { disposicion: mia });
    check('y guardar da 409 sin-clave', sc.status === 409 && sc.motivo === 'sin-clave' && t2.borrarDisposicion(n.sesion).motivo === 'sin-clave');
    fs.writeFileSync(archivo, JSON.stringify((({ clave: _c, ...resto }) => resto)(s)));
    const t3 = armar();
    check('una sesión de antes (sin clave): sin disposición', t3.estado(n.sesion).disposicion.clave === null);
    t2.parar(); t3.parar();
  });

  // ------------------------------------------------------------- rutas y ajustes
  await group('Las rutas v2 y los ajustes', async () => {
    cfg = config();
    const t = armar();
    const rutas = rutasMutacionV2({ nucleo: {}, cola: {}, ctx: {}, chatTerminal: 'x', registro: {}, idem: { porId: () => null }, recorte: '', imagenes: {}, taller: () => t });
    const ruta = (metodo, p) => rutas.find((x) => x.metodo === metodo && x.patron.test(p));
    const llamar = (metodo, p, cuerpo = {}) => { const r = ruta(metodo, p); return r.fn({ p: r.patron.exec(p).slice(1).map(decodeURIComponent), cuerpo, url: new URL(`http://x${p}`) }); };
    const n = await llamar('POST', '/api/v2/taller:abrir', { alma: 'alya', ventana, plantilla: 'plugin:nueva' });
    check(':abrir trae disposicion', n.ok && n.disposicion.clave === 'plugin:sdxl/nueva');
    check(':disposicion declara su topeCuerpo de 300 KB', ruta('POST', `/api/v2/taller/${n.sesion}:disposicion`).topeCuerpo === 300 * 1024 && TOPE_DISPOSICION_CUERPO === 300 * 1024);
    check(':disposicion guarda', (await llamar('POST', `/api/v2/taller/${n.sesion}:disposicion`, { disposicion: mia })).clave === 'plugin:sdxl/nueva');
    check('GET /taller/<sesion> trae disposicion', (await llamar('GET', `/api/v2/taller/${n.sesion}`)).disposicion.deUsuario === true);
    const mala = await llamar('POST', `/api/v2/taller/${n.sesion}:disposicion`, { disposicion: { nodos: { 3: { tipo: 'K', pos: [0, 0], tam: [1, 1], x: 1 } } } });
    check('un 400 lleva su campo (deTaller ya no se lo come)', mala.codigo === 400 && mala.campo === 'disposicion.nodos.3.x' && mala.motivo === 'disposicion');
    const b = await llamar('POST', `/api/v2/taller/${n.sesion}:disposicion-borrar`);
    check(':disposicion-borrar', b.ok && b.borrada !== null && b.delPlugin !== null);
    const lista = await llamar('GET', '/api/v2/taller/plantillas');
    check('la lista trae conDisposicion y disposicionDelPlugin por fila', lista.plantillas.filter((p) => p.id.startsWith('plugin:')).every((p) => typeof p.conDisposicion === 'boolean' && typeof p.disposicionDelPlugin === 'boolean'));
    const gp = await llamar('POST', '/api/v2/taller/plantillas', { nombre: 'Grande', grafo: JSON.parse(fs.readFileSync(path.join(F.DIR_PLANTILLAS, 'sdxl', 'nueva.json'), 'utf8')), disposicion: conNodos(350) });
    check('POST /taller/plantillas con una que no vale: sinDisposicion', gp.ok && gp.sinDisposicion === true);
    t.parar();
    // Ajustes.
    check('por defecto, prendida', A.defectos().taller.disposicion_plugin === true);
    const g = A.aplicarImagenes({ imagenes: {} }, { taller: { disposicion_plugin: false } });
    check('el PATCH la guarda', g.imagenes.taller.disposicion_plugin === false);
    check('el PATCH rechaza un valor que no es booleano', (() => { try { A.aplicarImagenes({}, { taller: { disposicion_plugin: 'no' } }); return false; } catch (e) { return /true o false/.test(e.message); } })());
    const nm = A.normalizar({ taller: { disposicion_plugin: false } });
    check('normalizar la lee', nm.imagenes.taller.disposicion_plugin === false && A.normalizar({}).imagenes.taller.disposicion_plugin === true);
    check('la vista v2: prendida si falta, y la guardada si está', ajustesV2({ imagenes: { taller: {} } }).imagenes.taller.disposicion_plugin === true && ajustesV2({ imagenes: { taller: { disposicion_plugin: false } } }).imagenes.taller.disposicion_plugin === false);
  });

  fs.rmSync(raiz, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
