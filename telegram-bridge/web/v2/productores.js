/**
 * FEAT-201 F0 S3 — Los productores de eventos v2.
 *
 * - `turno.*`: un suscriptor del registro de tareas. Publica solo en el alta
 *   (`info.alta`) o en un cambio de estado (`info.cambioEstado`), nunca por la
 *   actividad del agente. Un centinela por `tareaId` deja pasar un solo evento
 *   terminal.
 * - `turno.texto`: el observador de parciales de la cola (efímero).
 * - `carriles`: una foto de las colas en cada alta o cambio de estado.
 * - `log.linea`: un seguidor de `daemon.log`, que solo corre mientras alguien
 *   escucha el tema `log`. El archivo lo escribe la redirección de la salida del
 *   daemon, no un escritor de JS; si se achica (rotación), vuelve al principio.
 */
import fs from 'node:fs';

const TIPO_POR_ESTADO = Object.freeze({
  en_curso: 'turno.en_curso', ok: 'turno.fin', cancelada: 'turno.cancelado', error: 'turno.error', interrumpida: 'turno.error'
});
const TERMINALES = new Set(['ok', 'cancelada', 'error', 'interrumpida']);
const TOPE_CENTINELA = 2000;
const MARCA_FOTO = '🖼️ foto';
const TOPE_LINEA = 4000;
const INTERVALO_LOG_MS = 1000;
const TOPE_LECTURA_LOG = 256 * 1024;

const iso = (v) => (v === null || v === undefined ? null : typeof v === 'number' ? new Date(v).toISOString() : String(v));

/** Quita el sufijo de recorte del registro y dice si lo tenía. */
export function sinRecorte(texto, recorte) {
  if (typeof texto !== 'string') return { texto: texto ?? null, truncado: false };
  return texto.endsWith(recorte) ? { texto: texto.slice(0, -recorte.length), truncado: true } : { texto, truncado: false };
}

/** El sujeto v2 de una tarea del registro, o `null` si no es de un alma ni de un agente. */
export function sujetoDe(tarea) {
  const s = tarea?.sujeto;
  if (s?.tipo === 'alma' && s.clave) return { tipo: 'alma', id: String(s.clave) };
  if (s?.tipo === 'agente' && s.nombre) return { tipo: 'agente', id: String(s.nombre) };
  return null;
}

/** Una tarea del registro con la forma del agregado `turno`. `extras`: lo que solo sabe v2 (tid, idCliente…). */
export function turnoDe(tarea, { recorte, extras = null } = {}) {
  const sujeto = sujetoDe(tarea);
  const pedido = sinRecorte(String(tarea.pedido || ''), recorte).texto;
  const resultado = sinRecorte(tarea.resultado ?? null, recorte);
  const error = sinRecorte(tarea.error ?? null, recorte).texto;
  const turno = {
    tareaId: String(tarea.id),
    estado: tarea.estado,
    origen: ['telegram', 'web', 'terminal'].includes(tarea.origen) ? tarea.origen : 'telegram',
    sujeto,
    pedido,
    resultado: resultado.texto,
    resultadoTruncado: resultado.truncado,
    error: error === null ? null : String(error).slice(0, 2000),
    // El registro no guarda la imagen: la marca es la que pone datosDeTarea (bot.js) a una foto.
    adjunto: pedido.startsWith(MARCA_FOTO),
    creada: iso(tarea.creada),
    iniciada: iso(tarea.iniciada),
    terminada: iso(tarea.terminada)
  };
  const e = extras ? extras(turno.tareaId) : null;
  if (e?.tid) turno.tid = e.tid;
  if (e?.idCliente) turno.idCliente = e.idCliente;
  if (e?.reintentoDe) turno.reintentoDe = e.reintentoDe;
  return turno;
}

export function carrilesDe(estado) {
  return (estado || []).map((c) => ({
    carril: String(c.carril),
    enCurso: c.enCurso
      ? {
        tareaId: c.enCurso.tareaId || null,
        sujeto: c.enCurso.voz || c.enCurso.agent || c.enCurso.mode || null,
        desde: iso(c.enCurso.desde),
        extracto: String(c.enCurso.extracto || '').slice(0, 200)
      }
      : null,
    enCola: Array.isArray(c.pendientes) ? c.pendientes.length : 0
  }));
}

/**
 * `registro`: `{ suscribir, obtener }` de `tareas.js`. `alParcial`: el registro de
 * observadores de parciales de `bot.js`. `estadoDeCarriles`: el de `bot.js`.
 */
export function crearProductoresV2({
  almacen, registro, recorte, alParcial = null, estadoDeCarriles = () => [], logFile = null,
  extras = null, leer = fs, intervaloLogMs = INTERVALO_LOG_MS
}) {
  const terminados = new Set();
  const marcarTerminado = (id) => {
    terminados.add(id);
    if (terminados.size > TOPE_CENTINELA) terminados.delete(terminados.values().next().value);
  };
  const bajas = [];

  bajas.push(registro.suscribir((tarea, info = {}) => {
    if (!info.alta && !info.cambioEstado) return;
    const sujeto = sujetoDe(tarea);
    if (sujeto) {
      const tipo = info.alta ? 'turno.inicio' : TIPO_POR_ESTADO[tarea.estado];
      const id = String(tarea.id);
      const terminal = !info.alta && TERMINALES.has(tarea.estado);
      if (tipo && !(terminal && terminados.has(id))) {
        if (terminal) marcarTerminado(id);
        almacen.publicar(`sujeto:${sujeto.id}`, tipo, turnoDe(tarea, { recorte, extras }));
      }
    }
    almacen.publicar('carriles', 'carriles', { carriles: carrilesDe(estadoDeCarriles()) });
  }));

  if (typeof alParcial === 'function') {
    bajas.push(alParcial((tareaId, texto) => {
      const sujeto = sujetoDe(registro.obtener(tareaId));
      if (!sujeto) return;
      const datos = { tareaId: String(tareaId), texto: String(texto ?? '').slice(-16384) };
      const e = extras ? extras(datos.tareaId) : null;
      if (e?.tid) datos.tid = e.tid;
      almacen.publicar(`sujeto:${sujeto.id}`, 'turno.texto', datos, { efimero: true });
    }));
  }

  // daemon.log: solo mientras alguien escucha `log`.
  let reloj = null;
  let posicion = 0;
  let resto = '';
  const nivelDe = (l) => (/\b(error|fall[oó]|❌)/i.test(l) ? 'error' : /\b(aviso|warn|⚠)/i.test(l) ? 'aviso' : 'info');
  const leerNuevo = () => {
    let tam;
    try { tam = leer.statSync(logFile).size; } catch { return; }
    if (tam < posicion) { posicion = 0; resto = ''; }
    if (tam === posicion) return;
    const desde = Math.max(posicion, tam - TOPE_LECTURA_LOG);
    const largo = tam - desde;
    let fd;
    try {
      fd = leer.openSync(logFile, 'r');
      const buf = Buffer.alloc(largo);
      leer.readSync(fd, buf, 0, largo, desde);
      posicion = tam;
      const lineas = (resto + buf.toString('utf8')).split(/\r?\n/);
      resto = lineas.pop() || '';
      for (const l of lineas) {
        if (!l.trim()) continue;
        almacen.publicar('log', 'log.linea', { texto: l.slice(0, TOPE_LINEA), nivel: nivelDe(l) });
      }
    } catch {} finally {
      if (fd !== undefined) try { leer.closeSync(fd); } catch {}
    }
  };
  const ajustarLog = () => {
    if (!logFile) return;
    const quiere = almacen.hayInteres('log');
    if (quiere && !reloj) {
      // Arranca desde el final: lo anterior se pide por REST (GET /logs).
      try { posicion = leer.statSync(logFile).size; } catch { posicion = 0; }
      resto = '';
      reloj = setInterval(leerNuevo, intervaloLogMs);
      reloj.unref?.();
    } else if (!quiere && reloj) {
      clearInterval(reloj);
      reloj = null;
    }
  };
  bajas.push(almacen.alCambiarSuscriptores(ajustarLog));

  return {
    // Solo mientras alguien escucha `log`: sin seguidor activo no hay desde dónde leer.
    leerLogAhora: () => { if (reloj) leerNuevo(); },
    cerrar() {
      for (const b of bajas) try { b(); } catch {}
      if (reloj) clearInterval(reloj);
      reloj = null;
    }
  };
}
