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

export const TOPE_TEXTO = 4096;
// La web no lanza trabajo en el carril principal, así que tampoco lo cancela:
// un /run de Telegram no se corta desde el navegador.
export const CARRILES_WEB = Object.freeze(['cast', 'alma']);

const error = (codigo, mensaje) => ({ codigo, ok: false, error: mensaje });
export const LIMITE_LECTURA_FANOUT_MS = 500;
export const TTL_WORKSPACES_FANOUT_MS = 60 * 1000;
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
 * @param {object} deps.almas            { recuerdos, rutas, hilos } de mcp-server/almas
 * @param {Function} deps.workspaces     getKnownWorkspaces
 * @param {Function} deps.ultimoWorkspace getUltimoWorkspaceCast
 * @param {Function} deps.logs           (n) => { aviso } | { encabezado, contenido }
 * @param {Function} deps.sesiones       () => objeto serializable
 * @param {object} [deps.fanout]         FEAT-055: { leerLotes(ruta, opciones) → Promise, limiteMs, ttlWorkspacesMs, ahora };
 *                                       FEAT-057: detener(ruta, lote, tarea)
 * @param {object} [deps.programaciones] FEAT-066: el registro (telegram-bridge/programaciones.js)
 * @param {Function} [deps.modeloEfectivo] FEAT-066: () => { model, effortPorDefecto }, el que se congela
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
  proveedores = null
}) {
  const ctx = crearCtxWeb(canal, chatId);

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
  const sinRegistro = () => error(503, 'El registro de programaciones no está disponible.');
  const conCodigo = (r) => (r.ok ? r : error(r.codigo, r.error));

  const vistaRecuerdos = (modelo, tope) => ({
    usado: almas.recuerdos.usado(modelo),
    tope,
    entradas: almas.recuerdos.entradas(modelo).map((e) => ({ id: e.id || null, texto: e.texto }))
  });

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
        usuario: vistaRecuerdos(usuario, almas.recuerdos.TOPE_USUARIO)
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
    }
  };
}
