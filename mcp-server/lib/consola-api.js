/**
 * FEAT-162 — El cliente HTTP de la herramienta MCP `consola`: habla con la API
 * de la consola web del daemon con la credencial del orquestador
 * (`orquestador-token.json`, que escribe `servirWeb` en bot.js). Esa credencial
 * nunca da el acceso completo: el servidor aplica el modo (`orquestacion_modo`),
 * las listas de lo vedado y registra cada acción en la orquestación de `quien`.
 *
 * No es una barrera contra un proceso con acceso al disco (el token completo
 * está al lado): delimita lo que hace la herramienta.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dataDirPath } = require('./buzones.js');
const identidadSesion = require('./identidad-sesion.js');

const ARCHIVO = 'orquestador-token.json';
const TIMEOUT_MS = 20_000;
const RE_QUIEN = /^[\p{L}\p{N} _-]{1,32}$/u;
const ESPERA_PASO_MS = 3_000;
const ESPERA_TOPE_MS = 10 * 60 * 1000;

class ErrorConsola extends Error {}

function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** `{ url, token }` del daemon vivo, o lanza con lo que hay que hacer. */
function leerAcceso({ dataDir = dataDirPath(), vivo = pidVivo } = {}) {
  const dirBridge = path.join(__dirname, '..', '..', 'telegram-bridge');
  for (const dir of [dataDir, dirBridge]) {
    let datos;
    try { datos = JSON.parse(fs.readFileSync(path.join(dir, ARCHIVO), 'utf8')); } catch { continue; }
    if (!datos || typeof datos.url !== 'string' || typeof datos.token !== 'string') continue;
    if (!vivo(datos.pid)) throw new ErrorConsola('La consola no está activa (el daemon que dejó la credencial ya no corre). Reinicialo con `npm run bridge:daemon:update`.');
    return { url: datos.url.replace(/\/+$/, ''), token: datos.token };
  }
  throw new ErrorConsola('La consola no está activa: no hay credencial de orquestador. Arrancá o reiniciá el daemon con `npm run bridge:daemon:update` (desde v1.34.0).');
}

/** Quién orquesta: la identidad de la sesión (Spica, Epikouros) o, si no hay, el nombre de la cuenta. Nunca null. */
function quienOrquesta({ env = process.env, home = os.homedir() } = {}) {
  let config = null;
  try { config = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'antigravity.json'), 'utf8')); } catch { /* sin config */ }
  const configDir = env.CLAUDE_CONFIG_DIR;
  const identidad = identidadSesion.identidadDeConfig(config, { configDir, home });
  const candidatos = [identidad?.nombre, identidadSesion.resolverCuenta({ configDir, home, cuentas: config?.motores?.cuentas }), 'principal'];
  return candidatos.find((c) => typeof c === 'string' && RE_QUIEN.test(c));
}

/**
 * Un pedido a la API. Devuelve `{ status, datos }` (el JSON de la consola); solo lanza si no hay
 * consola o la red falla. `fetchImpl` y `acceso` se inyectan en los tests.
 */
async function pedir(metodo, ruta, cuerpo, { acceso = leerAcceso(), quien = quienOrquesta(), sesion = null, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!/^\/api\//.test(String(ruta))) throw new ErrorConsola('La ruta tiene que empezar con /api/ (pedí el catálogo con la acción `rutas`).');
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), timeoutMs);
  try {
    const r = await fetchImpl(acceso.url + ruta, {
      method: metodo,
      headers: {
        'x-lagrange-orquestador': acceso.token,
        'x-lagrange-quien': encodeURIComponent(quien),
        // F3 — El buzón de esta sesión: `abrir` lo guarda para que las notas del usuario le lleguen.
        ...(typeof sesion === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(sesion) ? { 'x-lagrange-sesion': sesion } : {}),
        origin: acceso.url,
        'sec-fetch-site': 'same-origin',
        ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      signal: control.signal
    });
    const texto = await r.text();
    let datos;
    try { datos = JSON.parse(texto); } catch { datos = { ok: false, error: texto.slice(0, 300) }; }
    return { status: r.status, datos };
  } catch (err) {
    if (err?.name === 'AbortError') throw new ErrorConsola(`La consola no respondió en ${Math.round(timeoutMs / 1000)} s.`);
    throw new ErrorConsola(`No se pudo hablar con la consola: ${err?.message || err}`);
  } finally {
    clearTimeout(reloj);
  }
}

/** Lo que se ve del tablero, compacto: por estado, con id, título y de quién. */
function resumirTablero(tareas, lotes) {
  const lista = Array.isArray(tareas) ? tareas : [];
  const porEstado = {};
  for (const t of lista) (porEstado[t.estado] ||= []).push(t);
  const linea = (t) => `- \`${t.id}\` ${t.titulo || String(t.pedido || '').slice(0, 60)}${t.creadaPor && t.creadaPor !== 'usuario' ? ` · ${t.creadaPor}` : ''}${t.propuesta ? ' · propuesta' : ''}${t.madre ? ` · hija de ${t.madre}` : ''}`;
  const partes = [];
  for (const [estado, xs] of Object.entries(porEstado)) {
    partes.push(`**${estado}** (${xs.length})`, ...xs.slice(0, 15).map(linea), ...(xs.length > 15 ? [`- … y ${xs.length - 15} más`] : []));
  }
  const ls = Array.isArray(lotes) ? lotes : [];
  if (ls.length) partes.push(`**lotes** (${ls.length})`, ...ls.slice(0, 10).map((l) => `- \`${l.id}\` ${l.titulo || ''} · ${l.estado || ''}`));
  return partes.join('\n') || '(tablero vacío)';
}

/**
 * Espera a que un objetivo llegue a un estado: una tarea, un lote o una aprobación. Consulta cada
 * `pasoMs` (no usa el SSE, que no termina). Devuelve `{ llego, estado, datos }`.
 */
async function esperar({ tipo, id, orquestacion, estados, topeMs = ESPERA_TOPE_MS, pasoMs = ESPERA_PASO_MS, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), ...opciones }) {
  const quieren = new Set(estados);
  // Sin estados pedidos, cualquier cambio respecto del primero que se ve (si no, volvería al instante).
  let inicial;
  const fin = Date.now() + Math.min(topeMs, ESPERA_TOPE_MS);
  let ultimo = null;
  for (;;) {
    let estado = null;
    if (tipo === 'tarea') {
      const r = await pedir('GET', `/api/tareas/${encodeURIComponent(id)}`, undefined, opciones);
      ultimo = r.datos;
      estado = r.datos?.tarea?.estado ?? null;
    } else if (tipo === 'lote') {
      const r = await pedir('GET', `/api/lotes/${encodeURIComponent(id)}`, undefined, opciones);
      ultimo = r.datos;
      estado = r.datos?.lote?.estado ?? r.datos?.estado ?? null;
    } else if (tipo === 'aprobacion') {
      const r = await pedir('GET', '/api/orquestaciones', undefined, opciones);
      const o = (r.datos?.orquestaciones || []).find((x) => x.id === orquestacion);
      const a = o?.aprobaciones?.find((x) => x.id === id);
      ultimo = a || null;
      estado = a?.estado ?? null;
    } else if (tipo === 'nota') {
      // F3 — La próxima nota del usuario: el «estado» es el id de su última nota (cambia cuando llega otra).
      const r = await pedir('GET', '/api/orquestaciones', undefined, opciones);
      const o = (r.datos?.orquestaciones || []).find((x) => x.id === orquestacion);
      const nota = (o?.conversacion || []).filter((n) => n.de === 'usuario').at(-1) || null;
      ultimo = nota;
      estado = nota?.id ?? 'ninguna';
    } else {
      throw new ErrorConsola('`esperar` necesita tipo tarea, lote, aprobacion o nota.');
    }
    if (inicial === undefined) inicial = estado;
    if (estado && (quieren.size ? quieren.has(estado) : estado !== inicial)) return { llego: true, estado, datos: ultimo };
    if (Date.now() + pasoMs > fin) return { llego: false, estado, datos: ultimo };
    await dormir(pasoMs);
  }
}

module.exports = { ARCHIVO, ErrorConsola, leerAcceso, quienOrquesta, pedir, resumirTablero, esperar, ESPERA_TOPE_MS };
