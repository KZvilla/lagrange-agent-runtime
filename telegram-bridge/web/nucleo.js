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
const ID_TAREA = /^t_[a-z0-9]{1,40}$/;

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
 */
export function crearNucleoWeb({
  canal, chatId = CHAT_WEB_LOCAL, bot, almas, workspaces, ultimoWorkspace, logs, sesiones,
  // FEAT-053
  tareas, estadoDaemon, estadoAgente, nombreAgenteValido
}) {
  const ctx = crearCtxWeb(canal, chatId);

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

    olvidar(clave, id) {
      const a = alma(clave);
      if (!a) return error(404, 'No existe esa alma.');
      const r = bot.olvidarRecuerdo(a.clave, id);
      if (!r.ok) return error(r.motivo === 'id' ? 400 : r.motivo === 'inexistente' ? 404 : 500, r.mensaje);
      return { ok: true, olvidado: r.olvidado };
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

    tareas(sujeto) {
      // FEAT-054 — Sin sujeto: todas, en resumen (el tablero).
      if (sujeto === null || sujeto === undefined) {
        return { ok: true, tareas: tareas.listar().map((t) => tareas.resumen(t)) };
      }
      const clave = sujetoValido(sujeto);
      if (!clave) return error(400, 'Sujeto inválido: se espera alma:<clave> o agente:<nombre>.');
      return { ok: true, sujeto: clave, tareas: tareas.listar({ sujeto: clave }) };
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
