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
 * - `turno.actividad` (F1 S0): efímero, con el último paso de la actividad del
 *   agente. No pasa por el centinela: no es un cambio de estado.
 * - `consolidacion.fin` (F1 S0): un seguidor del diario de cada alma que alguien
 *   escucha, como el de `daemon.log`.
 * - `turno.imagen` (FEAT-210): el turno entero cuando cambian sus imágenes
 *   (`info.cambioImagen`). No pasa por el centinela: llega también con el turno cerrado.
 */
import fs from 'node:fs';

const TIPO_POR_ESTADO = Object.freeze({
  en_curso: 'turno.en_curso', ok: 'turno.fin', cancelada: 'turno.cancelado', error: 'turno.error', interrumpida: 'turno.error'
});
const TERMINALES = new Set(['ok', 'cancelada', 'error', 'interrumpida']);
const TOPE_CENTINELA = 2000;
const MARCA_FOTO = '🖼️ foto';
export const TOPE_LINEA = 4000;
const INTERVALO_LOG_MS = 1000;
const TOPE_LECTURA_LOG = 256 * 1024;
const INTERVALO_DIARIO_MS = 5000;
const TOPE_DIARIO = 50;

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

// FEAT-201 F1 S0 — Los topes del registro (tareas.js: TOPE_ACTIVIDAD, TOPE_TEXTO_ACTIVIDAD).
const TOPE_PASOS = 40;
const TOPE_TEXTO_PASO = 120;
const texto = (v, tope) => (typeof v === 'string' ? v.slice(0, tope) : undefined);
const entero = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);
const sinIndefinidos = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const textoONulo = (v, tope) => (typeof v === 'string' ? v.slice(0, tope) : v === null ? null : undefined);
const enteroPositivo = (v) => (Number.isInteger(v) && v > 0 ? v : undefined);
const textos = (v, tope, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => x.slice(0, tope)) : undefined);

/** Un paso de actividad `{ t, texto }`, o `null` si no tiene forma. */
export function pasoDe(p) {
  if (!p || typeof p !== 'object' || typeof p.texto !== 'string') return null;
  return { t: iso(p.t) || '', texto: p.texto.slice(0, TOPE_TEXTO_PASO) };
}

export function actividadDe(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.slice(-TOPE_PASOS).map(pasoDe).filter(Boolean);
}

const TIPOS_HERRAMIENTA = new Set(['archivo', 'web', 'link']);

/**
 * El pie de memoria de `cierreDeCharla` y `cierreDeCast` (bot.js), solo con los
 * campos y tipos del esquema: lo que no encaja se descarta, no se reenvía.
 */
export function memoriaDe(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const h = m.herramienta && typeof m.herramienta === 'object' && TIPOS_HERRAMIENTA.has(m.herramienta.tipo)
    ? sinIndefinidos({
      tipo: m.herramienta.tipo,
      consulta: texto(m.herramienta.consulta, 300),
      dominio: texto(m.herramienta.dominio, 253),
      n: entero(m.herramienta.n),
      rechazo: texto(m.herramienta.rechazo, 300),
      fuentes: textos(m.herramienta.fuentes, 200, 8)
    })
    : undefined;
  const tb = m.tablero && typeof m.tablero === 'object'
    ? sinIndefinidos({ propuestas: entero(m.tablero.propuestas), notas: entero(m.tablero.notas), rechazos: entero(m.tablero.rechazos) })
    : undefined;
  const salida = sinIndefinidos({
    recordo: entero(m.recordo), corrigio: entero(m.corrigio), olvido: entero(m.olvido), archivo: entero(m.archivo),
    rechazos: entero(m.rechazos), guardadas: entero(m.guardadas), enCuarentena: entero(m.enCuarentena),
    usada: typeof m.usada === 'boolean' ? m.usada : undefined,
    recuperada: typeof m.recuperada === 'boolean' ? m.recuperada : undefined,
    bloqueado: typeof m.bloqueado === 'boolean' ? m.bloqueado : undefined,
    herramienta: h,
    externo: textos(m.externo, 200, 8),
    red: texto(m.red, 32),
    herramientasRed: textos(m.herramientasRed, 200, 8),
    tablero: tb,
    // FEAT-210 — Lo que pidió de imagen, o el motivo por el que no; y si la foto era segura.
    imagen: m.imagen && typeof m.imagen === 'object' && !Array.isArray(m.imagen)
      ? { pedida: typeof m.imagen.pedida === 'string' ? m.imagen.pedida.slice(0, 300) : null, rechazo: MOTIVOS_RECHAZO_IMAGEN.has(m.imagen.rechazo) ? m.imagen.rechazo : null, ...(typeof m.imagen.detalle === 'string' && m.imagen.detalle ? { detalle: m.imagen.detalle.slice(0, 40) } : {}) }
      : undefined,
    fotoSegura: m.fotoSegura === 'marcada' || m.fotoSegura === 'reconocida' ? m.fotoSegura : undefined,
    vision: m.vision === 'propia' || m.vision === 'descripcion' ? m.vision : undefined
  });
  return Object.keys(salida).length ? salida : null;
}

// FEAT-210 — Los motivos de rechazo de una imagen y los estados de una entrada (los de `codigos.js` y `tareas.js`).
const MOTIVOS_RECHAZO_IMAGEN = new Set(['apagadas', 'hilo-externo', 'una-por-turno', 'pasada-descartada', 'aislado']);
const ESTADOS_IMAGEN = new Set(['generando', 'lista', 'error', 'borrada']);
const TOPE_IMAGENES = 4;
const CASOS_IMAGEN = new Set(['nueva', 'variacion', 'retoque', 'edicion']);
const CAMBIOS_IMAGEN = new Set(['leve', 'medio', 'fuerte']);
const lorasDe = (v) => {
  const l = (Array.isArray(v) ? v : []).filter((x) => x && typeof x === 'object' && typeof x.clave === 'string' && x.clave && Number.isFinite(x.fuerza) && x.fuerza >= 0 && x.fuerza <= 2)
    .slice(0, 4).map((x) => ({ clave: x.clave.slice(0, 30), fuerza: x.fuerza }));
  return l.length ? l : undefined;
};

/** FEAT-210 §5 — Las imágenes de un turno, solo con los campos públicos del esquema (nunca rutas). */
export function imagenesDe(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((i) => i && typeof i === 'object' && Number.isInteger(i.n) && i.n >= 1 && ESTADOS_IMAGEN.has(i.estado))
    .slice(0, TOPE_IMAGENES)
    .map((i) => sinIndefinidos({
      n: i.n, estado: i.estado, ancho: enteroPositivo(i.ancho), alto: enteroPositivo(i.alto),
      tipo: textoONulo(i.tipo, 32), proveedor: textoONulo(i.proveedor, 32), modelo: textoONulo(i.modelo, 200),
      prompt: textoONulo(i.prompt, 2000), negativo: textoONulo(i.negativo, 500),
      desdeFoto: typeof i.desdeFoto === 'boolean' ? i.desdeFoto : undefined,
      fotoIgnorada: typeof i.fotoIgnorada === 'boolean' ? i.fotoIgnorada : undefined,
      intento: enteroPositivo(i.intento), codigo: textoONulo(i.codigo, 40), mensaje: textoONulo(i.mensaje, 200),
      creada: i.creada === undefined ? undefined : iso(i.creada), terminada: i.terminada === undefined ? undefined : iso(i.terminada),
      // FEAT-212 — El caso hecho y el pedido, y lo que lo describe. Una que todavía no tiene caso los omite.
      caso: CASOS_IMAGEN.has(i.caso) ? i.caso : undefined, casoPedido: CASOS_IMAGEN.has(i.casoPedido) ? i.casoPedido : undefined,
      zona: textoONulo(i.zona, 120), instruccion: textoONulo(i.instruccion, 2000), perfil: textoONulo(i.perfil, 40),
      loras: lorasDe(i.loras), sinChequeoZona: i.sinChequeoZona === true ? true : undefined,
      // FEAT-213 — Cuánto cambia una variación y la fuerza que llevó.
      cambio: CAMBIOS_IMAGEN.has(i.cambio) ? i.cambio : undefined, fuerza: Number.isFinite(i.fuerza) && i.fuerza >= 0 && i.fuerza <= 1 ? i.fuerza : undefined
    }));
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
  // FEAT-201 F1 S0 — La actividad del agente y el pie de memoria, con la forma exacta del esquema.
  const actividad = actividadDe(tarea.actividad);
  if (actividad.length) turno.actividad = actividad;
  const memoria = memoriaDe(tarea.memoria);
  if (memoria) turno.memoria = memoria;
  // FEAT-210 — Las imágenes del turno (el registro las guarda sin rutas; acá se recortan a la forma del esquema).
  const imagenes = imagenesDe(tarea.imagenes);
  if (imagenes.length) turno.imagenes = imagenes;
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
/**
 * El nivel de una línea de daemon.log, por su contenido. FEAT-201 F3 — La usan el seguidor y `GET /daemon/log`,
 * siempre sobre la línea ya redactada, así los dos caminos clasifican igual.
 */
export const nivelDe = (l) => (/\b(error|fall[oó]|❌)/i.test(l) ? 'error' : /\b(aviso|warn|⚠)/i.test(l) ? 'aviso' : 'info');

export function crearProductoresV2({
  almacen, registro, recorte, alParcial = null, estadoDeCarriles = () => [], logFile = null,
  extras = null, leer = fs, intervaloLogMs = INTERVALO_LOG_MS,
  diario = null, almas = null, intervaloDiarioMs = INTERVALO_DIARIO_MS,
  // FEAT-201 F3 — La línea se redacta entera antes de cortarla: un valor que cruza el corte no sale a medias.
  redactar = (t) => t
}) {
  const terminados = new Set();
  const marcarTerminado = (id) => {
    terminados.add(id);
    if (terminados.size > TOPE_CENTINELA) terminados.delete(terminados.values().next().value);
  };
  const bajas = [];

  bajas.push(registro.suscribir((tarea, info = {}) => {
    // F1 S0 — La actividad va como evento efímero con el último paso: no cambia el estado ni el centinela.
    if (info.actividad && !info.alta && !info.cambioEstado) {
      const sujeto = sujetoDe(tarea);
      const paso = Array.isArray(tarea?.actividad) ? pasoDe(tarea.actividad.at(-1)) : null;
      if (sujeto && paso) almacen.publicar(`sujeto:${sujeto.id}`, 'turno.actividad', { tareaId: String(tarea.id), paso }, { efimero: true });
      return;
    }
    // FEAT-210 — Un cambio de imágenes publica el turno entero, también con el turno ya cerrado (sin centinela).
    if (info.cambioImagen) {
      const s = sujetoDe(tarea);
      if (s) almacen.publicar(`sujeto:${s.id}`, 'turno.imagen', turnoDe(tarea, { recorte, extras }));
    }
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
        const r = String(redactar(l));
        almacen.publicar('log', 'log.linea', { texto: r.slice(0, TOPE_LINEA), nivel: nivelDe(r) });
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

  // F1 S0 — `consolidacion.fin`. La consolidación corre en un proceso aparte (bot.js `lanzarConsolidacion` y el MCP
  // al cerrar una charla de voz): lo único que queda es su entrada `tipo: 'consolidacion'` en el diario del alma. Este
  // seguidor lee el diario de las almas que alguien escucha, y arranca desde el final para no publicar lo viejo.
  const vistos = new Map(); // clave → { ts, firmas } de la última entrada vista
  const firma = (e) => JSON.stringify([e.ts, e.resumen ?? null, e.motivo ?? null, e.stream_id ?? null]);
  let relojDiario = null;
  const escuchadas = () => (diario && typeof almas === 'function'
    ? almas().map((a) => String(a.clave)).filter((c) => almacen.hayInteres(`sujeto:${c}`))
    : []);
  const marcarVisto = (clave, entradas) => {
    const ts = entradas.reduce((m, e) => (typeof e.ts === 'string' && e.ts > m ? e.ts : m), '');
    vistos.set(clave, { ts, firmas: new Set(entradas.filter((e) => e.ts === ts).map(firma)) });
  };
  const leerDiarios = () => {
    for (const clave of escuchadas()) {
      let entradas;
      try { entradas = diario.ultimas(clave, TOPE_DIARIO).filter((e) => e && typeof e.ts === 'string'); } catch { continue; }
      const visto = vistos.get(clave);
      if (!visto) { marcarVisto(clave, entradas); continue; }
      const nuevas = entradas.filter((e) => e.ts > visto.ts || (e.ts === visto.ts && !visto.firmas.has(firma(e))));
      if (!nuevas.length) continue;
      for (const e of nuevas) {
        if (e.tipo !== 'consolidacion') continue;
        const datos = { sujeto: clave, ok: !e.motivo };
        if (e.motivo) datos.motivo = String(e.motivo).slice(0, 300);
        almacen.publicar(`sujeto:${clave}`, 'consolidacion.fin', datos);
      }
      marcarVisto(clave, [...entradas.filter((e) => e.ts === visto.ts && visto.firmas.has(firma(e))), ...nuevas]);
    }
  };
  const ajustarDiario = () => {
    const hay = escuchadas();
    // Un alma que deja de escucharse se olvida: al volver arranca otra vez desde el final.
    for (const c of [...vistos.keys()]) if (!hay.includes(c)) vistos.delete(c);
    if (hay.length && !relojDiario) {
      leerDiarios(); // marca el final de cada diario sin publicar
      relojDiario = setInterval(leerDiarios, intervaloDiarioMs);
      relojDiario.unref?.();
    } else if (hay.length) {
      leerDiarios();
    } else if (relojDiario) {
      clearInterval(relojDiario);
      relojDiario = null;
    }
  };
  if (diario) bajas.push(almacen.alCambiarSuscriptores(ajustarDiario));

  return {
    leerDiariosAhora: () => { if (relojDiario) leerDiarios(); },
    // Solo mientras alguien escucha `log`: sin seguidor activo no hay desde dónde leer.
    leerLogAhora: () => { if (reloj) leerNuevo(); },
    cerrar() {
      for (const b of bajas) try { b(); } catch {}
      if (reloj) clearInterval(reloj);
      reloj = null;
      if (relojDiario) clearInterval(relojDiario);
      relojDiario = null;
    }
  };
}
