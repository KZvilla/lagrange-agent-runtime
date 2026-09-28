/**
 * FEAT-092 — Registro de sesiones de Claude Code y envío de mensajes entre
 * ellas, en el daemon del nodo. Dentro del mismo nodo no hace falta servidor
 * (sirve en `rol = solo`); entre nodos (§5.2, paso 5) el mensaje sale por
 * `remoto` y llega al otro lado por `recibir`, que aplica el permiso del nodo
 * de destino (§6.1).
 *
 * El registro vive en memoria. Cada MCP se da de alta al arrancar (y deja su
 * alta en `buzones/<sesion>.mcp`, así un daemon que se reinicia lo reconstruye)
 * y el daemon barre cada minuto las que tienen el MCP muerto: MCP y daemon están
 * en la misma máquina, no hace falta latido.
 *
 * `de` lo pone el daemon a partir del registro, no la sesión. Un proceso local
 * malicioso podría escribir un buzón a mano: dentro del mismo usuario no hay
 * frontera (FEAT-092 §6.1), y no se intenta impedir.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { redactSecrets } from './policy.js';

const require = createRequire(import.meta.url);
const buzones = require('../mcp-server/lib/buzones.js');

export const FORMA_NOMBRE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TOPE_TEXTO_BYTES = 8 * 1024;
export const TOPE_CADENA = 10;
export const TOPE_POR_HORA = 30;
const HORA_MS = 3600 * 1000;

/** `My Project` → `my-project`, `mi_repo` → `mi-repo`; si no queda nada, `sesion`. */
export function slugNombre(texto) {
  const s = String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return FORMA_NOMBRE.test(s) ? s : 'sesion';
}

const FORMA_ID = /^m_[0-9a-f]{10}$/;

/**
 * @param {string|function} [o.nodo]  el nombre de este nodo (`local` en solo); una
 *   función si se conoce después de arrancar (el de `nodo.json`).
 * @param {object} [o.remoto]  FEAT-092 §5.2 — `{ enviar(sobre), agentes() }`: el camino a
 *   otros nodos (el servidor, o el cliente de la red en un nodo). Sin él, solo este nodo.
 * @param {function} [o.permite]  §6.1 — el `BRIDGE_NODO_PERMITE` de este daemon: un
 *   mensaje de otro nodo entra solo con `ejecutar`.
 * @param {function} [o.alCambiar]  cada alta, baja o cambio (el nodo le manda su lista al servidor).
 */
export function crearRegistro({ dataDir, nodo = 'local', remoto = null, permite = () => 'lectura', alCambiar = () => {}, vivo = buzones.pidVivo, ahora = Date.now, log = () => {} } = {}) {
  const sesiones = new Map();
  const envios = new Map();
  const nombreNodo = typeof nodo === 'function' ? () => nodo() || 'local' : () => nodo;
  const avisar = () => { try { alCambiar(); } catch {} };

  const ocupado = (nombre, salvo) => [...sesiones.values()].some((s) => s.nombre === nombre && s.sesion !== salvo);
  const libre = (base, salvo) => {
    if (!ocupado(base, salvo)) return base;
    for (let i = 2; ; i++) {
      const sufijo = `-${i}`;
      const nombre = `${base.slice(0, 32 - sufijo.length).replace(/-+$/g, '')}${sufijo}`;
      if (!ocupado(nombre, salvo)) return nombre;
    }
  };
  const publica = (s) => ({
    nombre: s.nombre, nodo: nombreNodo(), host: s.host, proyecto: s.cwd ? path.basename(s.cwd) : null,
    desde: s.desde, entrega: s.entrega, silenciada: s.silenciada
  });

  function alta({ sesion, host = null, cwd = null, nombre = null, mcpPid, claudePid = null, inicio = 0 } = {}) {
    if (!buzones.sesionValida(sesion)) return { ok: false, codigo: 400, error: 'Sesión inválida.' };
    if (!Number.isInteger(mcpPid) || mcpPid <= 0) return { ok: false, codigo: 400, error: 'Falta el pid del MCP.' };
    const previa = sesiones.get(sesion);
    const arranque = Number.isFinite(inicio) && inicio > 0 ? inicio : 0;
    // BE-066 — Dos MCP vivos de la misma sesión (una reconexión solapada): se
    // queda el que arrancó después, aunque el alta del viejo llegue última. Con
    // el mismo `inicio` no hay cómo saberlo: se queda el que ya estaba. Un
    // cliente anterior a BE-066 no manda `inicio` y cuenta como el más viejo
    // (entre dos de esos, gana la última alta, como antes).
    if (previa && previa.mcpPid !== mcpPid && vivo(previa.mcpPid) && previa.inicio > 0 && previa.inicio >= arranque) {
      return { ok: true, ajena: true, sesion: publica(previa) };
    }
    const pedido = typeof nombre === 'string' && FORMA_NOMBRE.test(nombre) ? nombre : null;
    const s = {
      sesion,
      host: typeof host === 'string' ? host.slice(0, 64) : null,
      cwd: typeof cwd === 'string' ? cwd : null,
      mcpPid,
      inicio: arranque,
      claudePid: Number.isInteger(claudePid) && claudePid > 0 ? claudePid : null,
      // Sin el proceso de Claude Code no hay cómo encontrar el buzón desde un hook.
      entrega: Number.isInteger(claudePid) && claudePid > 0 ? 'hooks' : 'manual',
      silenciada: previa?.silenciada ?? false,
      desde: previa?.desde ?? new Date(ahora()).toISOString(),
      nombre: previa?.nombre ?? libre(pedido || slugNombre(cwd ? path.basename(cwd) : ''), sesion)
    };
    sesiones.set(sesion, s);
    if (!previa) { log(`[mensajes] alta ${nombreNodo()}/${s.nombre} (${s.entrega})`); avisar(); }
    return { ok: true, sesion: publica(s) };
  }

  /**
   * BE-066 — Con `mcpPid`, solo si la sesión sigue siendo de ese MCP: uno viejo
   * que cierra tarde no da de baja al que ya la retomó. `soloSiMuerto` es la baja
   * de un cliente anterior a BE-066 (sin `mcpPid`): no se sabe de quién viene,
   * así que solo saca una sesión cuyo MCP ya murió; si no, la deja al barrido.
   * El barrido no pasa ninguna de las dos.
   */
  function baja(sesion, { mcpPid = null, soloSiMuerto = false } = {}) {
    const s = sesiones.get(sesion);
    if (!s) return { ok: true };
    if (Number.isInteger(mcpPid) && s.mcpPid !== mcpPid) return { ok: true, ajena: true };
    if (soloSiMuerto && vivo(s.mcpPid)) return { ok: true, diferida: true };
    sesiones.delete(sesion);
    log(`[mensajes] baja ${nombreNodo()}/${s.nombre}`);
    avisar();
    return { ok: true };
  }

  /** Saca las sesiones cuyo MCP ya no existe. */
  function barrer() {
    let n = 0;
    for (const s of [...sesiones.values()]) {
      if (!vivo(s.mcpPid)) { baja(s.sesion); n++; }
    }
    return n;
  }

  function reconstruir() {
    for (const a of buzones.altasVivas(dataDir, { vivo })) alta(a);
    return sesiones.size;
  }

  function renombrar(sesion, nombre) {
    const s = sesiones.get(sesion);
    if (!s) return { ok: false, codigo: 404, error: 'Esta sesión no está registrada.' };
    if (typeof nombre !== 'string' || !FORMA_NOMBRE.test(nombre)) {
      return { ok: false, codigo: 400, error: 'Nombre inválido: minúsculas, dígitos y guiones, hasta 32.' };
    }
    if (ocupado(nombre, sesion)) return { ok: false, codigo: 409, error: `Ya hay una sesión llamada ${nombre}.` };
    s.nombre = nombre;
    avisar();
    return { ok: true, sesion: publica(s) };
  }

  function silenciar(sesion, si) {
    const s = sesiones.get(sesion);
    if (!s) return { ok: false, codigo: 404, error: 'Esta sesión no está registrada.' };
    s.silenciada = si === true;
    avisar();
    return { ok: true, sesion: publica(s) };
  }

  function lista() {
    return [...sesiones.values()].map(publica);
  }

  /**
   * §5.1 — `accion: agentes`: las de este nodo más las del resto de la red. Si
   * el servidor no responde, las de acá con el aviso.
   */
  async function listaRed() {
    const propias = lista();
    if (!remoto) return { sesiones: propias };
    try {
      const otras = (await remoto.agentes()) || [];
      return { sesiones: [...propias, ...otras.filter((s) => s && s.nodo !== nombreNodo())] };
    } catch (err) {
      return { sesiones: propias, aviso: `Solo las de este nodo: ${redactSecrets(err.message)}` };
    }
  }

  const comoLoVe = (destino) => (destino.entrega === 'hooks'
    ? 'al terminar su turno, o al despertarla si está ociosa'
    : 'cuando lea su buzón (mensaje, accion: leer)');

  /**
   * Manda un mensaje. No hay cola: si no se puede entregar ahora, se dice ahora
   * (FEAT-092 §5.1). A una sesión de este nodo responde en el acto; a otro nodo
   * devuelve una promesa (los frenos se aplican acá, en el origen, §6.3).
   */
  function enviar({ de, para = null, texto, respuestaA = null } = {}) {
    const nodo = nombreNodo();
    const origen = sesiones.get(de);
    if (!origen) return { ok: false, codigo: 403, error: 'Esta sesión no está registrada en el daemon.' };
    const limpio = redactSecrets(String(texto ?? '')).trim();
    if (!limpio) return { ok: false, codigo: 400, error: 'El mensaje está vacío.' };
    if (Buffer.byteLength(limpio) > TOPE_TEXTO_BYTES) return { ok: false, codigo: 413, error: 'El mensaje pasa de 8 KB.' };

    // Una respuesta va a quien mandó el original, con la cadena +1.
    let cadena = 0;
    let destinoNombre = para;
    if (respuestaA) {
      const original = buzones.leerMensajes(dataDir, origen.sesion).find((m) => m.id === respuestaA);
      if (!original) return { ok: false, codigo: 404, error: `No tengo un mensaje ${respuestaA} en tu buzón.` };
      cadena = (Number(original.cadena) || 0) + 1;
      if (!destinoNombre) destinoNombre = original.de?.nodo === nodo ? original.de?.nombre : `${original.de?.nodo}/${original.de?.nombre}`;
    }
    if (cadena >= TOPE_CADENA) {
      log(`[mensajes] freno de cadena: ${nodo}/${origen.nombre} → ${destinoNombre}`);
      return { ok: false, codigo: 429, error: `Conversación de ${TOPE_CADENA} idas y vueltas entre agentes: pedile al usuario que decida si sigue.` };
    }

    const [nodoDestino, nombreDestino] = String(destinoNombre ?? '').includes('/')
      ? String(destinoNombre).split('/', 2)
      : [nodo, String(destinoNombre ?? '')];
    const remota = nodoDestino !== nodo;
    if (remota) {
      if (!remoto) return { ok: false, codigo: 400, error: `${nodoDestino} es otro nodo, y este daemon no está en una red de nodos (BRIDGE_ROL=solo).` };
      if (!FORMA_NOMBRE.test(nodoDestino) || !FORMA_NOMBRE.test(nombreDestino)) {
        return { ok: false, codigo: 400, error: `«${destinoNombre}» no es un destino válido: <nodo>/<nombre>.` };
      }
    }
    const destino = remota ? null : [...sesiones.values()].find((s) => s.nombre === nombreDestino);
    if (!remota) {
      if (!destino) return { ok: false, codigo: 404, error: `No hay una sesión ${nodo}/${nombreDestino}. Mirá cuáles hay con accion: agentes.` };
      if (destino.sesion === origen.sesion) return { ok: false, codigo: 400, error: 'Esa es esta misma sesión.' };
      if (destino.silenciada) return { ok: false, codigo: 409, error: `${nodo}/${destino.nombre} no recibe mensajes.` };
    }

    const t = ahora();
    const recientes = (envios.get(origen.sesion) || []).filter((x) => t - x < HORA_MS);
    if (recientes.length >= TOPE_POR_HORA) {
      log(`[mensajes] freno de ritmo: ${nodo}/${origen.nombre}`);
      return { ok: false, codigo: 429, error: `Ya mandaste ${TOPE_POR_HORA} mensajes en la última hora.` };
    }
    envios.set(origen.sesion, [...recientes, t]);

    if (remota) {
      const sobre = {
        id: `m_${crypto.randomBytes(5).toString('hex')}`,
        de: { nodo, sesion: origen.sesion, nombre: origen.nombre },
        para: `${nodoDestino}/${nombreDestino}`,
        texto: limpio,
        respuestaA: respuestaA || null,
        cadena,
        creado: new Date(t).toISOString()
      };
      return Promise.resolve()
        .then(() => remoto.enviar(sobre))
        .then((r) => {
          const res = r && typeof r === 'object' ? r : { ok: false, codigo: 502, error: 'Respuesta inválida del servidor.' };
          log(`[mensajes] ${sobre.id} ${nodo}/${origen.nombre} → ${sobre.para}${respuestaA ? ` (responde ${respuestaA})` : ''}: ${res.ok ? 'entregado' : `rechazado (${res.codigo || 'error'})`}`);
          return res.ok ? { ok: true, id: sobre.id, para: sobre.para, como: res.como || comoLoVe({}) } : { ok: false, codigo: res.codigo || 502, error: res.error || 'No se pudo entregar.' };
        })
        .catch((err) => {
          log(`[mensajes] ${sobre.id} ${nodo}/${origen.nombre} → ${sobre.para}: ${redactSecrets(err.message)}`);
          return { ok: false, codigo: err.codigo || 503, error: `No se pudo llegar a ${nodoDestino}: ${redactSecrets(err.message)}` };
        });
    }

    const sobre = {
      id: `m_${crypto.randomBytes(5).toString('hex')}`,
      de: { nodo, sesion: origen.sesion, nombre: origen.nombre },
      para: `${nodo}/${destino.nombre}`,
      texto: limpio,
      respuestaA: respuestaA || null,
      cadena,
      creado: new Date(t).toISOString()
    };
    try {
      buzones.agregar(dataDir, destino.sesion, sobre, t);
    } catch (err) {
      log(`[mensajes] no se pudo escribir el buzón de ${nodo}/${destino.nombre}: ${redactSecrets(err.message)}`);
      return { ok: false, codigo: 500, error: 'No se pudo escribir el buzón.' };
    }
    // Sin el texto (§6.4).
    log(`[mensajes] ${sobre.id} ${nodo}/${origen.nombre} → ${sobre.para}${respuestaA ? ` (responde ${respuestaA})` : ''}`);
    return { ok: true, id: sobre.id, para: sobre.para, como: comoLoVe(destino) };
  }

  /**
   * §5.2 — Un mensaje que viene de otro nodo (por el servidor). El `de` ya lo
   * validó el servidor contra la conexión; acá se revisa la forma, el permiso
   * de este nodo (§6.1) y la sesión de destino. Nunca lanza.
   */
  function recibir(sobre) {
    const nodo = nombreNodo();
    const s = sobre && typeof sobre === 'object' ? sobre : {};
    const de = s.de && typeof s.de === 'object' ? s.de : {};
    const [nodoDestino, nombreDestino] = typeof s.para === 'string' ? s.para.split('/', 2) : [];
    if (!FORMA_ID.test(String(s.id)) || !FORMA_NOMBRE.test(String(de.nodo)) || !FORMA_NOMBRE.test(String(de.nombre))
      || typeof de.sesion !== 'string' || de.sesion.length > 128 || nodoDestino !== nodo || !FORMA_NOMBRE.test(String(nombreDestino))
      || (s.respuestaA != null && !FORMA_ID.test(String(s.respuestaA)))
      || !Number.isInteger(s.cadena) || s.cadena < 0 || s.cadena >= TOPE_CADENA) {
      return { ok: false, codigo: 400, error: 'Mensaje inválido.' };
    }
    if (de.nodo === nodo) return { ok: false, codigo: 400, error: 'Un mensaje de este mismo nodo no viene por la red.' };
    if (permite() !== 'ejecutar') {
      log(`[mensajes] ${s.id} ${de.nodo}/${de.nombre} → ${s.para}: rechazado (permiso)`);
      return { ok: false, codigo: 403, error: `${nodo} no acepta mensajes de otros nodos (hace falta BRIDGE_NODO_PERMITE=ejecutar).` };
    }
    const limpio = redactSecrets(String(s.texto ?? '')).trim();
    if (!limpio) return { ok: false, codigo: 400, error: 'El mensaje está vacío.' };
    if (Buffer.byteLength(limpio) > TOPE_TEXTO_BYTES) return { ok: false, codigo: 413, error: 'El mensaje pasa de 8 KB.' };
    const destino = [...sesiones.values()].find((x) => x.nombre === nombreDestino);
    if (!destino) return { ok: false, codigo: 404, error: `No hay una sesión ${nodo}/${nombreDestino}.` };
    if (destino.silenciada) return { ok: false, codigo: 409, error: `${nodo}/${destino.nombre} no recibe mensajes.` };
    const t = ahora();
    const entrada = {
      id: s.id,
      de: { nodo: de.nodo, sesion: de.sesion, nombre: de.nombre },
      para: `${nodo}/${destino.nombre}`,
      texto: limpio,
      respuestaA: s.respuestaA || null,
      cadena: s.cadena,
      creado: typeof s.creado === 'string' ? s.creado.slice(0, 40) : new Date(t).toISOString()
    };
    try {
      buzones.agregar(dataDir, destino.sesion, entrada, t);
    } catch (err) {
      log(`[mensajes] no se pudo escribir el buzón de ${nodo}/${destino.nombre}: ${redactSecrets(err.message)}`);
      return { ok: false, codigo: 500, error: 'No se pudo escribir el buzón.' };
    }
    log(`[mensajes] ${entrada.id} ${de.nodo}/${de.nombre} → ${entrada.para}${entrada.respuestaA ? ` (responde ${entrada.respuestaA})` : ''} (de otro nodo)`);
    return { ok: true, id: entrada.id, para: entrada.para, como: comoLoVe(destino) };
  }

  const ids = () => new Set(sesiones.keys());

  return { alta, baja, barrer, reconstruir, renombrar, silenciar, lista, listaRed, enviar, recibir, ids };
}
