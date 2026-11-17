'use strict';

// FEAT-197 — La interfaz pública de las tools va en inglés y sin el proveedor en el nombre. Por dentro, las
// definiciones y los handlers conservan sus nombres de siempre (agy_lote, accion, tareas…): esta tabla es el único
// lugar donde se traduce, en las dos direcciones, para que el esquema publicado y la traducción de argumentos no
// puedan divergir.
//
// Formato de un parámetro:
//   'nuevo'                         → solo cambia el nombre
//   { a, enum, items, props }       → nombre nuevo (a; si falta, el mismo), valores (viejo → nuevo), objetos de un
//                                     array (items) u objeto anidado (props), con el mismo formato
//   { quitar: true }                → alias viejo: no se publica y una llamada que lo use se rechaza

const PEDIDO = { pedido: 'request_id', esperar_segundos: 'wait_seconds' };
const TAREA_FANOUT = { archivos: 'files', modelo: 'model', soloLectura: 'read_only' };

const TOOLS = Object.freeze({
  agy_run: { nuevo: 'run' },
  agy_image: { nuevo: 'image' },
  agy_fanout: {
    nuevo: 'fanout',
    params: {
      aprobacion: 'approval',
      tareas: { a: 'tasks', items: TAREA_FANOUT },
      concurrencia: 'concurrency',
      modelo: 'model'
    }
  },
  agy_lote: {
    nuevo: 'batch',
    params: {
      accion: { a: 'action', enum: { lanzar: 'launch', estado: 'status' } },
      aprobacion: 'approval',
      tareas: { a: 'tasks', items: { archivos: 'files', modelo: 'model', prueba: 'test' } },
      concurrencia: 'concurrency',
      modelo: 'model',
      motor: 'engine',
      modelo_auditor: 'auditor_model',
      receta: 'recipe'
    }
  },
  agy_plan: { nuevo: 'plan', params: PEDIDO },
  agy_review: { nuevo: 'review', params: PEDIDO },
  agy_audit: { nuevo: 'audit', params: PEDIDO },
  agy_research: { nuevo: 'research' },
  agy_usage: { nuevo: 'usage' },
  agy_status: { nuevo: 'status' },
  agy_session_summary: { nuevo: 'session_summary' },
  agy_voice_stream: {
    nuevo: 'voice_stream',
    params: { confirmacion: 'confirmation', alma: { quitar: true } }
  },
  auditoria: {
    nuevo: 'audit_queue',
    params: {
      accion: {
        a: 'action',
        enum: { pedir: 'request', listar: 'list', tomar: 'take', soltar: 'release', anular: 'cancel', entregar: 'submit', recoger: 'collect' }
      },
      pedido: { quitar: true },
      que: { a: 'which', enum: { para_auditar: 'to_audit', mios: 'mine' } },
      forzar: 'force',
      informe: 'report',
      nombre: 'label',
      esperar_segundos: 'wait_seconds'
    }
  },
  consola: {
    nuevo: 'console',
    params: {
      accion: {
        a: 'action',
        enum: {
          estado: 'status', rutas: 'routes', abrir: 'open', pasos: 'steps', terminar: 'finish', llamar: 'call',
          esperar: 'wait', responder: 'reply', preguntar: 'ask'
        }
      },
      texto: 'text',
      nota: 'note',
      titulo: 'title',
      pasos: {
        a: 'steps',
        items: {
          texto: 'text',
          estado: { a: 'status', enum: { pendiente: 'pending', en_curso: 'in_progress', hecho: 'done', fallo: 'failed' } },
          enlaces: { a: 'links', items: { tipo: { a: 'type', enum: { tarjeta: 'card', lote: 'batch' } } } }
        }
      },
      metodo: 'method',
      ruta: 'route',
      cuerpo: 'body',
      tipo: { a: 'type', enum: { tarea: 'task', lote: 'batch', aprobacion: 'approval', nota: 'note' } },
      estados: 'states',
      segundos: 'seconds'
    }
  },
  mensaje: {
    nuevo: 'message',
    params: {
      accion: {
        a: 'action',
        enum: { agentes: 'agents', enviar: 'send', leer: 'read', responder: 'reply', nombre: 'rename', silenciar: 'mute' }
      },
      para: 'to',
      texto: 'text',
      esperar: 'wait',
      todos: 'all',
      nombre: 'name',
      si: 'muted'
    }
  },
  conocimiento: {
    nuevo: 'knowledge',
    params: {
      accion: { a: 'action', enum: { buscar: 'search', leer: 'read', anotar: 'note', verificar: 'verify' } },
      tipo: { a: 'type', enum: { Decision: 'decision', Hallazgo: 'finding', Trampa: 'pitfall', Pendiente: 'todo' } },
      limite: 'limit',
      ruta: 'path',
      titulo: 'title',
      cuerpo: 'body',
      descripcion: 'description',
      revisar: 'revise',
      dias: 'days',
      proyecto: 'project'
    }
  },
  recall: { nuevo: 'recall', params: { desde: 'from', archivos: 'files' } },
  narrate: { nuevo: 'narrate', params: { modo: { a: 'delivery', enum: { inmediato: 'immediate', diferido: 'deferred' } }, motor: { quitar: true } } },
  say: { nuevo: 'say', params: { modo: { a: 'delivery', enum: { inmediato: 'immediate', diferido: 'deferred' } }, motor: { quitar: true } } },
  telegram_send_voice: {
    nuevo: 'telegram_send_voice',
    params: { reaccionable: { a: 'reactable', props: { alma: 'soul', extracto: 'excerpt' } } }
  },
  cast_agent: {
    nuevo: 'cast_agent',
    params: {
      aprobacion: 'approval',
      action: { enum: { exportar: 'export', importar: 'import' } },
      archivo: 'file',
      forzar: 'force',
      confirmar: 'confirm',
      confirmacion: 'confirmation_token'
    }
  },
  alma: {
    nuevo: 'soul',
    params: {
      action: {
        enum: {
          listar: 'list', ver: 'show', olvidar: 'forget', semilla: 'seed', agente: 'agent', exportar: 'export',
          importar: 'import'
        }
      },
      voz: 'voice',
      forzar: 'force',
      tipo: { a: 'type', enum: { completa: 'full', identidad: 'identity', usuario: 'user', voz: 'voice' } },
      incluir_diario: 'include_diary',
      incluir_hilo: 'include_thread',
      archivo: 'file',
      confirmar: 'confirm',
      confirmacion: 'confirmation_token',
      sondas: 'probes'
    }
  }
});

/** Nombre viejo → nuevo, solo de las tools que cambiaron de nombre. */
const NOMBRES = Object.freeze(Object.fromEntries(
  Object.entries(TOOLS).filter(([viejo, t]) => t.nuevo !== viejo).map(([viejo, t]) => [viejo, t.nuevo])
));
const INTERNO = Object.freeze(Object.fromEntries(Object.entries(TOOLS).map(([viejo, t]) => [t.nuevo, viejo])));

const spec = (s) => (typeof s === 'string' ? { a: s } : s || {});
const nombrePublico = (viejo, s) => spec(s).a || viejo;

/** Nombre público de una tool interna (las que no están en la tabla no cambian). */
function nombreNuevo(interno) {
  return TOOLS[interno] ? TOOLS[interno].nuevo : interno;
}

/** Nombre interno de una tool pública, o null si el nombre público no existe en la tabla. */
function nombreInterno(publico) {
  return Object.prototype.hasOwnProperty.call(INTERNO, publico) ? INTERNO[publico] : null;
}

function invertir(obj) {
  return Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [v, k]));
}

// --- Esquema: interno → público ----------------------------------------------------------------------------

function esquemaPropiedades(props, params) {
  const salida = {};
  for (const [viejo, def] of Object.entries(props || {})) {
    const s = params ? params[viejo] : undefined;
    if (s && spec(s).quitar) continue;
    salida[nombrePublico(viejo, s)] = esquemaValor(def, s ? spec(s) : null);
  }
  return salida;
}

function esquemaValor(def, s) {
  if (!def || typeof def !== 'object' || !s) return def;
  const copia = { ...def };
  if (s.enum && Array.isArray(def.enum)) copia.enum = def.enum.map((v) => (v in s.enum ? s.enum[v] : v));
  if (s.items && def.items && def.items.properties) copia.items = esquemaObjeto(def.items, s.items);
  if (s.props && def.properties) Object.assign(copia, esquemaObjeto(def, s.props));
  return copia;
}

function esquemaObjeto(def, params) {
  const copia = { ...def, properties: esquemaPropiedades(def.properties, params) };
  if (Array.isArray(def.required)) {
    copia.required = def.required
      .filter((k) => !(params && params[k] && spec(params[k]).quitar))
      .map((k) => nombrePublico(k, params && params[k]));
  }
  return copia;
}

/** La definición interna de una tool, como se publica en tools/list. */
function esquemaPublico(tool) {
  const t = TOOLS[tool.name];
  if (!t) return tool;
  return { ...tool, name: t.nuevo, inputSchema: t.params ? esquemaObjeto(tool.inputSchema, t.params) : tool.inputSchema };
}

// --- Argumentos: público → interno ---------------------------------------------------------------------------

class ErrorNombreViejo extends Error {}

function argsObjeto(args, params, ruta) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !params) return args;
  const porPublico = {};
  const renombrados = {};
  for (const [viejo, s] of Object.entries(params)) {
    const sp = spec(s);
    if (sp.quitar) { renombrados[viejo] = null; continue; }
    porPublico[nombrePublico(viejo, s)] = { viejo, sp };
    if (nombrePublico(viejo, s) !== viejo) renombrados[viejo] = nombrePublico(viejo, s);
  }
  const salida = {};
  for (const [clave, valor] of Object.entries(args)) {
    if (Object.prototype.hasOwnProperty.call(renombrados, clave) && !porPublico[clave]) {
      const nuevo = renombrados[clave];
      throw new ErrorNombreViejo(nuevo
        ? `El parámetro \`${ruta}${clave}\` ahora se llama \`${ruta}${nuevo}\` (FEAT-197).`
        : `El parámetro \`${ruta}${clave}\` ya no existe (FEAT-197): era un alias viejo.`);
    }
    const p = porPublico[clave];
    if (!p) { salida[clave] = valor; continue; }
    salida[p.viejo] = argsValor(valor, p.sp, `${ruta}${clave}.`);
  }
  return salida;
}

function argsValor(valor, sp, ruta) {
  if (sp.enum && typeof valor === 'string') {
    const inverso = invertir(sp.enum);
    if (inverso[valor] !== undefined) return inverso[valor];
    if (sp.enum[valor] !== undefined && sp.enum[valor] !== valor) {
      throw new ErrorNombreViejo(`El valor "${valor}" de \`${ruta.slice(0, -1)}\` ahora es "${sp.enum[valor]}" (FEAT-197).`);
    }
    return valor;
  }
  if (sp.items && Array.isArray(valor)) return valor.map((v) => argsObjeto(v, sp.items, ruta));
  if (sp.props) return argsObjeto(valor, sp.props, ruta);
  return valor;
}

/**
 * Traduce una llamada pública a la interna. Devuelve { nombre, args } o { error } (nombre o parámetro viejos:
 * no es un alias, no corre nada; el texto dice el nombre nuevo). Una tool que no está en la tabla pasa igual.
 */
function llamadaInterna(nombre, args) {
  if (Object.prototype.hasOwnProperty.call(NOMBRES, nombre)) {
    return { error: `La tool \`${nombre}\` ahora se llama \`${NOMBRES[nombre]}\` (FEAT-197).`, nuevo: NOMBRES[nombre] };
  }
  const interno = nombreInterno(nombre);
  if (!interno) return { nombre, args };
  const t = TOOLS[interno];
  try {
    return { nombre: interno, args: t.params ? argsObjeto(args || {}, t.params, '') : (args || {}) };
  } catch (err) {
    if (err instanceof ErrorNombreViejo) return { error: err.message };
    throw err;
  }
}

// --- Argumentos: interno → público (el camino inverso; lo usa el cliente de los tests) -------------------------

function argsPublicosObjeto(args, params) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !params) return args;
  const salida = {};
  for (const [clave, valor] of Object.entries(args)) {
    const s = params[clave];
    if (!s || spec(s).quitar) { salida[clave] = valor; continue; }
    const sp = spec(s);
    let v = valor;
    if (sp.enum && typeof valor === 'string' && sp.enum[valor] !== undefined) v = sp.enum[valor];
    else if (sp.items && Array.isArray(valor)) v = valor.map((x) => argsPublicosObjeto(x, sp.items));
    else if (sp.props) v = argsPublicosObjeto(valor, sp.props);
    salida[nombrePublico(clave, s)] = v;
  }
  return salida;
}

/**
 * La llamada pública que corresponde a una interna (`agy_lote` + `accion: "estado"` → `batch` + `action: "status"`).
 * Un nombre que ya es público (o desconocido) pasa con los argumentos tal cual.
 */
function llamadaPublica(nombre, args) {
  const t = TOOLS[nombre];
  if (!t) return { nombre, args };
  return { nombre: t.nuevo, args: t.params ? argsPublicosObjeto(args || {}, t.params) : args };
}

/** El valor público de un valor interno de `param` (p. ej. agy_lote/accion/lanzar → launch), para los textos. */
function valorPublico(interno, param, valor) {
  const s = TOOLS[interno] && TOOLS[interno].params ? spec(TOOLS[interno].params[param]) : {};
  return s.enum && s.enum[valor] !== undefined ? s.enum[valor] : valor;
}

module.exports = { TOOLS, NOMBRES, nombreNuevo, nombreInterno, esquemaPublico, llamadaInterna, llamadaPublica, valorPublico };
