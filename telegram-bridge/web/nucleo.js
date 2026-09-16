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
export function crearNucleoWeb({ canal, chatId = CHAT_WEB_LOCAL, bot, almas, workspaces, ultimoWorkspace, logs, sesiones }) {
  const ctx = crearCtxWeb(canal, chatId);

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
      await bot.dispatchCast(ctx, { agent: agente, prompt: t, cwd: ws.path, workspaceName: ws.displayName || ws.name });
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
    }
  };
}
