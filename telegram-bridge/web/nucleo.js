/**
 * FEAT-052 — Operaciones de la consola web.
 *
 * Validan la entrada y llaman a las mismas funciones que usan los comandos de
 * Telegram (`dispatchCharla`, `dispatchCast`, `cancelarCarriles`…), que se
 * reciben inyectadas desde `bot.js`. Devuelven objetos planos; un `codigo`
 * distinto de 200 lo traduce `servidor.js` al estado HTTP.
 *
 * Nada de acá lanza el modelo principal: la charla y el cast van por agy.
 */

import { crearCtxWeb, CHAT_WEB_LOCAL } from './canal.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { redactarReglas } from './reglas.js';

// FEAT-079 — Criterio guardado de un agente: cuántas entradas y cuánto texto
// de cada una llegan a la consola.
export const TOPE_CRITERIO = 50;
export const TOPE_TEXTO_CRITERIO = 1200;
const TIPO_CRITERIO = { decision: 'decision', 'user-correction': 'correccion' };
// FEAT-084 — mcp-memory guarda las correcciones con otro `observation_type`
// (llegan como `otro`), pero siempre con este prefijo: el texto es lo estable.
const PREFIJO_CORRECCION = /^\s*User corrected:/i;
const tipoCriterio = (e) => TIPO_CRITERIO[e.tipo]
  || (PREFIJO_CORRECCION.test(String(e.contenido ?? '')) ? 'correccion' : 'otro');
// FEAT-081 — Resultados de una búsqueda en la memoria profunda y largo de la consulta.
export const TOPE_PROFUNDA = 10;
export const TOPE_CONSULTA_PROFUNDA = 500;

export const TOPE_TEXTO = 4096;
// La web no lanza trabajo en el carril principal, así que tampoco lo cancela:
// un /run de Telegram no se corta desde el navegador.
export const CARRILES_WEB = Object.freeze(['cast', 'alma']);

const error = (codigo, mensaje) => ({ codigo, ok: false, error: mensaje });
export const LIMITE_LECTURA_FANOUT_MS = 500;
export const TTL_WORKSPACES_FANOUT_MS = 60 * 1000;
// FEAT-086 — Cuánto se sigue marcando un cambio de resolución de un alias.
export const CAMBIO_RECIENTE_MS = 7 * 24 * 60 * 60 * 1000;
const ID_TAREA = /^t_[a-z0-9]{1,40}$/;
const ID_PROGRAMACION = /^p_[a-z0-9]{1,40}$/;
// FEAT-068 — Holgado sobre las 200 cerradas que guarda el registro.
export const TOPE_ARCHIVAR = 300;
// FEAT-066 — Corridas que se muestran por programación.
export const TOPE_CORRIDAS = 20;

function textoValido(valor) {
  if (typeof valor !== 'string') return null;
  const t = valor.trim();
  return t && t.length <= TOPE_TEXTO ? t : null;
}

/**
 * @param {object} deps
 * @param {object} deps.canal            canal web (web/canal.js)
 * @param {object} deps.bot              funciones exportadas por bot.js
 * @param {object} deps.almas            { recuerdos, rutas, hilos, diario } de mcp-server/almas;
 *                                       FEAT-081: `profunda` (almas/profunda.js), opcional
 * @param {Function} deps.workspaces     getKnownWorkspaces
 * @param {Function} deps.ultimoWorkspace getUltimoWorkspaceCast
 * @param {Function} deps.logs           (n) => { aviso } | { encabezado, contenido }
 * @param {Function} deps.sesiones       () => objeto serializable
 * @param {object} [deps.fanout]         FEAT-055: { leerLotes(ruta, opciones) → Promise, limiteMs, ttlWorkspacesMs, ahora };
 *                                       FEAT-057: detener(ruta, lote, tarea)
 * @param {object} [deps.programaciones] FEAT-066: el registro (telegram-bridge/programaciones.js)
 * @param {Function} [deps.modeloEfectivo] FEAT-066: () => { model, effortPorDefecto }, el que se congela
 * @param {object} [deps.motores]        FEAT-075: { config(), elegir(config, rol) → { motor, modelo, esfuerzo, cuenta },
 *                                       catalogo(), guardarRol(rol, entrada|null), sondasClaude(clave) }
 *                                       (FEAT-085: `cuenta` y `clave` = `claude` o `claude@<cuenta>`)
 *                                       FEAT-086: resoluciones() → { [rol]: { alias, cuenta, modelo, visto_en, anterior, cambio_en } }
 * @param {Function} [deps.criterio]     FEAT-079: (nombre) → Promise<{ ok, entradas, truncado } | { ok: false }>
 *                                       (mcp-server/agents/memoria.js criterioDeAgente)
 * @param {object} [deps.cuarentena]     SEC-021: { listar(nombre) → { ok, entradas }, promover(id, nombre) → Promise<{ ok, motivo }>,
 *                                       descartar(id, nombre) → { ok, motivo } } (mcp-server/agents/cuarentena.js)
 */
export function crearNucleoWeb({
  canal, chatId = CHAT_WEB_LOCAL, bot, almas, workspaces, ultimoWorkspace, logs, sesiones,
  // FEAT-053
  tareas, estadoDaemon, estadoAgente, nombreAgenteValido,
  // FEAT-055
  fanout: {
    leerLotes = async () => ({ lotes: [] }),
    // FEAT-057 — (ruta, lote, tarea): escribe el centinela de detención.
    detener = () => { throw new Error('Sin detener de fan-out.'); },
    limiteMs = LIMITE_LECTURA_FANOUT_MS,
    ttlWorkspacesMs = TTL_WORKSPACES_FANOUT_MS,
    ahora = Date.now
  } = {},
  // FEAT-066
  programaciones = null,
  modeloEfectivo = () => ({ model: null, effortPorDefecto: null }),
  // FEAT-069 — { lista() → Promise<[...]> } (mcp-server/lib/proveedores.js)
  proveedores = null,
  lotes = null,
  motores = null,
  // FEAT-076 — { raizDe(nombre) → ruta|null, descubrir(raiz), leer(raiz, id) } (web/reglas.js)
  reglas = null,
  criterio = null,
  cuarentena = null
}) {
  const ctx = crearCtxWeb(canal, chatId);

  // FEAT-085 — La clave de cuenta de una elección (`claude@trabajo`): indexa
  // sondas e hilos. Sin cuenta, el id del motor, como antes.
  const claveDeSondas = (e) => (e && e.cuenta ? `${e.motor}@${e.cuenta}` : e ? e.motor : 'antigravity');

  // FEAT-075 — Los roles que la consola edita: uno por alma y uno por agente
  // castable. Los generales (`alma`, `cast`, `consolidar`) quedan para
  // `set_config`. Los agentes con escritura no son castables: no llegan acá.
  // FEAT-079 — Y la consolidación de la charla de voz de cada alma.
  const sujetosDeMotor = () => [
    ...bot.almasDisponibles().map((a) => ({ rol: `alma:${a.clave}`, general: 'alma', tipo: 'alma', id: a.clave })),
    ...bot.almasDisponibles().map((a) => ({ rol: `consolidar:${a.clave}`, general: 'consolidar', tipo: 'consolidacion', id: a.clave })),
    ...bot.agentesCasteables().map((a) => ({ rol: `cast:${a.nombre}`, general: 'cast', tipo: 'agente', id: a.nombre }))
  ];

  // Leer las sondas de claude corre `where.exe` (y la primera vez `claude
  // --version`) de forma síncrona: solo se consultan si algún sujeto usa claude.
  // FEAT-085 — `clave`: `claude` o `claude@<cuenta>`; cada cuenta tiene sus sondas.
  const estadoSondasClaude = async (clave = 'claude') => {
    try {
      const s = motores.sondasClaude(clave);
      if (s.corriendo()) return { estado: 'corriendo', motivo: null };
      const huella = s.huellaActual();
      const vs = await Promise.all([s.leerSondas('sin-tools', { huella }), s.leerSondas('lectura', { huella })]);
      const falla = vs.find((v) => !v.ok);
      return falla ? { estado: 'no-vigentes', motivo: falla.motivo } : { estado: 'vigentes', motivo: null };
    } catch (err) {
      return { estado: 'no-vigentes', motivo: `no se pudo leer: ${String(err?.message || err).slice(0, 200)}` };
    }
  };

  // FEAT-086 — La última resolución del alias del rol, solo si corresponde a lo
  // configurado hoy (mismo alias y misma cuenta): una de otra configuración
  // diría un modelo que este rol ya no pide. `cambioReciente`: marcado hace
  // menos de `CAMBIO_RECIENTE_MS`.
  const resolucionDe = (resoluciones, rol, efectivo) => {
    const r = resoluciones && resoluciones[rol];
    if (!r || efectivo.motor !== 'claude' || r.alias !== efectivo.modelo || (r.cuenta || null) !== (efectivo.cuenta || null)) return null;
    const cambio = Date.parse(r.cambio_en || '');
    return {
      modelo: r.modelo, vistoEn: r.visto_en || null,
      anterior: r.anterior ? r.anterior.modelo : null, cambioEn: r.cambio_en || null,
      cambioReciente: Number.isFinite(cambio) && ahora() - cambio < CAMBIO_RECIENTE_MS
    };
  };

  const vistaMotores = async () => {
    const config = motores.config();
    const tabla = (config && config.motores && config.motores.roles) || {};
    let resoluciones = {};
    try { resoluciones = typeof motores.resoluciones === 'function' ? motores.resoluciones() || {} : {}; } catch { /* sin historia, sin resolución */ }
    const sujetos = sujetosDeMotor().map((s) => {
      const efectivo = motores.elegir(config, s.rol);
      return {
        ...s,
        propio: tabla[s.rol] || null,
        origen: tabla[s.rol] ? s.rol : (tabla[s.general] ? s.general : null),
        efectivo,
        resolucion: resolucionDe(resoluciones, s.rol, efectivo)
      };
    });
    const claves = [...new Set(sujetos.filter((s) => s.efectivo.motor === 'claude').map((s) => claveDeSondas(s.efectivo)))];
    const sondas = claves.length
      ? Object.fromEntries(await Promise.all(claves.map(async (c) => [c, await estadoSondasClaude(c)])))
      : null;
    const extras = sujetos.map((s) => s.efectivo);
    return { ok: true, catalogo: motores.catalogo(extras), sujetos, sondas, avisos: (config && config.avisos) || [] };
  };

  // FEAT-055 — El tablero sondea el fan-out. La lista de workspaces se renueva
  // una vez por minuto (`getKnownWorkspaces` lee el disco de forma síncrona) y
  // cada workspace tiene como mucho una lectura en vuelo: una lectura colgada
  // ocupa un hilo del pool de libuv hasta que el disco responda, y relanzarla
  // en cada sondeo terminaría agotando el pool de todo el daemon.
  let workspacesFanout = null;
  const lecturasEnVuelo = new Map();
  const VENCIDA = Symbol('vencida');

  const workspacesDeFanout = () => {
    const t = ahora();
    if (!workspacesFanout || t >= workspacesFanout.vence) {
      workspacesFanout = { vence: t + ttlWorkspacesMs, lista: workspaces() };
    }
    return workspacesFanout.lista;
  };

  // Los lotes de un workspace, `null` si la lectura falló o `VENCIDA` si no
  // respondió a tiempo (o si todavía hay una lectura anterior en vuelo).
  const leerConLimite = async (w, opciones) => {
    const id = String(w.id);
    if (lecturasEnVuelo.has(id)) return VENCIDA;
    const lectura = (async () => {
      try {
        return await leerLotes(w.path, opciones);
      } catch {
        return null;
      } finally {
        lecturasEnVuelo.delete(id);
      }
    })();
    lecturasEnVuelo.set(id, lectura);
    let temporizador = null;
    const vencer = new Promise((resolve) => { temporizador = setTimeout(() => resolve(VENCIDA), limiteMs); });
    const r = await Promise.race([lectura, vencer]);
    clearTimeout(temporizador);
    return r;
  };

  // `alma:<clave>` o `agente:<nombre>`, validado con las mismas reglas que el
  // resto del bridge. Devuelve la clave normalizada o `null`.
  const sujetoValido = (crudo) => {
    const m = /^(alma|agente):(.+)$/.exec(String(crudo ?? ''));
    if (!m) return null;
    if (m[1] === 'alma') {
      try { almas.rutas.validarClave(m[2]); } catch { return null; }
    } else if (!nombreAgenteValido(m[2])) {
      return null;
    }
    return `${m[1]}:${m[2]}`;
  };

  // Estado de cada sujeto a partir del registro y de la cola: en curso, en
  // cola (con posición) o la última actividad.
  const estadosDeSujetos = () => {
    const posiciones = new Map();
    for (const c of bot.estadoDeCarriles()) {
      const ocupado = c.enCurso ? 1 : 0;
      c.pendientes.forEach((t, i) => { if (t.tareaId) posiciones.set(t.tareaId, i + 1 + ocupado); });
    }
    const porSujeto = new Map();
    for (const t of tareas.listar()) {
      // Una tarjeta sin lanzar no es actividad del sujeto.
      if (t.estado === tareas.POR_HACER) continue;
      const clave = tareas.claveSujeto(t.sujeto);
      const previo = porSujeto.get(clave) || {};
      if (t.estado === 'en_curso') previo.enCurso = { desde: t.iniciada, actividad: t.actividad?.at(-1)?.texto || null };
      else if (t.estado === 'en_cola') previo.enCola = previo.enCola || { posicion: posiciones.get(t.id) || null };
      else previo.ultima = t.terminada || t.creada;
      porSujeto.set(clave, previo);
    }
    return porSujeto;
  };

  // Clave exacta de un alma que existe. `listarClaves` solo devuelve claves
  // válidas, así que esto también descarta `..` y compañía.
  const alma = (clave) => bot.almasDisponibles().find((a) => a.clave === clave) || null;

  /**
   * FEAT-057 — El sujeto y el proyecto de una tarjeta, validados como en
   * `castear`: el alma existe, el agente es castable y el proyecto se guarda
   * por id. Resolver acá no recuerda el favorito: eso pasa al lanzar.
   * Devuelve `{ datos }` o `{ error }`.
   */
  const asignacion = ({ sujeto, workspaceId } = {}) => {
    if (sujeto === null || sujeto === undefined || sujeto === '') return { datos: { sujeto: null, proyecto: null, workspaceId: null } };
    const clave = sujetoValido(sujeto);
    if (!clave) return { error: error(400, 'Una tarjeta se asigna a alma:<clave> o agente:<nombre>.') };
    const nombre = clave.slice(clave.indexOf(':') + 1);
    if (clave.startsWith('alma:')) {
      const a = alma(nombre);
      if (!a) return { error: error(400, 'No existe esa alma.') };
      return { datos: { sujeto: { tipo: 'alma', clave: a.clave, voz: a.voz }, proyecto: null, workspaceId: null } };
    }
    const validacion = bot.validarCastDesdeChat(nombre);
    if (!validacion.ok) return { error: error(400, validacion.mensaje) };
    let ws = null;
    if (workspaceId !== undefined && workspaceId !== null && workspaceId !== '') {
      ws = workspaces().find((w) => String(w.id) === String(workspaceId));
      if (!ws) return { error: error(400, 'Proyecto no encontrado o ya no existe en disco.') };
    }
    return {
      datos: {
        sujeto: { tipo: 'agente', nombre },
        proyecto: ws ? ws.displayName || ws.name : null,
        workspaceId: ws ? String(ws.id) : null
      }
    };
  };

  const idValido = (id) => ID_TAREA.test(String(id));
  const rutaIgual = (a, b) => {
    const izquierda = path.resolve(String(a || ''));
    const derecha = path.resolve(String(b || ''));
    return process.platform === 'win32'
      ? izquierda.toLowerCase() === derecha.toLowerCase()
      : izquierda === derecha;
  };
  const recortarSeguro = (v, n = 64 * 1024) => String(v || '').slice(0, n);

  const workspaceParaRepo = (repo) => workspaces().find((w) => rutaIgual(w.path, repo)) || null;
  const tarjetasPorLote = () => {
    const mapa = new Map();
    for (const t of tareas.listar()) if (t.loteId) {
      const grupo = mapa.get(t.loteId) || { madre: null, hijas: [] };
      if (t.motivo === 'hija') grupo.hijas.push(t.id); else grupo.madre = t.id;
      mapa.set(t.loteId, grupo);
    }
    return mapa;
  };
  const tareaLoteSegura = (t) => ({
    id: t.id,
    cardId: ID_TAREA.test(String(t.id)) ? t.id : null,
    estado: t.estado,
    rama: t.rama || null,
    commit: t.commit || null,
    commitCorto: t.commit ? String(t.commit).slice(0, 8) : null,
    sinCambios: !!t.sinCambios,
    anomalias: (t.anomalias || []).slice(0, 50).map((a) => ({ ruta: recortarSeguro(a.ruta, 500), motivo: recortarSeguro(a.motivo, 500) })),
    error: t.error ? recortarSeguro(t.error, 1000) : null,
    prueba: t.prueba ? {
      estado: t.prueba.estado, argv: Array.isArray(t.prueba.argv) ? t.prueba.argv.slice(0, 32).map((x) => recortarSeguro(x, 4096)) : null,
      exitCode: t.prueba.exitCode ?? null, duracionMs: t.prueba.duracionMs ?? null,
      salida: recortarSeguro(t.prueba.salida, 16 * 1024), salidaTruncada: !!t.prueba.salidaTruncada,
      error: t.prueba.error ? recortarSeguro(t.prueba.error, 1000) : null
    } : null,
    auditoria: t.auditoria ? {
      estado: t.auditoria.estado, veredicto: t.auditoria.veredicto || null, modelo: t.auditoria.modelo || null,
      duracionMs: t.auditoria.duracionMs ?? null, reporte: recortarSeguro(t.auditoria.reporte),
      error: t.auditoria.error ? recortarSeguro(t.auditoria.error, 1000) : null
    } : null
  });
  const proyectarLote = (lote, detalle = false) => {
    const ws = workspaceParaRepo(lote.repo);
    if (!ws) return null;
    const vinculo = tarjetasPorLote().get(lote.id) || { madre: null, hijas: [] };
    return {
      id: lote.id, estado: lote.estado, creado: lote.creado, actualizado: lote.actualizado,
      modelo: lote.modelo || null, workspace: { id: String(ws.id), nombre: ws.displayName || ws.name },
      madreId: vinculo.madre, hijasIds: vinculo.hijas,
      tareas: (lote.tareas || []).map((t) => detalle ? tareaLoteSegura(t) : ({ id: t.id, estado: t.estado, commitCorto: t.commit ? String(t.commit).slice(0, 8) : null }))
    };
  };

  const familiaLanzable = (madreId, payload = null, { ignorarReserva = false } = {}) => {
    const madre = tareas.obtener(madreId);
    if (!madre) return { error: error(404, 'No existe esa tarjeta.') };
    if (madre.estado !== tareas.POR_HACER || madre.propuesta || madre.madre) return { error: error(409, 'La tarjeta no es una madre lanzable.') };
    const hijas = tareas.listar().filter((t) => t.motivo === 'hija' && t.madre === madre.id && t.estado === tareas.POR_HACER);
    if (hijas.length < 1 || hijas.length > 6) return { error: error(409, 'La madre debe tener entre 1 y 6 hijas actuales.') };
    if (hijas.some((h) => h.propuesta || h.sujeto?.tipo !== 'agente' || !h.workspaceId)) return { error: error(409, 'Todas las hijas deben estar aceptadas, asignadas a un agente y tener proyecto.') };
    if ([madre, ...hijas].some((t) => t.loteId || (!ignorarReserva && tareas.familiaReservada(t.id)))) return { error: error(409, 'La familia ya está reservada o vinculada a un lote.') };
    const wsIds = new Set(hijas.map((h) => String(h.workspaceId)));
    if (wsIds.size !== 1) return { error: error(409, 'Todas las hijas deben usar el mismo proyecto.') };
    const workspaceId = [...wsIds][0];
    if (madre.workspaceId && String(madre.workspaceId) !== workspaceId) return { error: error(409, 'El proyecto de la madre no coincide con el de sus hijas.') };
    const ws = workspaces().find((w) => String(w.id) === workspaceId);
    if (!ws) return { error: error(400, 'El proyecto ya no está disponible.') };
    if (payload) {
      if (!Array.isArray(payload.hijas) || payload.hijas.length !== hijas.length) return { error: error(400, 'El payload debe incluir exactamente todas las hijas.') };
      const recibidos = payload.hijas.map((h) => h?.id);
      if (new Set(recibidos).size !== recibidos.length || hijas.some((h) => !recibidos.includes(h.id))) return { error: error(400, 'Las hijas del payload no coinciden con la familia actual.') };
    }
    return { madre, hijas, ws };
  };
  const sinRegistro = () => error(503, 'El registro de programaciones no está disponible.');
  const conCodigo = (r) => (r.ok ? r : error(r.codigo, r.error));

  // `activa()` solo lee env y la config local; igual, un fallo es "apagada".
  const profundaActiva = () => {
    try { return Boolean(almas.profunda?.activa()); } catch { return false; }
  };
  const vistaRecuerdos = (modelo, tope) => ({
    usado: almas.recuerdos.usado(modelo),
    tope,
    entradas: almas.recuerdos.entradas(modelo).map((e) => ({ id: e.id || null, texto: e.texto }))
  });

  // SEC-021 — La vista de la cuarentena de un agente (la usan las tres operaciones).
  const vistaCuarentena = (nombre) => {
    if (!nombreAgenteValido(nombre)) return error(400, 'Nombre de agente inválido.');
    if (!bot.agentesCasteables().some((a) => a.nombre === nombre)) return error(404, 'No es un agente castable.');
    if (!cuarentena) return error(503, 'Sin cuarentena.');
    let r;
    try { r = cuarentena.listar(nombre); } catch { r = null; }
    if (!r || !r.ok) return error(503, 'No se pudo leer la cuarentena.');
    const recortar = (t) => (t.length > TOPE_TEXTO_CRITERIO ? `${t.slice(0, TOPE_TEXTO_CRITERIO)}…` : t);
    const p = (e) => e.procedencia || {};
    return {
      ok: true,
      total: r.entradas.length,
      entradas: r.entradas.slice(0, TOPE_CRITERIO).map((e) => ({
        id: e.id,
        creada: typeof e.creada === 'string' ? e.creada : null,
        promoviendo: Boolean(e.promoviendo),
        textos: [...(e.decisions || []), ...(e.userCorrections || [])].map((t) => recortar(redactarReglas(String(t)))),
        procedencia: {
          motor: p(e).motor || null,
          modeloReal: p(e).modeloReal || null,
          red: p(e).red || null,
          herramientasRed: Array.isArray(p(e).herramientasRed) ? p(e).herramientasRed.slice(0, 8) : [],
          origen: p(e).origen || null
        }
      }))
    };
  };

  return {
    canal,
    chatId,

    almas() {
      return { ok: true, almas: bot.almasDisponibles() };
    },

    memoria(clave) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      const memoria = almas.recuerdos.leer(almas.rutas.rutasDe(a.clave).memoria, 'm');
      const usuario = almas.recuerdos.leer(almas.rutas.rutaUsuario(), 'u');
      return {
        ok: true,
        ...a,
        memoria: vistaRecuerdos(memoria, almas.recuerdos.TOPE_MEMORIA),
        usuario: vistaRecuerdos(usuario, almas.recuerdos.TOPE_USUARIO),
        // FEAT-081 — Si el panel muestra el buscador de la memoria profunda.
        profunda: profundaActiva()
      };
    },

    // FEAT-081 — Buscar en la memoria profunda del alma. El motivo de un fallo
    // del servicio no llega al navegador: el texto es fijo, como en el criterio.
    async buscarProfunda(clave, q) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      const consulta = typeof q === 'string' ? q : '';
      if (consulta.length > TOPE_CONSULTA_PROFUNDA) return error(400, 'La búsqueda es demasiado larga.');
      if (!almas.profunda) return error(503, 'La memoria profunda está apagada.');
      let r = null;
      try {
        r = await almas.profunda.buscarDetallado(a.clave, consulta, { limite: TOPE_PROFUNDA, timeoutMs: 8000 });
      } catch {
        r = null;
      }
      if (r && r.motivo === 'corta') return error(422, 'Escribí al menos 3 palabras.');
      if (r && r.motivo === 'apagada') return error(503, 'La memoria profunda está apagada.');
      if (!r || !r.ok || !Array.isArray(r.resultados)) return error(503, 'La memoria profunda no respondió.');
      const idsArchivo = new Set([
        ...almas.recuerdos.entradas(almas.recuerdos.leer(almas.rutas.rutasDe(a.clave).memoria, 'm')),
        ...almas.recuerdos.entradas(almas.recuerdos.leer(almas.rutas.rutaUsuario(), 'u'))
      ].map((e) => String(e.id || '').toLowerCase()).filter(Boolean));
      return {
        ok: true,
        resultados: r.resultados.slice(0, TOPE_PROFUNDA).map((e) => {
          const id = typeof e.id === 'string' && almas.profunda.ID_VALIDO.test(e.id.toLowerCase()) ? e.id.toLowerCase() : null;
          return {
            id,
            texto: String(e.texto ?? ''),
            creado: typeof e.creado === 'string' ? e.creado : null,
            enArchivo: Boolean(id && idsArchivo.has(id))
          };
        })
      };
    },

    // FEAT-046 — async: también borra de la memoria profunda (servidor.js ya espera a `fn`).
    async olvidar(clave, id) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      const r = await bot.olvidarRecuerdo(a.clave, id, 'web');
      if (!r.ok) {
        const codigo = { id: 400, inexistente: 404, servicio: 503 }[r.motivo] || 500;
        return error(codigo, r.mensaje);
      }
      return { ok: true, olvidado: r.olvidado, enArchivo: r.enArchivo, aviso: r.aviso };
    },

    // FEAT-055 — El usuario agrega un recuerdo del alma o sobre sí mismo.
    recordar(clave, { texto, sobre } = {}) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      const r = bot.agregarRecuerdo(a.clave, sobre, texto);
      if (!r.ok) {
        const codigo = { sobre: 400, texto: 400, escaneo: 400, lleno: 409, duplicado: 409 }[r.motivo] || 500;
        return error(codigo, r.mensaje);
      }
      return { ok: true, id: r.id, texto: r.texto };
    },

    async mensaje(clave, texto) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      const t = textoValido(texto);
      if (!t) return error(400, `El mensaje tiene que tener entre 1 y ${TOPE_TEXTO} caracteres.`);
      await bot.dispatchCharla(ctx, { clave: a.clave, voz: a.voz, texto: t });
      return { ok: true, encolado: true };
    },

    hiloNuevo(clave) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      almas.hilos.olvidarHilo(a.clave);
      return { ok: true };
    },

    agentes() {
      return { ok: true, agentes: bot.agentesCasteables() };
    },

    workspaces() {
      const favorito = ultimoWorkspace(chatId);
      return {
        ok: true,
        workspaces: workspaces().map((w) => ({
          id: String(w.id),
          nombre: w.displayName || w.name,
          favorito: String(w.id) === String(favorito)
        }))
      };
    },

    async castear({ agente, workspaceId, pedido } = {}) {
      if (typeof agente !== 'string') return error(400, 'Falta el agente.');
      const validacion = bot.validarCastDesdeChat(agente);
      if (!validacion.ok) return error(400, validacion.mensaje);
      const t = textoValido(pedido);
      if (!t) return error(400, `El pedido tiene que tener entre 1 y ${TOPE_TEXTO} caracteres.`);
      if (typeof workspaceId !== 'string' || !workspaceId) return error(400, 'Falta el proyecto.');
      // Al final: resolver el workspace lo recuerda como favorito, y eso solo
      // tiene que pasar con un cast que de verdad se lanza.
      const ws = bot.resolverWorkspaceDeCast(chatId, workspaceId);
      if (!ws) return error(400, 'Proyecto no encontrado o ya no existe en disco.');
      await bot.dispatchCast(ctx, { agent: agente, prompt: t, cwd: ws.path, workspaceName: ws.displayName || ws.name, workspaceId: ws.id });
      return { ok: true, encolado: true };
    },

    cola() {
      return { ok: true, carriles: bot.estadoDeCarriles() };
    },

    cancelar(carril) {
      if (carril !== undefined && carril !== null && !CARRILES_WEB.includes(carril)) {
        return error(400, `Carril desconocido. Válidos: ${CARRILES_WEB.join(', ')}.`);
      }
      return { ok: true, ...bot.cancelarCarriles(carril ? [carril] : [...CARRILES_WEB], chatId) };
    },

    sesiones() {
      return { ok: true, ...sesiones() };
    },

    logs(n) {
      return { ok: true, ...logs(n) };
    },

    // ---------------------------------------------------------------- FEAT-053

    estado() {
      const carriles = bot.estadoDeCarriles().map((c) => ({
        carril: c.carril,
        enCurso: c.enCurso ? { kind: c.enCurso.kind, desde: c.enCurso.desde } : null,
        enCola: c.pendientes.length
      }));
      return { ok: true, ...estadoDaemon(), carriles };
    },

    sujetos() {
      const estados = estadosDeSujetos();
      return {
        ok: true,
        almas: bot.almasDisponibles().map((a) => ({ ...a, ...(estados.get(`alma:${a.clave}`) || {}) })),
        agentes: bot.agentesCasteables().map((a) => ({ ...a, ...(estados.get(`agente:${a.nombre}`) || {}) }))
      };
    },

    tareas(sujeto, q = null, programado = null) {
      // FEAT-066 — Las corridas de una programación, las más recientes primero.
      if (programado !== null && programado !== undefined) {
        if (!ID_PROGRAMACION.test(String(programado))) return error(400, 'Id de programación inválido.');
        const corridas = tareas.listar({ programado: String(programado) }).slice(-TOPE_CORRIDAS).reverse();
        return { ok: true, programado: String(programado), tareas: corridas.map((t) => tareas.resumen(t)) };
      }
      // FEAT-054 — Sin sujeto: todas, en resumen (el tablero). FEAT-057: `q`
      // busca en el título, el pedido completo y las notas.
      if (sujeto === null || sujeto === undefined) {
        if (q !== null && q !== undefined) {
          if (String(q).length > tareas.TOPE_BUSQUEDA) return error(400, `La búsqueda admite hasta ${tareas.TOPE_BUSQUEDA} caracteres.`);
          return { ok: true, q: String(q), tareas: tareas.buscar(q).map((t) => tareas.resumen(t)) };
        }
        return { ok: true, tareas: tareas.listar().map((t) => tareas.resumen(t)) };
      }
      const clave = sujetoValido(sujeto);
      if (!clave) return error(400, 'Sujeto inválido: se espera alma:<clave> o agente:<nombre>.');
      // El historial de la conversación es lo que corrió.
      return { ok: true, sujeto: clave, tareas: tareas.listar({ sujeto: clave }).filter((t) => t.estado !== tareas.POR_HACER) };
    },

    // ---------------------------------------------------------------- FEAT-057

    tarea(id) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const t = tareas.obtener(id);
      return t ? { ok: true, tarea: t } : error(404, 'No existe esa tarea.');
    },

    // `lanzar`: "Guardar y lanzar". Si lanzar falla, la tarjeta queda en Por hacer.
    async crearTarjeta({ titulo, pedido, sujeto, workspaceId, lanzar = false } = {}) {
      const a = asignacion({ sujeto, workspaceId });
      if (a.error) return a.error;
      const r = tareas.crearTarjeta({ titulo, pedido, ...a.datos });
      if (!r.ok) return conCodigo(r);
      if (lanzar !== true) return { ok: true, tarea: tareas.resumen(r.tarea) };
      const l = await bot.lanzarTarjetaWeb(r.tarea.id, ctx);
      const tarea = tareas.resumen(tareas.obtener(r.tarea.id));
      return l.ok ? { ok: true, tarea, lanzada: true } : { ...error(l.codigo, l.error), tarea };
    },

    editarTarjeta(id, cuerpo = {}) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const cambios = {};
      if ('titulo' in cuerpo) cambios.titulo = cuerpo.titulo;
      if ('pedido' in cuerpo) cambios.pedido = cuerpo.pedido;
      if ('sujeto' in cuerpo || 'workspaceId' in cuerpo) {
        const actual = tareas.obtener(id);
        if (!actual) return error(404, 'No existe esa tarea.');
        const a = asignacion({
          sujeto: 'sujeto' in cuerpo ? cuerpo.sujeto : tareas.claveSujeto(actual.sujeto),
          workspaceId: 'workspaceId' in cuerpo ? cuerpo.workspaceId : actual.workspaceId
        });
        if (a.error) return a.error;
        Object.assign(cambios, a.datos);
      }
      const r = tareas.editarTarjeta(id, cambios);
      return r.ok ? { ok: true, tarea: tareas.resumen(r.tarea) } : conCodigo(r);
    },

    async lanzarTarjeta(id) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const r = await bot.lanzarTarjetaWeb(id, ctx);
      return r.ok ? { ok: true, encolado: true } : error(r.codigo, r.error);
    },

    borrarTarjeta(id) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const antes = tareas.obtener(id);
      const r = tareas.borrarTarjeta(id);
      // FEAT-058 — Descartar una propuesta queda en el diario de quien la hizo.
      if (r.ok && antes?.propuesta && /^alma:/.test(antes.creadaPor || '') && almas.diario) {
        try {
          almas.diario.anotar(antes.creadaPor.slice('alma:'.length), { superficie: 'web', tipo: 'tablero:descartada', id, resumen: antes.titulo || '' });
        } catch { /* el diario es un registro: no frena el borrado */ }
      }
      return conCodigo(r);
    },

    // FEAT-059 — "Partir en tarjetas" con un agente orquestador.
    async partirTarjeta(id, { agente, workspaceId } = {}) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      if (agente !== undefined && typeof agente !== 'string') return error(400, 'Agente inválido.');
      if (workspaceId !== undefined && workspaceId !== null && typeof workspaceId !== 'string') return error(400, 'Proyecto inválido.');
      const r = await bot.partirTarjetaWeb(id, { agente, workspaceId: workspaceId || null }, ctx);
      return r.ok ? { ok: true, encolado: true } : error(r.codigo, r.error);
    },

    // ---------------------------------------------------------------- FEAT-061 fase 4

    async lanzarLote(id, cuerpo = {}) {
      if (!lotes) return error(503, 'El servicio de lotes no está disponible.');
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const familia = familiaLanzable(id, cuerpo);
      if (familia.error) return familia.error;
      const porId = new Map(familia.hijas.map((h) => [h.id, h]));
      const slug = `web-${id.replace(/^t_/, '').slice(0, 24)}-${crypto.randomBytes(4).toString('hex')}`;
      const solicitud = {
        slug, cwd: familia.ws.path, modelo: cuerpo.modelo, effort: cuerpo.effort,
        concurrencia: cuerpo.concurrencia, timeout_minutes: cuerpo.timeout_minutes,
        tareas: cuerpo.hijas.map((entrada) => {
          const tarjeta = porId.get(entrada.id);
          return {
            id: tarjeta.id,
            prompt: `${tarjeta.titulo ? `${tarjeta.titulo}\n\n` : ''}${tarjeta.pedido}`,
            archivos: entrada.archivos,
            prueba: entrada.prueba ?? null
          };
        })
      };
      try { lotes.servicio.validarSolicitud(solicitud); } catch (err) { return error(400, err.message); }
      const ids = [familia.madre.id, ...familia.hijas.map((h) => h.id)];
      const tomada = tareas.reservarFamilia(ids);
      if (!tomada.ok) return conCodigo(tomada);
      let reserva = null;
      try {
        reserva = await lotes.servicio.preparar(solicitud);
        const actual = familiaLanzable(id, cuerpo, { ignorarReserva: true });
        if (actual.error) throw new Error(actual.error.error);
        const vinculada = tareas.vincularLote({ madre: actual.madre, hijas: actual.hijas, loteId: slug });
        if (!vinculada.ok) throw new Error(vinculada.error);
        lotes.servicio.ejecutarEnSegundoPlano(reserva, { onError: (err) => lotes.log?.(`Lote ${slug}: ${err.message}`) });
        return { codigo: 202, ok: true, id: slug, estado: 'corriendo' };
      } catch (err) {
        if (reserva) await lotes.servicio.cancelar(reserva, err.message);
        const infraestructura = /Docker|imagen|volumen|OAuth|CA TLS/i.test(err.message);
        return error(infraestructura ? 503 : 409, err.message);
      } finally { tareas.liberarReservaFamilia(ids); }
    },

    lotes() {
      if (!lotes) return error(503, 'El servicio de lotes no está disponible.');
      lotes.registro.marcarInterrumpidos();
      const estado = lotes.registro.listarConEstado
        ? lotes.registro.listarConEstado()
        : { lotes: lotes.registro.listar(), ilegibles: 0 };
      return { ok: true, lotes: estado.lotes.map((l) => proyectarLote(l, false)).filter(Boolean), ilegibles: estado.ilegibles };
    },

    lote(id) {
      if (!lotes) return error(503, 'El servicio de lotes no está disponible.');
      try { lotes.validarId(id, 'id del lote'); } catch (err) { return error(400, err.message); }
      const lote = lotes.registro.leer(id);
      if (!lote) return error(404, 'No existe ese lote.');
      const vista = proyectarLote(lote, true);
      return vista ? { ok: true, lote: vista } : error(404, 'El lote no pertenece a un proyecto disponible.');
    },

    async diffLote(id, tareaId) {
      if (!lotes) return error(503, 'El servicio de lotes no está disponible.');
      try { lotes.validarId(id, 'id del lote'); lotes.validarId(tareaId, 'id de tarea del lote'); } catch (err) { return error(400, err.message); }
      const lote = lotes.registro.leer(id);
      const tarea = lote?.tareas?.find((t) => t.id === tareaId);
      if (!lote || !workspaceParaRepo(lote.repo)) return error(404, 'No existe ese lote.');
      if (!tarea?.commit) return error(409, 'La tarea todavía no tiene commit.');
      try { return { ok: true, ...(await lotes.diff({ repo: lote.repo, commit: tarea.commit })) }; }
      catch (err) { return error(/supera/.test(err.message) ? 413 : 409, err.message); }
    },

    async descartarLote(id, { confirmacion } = {}) {
      if (!lotes) return error(503, 'El servicio de lotes no está disponible.');
      try { lotes.validarId(id, 'id del lote'); } catch (err) { return error(400, err.message); }
      if (confirmacion !== id) return error(400, 'La confirmación no coincide con el id del lote.');
      const lote = lotes.registro.leer(id);
      if (!lote || !workspaceParaRepo(lote.repo)) return error(404, 'No existe ese lote.');
      try {
        const r = await lotes.descartar({ registro: lotes.registro, id, git: lotes.git, confirmar: async () => confirmacion,
          recolectarRestos: lotes.recolectarRestos, informar: () => {} });
        if (!r.descartado) return error(409, 'No se descartó el lote.');
        tareas.desvincularLote(id);
        return { ok: true, ...r };
      } catch (err) { return error(409, err.message); }
    },

    // FEAT-058 — El usuario acepta la propuesta de un alma.
    aceptarPropuesta(id) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const r = tareas.aceptarPropuesta(id);
      return r.ok ? { ok: true, tarea: tareas.resumen(r.tarea) } : conCodigo(r);
    },

    agregarNota(id, texto) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const r = tareas.agregarNota(id, texto, 'usuario');
      return r.ok ? { ok: true, nota: r.nota } : conCodigo(r);
    },

    devolver(id) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const r = tareas.devolver(id);
      return r.ok ? { ok: true, tarea: tareas.resumen(r.tarea) } : conCodigo(r);
    },

    // FEAT-068 — Archivar saca una tarea cerrada del tablero, sin borrarla.
    archivarTarea(id) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const r = tareas.archivarTarea(id);
      return r.ok ? { ok: true, tarea: tareas.resumen(r.tarea) } : conCodigo(r);
    },

    desarchivarTarea(id) {
      if (!idValido(id)) return error(400, 'Id de tarea inválido.');
      const r = tareas.desarchivarTarea(id);
      return r.ok ? { ok: true, tarea: tareas.resumen(r.tarea) } : conCodigo(r);
    },

    // Los ids son los que el usuario ve con sus filtros: el servidor no
    // decide por columna, porque archivaría lo que el filtro escondía.
    archivarTareas(ids) {
      if (!Array.isArray(ids) || !ids.length) return error(400, 'Se espera una lista de ids.');
      if (ids.length > TOPE_ARCHIVAR) return error(400, `Se archivan hasta ${TOPE_ARCHIVAR} tareas por vez.`);
      if (!ids.every(idValido)) return error(400, 'Id de tarea inválido.');
      return conCodigo(tareas.archivarTareas(ids));
    },

    cancelarTarea(id) {
      if (!ID_TAREA.test(String(id))) return error(400, 'Id de tarea inválido.');
      const r = bot.cancelarTarea(id);
      return r.ok ? { ok: true, accion: r.accion } : error(r.codigo, r.error);
    },

    async reintentarTarea(id) {
      if (!ID_TAREA.test(String(id))) return error(400, 'Id de tarea inválido.');
      const r = await bot.reintentarTarea(id, ctx);
      return r.ok ? { ok: true, encolado: true } : error(r.codigo, r.error);
    },

    // ---------------------------------------------------------------- FEAT-055

    async fanout() {
      const lentos = [];
      const lotes = [];
      await Promise.all(workspacesDeFanout().map(async (w) => {
        const workspace = { id: String(w.id), nombre: w.displayName || w.name };
        const r = await leerConLimite(w);
        if (r === VENCIDA) { lentos.push(workspace.nombre); return; }
        // La ruta nunca sale: el workspace va por id y nombre.
        for (const lote of r?.lotes || []) lotes.push({ ...lote, workspace });
      }));
      lotes.sort((a, b) => String(b.actualizado || '').localeCompare(String(a.actualizado || '')));
      return { ok: true, lotes, lentos };
    },

    /**
     * FEAT-057 — Pide detener una subtarea en curso. El centinela es una
     * escritura en el repo del lote: solo se escribe sobre una subtarea que la
     * lectura de ahora confirma que existe y está corriendo.
     */
    async detenerFanout({ workspaceId, lote, tarea } = {}) {
      // `detalleLotes` recorta slug e id a 80: uno de 80 podría ser el recorte de otro.
      const campo = (v) => typeof v === 'string' && v.length > 0 && v.length < 80;
      if (!campo(workspaceId) || !campo(lote) || !campo(tarea)) return error(400, 'Faltan el proyecto, el lote o la subtarea.');
      const w = workspacesDeFanout().find((x) => String(x.id) === workspaceId);
      if (!w) return error(404, 'Proyecto desconocido.');
      const r = await leerConLimite(w, { maximo: Infinity });
      if (r === VENCIDA || !r) return error(503, 'El proyecto no responde: probá de nuevo en un momento.');
      const sub = r.lotes?.find((l) => l.slug === lote)?.tareas?.find((t) => t.id === tarea);
      if (!sub) return error(404, 'No existe ese lote o esa subtarea.');
      if (sub.estado !== 'corriendo' && sub.estado !== 'reintentando') return error(400, 'La subtarea no está en curso.');
      try {
        detener(w.path, lote, tarea);
      } catch {
        return error(500, 'No se pudo pedir la detención.');
      }
      return { ok: true, lote, tarea };
    },

    async escucharTarea(id) {
      if (!ID_TAREA.test(String(id))) return error(400, 'Id de tarea inválido.');
      const r = await bot.escucharTarea(id);
      if (!r.ok) return error(r.codigo, r.error);
      // El servidor lo manda tal cual, con las mismas cabeceras base.
      return { binario: r.audio, tipo: 'audio/wav' };
    },

    // FEAT-056 — Sin clave, la voz por defecto (la de un cast).
    async prepararVoz({ clave } = {}) {
      let voz = null;
      if (clave !== undefined && clave !== null && clave !== '') {
        try { almas.rutas.validarClave(String(clave)); } catch { return error(400, 'Clave de alma inválida.'); }
        const a = alma(String(clave));
        if (!a) return error(404, 'No existe esa alma.');
        voz = a.voz;
      }
      const r = await bot.prepararVoz({ voz });
      if (!r.ok) return error(r.codigo, r.error);
      return { ok: true, perfil: r.perfil, proveedor: r.proveedor, precargado: r.precargado };
    },

    // ---------------------------------------------------------------- FEAT-075

    async motores() {
      if (!motores) return error(503, 'Sin configuración de motores.');
      return vistaMotores();
    },

    // `{ rol, motor, modelo, esfuerzo }` o `{ rol, quitar: true }` (vuelve a
    // heredar). Valida estricto con `roles.js`; si no valida, nada se guarda.
    async guardarMotor(cuerpo) {
      if (!motores) return error(503, 'Sin configuración de motores.');
      const rol = typeof cuerpo?.rol === 'string' ? cuerpo.rol : '';
      if (!sujetosDeMotor().some((s) => s.rol === rol)) return error(404, 'No es un rol editable desde la consola (alma, su consolidación o agente castable).');
      const entrada = cuerpo.quitar === true
        ? null
        : { motor: cuerpo.motor, modelo: cuerpo.modelo ?? null, esfuerzo: cuerpo.esfuerzo ?? null };
      let r;
      try {
        r = motores.guardarRol(rol, entrada);
      } catch (err) {
        return error(500, `No se pudo guardar: ${String(err?.message || err).slice(0, 200)}`);
      }
      if (!r.ok) return error(400, r.motivo);
      // Un rol en claude exige sondas vigentes: se disparan ya, en segundo
      // plano, si hacen falta (si están vigentes no se vuelven a pagar).
      if (entrada && entrada.motor === 'claude') {
        try {
          // FEAT-085 — Las de la cuenta que quedó guardada (la web no la edita, la conserva).
          const guardado = (r.roles && r.roles[rol]) || entrada;
          Promise.resolve(motores.sondasClaude(claveDeSondas(guardado)).dispararSiHaceFalta()).catch(() => {});
        } catch { /* el próximo turno las dispara igual */ }
      }
      return vistaMotores();
    },

    // ---------------------------------------------------------------- FEAT-066

    // FEAT-069 — Solo lectura: la consola avisa, nunca actualiza (D4).
    async proveedores() {
      if (!proveedores) return error(503, 'Sin datos de proveedores.');
      try {
        return { ok: true, proveedores: await proveedores.lista() };
      } catch (err) {
        return error(503, `No se pudo consultar: ${String(err?.message || err).slice(0, 200)}`);
      }
    },

    programaciones() {
      if (!programaciones) return sinRegistro();
      return { ok: true, programaciones: programaciones.listar(), topeFallos: programaciones.TOPE_FALLOS };
    },

    /**
     * Lo mismo que `/cron nueva`, con una diferencia: el proyecto de un agente
     * es explícito. Telegram toma el último usado porque no tiene dónde
     * elegirlo; acá hay selector, y adivinar sobre qué repo corre un trabajo
     * nocturno no es aceptable.
     */
    crearProgramacion({ titulo, pedido, sujeto, workspaceId, horario, silencioso = false, avisarTelegram = false } = {}) {
      if (!programaciones) return sinRegistro();
      if (sujeto === null || sujeto === undefined || sujeto === '') return error(400, 'Una programación se asigna a un alma o a un agente.');
      const a = asignacion({ sujeto, workspaceId });
      if (a.error) return a.error;
      if (a.datos.sujeto.tipo === 'agente' && !a.datos.workspaceId) return error(400, 'Un agente programado necesita un proyecto.');
      // El modelo EFECTIVO de ahora queda congelado, igual que en Telegram.
      const { model, effortPorDefecto } = modeloEfectivo() || {};
      const r = programaciones.crear({
        titulo: titulo === '' ? undefined : titulo,
        pedido, horario, ...a.datos,
        modelo: model || null, esfuerzo: effortPorDefecto || null,
        silencioso: silencioso === true,
        avisarTelegram: avisarTelegram === true,
        origen: 'web'
      });
      return r.ok ? { ok: true, programacion: r.programacion } : conCodigo(r);
    },

    pausarProgramacion(id) {
      if (!programaciones) return sinRegistro();
      if (!ID_PROGRAMACION.test(String(id))) return error(400, 'Id de programación inválido.');
      return conCodigo(programaciones.activar(id, false));
    },

    seguirProgramacion(id) {
      if (!programaciones) return sinRegistro();
      if (!ID_PROGRAMACION.test(String(id))) return error(400, 'Id de programación inválido.');
      return conCodigo(programaciones.activar(id, true));
    },

    borrarProgramacion(id) {
      if (!programaciones) return sinRegistro();
      if (!ID_PROGRAMACION.test(String(id))) return error(400, 'Id de programación inválido.');
      return conCodigo(programaciones.borrar(id));
    },

    contextoAgente(nombre) {
      if (!nombreAgenteValido(nombre)) return error(400, 'Nombre de agente inválido.');
      if (!bot.agentesCasteables().some((a) => a.nombre === nombre)) return error(404, 'No es un agente castable.');
      const ultimoCast = tareas.listar({ sujeto: `agente:${nombre}` }).filter((t) => t.estado === 'ok').at(-1) || null;
      return {
        ok: true,
        nombre,
        ...estadoAgente(nombre),
        memoria: ultimoCast ? ultimoCast.memoria : null
      };
    },

    // FEAT-079 — El criterio que el agente acumuló en mcp-memory (decisiones y
    // correcciones), de solo lectura. El texto pasa por el mismo redactor que
    // el visor de reglas; ni el hash ni la sesión salen de acá, y un fallo del
    // servicio no reenvía su motivo (puede traer detalles del servicio).
    async criterioAgente(nombre) {
      if (!nombreAgenteValido(nombre)) return error(400, 'Nombre de agente inválido.');
      if (!bot.agentesCasteables().some((a) => a.nombre === nombre)) return error(404, 'No es un agente castable.');
      if (!criterio) return error(503, 'Sin servicio de memoria.');
      let r = null;
      try { r = await criterio(nombre); } catch { r = null; }
      if (!r || !r.ok || !Array.isArray(r.entradas)) return error(503, 'El servicio de memoria no respondió.');
      const recortar = (t) => (t.length > TOPE_TEXTO_CRITERIO ? `${t.slice(0, TOPE_TEXTO_CRITERIO)}…` : t);
      return {
        ok: true,
        total: r.entradas.length,
        truncado: Boolean(r.truncado),
        entradas: r.entradas.slice(0, TOPE_CRITERIO).map((e) => ({
          tipo: tipoCriterio(e),
          texto: recortar(redactarReglas(String(e.contenido ?? ''))),
          usos: Number.isFinite(e.usos) ? e.usos : 0,
          creado: typeof e.creado === 'string' ? e.creado : null
        }))
      };
    },

    // ---------------------------------------------------------------- SEC-021

    // Lo que el agente aprendió en turnos con red (o sin datos de red), retenido
    // hasta que el usuario lo promueva. El texto es no confiable: pasa por el
    // redactor y el cliente lo pinta como texto, nunca como HTML.
    cuarentenaAgente(nombre) {
      return vistaCuarentena(nombre);
    },

    async promoverCuarentena(nombre, id) {
      if (!nombreAgenteValido(nombre)) return error(400, 'Nombre de agente inválido.');
      if (!bot.agentesCasteables().some((a) => a.nombre === nombre)) return error(404, 'No es un agente castable.');
      if (!cuarentena) return error(503, 'Sin cuarentena.');
      let r;
      try { r = await cuarentena.promover(String(id || ''), nombre); } catch (err) { r = { ok: false, motivo: err.message }; }
      // El motivo es nuestro (id, carrera, memoria caída): no trae contenido del servicio.
      if (!r || !r.ok) return error(409, `No se promovió: ${String(r?.motivo || 'sin detalle').slice(0, 160)}`);
      return vistaCuarentena(nombre);
    },

    descartarCuarentena(nombre, id) {
      if (!nombreAgenteValido(nombre)) return error(400, 'Nombre de agente inválido.');
      if (!bot.agentesCasteables().some((a) => a.nombre === nombre)) return error(404, 'No es un agente castable.');
      if (!cuarentena) return error(503, 'Sin cuarentena.');
      let r;
      try { r = cuarentena.descartar(String(id || ''), nombre); } catch (err) { r = { ok: false, motivo: err.message }; }
      if (!r || !r.ok) return error(409, `No se descartó: ${String(r?.motivo || 'sin detalle').slice(0, 160)}`);
      return vistaCuarentena(nombre);
    },

    // ---------------------------------------------------------------- FEAT-076

    // El hilo de cada motor y cuánto le queda de la ventana. El id del hilo va
    // recortado: identifica sin servir para retomarlo desde afuera.
    hiloAlma(clave, ahora = Date.now()) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      const entrada = almas.hilos.leerEstado().almas?.[a.clave] || null;
      const ventana = almas.hilos.VENTANA_MS;
      const hilos = almas.hilos.hilosDe(entrada).map(([motor, h]) => {
        const ultimo = Date.parse(h.ultimo_turno || '');
        const resta = Number.isFinite(ultimo) ? ventana - (ahora - ultimo) : null;
        return {
          motor,
          hilo: String(h.conversation_id).slice(0, 8),
          ultimoTurno: h.ultimo_turno || null,
          venceEnMs: resta !== null && resta > 0 ? resta : null
        };
      });
      // FEAT-085 — La clave de cuenta: los hilos de un alma con cuenta se guardan bajo `claude@<cuenta>`.
      const efectivo = motores ? claveDeSondas(motores.elegir(motores.config(), `alma:${a.clave}`)) : 'antigravity';
      return { ok: true, clave: a.clave, turnos: entrada?.turnos || 0, ventanaMs: ventana, efectivo, hilos };
    },

    // Solo lo que el alma hizo en segundo plano: las líneas sin `tipo` son
    // turnos de charla y ya están en Actividad reciente.
    diarioAlma(clave) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      const deFondo = (e) => e && typeof e.tipo === 'string'
        && (['consolidacion', 'saneado', 'rechazo', 'olvidar'].includes(e.tipo) || e.tipo.startsWith('memoria:'));
      const eventos = almas.diario.ultimas(a.clave, 50).filter(deFondo).slice(-10).reverse()
        .map((e) => ({ ts: e.ts || null, tipo: e.tipo, id: e.id || null, motivo: e.motivo || null, resumen: e.resumen || null }));
      return { ok: true, clave: a.clave, eventos };
    },

    // Archivos de reglas del proyecto del hilo actual del agente. La ruta del
    // proyecto la resuelve `reglas.raizDe` en el servidor y nunca sale de acá.
    async reglasAgente(nombre) {
      if (!reglas) return error(503, 'Sin visor de reglas.');
      if (!nombreAgenteValido(nombre)) return error(400, 'Nombre de agente inválido.');
      if (!bot.agentesCasteables().some((a) => a.nombre === nombre)) return error(404, 'No es un agente castable.');
      const raiz = reglas.raizDe(nombre);
      if (!raiz) return error(404, 'El hilo del agente no está en un proyecto conocido.');
      const lista = await reglas.descubrir(raiz);
      if (!lista) return error(404, 'El proyecto ya no existe.');
      return { ok: true, ...lista };
    },

    async reglaAgente(nombre, id) {
      if (!reglas) return error(503, 'Sin visor de reglas.');
      if (!nombreAgenteValido(nombre)) return error(400, 'Nombre de agente inválido.');
      if (!/^[0-9a-f]{12}$/.test(String(id))) return error(400, 'Id de archivo inválido.');
      if (!bot.agentesCasteables().some((a) => a.nombre === nombre)) return error(404, 'No es un agente castable.');
      const raiz = reglas.raizDe(nombre);
      if (!raiz) return error(404, 'El hilo del agente no está en un proyecto conocido.');
      const r = await reglas.leer(raiz, id);
      if (!r.ok) return error(r.codigo || 500, r.error);
      return r;
    }
  };
}
