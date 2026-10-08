/**
 * FEAT-136 F4 — Lo que pidió la auditoría de implementación (agy_audit,
 * 2026-10-08): «Olvidar el estado de esta pantalla» en Ajustes, la última
 * vista recordada por dispositivo, y las claves viejas del panel pasadas a
 * `lagrange.ui.*` (así olvidar las alcanza).
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const PUBLICO = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public');
const leer = (...p) => fs.readFileSync(path.join(PUBLICO, ...p), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  await group('Ajustes: olvidar el estado de esta pantalla', () => {
    const vista = leer('ui', 'vista-ajustes.js');
    const olvidar = vista.slice(vista.indexOf('function OlvidarPantalla('), vista.indexOf('\n}\n', vista.indexOf('function OlvidarPantalla(')));
    check('usa olvidarTodo de persistencia', /import \{ persistente, olvidarTodo \} from '\.\/persistencia\.js';/.test(vista) && olvidar.includes('olvidarTodo();'));
    check('recarga después: ninguna señal en memoria lo vuelve a escribir', /olvidarTodo\(\);\s*location\.reload\(\);/.test(olvidar));
    check('pide confirmación', olvidar.includes('<${BotonDosPasos} texto="Olvidar el estado de esta pantalla"'));
    check('la página lo muestra', vista.includes('<${OlvidarPantalla} />'));
  });

  await group('La última vista, por dispositivo', () => {
    const app = leer('app.js');
    const fuente = /const RUTA_RECORDABLE = (\/.*\/);/.exec(app)?.[1];
    check('hay un patrón de rutas recordables', Boolean(fuente));
    const re = new Function(`return ${fuente};`)();
    for (const r of ['/', '/alma/alya', '/agente/lagrange-reviewer', '/tablero', '/programado', '/proveedores', '/rendimiento', '/ajustes', '/sesiones', '/logs']) {
      check(`recuerda ${r}`, re.test(r));
    }
    for (const r of ['/login', '/tablero?t=abc', '/alma/', '/alma/a/b', '/api/estado', '/vendor/preact.module.js', 'https://otro/tablero', '/alma/x#y']) {
      check(`no recuerda ${r}`, !re.test(r));
    }
    check('se valida al leer', app.includes("persistente('ruta.ultima', '/', { validar: (v) => typeof v === 'string' && RUTA_RECORDABLE.test(v) })"));
    check('solo restaura al abrir en / sin parámetros', app.includes("if (location.pathname === '/' && !location.search && !location.hash && ultimaRuta.value !== '/') history.replaceState(null, '', ultimaRuta.value);"));
    const arranque = app.slice(app.indexOf('// ---------------------------------------------------------------- arranque'));
    check('restaura antes de leer la ruta', arranque.indexOf('history.replaceState(null, \'\', ultimaRuta.value)') < arranque.indexOf('estado.ruta = leerRuta();'));
    const cambio = app.slice(app.indexOf('function alCambiarRuta()'), app.indexOf('\n  }\n', app.indexOf('function alCambiarRuta()')));
    check('cada navegación la recuerda', cambio.indexOf('recordarRuta();') > cambio.indexOf('estado.ruta = leerRuta();'));
  });

  await group('Panel: las claves viejas pasan a lagrange.ui.*', () => {
    const panel = leer('ui', 'panel.js');
    const abierto = panel.slice(panel.indexOf('export function abiertoDe('), panel.indexOf('\n}\n', panel.indexOf('export function abiertoDe(')));
    check('copia el valor viejo si no hay uno nuevo', abierto.includes("if (leer(k) === undefined) escribir(k, v === '1');"));
    check('y borra la clave vieja', abierto.includes('localStorage.removeItem(vieja);'));
    check('no lee lagrange.panel.* en ningún otro lado', (panel.match(/lagrange\.panel\./g) || []).length === 2);
  });

  report();
})();
