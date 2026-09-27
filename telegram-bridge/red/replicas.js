/**
 * FEAT-090 §6.4 — La réplica de lectura del tablero de cada nodo, en el
 * servidor. La última foto conocida: la consola y las almas ven el tablero de
 * un nodo aunque esté desconectado.
 *
 * Solo la escriben los eventos que el nodo ya manda (`tarea`,
 * `tarea_borrada`, `programacion`, `programacion_borrada`) y el rearmado
 * entero al conectarse o con `nodo-resincronizar`. Ninguna acción del servidor
 * la modifica: las acciones van al nodo, y la réplica cambia cuando llega el
 * evento. Persistida en `replicas/<nodo>.json`, como mucho cada 5 s.
 */

import path from 'node:path';
import fs from 'node:fs';
import { leerJson, escribirJson } from './almacen.js';

const GUARDAR_CADA_MS = 5000;
const ID_NODO = /^[0-9a-f-]{36}$/;

export function crearReplicas({ dataDir, guardarCadaMs = GUARDAR_CADA_MS, ahora = () => Date.now() } = {}) {
  const dir = dataDir ? path.join(dataDir, 'replicas') : null;
  const replicas = new Map(); // nodo → { tareas: Map, programaciones: Map, workspaces: [], actualizado }
  const pendientes = new Map();
  const ultimos = new Map();

  const archivo = (nodo) => path.join(dir, `${nodo}.json`);

  function cargar(nodo) {
    if (replicas.has(nodo)) return replicas.get(nodo);
    const vacia = { tareas: new Map(), programaciones: new Map(), workspaces: [], actualizado: null };
    if (dir && ID_NODO.test(nodo)) {
      const d = leerJson(archivo(nodo), null);
      if (d) {
        for (const t of Array.isArray(d.tareas) ? d.tareas : []) if (t?.id) vacia.tareas.set(t.id, t);
        for (const p of Array.isArray(d.programaciones) ? d.programaciones : []) if (p?.id) vacia.programaciones.set(p.id, p);
        vacia.workspaces = Array.isArray(d.workspaces) ? d.workspaces : [];
        vacia.actualizado = d.actualizado || null;
      }
    }
    replicas.set(nodo, vacia);
    return vacia;
  }

  function guardar(nodo) {
    pendientes.delete(nodo);
    ultimos.set(nodo, ahora());
    if (!dir || !ID_NODO.test(nodo)) return;
    const r = replicas.get(nodo);
    if (!r) return;
    try {
      escribirJson(archivo(nodo), { tareas: [...r.tareas.values()], programaciones: [...r.programaciones.values()], workspaces: r.workspaces, actualizado: r.actualizado });
    } catch {}
  }

  function programarGuardado(nodo) {
    if (pendientes.has(nodo)) return;
    const falta = (ultimos.get(nodo) || 0) + guardarCadaMs - ahora();
    if (falta <= 0) return guardar(nodo);
    const t = setTimeout(() => guardar(nodo), falta);
    t.unref?.();
    pendientes.set(nodo, t);
  }

  return {
    /** Un evento del canal del nodo. Lo que no es del tablero se ignora. */
    aplicar(nodo, evento) {
      const r = cargar(nodo);
      if (evento?.tipo === 'tarea' && evento.tarea?.id) r.tareas.set(evento.tarea.id, evento.tarea);
      else if (evento?.tipo === 'tarea_borrada' && evento.id) r.tareas.delete(evento.id);
      else if (evento?.tipo === 'programacion' && evento.programacion?.id) r.programaciones.set(evento.programacion.id, evento.programacion);
      else if (evento?.tipo === 'programacion_borrada' && evento.id) r.programaciones.delete(evento.id);
      else return false;
      r.actualizado = new Date(ahora()).toISOString();
      programarGuardado(nodo);
      return true;
    },

    /** El rearmado entero, con lo que devuelve el nodo. */
    rearmar(nodo, { tareas = [], programaciones = [], workspaces = [] } = {}) {
      const r = cargar(nodo);
      r.tareas = new Map((Array.isArray(tareas) ? tareas : []).filter((t) => t?.id).map((t) => [t.id, t]));
      r.programaciones = new Map((Array.isArray(programaciones) ? programaciones : []).filter((p) => p?.id).map((p) => [p.id, p]));
      r.workspaces = Array.isArray(workspaces) ? workspaces : [];
      r.actualizado = new Date(ahora()).toISOString();
      programarGuardado(nodo);
    },

    /** Foto de un nodo: `{ tareas, programaciones, workspaces, actualizado }`. */
    de(nodo) {
      const r = cargar(nodo);
      return { tareas: [...r.tareas.values()], programaciones: [...r.programaciones.values()], workspaces: r.workspaces, actualizado: r.actualizado };
    },

    /** Los nodos que tienen réplica en memoria o en disco. */
    nodos() {
      const ids = new Set(replicas.keys());
      if (dir) { try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) ids.add(f.slice(0, -5)); } catch {} }
      return [...ids].filter((id) => ID_NODO.test(id));
    },

    guardarYa(nodo) { for (const n of nodo ? [nodo] : [...replicas.keys()]) guardar(n); }
  };
}
