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

const VERSION = 1;

const ESTADOS = ['corriendo', 'para revisar', 'fallido', 'interrumpido', 'descartado'];

// Desde dónde se puede pasar a cada estado. Un lote descartado es final: nada
// lo reabre.
const TRANSICIONES = {
  'para revisar': ['corriendo'],
  'fallido': ['corriendo'],
  'interrumpido': ['corriendo'],
  'descartado': ['para revisar', 'fallido', 'interrumpido']
};

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
    return datos || null;
  }

  function guardar(lote) {
    const destino = ruta(lote.id);
    const { ilegible } = leerJson(destino);
    guardarJson(destino, lote, { ilegible });
    return lote;
  }

  function crear({ id, repo, ramaBase, modelo, tareas, pid = process.pid }) {
    const previo = leer(id);
    if (previo) {
      // Un lote descartado ya no tiene worktrees ni ramas: su nombre vuelve a
      // estar libre. Su archivo NO se borra —nada se expulsa—, se aparta con la
      // fecha, para que el historial siga en disco.
      if (previo.estado !== 'descartado') throw new Error(`ya existe un lote con id ${id}`);
      const marca = String(previo.creado || new Date().toISOString()).replace(/[:.]/g, '-');
      try {
        fs.mkdirSync(carpeta, { recursive: true });
        fs.renameSync(ruta(id), path.join(carpeta, `${id}-descartado-${marca}.json`));
      } catch (err) {
        throw new Error(`no se pudo apartar el lote descartado ${id}: ${err.message}`);
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
      tareas: (tareas || []).map(t => ({
        id: t.id,
        rama: t.rama || null,
        worktree: t.worktree || null,
        estado: 'corriendo',
        commit: null,
        anomalias: [],
        error: null,
        conversation_id: null
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

  function listar() {
    let archivos = [];
    try {
      archivos = fs.readdirSync(carpeta).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
    return archivos
      .map(f => leer(path.basename(f, '.json')))
      .filter(Boolean)
      .sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
  }

  /**
   * Un lote en `corriendo` cuyo proceso dueño ya no existe quedó huérfano: el
   * MCP murió (o lo mataron) a mitad. Se marca `interrumpido` para que el
   * recolector pueda limpiar sus contenedores sin tocar los de un lote vivo.
   */
  function marcarInterrumpidos() {
    const marcados = [];
    for (const lote of listar()) {
      if (lote.estado !== 'corriendo') continue;
      if (pidVivo(lote.pid)) continue;
      for (const t of lote.tareas) {
        if (t.estado === 'corriendo') t.estado = 'interrumpida';
      }
      lote.estado = 'interrumpido';
      lote.actualizado = new Date().toISOString();
      lote.historial.push({ estado: 'interrumpido', cuando: lote.actualizado, motivo: 'el proceso dueño ya no existe' });
      guardar(lote);
      marcados.push(lote.id);
    }
    return marcados;
  }

  return { carpeta, ruta, crear, leer, listar, guardar, actualizarTarea, cambiarEstado, marcarInterrumpidos };
}

module.exports = { VERSION, ESTADOS, TRANSICIONES, crearRegistro };
