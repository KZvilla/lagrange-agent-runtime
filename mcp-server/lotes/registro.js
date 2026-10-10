/**
 * Registro de lotes (FEAT-061 fase 2, §4.5 del plan).
 *
 * UN ARCHIVO POR LOTE, Y NADA SE EXPULSA
 * --------------------------------------
 * El RFC pedía un `lotes.json` al estilo de `programaciones.json`. Acá es un
 * archivo por lote, por dos razones concretas:
 *  - en la fase 2 escribe el proceso MCP, y puede haber dos sesiones de Claude
 *    Code abiertas; en la fase 4 escribirá además el daemon. Un archivo por lote
 *    no tiene dos escritores sobre el mismo archivo, así que no hace falta lock;
 *  - el sistema ya demostró que olvida activamente (el tablero expulsa tarjetas
 *    cerradas, el diario se trunca). Un lote es trabajo real sin integrar: si se
 *    evapora, el usuario pierde ramas sin saber que existieron. Sale solo por
 *    `descartado`, que es un acto humano.
 */
const path = require('node:path');
const fs = require('node:fs');
const { leerJson, guardarJson } = require('../agents/almacen.js');

const VERSION = 2;

const ESTADOS_ACTIVOS = ['corriendo', 'verificando', 'auditando'];
// F4b — `esperando humano`: una tarea espera una respuesta. No es activo (no tiene proceso dueño, así que
// `marcarInterrumpidos` no lo toca y sobrevive a un reinicio) ni final (se reanuda o se descarta).
const ESPERANDO_HUMANO = 'esperando humano';
const ESTADOS = [...ESTADOS_ACTIVOS, ESPERANDO_HUMANO, 'para revisar', 'fallido', 'interrumpido', 'descartado', 'integrado'];
// Los que liberan el id: el lote ya no tiene worktrees ni ramas.
const ESTADOS_FINALES = ['descartado', 'integrado'];

// Desde dónde se puede pasar a cada estado. Un lote descartado o integrado es
// final: nada lo reabre. FEAT-108: solo se integra lo que está para revisar.
const TRANSICIONES = {
  // FEAT-149 F2 — Las vueltas del bucle: de la revisión se vuelve a escribir, y después de una vuelta
  // sin cambios se puede auditar o cerrar desde «corriendo». F4a — Un grafo puede volver del juez a
  // Verificar y cerrar después de Verificar: se suman esos orígenes, sin quitar ninguno.
  // F4b — Se reanuda desde `esperando humano` y se llega a él desde cualquier activo.
  'corriendo': ['verificando', 'auditando', ESPERANDO_HUMANO],
  'verificando': ['corriendo', 'auditando', ESPERANDO_HUMANO],
  'auditando': ['verificando', 'corriendo', ESPERANDO_HUMANO],
  [ESPERANDO_HUMANO]: [...ESTADOS_ACTIVOS],
  'para revisar': ['auditando', 'corriendo', 'verificando', ESPERANDO_HUMANO],
  'fallido': [...ESTADOS_ACTIVOS],
  'interrumpido': [...ESTADOS_ACTIVOS],
  'descartado': ['para revisar', 'fallido', 'interrumpido', ESPERANDO_HUMANO],
  'integrado': ['para revisar']
};

function pruebaInicial() {
  return { estado: 'pendiente', argv: null, exitCode: null, duracionMs: null, salida: '', salidaTruncada: false };
}

function auditoriaInicial() {
  return { estado: 'pendiente', veredicto: null, modelo: null, conversation_id: null, reporte: '', error: null, duracionMs: null };
}

function normalizar(lote) {
  if (!lote || typeof lote !== 'object') return lote;
  return {
    ...lote,
    tareas: (lote.tareas || []).map(t => ({
      modelo: null,
      // FEAT-011: los lotes guardados antes no la tienen.
      skill: null,
      sinCambios: false,
      prueba: pruebaInicial(),
      auditoria: auditoriaInicial(),
      ...t
    }))
  };
}

function vivo(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = existe pero es de otro usuario.
    return err.code === 'EPERM';
  }
}

/**
 * @param {object} opciones
 * @param {string} opciones.dir  Directorio de estado del bridge; los tests le pasan uno temporal.
 */
function crearRegistro({ dir, pidVivo = vivo }) {
  const carpeta = path.join(dir, 'lotes');

  function ruta(id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(id || ''))) {
      throw new Error(`id de lote inválido: ${JSON.stringify(id)}`);
    }
    return path.join(carpeta, `${id}.json`);
  }

  function leer(id) {
    const { datos } = leerJson(ruta(id));
    return datos ? normalizar(datos) : null;
  }

  function guardar(lote) {
    const destino = ruta(lote.id);
    const { ilegible } = leerJson(destino);
    lote.version = VERSION;
    guardarJson(destino, lote, { ilegible });
    return lote;
  }

  function crear({ id, repo, ramaBase, modelo, motor = null, receta = null, pedido = null, tareas, pid = process.pid }) {
    const previo = leer(id);
    if (previo) {
      // Un lote descartado o integrado ya no tiene worktrees ni ramas: su
      // nombre vuelve a estar libre. Su archivo NO se borra —nada se expulsa—,
      // se aparta con el estado y la fecha, para que el historial siga en disco.
      if (!ESTADOS_FINALES.includes(previo.estado)) throw new Error(`ya existe un lote con id ${id}`);
      const marca = String(previo.creado || new Date().toISOString()).replace(/[:.]/g, '-');
      try {
        fs.mkdirSync(carpeta, { recursive: true });
        fs.renameSync(ruta(id), path.join(carpeta, `${id}-${previo.estado}-${marca}.json`));
      } catch (err) {
        throw new Error(`no se pudo apartar el lote ${previo.estado} ${id}: ${err.message}`);
      }
    }
    return guardar({
      version: VERSION,
      id,
      estado: 'corriendo',
      pid,
      creado: new Date().toISOString(),
      actualizado: new Date().toISOString(),
      repo,
      ramaBase,
      modelo: modelo || null,
      // FEAT-131 — `claude@<cuenta>` si las tareas corrieron con Claude; sin él, agy.
      ...(motor ? { motor } : {}),
      // FEAT-149 — La receta efectiva (receta + cambios del lote), congelada: el visor dibuja desde acá.
      ...(receta ? { receta } : {}),
      // F4b — Lo necesario para reanudar el lote en otro proceso (sin cuerpos de skill ni credenciales).
      ...(pedido ? { pedido } : {}),
      tareas: (tareas || []).map(t => ({
        id: t.id,
        rama: t.rama || null,
        worktree: t.worktree || null,
        estado: 'corriendo',
        commit: null,
        anomalias: [],
        error: null,
        conversation_id: null,
        modelo: t.modelo || null,
        // FEAT-011: solo el nombre; el cuerpo de la SKILL nunca se persiste.
        skill: t.skill || null,
        sinCambios: false,
        prueba: pruebaInicial(),
        auditoria: auditoriaInicial()
      })),
      historial: [{ estado: 'corriendo', cuando: new Date().toISOString() }]
    });
  }

  function actualizarTarea(id, tareaId, cambios) {
    const lote = leer(id);
    if (!lote) throw new Error(`no hay lote ${id}`);
    const tarea = lote.tareas.find(t => t.id === tareaId);
    if (!tarea) throw new Error(`el lote ${id} no tiene la tarea ${tareaId}`);
    Object.assign(tarea, cambios);
    lote.actualizado = new Date().toISOString();
    return guardar(lote);
  }

  function cambiarEstado(id, estado) {
    if (!ESTADOS.includes(estado)) throw new Error(`estado desconocido: ${estado}`);
    const lote = leer(id);
    if (!lote) throw new Error(`no hay lote ${id}`);
    if (lote.estado === estado) return lote;
    const desde = TRANSICIONES[estado] || [];
    if (!desde.includes(lote.estado)) {
      throw new Error(`transición inválida: ${lote.estado} → ${estado}`);
    }
    lote.estado = estado;
    lote.actualizado = new Date().toISOString();
    lote.historial.push({ estado, cuando: lote.actualizado });
    return guardar(lote);
  }

  /**
   * F4b — Retoma un lote que esperaba a un humano: este proceso pasa a ser su dueño (`pid`, que vigila
   * `marcarInterrumpidos`) y el lote vuelve a `corriendo`. Lo llama `reanudar` con el lock del repo tomado.
   */
  function retomar(id, pid = process.pid) {
    const lote = leer(id);
    if (!lote) throw new Error(`no hay lote ${id}`);
    if (lote.estado !== ESPERANDO_HUMANO) throw new Error(`el lote ${id} está "${lote.estado}", no esperando a un humano`);
    lote.pid = pid;
    lote.estado = 'corriendo';
    lote.actualizado = new Date().toISOString();
    lote.historial.push({ estado: 'corriendo', cuando: lote.actualizado, motivo: 'reanudado' });
    return guardar(lote);
  }

  /**
   * F4b — Las respuestas humanas van en un archivo por tarea, fuera del archivo del lote: las escribe la
   * consola (el daemon) mientras el caminante, quizás en otro proceso, reescribe el lote. Con un solo
   * escritor por archivo, una respuesta no se pierde por una escritura que la pise. El caminante la
   * consume (la pasa a la tarea) y la borra.
   */
  const dirRespuestas = (id) => path.join(carpeta, 'respuestas', path.basename(ruta(id), '.json'));
  function guardarRespuesta(id, tareaId, respuesta) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(tareaId || ''))) throw new Error('id de tarea inválido');
    const dir = dirRespuestas(id);
    fs.mkdirSync(dir, { recursive: true });
    guardarJson(path.join(dir, `${tareaId}.json`), { ...respuesta, tarea: tareaId });
  }
  function leerRespuestas(id) {
    let archivos = [];
    try { archivos = fs.readdirSync(dirRespuestas(id)).filter((f) => f.endsWith('.json')); } catch { return {}; }
    const salida = {};
    for (const f of archivos) {
      const { datos } = leerJson(path.join(dirRespuestas(id), f));
      if (datos && datos.tarea === path.basename(f, '.json')) salida[datos.tarea] = datos;
    }
    return salida;
  }
  function borrarRespuesta(id, tareaId) {
    try { fs.rmSync(path.join(dirRespuestas(id), `${tareaId}.json`), { force: true }); } catch {}
    try { fs.rmdirSync(dirRespuestas(id)); } catch {}
  }

  function listarConEstado() {
    let archivos = [];
    try {
      archivos = fs.readdirSync(carpeta).filter(f => f.endsWith('.json'));
    } catch {
      return { lotes: [], ilegibles: 0 };
    }
    const lotes = [];
    let ilegibles = 0;
    for (const archivo of archivos) {
      const resultado = leerJson(path.join(carpeta, archivo));
      if (resultado.ilegible) ilegibles++;
      if (resultado.datos) lotes.push(normalizar(resultado.datos));
    }
    lotes.sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
    return { lotes, ilegibles };
  }

  function listar() { return listarConEstado().lotes; }

  /**
   * Un lote en `corriendo` cuyo proceso dueño ya no existe quedó huérfano: el
   * MCP murió (o lo mataron) a mitad. Se marca `interrumpido` para que el
   * recolector pueda limpiar sus contenedores sin tocar los de un lote vivo.
   */
  function marcarInterrumpidos() {
    const marcados = [];
    for (const lote of listar()) {
      if (!ESTADOS_ACTIVOS.includes(lote.estado)) continue;
      if (pidVivo(lote.pid)) continue;
      for (const t of lote.tareas) {
        if (ESTADOS_ACTIVOS.includes(t.estado)) t.estado = 'interrumpida';
      }
      lote.estado = 'interrumpido';
      lote.actualizado = new Date().toISOString();
      lote.historial.push({ estado: 'interrumpido', cuando: lote.actualizado, motivo: 'el proceso dueño ya no existe' });
      guardar(lote);
      marcados.push(lote.id);
    }
    return marcados;
  }

  return { carpeta, ruta, crear, leer, listar, listarConEstado, guardar, actualizarTarea, cambiarEstado, marcarInterrumpidos,
    retomar, guardarRespuesta, leerRespuestas, borrarRespuesta };
}

module.exports = { VERSION, ESTADOS, ESTADOS_ACTIVOS, ESPERANDO_HUMANO, ESTADOS_FINALES, TRANSICIONES, crearRegistro };
