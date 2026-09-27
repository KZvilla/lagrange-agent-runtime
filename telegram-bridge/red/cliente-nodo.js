/**
 * FEAT-089 — El lado nodo de la red: se conecta a su servidor, prueba quién es
 * (y exige que el servidor pruebe quién es él, §3.5), atiende los pedidos RPC
 * de solo lectura (§4.4), reenvía los eventos de su canal (§6.4) y le pasa al
 * servidor lo que el conector manda a Telegram (§5).
 *
 * Transporte: `node:http` (no el `fetch` global: SEC-022 necesita validar la
 * dirección al conectar), SSE del servidor al nodo y POST del nodo al servidor.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import {
  PROTOCOLO, nonce, firmar, verificar, textoSaludo, textoSesion, leerNodoPropio, archivosRed
} from './identidad.js';
import { borrarJson } from './almacen.js';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const ENTRE_SALUDOS_MS = 1000;
const SILENCIO_MAX_MS = 60_000;
const ESPERA_DESCONOCIDO_MS = 10 * 60_000;
const LOTE_EVENTOS = 50;
const LOTE_BYTES = 512 * 1024;
const LOTE_MS = 250;
const COLA_MAX = 100;
const COLA_VENCE_MS = 6 * 60 * 60_000;

/** Un pedido HTTP al servidor. Resuelve con `{ status, datos }`; lanza solo si no hubo respuesta. */
export function pedirHttp(base, ruta, { metodo = 'POST', encabezados = {}, cuerpo = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(ruta, base);
    let datos = null;
    const headers = { ...encabezados };
    if (Buffer.isBuffer(cuerpo)) {
      datos = cuerpo;
      headers['content-type'] = 'application/octet-stream';
    } else if (cuerpo !== null) {
      datos = Buffer.from(JSON.stringify(cuerpo), 'utf8');
      headers['content-type'] = 'application/json';
    }
    if (datos) headers['content-length'] = String(datos.length);
    const req = http.request(url, { method: metodo, headers }, (res) => {
      const partes = [];
      res.on('data', (d) => partes.push(d));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, datos: j });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Tiempo de espera agotado.')));
    req.on('error', reject);
    req.end(datos || undefined);
  });
}

const dormir = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {object} o.nucleo           núcleo local (armarNucleo)
 * @param {object} o.canal            canal local de la consola
 * @param {string} o.chatId           `CHAT_WEB_LOCAL`
 * @param {Set<string>} o.permitidos  métodos que acepta por RPC (metodosPermitidos)
 */
export function crearClienteNodo({
  dataDir,
  nucleo,
  canal,
  chatId,
  permitidos,
  version = null,
  capacidades = [],
  onAskRespondido = () => {},
  onRevocado = () => {},
  onEstado = () => {},
  log = () => {},
  pedir = pedirHttp,
  ahora = () => Date.now(),
  backoffMinMs = BACKOFF_MIN_MS,
  entreSaludosMs = ENTRE_SALUDOS_MS,
  silencioMaxMs = SILENCIO_MAX_MS,
  loteMs = LOTE_MS
}) {
  const arranque = crypto.randomUUID();
  let identidad = null;
  let detenido = false;
  let sesion = null;
  let conectado = false;
  let flujoReq = null;
  let ultimoSaludo = 0;
  let desconocidos = 0;
  let bajaCanal = null;
  const colaMensajes = [];
  let lote = [];
  let loteBytes = 0;
  let loteTimer = null;

  const base = () => identidad.servidor;
  const conSesion = () => ({ 'x-lagrange-sesion': sesion });

  function estado(campos) {
    try { onEstado(campos); } catch {}
  }

  // ------------------------------------------------------------------------
  // Apretón de manos (§3.5)
  // ------------------------------------------------------------------------

  async function apretonDeManos() {
    const nonceNodo = nonce();
    const s = await pedir(base(), '/nodo/saludo', { cuerpo: { v: PROTOCOLO, id: identidad.id, nonceNodo } });
    if (s.status === 401 && s.datos?.motivo === 'desconocido') {
      // Sin firma: un servidor falso podría mandarlo, así que no se borra nodo.json.
      desconocidos++;
      throw Object.assign(new Error('El servidor no reconoce este nodo.'), { desconocido: true });
    }
    if (s.status === 426) throw new Error(s.datos?.error || 'Protocolo incompatible con el servidor.');
    if (s.status !== 200 || !s.datos?.ok) throw new Error(s.datos?.error || `saludo respondió ${s.status}`);
    desconocidos = 0;
    const { servidorId, nonceServidor, firma } = s.datos;
    if (servidorId !== identidad.servidorId
      || !verificar(identidad.clavePublicaServidor, textoSaludo(identidad.id, nonceNodo, nonceServidor), firma)) {
      // No se manda nada más: ni capacidades, ni eventos, ni mensajes.
      throw Object.assign(new Error(`El servidor en ${base()} no es el emparejado.`), { impostor: true });
    }
    const r = await pedir(base(), '/nodo/sesion', {
      cuerpo: {
        id: identidad.id,
        nonceServidor,
        firma: firmar(identidad.clavePrivada, textoSesion(identidad.id, nonceServidor, nonceNodo)),
        nombre: identidad.nombre,
        capacidades,
        version,
        arranque
      }
    });
    if (r.status !== 200 || !r.datos?.sesion) throw new Error(r.datos?.error || `sesion respondió ${r.status}`);
    sesion = r.datos.sesion;
  }

  // ------------------------------------------------------------------------
  // Flujo del servidor
  // ------------------------------------------------------------------------

  function abrirFlujo() {
    return new Promise((resolve) => {
      const url = new URL('/nodo/flujo', base());
      let silencio = null;
      const vigilar = () => {
        clearTimeout(silencio);
        silencio = setTimeout(() => req.destroy(new Error('Flujo mudo.')), silencioMaxMs);
        silencio.unref?.();
      };
      const req = http.request(url, { method: 'GET', headers: conSesion() }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          clearTimeout(silencio);
          resolve({ ok: false, status: res.statusCode });
          return;
        }
        conectado = true;
        estado({ conectado: true, estado: 'conectado' });
        log(`[red] Conectado al servidor ${base()}.`);
        vaciarCola().catch(() => {});
        vigilar();
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (trozo) => {
          vigilar();
          buffer += trozo;
          let corte;
          while ((corte = buffer.indexOf('\n\n')) !== -1) {
            const bloque = buffer.slice(0, corte);
            buffer = buffer.slice(corte + 2);
            const datos = bloque.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (!datos) continue;
            let msj;
            try { msj = JSON.parse(datos); } catch { continue; }
            atenderMensaje(msj).catch((err) => log(`[red] Mensaje del servidor falló: ${err.message}`));
          }
        });
        const fin = () => { clearTimeout(silencio); resolve({ ok: true }); };
        res.on('end', fin);
        res.on('close', fin);
        res.on('error', fin);
      });
      flujoReq = req;
      req.on('error', () => { clearTimeout(silencio); resolve({ ok: false, status: 0 }); });
      req.end();
      vigilar();
    });
  }

  async function atenderMensaje(msj) {
    if (msj.tipo === 'pedido') return atenderPedido(msj);
    if (msj.tipo === 'ask-respondido') {
      if (typeof msj.askId === 'string' && typeof msj.respuesta === 'string') onAskRespondido(msj);
      return;
    }
    if (msj.tipo === 'revocado') {
      // Llegó por un flujo con sesión: es del servidor emparejado.
      log('[red] El servidor revocó este nodo: se borra nodo.json y no se reconecta.');
      borrarJson(archivosRed(dataDir).nodo);
      detenido = true;
      estado({ conectado: false, estado: 'revocado' });
      try { flujoReq?.destroy(); } catch {}
      onRevocado();
    }
  }

  async function atenderPedido({ id, metodo, args }) {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return;
    let r;
    if (typeof metodo !== 'string' || !permitidos.has(metodo) || typeof nucleo[metodo] !== 'function') {
      r = { ok: false, codigo: 403, error: 'Método no permitido para un nodo.' };
    } else {
      try {
        const resultado = await nucleo[metodo](...(Array.isArray(args) ? args : []));
        r = Buffer.isBuffer(resultado?.binario)
          ? { ok: false, codigo: 501, error: 'Respuesta binaria: llega con SEC-022.' }
          : { ok: true, resultado: resultado ?? {} };
      } catch (err) {
        r = { ok: false, codigo: 500, error: err.message };
      }
    }
    try { await pedir(base(), `/nodo/respuesta/${id}`, { encabezados: conSesion(), cuerpo: r }); } catch {}
  }

  // ------------------------------------------------------------------------
  // Eventos (§6.4)
  // ------------------------------------------------------------------------

  function alCanal(evento, info = {}) {
    if (!conectado) return; // el hueco de seq lo resincroniza el servidor
    const { seq, ts: _t, ...resto } = evento;
    let entrada = { seq, efimero: info.efimero === true, evento: resto };
    let bytes = Buffer.byteLength(JSON.stringify(entrada));
    if (bytes > LOTE_BYTES) {
      entrada = { seq, efimero: false, evento: { tipo: 'nodo-resincronizar' } };
      bytes = 64;
    }
    if (loteBytes + bytes > LOTE_BYTES) enviarLote();
    lote.push(entrada);
    loteBytes += bytes;
    if (lote.length >= LOTE_EVENTOS) return enviarLote();
    if (!loteTimer) { loteTimer = setTimeout(enviarLote, loteMs); loteTimer.unref?.(); }
  }

  function enviarLote() {
    clearTimeout(loteTimer);
    loteTimer = null;
    if (!lote.length) return;
    const eventos = lote;
    lote = [];
    loteBytes = 0;
    if (!conectado) return;
    pedir(base(), '/nodo/eventos', { encabezados: conSesion(), cuerpo: { arranque, eventos } }).catch(() => {});
  }

  // ------------------------------------------------------------------------
  // Telegram por el servidor (§5)
  // ------------------------------------------------------------------------

  async function mandarMensaje(entrada) {
    const r = await pedir(base(), '/nodo/telegram/mensaje', { encabezados: conSesion(), cuerpo: { texto: entrada.texto, hora: entrada.hora } });
    if (r.status >= 400) throw Object.assign(new Error(r.datos?.error || `el servidor respondió ${r.status}`), { rechazado: true });
    return r.datos;
  }

  async function vaciarCola() {
    while (conectado && colaMensajes.length) {
      const e = colaMensajes[0];
      if (ahora() - e.encolado > COLA_VENCE_MS) { colaMensajes.shift(); continue; }
      try {
        await mandarMensaje(e);
        colaMensajes.shift();
      } catch (err) {
        if (err.rechazado) { colaMensajes.shift(); log(`[red] Un mensaje encolado se descartó: ${err.message}`); continue; }
        return; // sin conexión: queda para la próxima
      }
    }
  }

  function encolar(texto, hora) {
    colaMensajes.push({ texto, hora, encolado: ahora() });
    while (colaMensajes.length > COLA_MAX) colaMensajes.shift();
  }

  /** §5.4 — Un mensaje sin conexión se encola (100, 6 h) y se manda al volver. */
  async function mensaje({ texto }) {
    const hora = new Date(ahora()).toISOString();
    if (!conectado) { encolar(texto, hora); return { ok: true, encolado: true }; }
    try {
      return { ok: true, ...(await mandarMensaje({ texto, hora })) };
    } catch (err) {
      if (err.rechazado) throw err;
      encolar(texto, hora);
      return { ok: true, encolado: true };
    }
  }

  function exigirConexion(que) {
    if (!conectado) throw new Error(`Servidor no disponible: ${que}.`);
  }

  async function binario(ruta, buffer, encabezados, que) {
    exigirConexion(que);
    const r = await pedir(base(), ruta, { encabezados: { ...conSesion(), ...encabezados }, cuerpo: buffer, timeoutMs: 120_000 });
    if (r.status >= 400) throw new Error(r.datos?.error || `el servidor respondió ${r.status}`);
    return r.datos;
  }

  const voz = (buffer, pie = '') =>
    binario('/nodo/telegram/voz', buffer, { 'x-lagrange-pie': encodeURIComponent(pie) }, 'la nota de voz no se envió');

  const archivo = (buffer, nombre, pie = '') =>
    binario('/nodo/telegram/archivo', buffer, { 'x-lagrange-nombre': encodeURIComponent(nombre), 'x-lagrange-pie': encodeURIComponent(pie) }, 'el archivo no se envió');

  async function preguntar(datos) {
    exigirConexion('la pregunta no se envió');
    const r = await pedir(base(), '/nodo/telegram/preguntar', { encabezados: conSesion(), cuerpo: datos });
    if (r.status >= 400 || !r.datos?.messageId) throw new Error(r.datos?.error || `el servidor respondió ${r.status}`);
    return r.datos;
  }

  async function quitarBotones(askId) {
    if (!conectado) return { ok: false };
    const r = await pedir(base(), '/nodo/telegram/quitar-botones', { encabezados: conSesion(), cuerpo: { askId } });
    return r.datos || { ok: false };
  }

  // ------------------------------------------------------------------------
  // Ciclo de conexión
  // ------------------------------------------------------------------------

  async function ciclo() {
    let fallos = 0;
    while (!detenido) {
      const falta = ultimoSaludo + entreSaludosMs - ahora();
      if (falta > 0) await dormir(falta);
      if (detenido) break;
      ultimoSaludo = ahora();
      let espera;
      try {
        await apretonDeManos();
        const r = await abrirFlujo();
        conectado = false;
        sesion = null;
        enviarLote();
        if (!detenido) {
          estado({ conectado: false, estado: 'reconectando' });
          log('[red] Se cortó el flujo con el servidor; se reconecta.');
        }
        fallos = r.ok ? 0 : fallos + 1;
      } catch (err) {
        conectado = false;
        fallos++;
        if (err.desconocido && desconocidos >= 3) {
          estado({ conectado: false, estado: 'desconocido-para-el-servidor' });
          log('[red] El servidor no reconoce este nodo; si lo revocaste, corré `npm run bridge:nodo -- salir`.');
          espera = ESPERA_DESCONOCIDO_MS;
        } else {
          estado({ conectado: false, estado: err.impostor ? 'servidor-no-verificado' : 'sin-servidor' });
          if (fallos === 1 || fallos % 10 === 0) log(`[red] ${err.message}`);
        }
      }
      if (detenido) break;
      if (espera === undefined) {
        const tope = Math.min(BACKOFF_MAX_MS, backoffMinMs * 2 ** Math.max(0, fallos - 1));
        espera = fallos === 0 ? backoffMinMs : tope * (0.5 + Math.random() * 0.5);
      }
      await dormir(espera);
    }
  }

  function iniciar() {
    identidad = leerNodoPropio(dataDir);
    if (!identidad) {
      estado({ conectado: false, estado: 'sin-emparejar' });
      log('[red] Este nodo no está emparejado: `npm run bridge:nodo -- unirse <url> <código>` y reiniciá el daemon.');
      return false;
    }
    bajaCanal = canal ? canal.suscribir(chatId, alCanal) : null;
    estado({ conectado: false, estado: 'conectando', servidor: identidad.servidor });
    ciclo().catch((err) => log(`[red] El ciclo de conexión terminó: ${err.message}`));
    return true;
  }

  function detener() {
    detenido = true;
    conectado = false;
    try { flujoReq?.destroy(); } catch {}
    bajaCanal?.();
    clearTimeout(loteTimer);
  }

  return {
    iniciar,
    detener,
    conectado: () => conectado,
    nombre: () => identidad?.nombre || null,
    colaPendiente: () => colaMensajes.length,
    mensaje,
    voz,
    archivo,
    preguntar,
    quitarBotones
  };
}
