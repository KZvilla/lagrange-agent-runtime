/**
 * FEAT-136 F0 — La base de los componentes de la consola web: los
 * vendorizados (Preact, signals, htm) verificados por sha256, el mapa de
 * `/vendor` y `/ui` que arma el servidor, la persistencia de la interfaz, el
 * despachador de eventos y las reglas de seguridad sobre `ui/`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const RAIZ = path.join(__dirname, '..');
const PUBLICO = path.join(RAIZ, 'telegram-bridge', 'web', 'public');
const VENDOR = path.join(PUBLICO, 'vendor');
const UI = path.join(PUBLICO, 'ui');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const temporales = [];
process.on('exit', () => { for (const d of temporales) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const importar = (ruta) => import(pathToFileURL(ruta).href);

/** Un Storage en memoria; `roto` hace que todo lance. */
function almacen({ roto = false } = {}) {
  const m = new Map();
  const falla = () => { throw new Error('QuotaExceededError'); };
  return {
    get length() { return roto ? falla() : m.size; },
    key: (i) => (roto ? falla() : [...m.keys()][i] ?? null),
    getItem: (k) => (roto ? falla() : (m.has(k) ? m.get(k) : null)),
    setItem: (k, v) => (roto ? falla() : m.set(k, String(v))),
    removeItem: (k) => (roto ? falla() : m.delete(k)),
    mapa: m
  };
}

async function main() {
  await group('vendorizados: manifiesto, sha256, imports relativos, sin eval', async () => {
    const man = JSON.parse(fs.readFileSync(path.join(VENDOR, 'MANIFEST.json'), 'utf8'));
    const js = fs.readdirSync(VENDOR).filter((f) => f.endsWith('.js'));
    check('cinco módulos', js.length === 5 && Object.keys(man.archivos).length === 5, js.join(','));
    for (const f of js) {
      const buf = fs.readFileSync(path.join(VENDOR, f));
      check(`${f}: sha256 = manifiesto`, man.archivos[f] && sha256(buf) === man.archivos[f].sha256);
      const txt = buf.toString('utf8');
      const especs = [...txt.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
      check(`${f}: solo imports './'`, especs.every((e) => e.startsWith('./')), especs.join(','));
      check(`${f}: sin eval ni new Function`, !/\beval\(|new Function|\bFunction\(/.test(txt));
    }
    check('versiones fijas', man.paquetes.map((p) => `${p.nombre}@${p.version}`).join() === 'preact@11.0.0,@preact/signals-core@1.14.4,@preact/signals@2.11.3,htm@3.1.1');
    check('integrity sha512 registrada', man.paquetes.every((p) => /^sha512-/.test(p.integridad)));
    check('licencias al lado', ['preact.LICENSE.txt', 'htm.LICENSE.txt', 'preact__signals.LICENSE.txt', 'preact__signals-core.LICENSE.txt'].every((f) => fs.existsSync(path.join(VENDOR, f))));
    const attrs = fs.readFileSync(path.join(RAIZ, '.gitattributes'), 'utf8');
    check('.gitattributes: los vendorizados sin conversión de fin de línea', /telegram-bridge\/web\/public\/vendor\/\*\.js -text/.test(attrs));
    const { reescribirImports } = await importar(path.join(RAIZ, 'scripts', 'vendor-ui.mjs'));
    check('reescribe preact/hooks', reescribirImports('import{a}from"preact/hooks";', 'x') === 'import{a}from"./hooks.module.js";');
    let lanzo = false;
    try { reescribirImports('import x from "lodash"', 'x'); } catch { lanzo = true; }
    check('un import desconocido falla', lanzo);
  });

  await group('ui/: seguridad e imports', () => {
    const archivos = fs.readdirSync(UI).filter((f) => f.endsWith('.js'));
    check('main, html, estado, persistencia y sse', ['main.js', 'html.js', 'estado.js', 'persistencia.js', 'sse.js'].every((f) => archivos.includes(f)));
    for (const f of archivos) {
      const txt = fs.readFileSync(path.join(UI, f), 'utf8');
      check(`${f}: sin HTML inyectado ni código dinámico`, !/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write|\beval\(|new Function|dangerouslySetInnerHTML/.test(txt.replace(/^\s*\*.*$/gm, '')));
      const especs = [...txt.matchAll(/\bfrom\s*["']([^"']+)["']|^import\s+["']([^"']+)["']/gm)].map((m) => m[1] || m[2]);
      check(`${f}: imports relativos`, especs.every((e) => e.startsWith('./') || e.startsWith('../vendor/')), especs.join(','));
    }
    const app = fs.readFileSync(path.join(PUBLICO, 'app.js'), 'utf8');
    check('app.js reenvía los eventos al puente', /window\.lagrangeUI\?\.evento\(e\)/.test(app));
    check('app.js no expone su estado', !/window\.\w+\s*=\s*estado\b/.test(app));
    const index = fs.readFileSync(path.join(PUBLICO, 'index.html'), 'utf8');
    check('index.html carga ui/main.js como módulo, después de app.js', index.indexOf('src="/app.js"') < index.indexOf('<script type="module" src="/ui/main.js">'));
  });

  await group('servidor: el mapa de /vendor y /ui', async () => {
    const { cargarModulosUI, NOMBRE_MODULO } = await importar(path.join(RAIZ, 'telegram-bridge', 'web', 'modulos-ui.js'));
    const real = cargarModulosUI({ dirPublico: PUBLICO });
    check('los cinco vendorizados verificados y los de ui', real.rechazados.length === 0 && [...real.rutas.keys()].filter((r) => r.startsWith('/vendor/')).length === 5 && real.rutas.has('/ui/main.js'));
    check('MANIFEST.json y las licencias no se sirven', !real.rutas.has('/vendor/MANIFEST.json') && ![...real.rutas.keys()].some((r) => r.endsWith('.txt')));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat136-'));
    temporales.push(dir);
    fs.mkdirSync(path.join(dir, 'vendor'));
    fs.mkdirSync(path.join(dir, 'ui', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor', 'bueno.js'), 'export const a = 1;');
    fs.writeFileSync(path.join(dir, 'vendor', 'tocado.js'), 'export const b = 2; // editado');
    fs.writeFileSync(path.join(dir, 'vendor', 'suelto.js'), 'export const c = 3;');
    fs.writeFileSync(path.join(dir, 'vendor', 'MANIFEST.json'), JSON.stringify({ archivos: { 'bueno.js': { sha256: sha256('export const a = 1;') }, 'tocado.js': { sha256: sha256('export const b = 2;') } } }));
    fs.writeFileSync(path.join(dir, 'ui', 'vista.js'), 'v1');
    fs.writeFileSync(path.join(dir, 'ui', 'Mayus.js'), 'x');
    fs.writeFileSync(path.join(dir, 'ui', 'nota.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'ui', 'sub', 'hondo.js'), 'x');
    const logs = [];
    const r = cargarModulosUI({ dirPublico: dir, log: (l) => logs.push(l) });
    check('el que coincide se sirve', r.rutas.has('/vendor/bueno.js'));
    check('uno editado o fuera del manifiesto no, y queda registrado', !r.rutas.has('/vendor/tocado.js') && !r.rutas.has('/vendor/suelto.js') && r.rechazados.sort().join() === 'suelto.js,tocado.js' && logs.length === 2);
    check('ui: solo nombres válidos, sin subdirectorios', [...r.rutas.keys()].filter((k) => k.startsWith('/ui/')).join() === '/ui/vista.js');
    fs.writeFileSync(path.join(dir, 'ui', 'vista.js'), 'v2');
    check('ui se relee en cada pedido', r.rutas.get('/ui/vista.js').leer().toString() === 'v2');
    fs.writeFileSync(path.join(dir, 'vendor', 'bueno.js'), 'export const a = 666;');
    check('vendor sirve lo verificado, no lo que cambió después', r.rutas.get('/vendor/bueno.js').leer().toString() === 'export const a = 1;');
    check('nombres', NOMBRE_MODULO.test('signals-core.module.js') && !NOMBRE_MODULO.test('../x.js') && !NOMBRE_MODULO.test('.oculto.js'));
    check('sin directorio: mapa vacío, sin tirar', cargarModulosUI({ dirPublico: path.join(dir, 'no-existe') }).rutas.size === 0);
  });

  await group('persistencia: localStorage por dispositivo, tolerante', async () => {
    const p = await importar(path.join(UI, 'persistencia.js'));
    const a = almacen();
    a.setItem('lagrange.ui.v1.vista', JSON.stringify('tablero'));
    a.setItem('lagrange.ui.v1.rota', '{no json');
    a.setItem('otra.cosa', 'x');
    check('lee lo guardado', p.leer('vista', { almacen: a }) === 'tablero');
    check('JSON roto: undefined', p.leer('rota', { almacen: a }) === undefined);
    check('validar en falso: undefined', p.leer('vista', { almacen: a, validar: (v) => v === 'charlas' }) === undefined);
    a.setItem('lagrange.ui.v1.grande', JSON.stringify('x'.repeat(p.TOPE_BYTES + 10)));
    check('lo que pasa el tope se ignora', p.leer('grande', { almacen: a }) === undefined);
    check('un almacén que falla no tira', p.leer('vista', { almacen: almacen({ roto: true }) }) === undefined && p.escribir('vista', 1, { almacen: almacen({ roto: true }) }) === false);
    check('sin almacén no tira', p.leer('vista', { almacen: null }) === undefined && p.olvidarTodo({ almacen: null }) === 0);

    const timers = [];
    const temporizador = { set: (fn) => { timers.push(fn); return timers.length; }, clear: (id) => { timers[id - 1] = null; } };
    const s = p.persistente('vista', 'charlas', { almacen: a, temporizador, validar: (v) => typeof v === 'string' });
    check('arranca con lo guardado', s.value === 'tablero');
    check('arrancar no escribe', timers.length === 0);
    s.value = 'ajustes';
    s.value = 'proveedores';
    check('debounce: solo el último timer vive', timers.filter(Boolean).length === 1);
    timers.filter(Boolean).forEach((fn) => fn());
    check('escribe el último valor', a.getItem('lagrange.ui.v1.vista') === '"proveedores"');
    const nueva = p.persistente('borrador.h1', '', { almacen: a, temporizador });
    check('sin guardado: el inicial', nueva.value === '');
    let lanzo = false;
    try { p.persistente('Mala Clave', 1, { almacen: a }); } catch { lanzo = true; }
    check('una clave inválida se rechaza', lanzo);
    a.setItem('lagrange.ui.v0.viejo', '1');
    check('olvidar borra todo lagrange.ui.* y nada más', p.olvidarTodo({ almacen: a }) === 4 && a.getItem('otra.cosa') === 'x' && a.mapa.size === 1);
  });

  await group('sse: despachador', async () => {
    const sse = await importar(path.join(UI, 'sse.js'));
    sse.olvidarOyentes();
    const vistos = [];
    sse.alEvento('tarea', (e) => vistos.push(`t:${e.id}`));
    sse.alEvento('tarea', () => { throw new Error('roto'); });
    sse.alEvento('*', (e) => vistos.push(`*:${e.tipo}`));
    const errorOriginal = console.error;
    console.error = () => {};
    const n = sse.despachar({ tipo: 'tarea', id: 7 });
    console.error = errorOriginal;
    check('un oyente que falla no corta a los demás', n === 2 && vistos.join() === 't:7,*:tarea');
    check('eventos inválidos: nada', sse.despachar(null) === 0 && sse.despachar({ tipo: 3 }) === 0 && sse.despachar('x') === 0);
    const baja = sse.alEvento('otro', () => vistos.push('otro'));
    baja();
    sse.despachar({ tipo: 'otro' });
    check('dar de baja', !vistos.includes('otro'));
  });

  report();
}

main().catch((err) => { console.error(err); process.exit(1); });
