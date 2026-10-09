/**
 * FEAT-052 — Servidor HTTP de la consola web local.
 *
 * Solo transporte y seguridad: cada ruta delega en el `nucleo` que arma
 * `bot.js` (charla, cast, cola…). No importa `bot.js`, así los tests lo
 * levantan con un núcleo falso y no hay import circular.
 *
 * Seguridad (plan §5): solo loopback, `Host` de loopback (anti rebinding),
 * token por arranque canjeado por una cookie `HttpOnly; SameSite=Strict`,
 * `Origin`/`Sec-Fetch-Site` en las mutaciones, sin CORS, y una CSP sin nada
 * inline: la interfaz son archivos estáticos (FEAT-053).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { redactSecrets } from '../policy.js';
import { crearRecolectorRendimiento } from '../rendimiento.js';
import { cargarModulosUI } from './modulos-ui.js';

const require = createRequire(import.meta.url);
const { tokenCoincide, hostEsLoopback, origenAceptable } = require('../../mcp-server/lib/seguridad-http.js');

export const PUERTO_WEB_POR_DEFECTO = 4518;
// BE-052 — Con WSL mirrored, Windows y WSL comparten el loopback. Cada lado
// tiene su puerto fijo para que un marcador abra siempre la misma consola.
export const PUERTO_WEB_WSL = 4519;
// Prefijo: el nombre real lleva el puerto (`cookieWeb`).
export const COOKIE_WEB = 'lg_web';
const TOPE_CUERPO_BYTES = 64 * 1024;
// Un proxy o el propio navegador cortan un SSE mudo; el comentario lo mantiene vivo.
const LATIDO_MS = 25_000;

const DIR_PUBLICO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// FEAT-053 — Lo único que se sirve del disco. Un mapa fijo, no una carpeta:
// ninguna ruta pedida llega a armar un path.
const ESTATICOS = Object.freeze({
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/rendimiento-vista.js': ['rendimiento-vista.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  // FEAT-148 — Estilos de la isla del grafo (xyflow + nodos), generados por grafo/build.mjs.
  '/grafo.css': ['grafo.css', 'text/css; charset=utf-8']
});

// Rutas de la interfaz: todas sirven la misma página y el cliente decide qué mostrar.
const RUTAS_SHELL = [/^\/$/, /^\/tablero$/, /^\/tuberias$/, /^\/programado$/, /^\/proveedores$/, /^\/rendimiento$/, /^\/ajustes$/, /^\/sesiones$/, /^\/logs$/, /^\/alma\/[^/]+$/, /^\/agente\/[^/]+$/];
// Las páginas de FEAT-052 ya no existen; un marcador viejo cae en el inicio.
const RUTAS_VIEJAS = new Set(['/cast', '/cola', '/memoria']);

// FEAT-055 — `media-src blob:`: el audio de "escuchar" llega por fetch y se
// reproduce desde un Blob.
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function leerPublico(nombre) {
  return fs.readFileSync(path.join(DIR_PUBLICO, nombre));
}

/** BE-052 — Puerto por defecto de la consola según dónde corre el daemon. */
export function puertoWebPorDefecto({ wsl = false } = {}) {
  return wsl ? PUERTO_WEB_WSL : PUERTO_WEB_POR_DEFECTO;
}

/**
 * BE-052 — Las cookies son por host, no por puerto (RFC 6265 §8.5): dos
 * consolas en el mismo loopback se pisarían `lg_web`. El nombre lleva el
 * puerto con el que el navegador llegó.
 */
export function cookieWeb(puerto) {
  return `${COOKIE_WEB}_${puerto}`;
}

/**
 * Puerto del encabezado `Host`, que es el que ve el navegador. No el del
 * socket: detrás de un túnel o de `docker -p` dos consolas pueden compartir el
 * puerto interno. `URL` entiende `[::1]:4519`; sin puerto, el del esquema.
 */
export function puertoDelHost(req) {
  try {
    return Number(new URL(`http://${String(req.headers.host || '')}`).port || 80);
  } catch {
    return null;
  }
}

export function leerCookie(req, nombre) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return null;
}

class ErrorHttp extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.codigo = codigo;
  }
}

function leerCuerpoJson(req) {
  return new Promise((resolve, reject) => {
    const tipo = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(tipo)) {
      reject(new ErrorHttp(415, 'Se espera application/json.'));
      req.resume();
      return;
    }
    const partes = [];
    let total = 0;
    let cortado = false;
    req.on('data', (trozo) => {
      if (cortado) return;
      total += trozo.length;
      if (total > TOPE_CUERPO_BYTES) {
        cortado = true;
        reject(new ErrorHttp(413, 'Cuerpo demasiado grande.'));
        return;
      }
      partes.push(trozo);
    });
    req.on('end', () => {
      if (cortado) return;
      const texto = Buffer.concat(partes).toString('utf8');
      if (!texto.trim()) return resolve({});
      try {
        const datos = JSON.parse(texto);
        if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('no es un objeto');
        resolve(datos);
      } catch {
        reject(new ErrorHttp(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function cabecerasBase(extra = {}) {
  return {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extra
  };
}

/**
 * FEAT-134 — Rutas de Ajustes: SIEMPRE de este proceso. No están en
 * `rutasApi`, así que no entran en `metodosPermitidos` ni en
 * `NIVEL_DE_MUTACION`: un nodo remoto nunca las ejecuta por RPC, y
 * `/api/n/<nodo>/ajustes` da 404. Pasan por el mismo bloque que las demás
 * (sesión, `mutacion` → origen aceptable y cuerpo JSON con tope).
 */
function rutasLocales(nucleo) {
  return [
    { metodo: 'GET', patron: /^\/api\/ajustes$/, fn: () => nucleo.ajustes() },
    { metodo: 'GET', patron: /^\/api\/ajustes\/perfiles$/, fn: () => nucleo.perfilesAjustes() },
    { metodo: 'POST', patron: /^\/api\/ajustes$/, mutacion: true, fn: ({ cuerpo }) => nucleo.guardarAjustes(cuerpo) },
    { metodo: 'POST', patron: /^\/api\/ajustes\/probar-voz$/, mutacion: true, fn: ({ cuerpo }) => nucleo.probarVoz(cuerpo) }
  ];
}

/**
 * Tabla de rutas de la API. `mutacion` exige además origen aceptable y cuerpo
 * JSON. `:clave` llega decodificado; validarlo es cosa del núcleo.
 */
function rutasApi(nucleo) {
  const segmento = '([^/]+)';
  return [
    { metodo: 'GET', patron: /^\/api\/almas$/, fn: () => nucleo.almas() },
    { metodo: 'GET', patron: new RegExp(`^/api/almas/${segmento}/memoria$`), fn: ({ p }) => nucleo.memoria(p[0]) },
    // FEAT-081 — Solo lee: la búsqueda en la memoria profunda del alma.
    { metodo: 'GET', patron: new RegExp(`^/api/almas/${segmento}/profunda$`), fn: ({ p, url }) => nucleo.buscarProfunda(p[0], url.searchParams.get('q')) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/olvidar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.olvidar(p[0], cuerpo.id) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/recordar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.recordar(p[0], cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/mensaje$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.mensaje(p[0], cuerpo.texto) },
    { metodo: 'POST', patron: new RegExp(`^/api/almas/${segmento}/nuevo$`), mutacion: true, fn: ({ p }) => nucleo.hiloNuevo(p[0]) },
    // FEAT-076 — Panel lateral: hilo y diario del alma; reglas del proyecto del agente (solo GET).
    { metodo: 'GET', patron: new RegExp(`^/api/almas/${segmento}/hilo$`), fn: ({ p }) => nucleo.hiloAlma(p[0]) },
    { metodo: 'GET', patron: new RegExp(`^/api/almas/${segmento}/diario$`), fn: ({ p }) => nucleo.diarioAlma(p[0]) },
    { metodo: 'GET', patron: new RegExp(`^/api/agentes/${segmento}/reglas$`), fn: ({ p }) => nucleo.reglasAgente(p[0]) },
    { metodo: 'GET', patron: new RegExp(`^/api/agentes/${segmento}/reglas/${segmento}$`), fn: ({ p }) => nucleo.reglaAgente(p[0], p[1]) },
    { metodo: 'GET', patron: /^\/api\/agentes$/, fn: () => nucleo.agentes() },
    { metodo: 'GET', patron: /^\/api\/workspaces$/, fn: () => nucleo.workspaces() },
    { metodo: 'POST', patron: /^\/api\/cast$/, mutacion: true, fn: ({ cuerpo }) => nucleo.castear(cuerpo) },
    { metodo: 'GET', patron: /^\/api\/cola$/, fn: () => nucleo.cola() },
    { metodo: 'POST', patron: /^\/api\/cancelar$/, mutacion: true, fn: ({ cuerpo }) => nucleo.cancelar(cuerpo.carril) },
    { metodo: 'GET', patron: /^\/api\/fanout$/, fn: () => nucleo.fanout() },
    // FEAT-057 — Escribe un centinela en el repo del lote.
    { metodo: 'POST', patron: /^\/api\/fanout\/detener$/, mutacion: true, fn: ({ cuerpo }) => nucleo.detenerFanout(cuerpo) },
    { metodo: 'GET', patron: /^\/api\/sesiones$/, fn: () => nucleo.sesiones() },
    { metodo: 'GET', patron: /^\/api\/logs$/, fn: ({ url }) => nucleo.logs(url.searchParams.get('n')) },
    // FEAT-053
    { metodo: 'GET', patron: /^\/api\/estado$/, fn: () => nucleo.estado() },
    { metodo: 'GET', patron: /^\/api\/sujetos$/, fn: () => nucleo.sujetos() },
    { metodo: 'GET', patron: /^\/api\/tareas$/, fn: ({ url }) => nucleo.tareas(url.searchParams.get('sujeto'), url.searchParams.get('q'), url.searchParams.get('programado')) },
    { metodo: 'GET', patron: new RegExp(`^/api/agentes/${segmento}/contexto$`), fn: ({ p }) => nucleo.contextoAgente(p[0]) },
    // FEAT-079
    { metodo: 'GET', patron: new RegExp(`^/api/agentes/${segmento}/criterio$`), fn: ({ p }) => nucleo.criterioAgente(p[0]) },
    // SEC-021 — Memoria en cuarentena: ver, promover (hace el commit a mcp-memory) y descartar.
    { metodo: 'GET', patron: new RegExp(`^/api/agentes/${segmento}/cuarentena$`), fn: ({ p }) => nucleo.cuarentenaAgente(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/agentes/${segmento}/cuarentena/promover$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.promoverCuarentena(p[0], cuerpo.id) },
    { metodo: 'POST', patron: new RegExp(`^/api/agentes/${segmento}/cuarentena/descartar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.descartarCuarentena(p[0], cuerpo.id) },
    // FEAT-054
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/cancelar$`), mutacion: true, fn: ({ p }) => nucleo.cancelarTarea(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/reintentar$`), mutacion: true, fn: ({ p }) => nucleo.reintentarTarea(p[0]) },
    // FEAT-055 — Mutación: ocupa GPU. Responde el audio, no JSON.
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/escuchar$`), mutacion: true, fn: ({ p }) => nucleo.escucharTarea(p[0]) },
    // FEAT-056 — Mutación: arranca servidores y carga pesos en la GPU.
    { metodo: 'POST', patron: /^\/api\/voz\/preparar$/, mutacion: true, fn: ({ cuerpo }) => nucleo.prepararVoz(cuerpo) },
    // FEAT-057 — Por hacer, detalle, notas y "volver a Por hacer".
    { metodo: 'POST', patron: /^\/api\/tarjetas$/, mutacion: true, fn: ({ cuerpo }) => nucleo.crearTarjeta(cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/editar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.editarTarjeta(p[0], cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/lanzar$`), mutacion: true, fn: ({ p }) => nucleo.lanzarTarjeta(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/mover$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.moverTarjeta(p[0], cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/borrar$`), mutacion: true, fn: ({ p }) => nucleo.borrarTarjeta(p[0]) },
    // FEAT-058
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/aceptar$`), mutacion: true, fn: ({ p }) => nucleo.aceptarPropuesta(p[0]) },
    // FEAT-059
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/partir$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.partirTarjeta(p[0], cuerpo) },
    // FEAT-061 fase 4 — lotes confinados persistentes.
    { metodo: 'POST', patron: new RegExp(`^/api/tarjetas/${segmento}/lote$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.lanzarLote(p[0], cuerpo) },
    { metodo: 'GET', patron: /^\/api\/lotes$/, fn: () => nucleo.lotes() },
    // FEAT-148 G3 — antes de /api/lotes/:id, que si no lo tomaría como un id.
    { metodo: 'GET', patron: /^\/api\/lotes\/borradores$/, fn: () => nucleo.borradoresLote() },
    { metodo: 'GET', patron: new RegExp(`^/api/lotes/${segmento}$`), fn: ({ p }) => nucleo.lote(p[0]) },
    { metodo: 'GET', patron: new RegExp(`^/api/lotes/${segmento}/tareas/${segmento}/diff$`), fn: ({ p }) => nucleo.diffLote(p[0], p[1]) },
    { metodo: 'POST', patron: new RegExp(`^/api/lotes/${segmento}/descartar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.descartarLote(p[0], cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/lotes/${segmento}/integrar$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.integrarLote(p[0], cuerpo) },
    { metodo: 'GET', patron: new RegExp(`^/api/tareas/${segmento}$`), fn: ({ p }) => nucleo.tarea(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/notas$`), mutacion: true, fn: ({ p, cuerpo }) => nucleo.agregarNota(p[0], cuerpo.texto) },
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/devolver$`), mutacion: true, fn: ({ p }) => nucleo.devolver(p[0]) },
    // FEAT-068
    { metodo: 'POST', patron: /^\/api\/tareas\/archivar$/, mutacion: true, fn: ({ cuerpo }) => nucleo.archivarTareas(cuerpo.ids) },
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/archivar$`), mutacion: true, fn: ({ p }) => nucleo.archivarTarea(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/tareas/${segmento}/desarchivar$`), mutacion: true, fn: ({ p }) => nucleo.desarchivarTarea(p[0]) },
    // FEAT-069 — Proveedores: solo GET.
    { metodo: 'GET', patron: /^\/api\/proveedores$/, fn: () => nucleo.proveedores() },
    // FEAT-075 — Motor, modelo y esfuerzo por alma y por agente.
    { metodo: 'GET', patron: /^\/api\/motores$/, fn: () => nucleo.motores() },
    { metodo: 'POST', patron: /^\/api\/motores\/rol$/, mutacion: true, fn: ({ cuerpo }) => nucleo.guardarMotor(cuerpo) },
    // FEAT-066 — Programado.
    { metodo: 'GET', patron: /^\/api\/programaciones$/, fn: () => nucleo.programaciones() },
    { metodo: 'POST', patron: /^\/api\/programaciones$/, mutacion: true, fn: ({ cuerpo }) => nucleo.crearProgramacion(cuerpo) },
    { metodo: 'POST', patron: new RegExp(`^/api/programaciones/${segmento}/pausar$`), mutacion: true, fn: ({ p }) => nucleo.pausarProgramacion(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/programaciones/${segmento}/seguir$`), mutacion: true, fn: ({ p }) => nucleo.seguirProgramacion(p[0]) },
    { metodo: 'POST', patron: new RegExp(`^/api/programaciones/${segmento}/borrar$`), mutacion: true, fn: ({ p }) => nucleo.borrarProgramacion(p[0]) }
  ];
}

// ==============================================================================
// SEC-022 §3 — Niveles de permiso de las acciones remotas
// ==============================================================================

/** Acumulativos: cada nivel incluye a los anteriores. */
export const NIVELES = Object.freeze(['lectura', 'operar', 'ejecutar']);

/**
 * §3.1 — El nivel de cada mutación. `operar`: cambia el tablero, las almas o
 * las programaciones sin lanzar agentes, sin GPU y sin borrar trabajo del
 * disco. `ejecutar`: lanza un agente, ocupa la GPU, cambia qué modelo corre o
 * borra trabajo del disco. Un test exige que toda ruta `mutacion` esté acá.
 */
export const NIVEL_DE_MUTACION = Object.freeze({
  cancelar: 'operar', cancelarTarea: 'operar', detenerFanout: 'operar', crearTarjeta: 'operar',
  editarTarjeta: 'operar', moverTarjeta: 'operar', borrarTarjeta: 'operar', aceptarPropuesta: 'operar', agregarNota: 'operar',
  devolver: 'operar', archivarTarea: 'operar', archivarTareas: 'operar', desarchivarTarea: 'operar',
  pausarProgramacion: 'operar', seguirProgramacion: 'operar', borrarProgramacion: 'operar',
  hiloNuevo: 'operar', recordar: 'operar', olvidar: 'operar', promoverCuarentena: 'operar', descartarCuarentena: 'operar',
  mensaje: 'ejecutar', castear: 'ejecutar', lanzarTarjeta: 'ejecutar', partirTarjeta: 'ejecutar', lanzarLote: 'ejecutar',
  reintentarTarea: 'ejecutar', crearProgramacion: 'ejecutar', guardarMotor: 'ejecutar', escucharTarea: 'ejecutar',
  prepararVoz: 'ejecutar', descartarLote: 'ejecutar', integrarLote: 'ejecutar'
});

/**
 * FEAT-090 §6.4, §6.6 — Métodos que solo pide el servidor por RPC (no tienen
 * ruta): la foto del tablero para la réplica, y lo que un alma propone o anota
 * en el tablero de un nodo. Con nivel, como las mutaciones.
 */
export const NIVEL_RPC = Object.freeze({ replicaTablero: 'lectura', proponerTarjetaDeAlma: 'operar', anotarDeAlma: 'operar' });

/**
 * Nivel que pide un método remoto: `lectura` para los de las rutas GET, el
 * de la tabla para las mutaciones, `null` para lo que no está en ninguna
 * (se rechaza). `crearTarjeta` es el único que mira sus argumentos: con
 * `lanzar: true` lanza un agente.
 */
export function nivelDe(metodo, args = [], permitidosLectura = metodosPermitidos()) {
  if (metodo === 'crearTarjeta' && args?.[0] && typeof args[0] === 'object' && args[0].lanzar === true) return 'ejecutar';
  if (Object.hasOwn(NIVEL_DE_MUTACION, metodo)) return NIVEL_DE_MUTACION[metodo];
  if (Object.hasOwn(NIVEL_RPC, metodo)) return NIVEL_RPC[metodo];
  if (permitidosLectura.has(metodo)) return 'lectura';
  return null;
}

/** ¿`permite` alcanza para `nivel`? Un nivel desconocido no alcanza para nada. */
export function nivelAlcanza(permite, nivel) {
  const p = NIVELES.indexOf(permite);
  const n = NIVELES.indexOf(nivel);
  return p >= 0 && n >= 0 && n <= p;
}

/** Los métodos que usan las rutas `mutacion`, para el test de cobertura de la tabla. */
export function metodosDeMutacion() {
  const pedidos = new Set();
  const espia = new Proxy({}, { get: (_, m) => (typeof m === 'string' ? () => { pedidos.add(m); return {}; } : undefined) });
  const url = new URL('http://127.0.0.1/');
  for (const r of rutasApi(espia)) {
    if (r.mutacion) r.fn({ p: ['x', 'y'], cuerpo: {}, url });
  }
  return pedidos;
}

/**
 * FEAT-089 §4.4 — Los métodos del núcleo que un nodo acepta ejecutar por RPC:
 * los que usan las rutas `GET` de la consola, y nada más. Se derivan de la
 * tabla de rutas ejecutándolas contra un núcleo que solo anota qué se pidió,
 * así una ruta `GET` nueva entra sola y una mutación no puede colarse.
 */
export function metodosPermitidos() {
  const pedidos = new Set();
  const espia = new Proxy({}, { get: (_, m) => (typeof m === 'string' ? () => { pedidos.add(m); return {}; } : undefined) });
  const url = new URL('http://127.0.0.1/');
  for (const r of rutasApi(espia)) {
    if (r.metodo !== 'GET') continue;
    r.fn({ p: ['x', 'y'], cuerpo: {}, url });
  }
  return pedidos;
}

/**
 * @param {object} opciones
 * @param {object} opciones.nucleo  operaciones de la consola (ver web/nucleo.js)
 * @param {string} opciones.token   secreto de este arranque
 * @param {object} [opciones.red]   FEAT-089, solo en `rol = servidor`: `{ servidorNodos, nucleoRemoto(id), nombreLocal }`
 */
export function crearServidorWeb({ nucleo, token, latidoMs = LATIDO_MS, red = null, nombreLocal = 'local', rendimiento = {} } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('crearServidorWeb necesita un token de al menos 32 caracteres.');
  if (!nucleo) throw new Error('crearServidorWeb necesita un núcleo.');
  const rutas = rutasApi(nucleo);
  const locales = rutasLocales(nucleo);
  const flujos = new Set();
  const recolector = crearRecolectorRendimiento(rendimiento);
  // FEAT-136 — `/vendor/*` verificados por sha256 y `/ui/*`: el mapa se arma una vez, acá.
  const modulosUI = cargarModulosUI({ dirPublico: DIR_PUBLICO, log: (l) => console.error(l) }).rutas;

  /**
   * SEC-022 §3.2 — El núcleo remoto de un nodo, con el anticipo del servidor:
   * lo que pide más de lo que el nodo permite (lo declaró en el apretón de
   * manos) se rechaza sin RPC. El nodo es la autoridad y vuelve a chequear.
   * Cada acción remota queda en el log (§3.4).
   */
  const lecturaPermitida = metodosPermitidos();
  function nucleoConPermiso(nodo) {
    const remoto = red.nucleoRemoto(nodo);
    return new Proxy({}, {
      get(_, metodo) {
        if (typeof metodo !== 'string' || metodo === 'then') return undefined;
        return async (...args) => {
          const nivel = nivelDe(metodo, args, lecturaPermitida);
          const permite = red.servidorNodos.permiteDe(nodo);
          if (!nivel || !nivelAlcanza(permite, nivel)) {
            if (nivel !== 'lectura') console.log(`[remoto] ${nodo} ${metodo} → 403 (el nodo permite ${permite})`);
            return { codigo: 403, ok: false, error: nivel ? `Este nodo permite solo ${permite}: ${metodo} pide ${nivel}.` : 'Método no permitido para un nodo.' };
          }
          const r = await remoto[metodo](...args);
          // BE-064 — El nodo no tiene voz: el servidor lee el resultado con la suya.
          if (metodo === 'escucharTarea' && r?.sinVoz === true && typeof red.escucharPrestado === 'function') {
            const p = await red.escucharPrestado(nodo, args[0]);
            console.log(`[remoto] ${nodo} escucharTarea → sin voz en el nodo (${String(r.error || '').slice(0, 120)}), voz del servidor: ${p?.ok ? 'ok' : p?.codigo || 'error'}`);
            return p?.ok ? { binario: p.audio, tipo: 'audio/wav' } : { codigo: p?.codigo || 503, ok: false, error: p?.error || 'La voz del servidor falló.' };
          }
          if (nivel !== 'lectura') console.log(`[remoto] ${nodo} ${metodo} → ${r?.ok === false || (r?.codigo && r.codigo >= 400) ? r.codigo || 'error' : 'ok'}`);
          return r;
        };
      }
    });
  }

  /** FEAT-089 §6.3 — Los nodos para el selector. El servidor es `local`. */
  const listaNodos = () => [
    { id: 'local', nombre: red?.nombreLocal || nombreLocal, conectado: true },
    ...(red ? red.servidorNodos.listaNodos() : [])
  ];

  // BE-052 — Solo la cookie del puerto del `Host`; la vieja `lg_web` ya no vale.
  const cookieDe = (req) => {
    const puerto = puertoDelHost(req);
    return puerto === null ? null : leerCookie(req, cookieWeb(puerto));
  };
  const autorizado = (req) =>
    tokenCoincide(token, cookieDe(req)) || tokenCoincide(token, req.headers['x-lagrange-token']);

  async function atender(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const responder = (codigo, cuerpo, tipo = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(codigo, cabecerasBase({ 'content-type': tipo, ...extra }));
      res.end(cuerpo);
    };
    const json = (codigo, datos) => responder(codigo, JSON.stringify(datos), 'application/json; charset=utf-8');

    if (!hostEsLoopback(req)) return responder(403, 'Solo se atiende por loopback.');
    // Sin preflight no hay forma de mandar cabeceras propias ni JSON cruzando orígenes.
    if (req.method === 'OPTIONS') return responder(405, 'No.');

    // FEAT-089 §3 — Los nodos entran antes de la cookie: se autentican con su
    // propio apretón de manos. Sin rol servidor, esto no existe.
    if (url.pathname.startsWith('/nodo/')) {
      if (!red) return json(404, { ok: false, error: 'Este daemon no acepta nodos (BRIDGE_ROL no es servidor).' });
      return red.servidorNodos.atender(req, res, url);
    }

    if (req.method === 'GET' && url.pathname === '/login') {
      if (!tokenCoincide(token, url.searchParams.get('t'))) {
        return responder(403, 'Token inválido o de un arranque anterior.\n\nPedí el link de nuevo con `npm run bridge:web` o con /web en Telegram.');
      }
      if (puertoDelHost(req) === null) return responder(400, 'Host inválido.');
      // Misma cadena que el token: un solo usuario local, sin tabla de sesiones.
      return responder(303, '', 'text/plain; charset=utf-8', {
        'set-cookie': `${cookieWeb(puertoDelHost(req))}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        location: '/'
      });
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204, cabecerasBase());
      return res.end();
    }

    if (!autorizado(req)) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return responder(401, 'Falta la sesión de la consola.\n\nAbrí el link que da `npm run bridge:web` (o /web en Telegram).');
      }
      return json(401, { ok: false, error: 'Sin sesión.' });
    }

    if (req.method === 'GET' && RUTAS_VIEJAS.has(url.pathname)) {
      return responder(302, '', 'text/plain; charset=utf-8', { location: '/' });
    }

    if (req.method === 'GET' && RUTAS_SHELL.some((r) => r.test(url.pathname))) {
      return responder(200, leerPublico('index.html'), 'text/html; charset=utf-8', { 'content-security-policy': CSP });
    }

    if (req.method === 'GET' && Object.hasOwn(ESTATICOS, url.pathname)) {
      const [archivo, tipo] = ESTATICOS[url.pathname];
      return responder(200, leerPublico(archivo), tipo, { 'content-security-policy': CSP });
    }

    if (req.method === 'GET' && modulosUI.has(url.pathname)) {
      const m = modulosUI.get(url.pathname);
      return responder(200, m.leer(), m.tipo, { 'content-security-policy': CSP });
    }

    if (req.method === 'GET' && url.pathname === '/api/eventos') {
      return abrirFlujo(req, res, url);
    }

    if (req.method === 'GET' && url.pathname === '/api/nodos') {
      return json(200, { ok: true, nodos: listaNodos() });
    }

    // FEAT-096 — Siempre este proceso; nunca una ruta del núcleo/RPC remoto.
    if (url.pathname === '/api/rendimiento') {
      if (req.method !== 'GET') return json(405, { ok: false, error: 'Método no permitido.' });
      return json(200, { ok: true, ...recolector.instantanea() });
    }
    if (/^\/api\/n\/[^/]+\/rendimiento$/.test(url.pathname)) {
      return json(404, { ok: false, error: 'No existe.' });
    }
    // FEAT-134 — Ajustes es de esta máquina: nunca por nodo.
    if (/^\/api\/n\/[^/]+\/ajustes(\/|$)/.test(url.pathname)) {
      return json(404, { ok: false, error: 'No existe.' });
    }

    // FEAT-090 §6.5 — La vista conjunta: lo local más la réplica de cada nodo.
    if (req.method === 'GET' && (url.pathname === '/api/red/tablero' || url.pathname === '/api/red/programaciones')) {
      if (!red?.vistaRed) return json(404, { ok: false, error: 'Este daemon no es servidor de una red de nodos.' });
      return json(200, { ok: true, ...(await red.vistaRed(url.pathname.endsWith('tablero') ? 'tablero' : 'programaciones')) });
    }

    // FEAT-089 §6.3 — `/api/n/<nodo>/<resto>` es `/api/<resto>` sobre ese nodo.
    let tabla = /^\/api\/ajustes(\/|$)/.test(url.pathname) ? locales : rutas;
    let camino = url.pathname;
    const deNodo = /^\/api\/n\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (deNodo) {
      let nodo;
      try { nodo = decodeURIComponent(deNodo[1]); } catch { return json(400, { ok: false, error: 'Ruta mal codificada.' }); }
      camino = `/api${deNodo[2]}`;
      if (nodo !== 'local') {
        if (!red || !red.servidorNodos.existeNodo(nodo)) return json(404, { ok: false, error: 'No existe ese nodo.' });
        tabla = rutasApi(nucleoConPermiso(nodo));
      }
    }

    const ruta = tabla.find((r) => r.metodo === req.method && r.patron.test(camino));
    if (!ruta) {
      const existe = tabla.some((r) => r.patron.test(camino));
      return json(existe ? 405 : 404, { ok: false, error: existe ? 'Método no permitido.' : 'No existe.' });
    }

    let p;
    try {
      p = ruta.patron.exec(camino).slice(1).map((x) => decodeURIComponent(x));
    } catch {
      return json(400, { ok: false, error: 'Ruta mal codificada.' });
    }

    let cuerpo = {};
    if (ruta.mutacion) {
      if (!origenAceptable(req)) return json(403, { ok: false, error: 'Origen no permitido.' });
      cuerpo = await leerCuerpoJson(req);
    }

    const resultado = await ruta.fn({ p, cuerpo, url });
    if (Buffer.isBuffer(resultado?.binario)) {
      // FEAT-134 — Probar voz manda qué sonó en cabeceras (`x-lagrange-*`, ya codificadas).
      const extra = {};
      for (const [k, v] of Object.entries(resultado.cabeceras || {})) if (/^x-lagrange-[a-z-]+$/.test(k) && typeof v === 'string') extra[k] = v;
      return responder(200, resultado.binario, resultado.tipo || 'application/octet-stream', extra);
    }
    const { codigo = 200, ...datos } = resultado || {};
    return json(codigo, datos);
  }

  function abrirFlujo(req, res, url) {
    const desde = Number(req.headers['last-event-id'] || url.searchParams.get('desde') || 0) || 0;
    res.writeHead(200, cabecerasBase({ 'content-type': 'text/event-stream; charset=utf-8' }));
    // Sin esto el navegador no ve el `open` hasta el primer evento o latido.
    res.flushHeaders();
    const enviar = (evento) => {
      res.write(`id: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`);
    };
    for (const evento of nucleo.canal.pendientes(nucleo.chatId, desde)) enviar(evento);
    const baja = nucleo.canal.suscribir(nucleo.chatId, enviar);
    const latido = setInterval(() => res.write(': latido\n\n'), latidoMs);
    const flujo = { res, cerrar: null };
    flujo.cerrar = () => {
      clearInterval(latido);
      baja();
      flujos.delete(flujo);
    };
    flujos.add(flujo);
    // `res`, no `req`: el `close` de la petición no avisa que el cliente se fue.
    res.on('close', flujo.cerrar);
  }

  const servidor = http.createServer((req, res) => {
    atender(req, res).catch((err) => {
      const codigo = err instanceof ErrorHttp ? err.codigo : 500;
      if (codigo === 500) console.error(`[web] ${req.method} ${req.url?.split('?')[0]}: ${redactSecrets(err?.stack || String(err))}`);
      if (res.headersSent) return res.end();
      res.writeHead(codigo, cabecerasBase({ 'content-type': 'application/json; charset=utf-8', connection: 'close' }));
      res.end(JSON.stringify({ ok: false, error: codigo === 500 ? 'Error interno (ver daemon.log).' : err.message }));
    });
  });

  // Un SSE abierto impide que `close()` termine: se cortan a mano.
  const cerrarOriginal = servidor.close.bind(servidor);
  servidor.once('listening', recolector.iniciar);
  servidor.close = (cb) => {
    servidor.off('listening', recolector.iniciar);
    recolector.cerrar();
    for (const flujo of [...flujos]) {
      flujo.cerrar();
      flujo.res.end();
    }
    red?.servidorNodos.cerrar();
    return cerrarOriginal(cb);
  };

  return servidor;
}
