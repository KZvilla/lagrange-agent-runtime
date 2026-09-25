/**
 * FEAT-022 — Orquestacion de un cast, compartida por la tool MCP `cast_agent`
 * y por el comando `/cast` del bot de Telegram.
 *
 * Vivia inline en el handler de `index.js`. Se extrajo para que el bot no la
 * duplicara: la parte que importa aca es `verificarResuelve`, el guardarrail
 * contra el fail-open de `agy --agent <inexistente>` (corre el agente por
 * defecto con escritura completa). Dos copias de ese guardarrail son dos
 * lugares donde se puede olvidar.
 *
 * Lo que este modulo NO hace: formatear para el canal, encolar, ni lanzar
 * procesos. El spawn lo hace `ejecutar`, inyectado por el llamante, que es
 * quien conoce su entorno (el bot sanea secretos; el MCP registra uso). El argv
 * lo arma el motor (FEAT-071) a partir del perfil `lectura` o `edicion`.
 *
 * Contrato de `ejecutar(cliArgs, { cwd, timeoutMinutes, onSpawn, onActividad, onTexto })`:
 *   → { success, data: { response, conversation_id, usage } | null,
 *       rawOutput, error, cancelled }
 * Es la forma que ya devuelve `executeAgy` del servidor MCP.
 */

const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const registro = require('./registry.js');
const estado = require('./estado.js');
const memoria = require('./memoria.js');
const aprendizaje = require('./aprendizaje.js');
const cuarentena = require('./cuarentena.js');
const procedencia = require('./procedencia.js');
const motores = require('../motores/index.js');

/**
 * SEC-021 — Las tools con las que un agente puede leer contenido de afuera: la
 * web, una URL o cualquier servidor MCP del usuario. Lo que un turno aprende
 * después de usarlas puede traer una instrucción inyectada.
 */
// `run_command` también: por la shell se llega a `curl` o a cualquier script.
const HERRAMIENTAS_RED = new Set([
  'search_web', 'read_url_content', 'call_mcp_tool', 'read_resource', 'list_resources', 'run_command',
  'WebFetch', 'WebSearch', 'Bash'
]);

/**
 * SEC-021 — ¿Este turno usó red? `'no'`, `'usada'`, `'desconocida'` o
 * `'heredada'`.
 *
 * `herramientas`: los nombres de tool que el motor informó en su resultado
 * (todos los pasos, no solo los que se muestran), o `null` si no los informa
 * (agy en `json`, la tool MCP): sin dato, `'desconocida'` (fail-closed). Un
 * paso sin nombre (`herramienta`) también. `hiloContaminado`: un turno anterior
 * de este mismo hilo usó red (o no se supo); lo aprendido ahora puede ser una
 * síntesis de aquello, así que hereda la cuarentena.
 */
function redDelTurno({ herramientas, hiloContaminado = false }) {
  const nombres = Array.isArray(herramientas) ? herramientas : null;
  if (nombres && nombres.some((n) => HERRAMIENTAS_RED.has(n))) {
    return { red: 'usada', herramientasRed: nombres.filter((n) => HERRAMIENTAS_RED.has(n)) };
  }
  if (!nombres || nombres.includes('herramienta')) return { red: 'desconocida', herramientasRed: [] };
  if (hiloContaminado) return { red: 'heredada', herramientasRed: [] };
  return { red: 'no', herramientasRed: [] };
}

const MOTIVO_RED = {
  usada: (h) => `usó ${h.join(', ')}`,
  desconocida: () => 'sin datos de si usó red',
  heredada: () => 'el hilo usó red en un turno anterior'
};

// FEAT-077 — Nombres que pueden llegar al prompt: sin saltos de línea ni otros
// controles, sin `..`, relativos y terminados en .md. Los citados salen de
// enlaces que escribió el proyecto: es texto no confiable.
const RUTA_REGLA = /^[A-Za-z0-9._/ -]{1,120}\.md$/;
const TOPE_REGLAS = 8;

/**
 * FEAT-077 — El puntero a los archivos de reglas del proyecto, o `''`.
 *
 * Medido (sonda F de FEAT-076): ningún motor los carga solo en un cast. En
 * claude, `--safe-mode` y `--restricted` apagan CLAUDE.md; agy en `-p` no
 * carga ninguno. Van solo los nombres, nunca el contenido: el CLAUDE.md de un
 * proyecto real pesa 72 KB y es texto del proyecto.
 *
 * `reglas`: `[{ ruta, canonico, para }]` con rutas relativas al cwd.
 */
function bloqueReglas(reglas) {
  if (!Array.isArray(reglas)) return '';
  const validas = reglas
    .filter((r) => r && typeof r.ruta === 'string' && RUTA_REGLA.test(r.ruta)
      && !r.ruta.startsWith('/') && !r.ruta.split('/').includes('..'))
    .sort((a, b) => Number(Boolean(b.canonico)) - Number(Boolean(a.canonico)))
    .slice(0, TOPE_REGLAS);
  if (!validas.length) return '';
  const lineas = validas.map((r) => {
    const nota = r.canonico ? ' (canónico)' : (r.para && /^[a-z]{1,20}$/.test(r.para) ? ` (para ${r.para})` : '');
    return `- ${r.ruta}${nota}`;
  });
  return '<reglas-del-proyecto>\n'
    + 'El proyecto tiene archivos de reglas que no se te cargaron solos. Antes de opinar o proponer cambios sobre el '
    + 'proyecto, leé con tus herramientas de lectura el canónico y los que apliquen; si el pedido no toca el proyecto, '
    + 'no hace falta.\n'
    + `${lineas.join('\n')}\n</reglas-del-proyecto>`;
}

/**
 * FEAT-077/078 — Los archivos de reglas del proyecto en `cwd`, para
 * `opciones.reglas`: el mismo `descubrir` del visor de la consola (ESM, con
 * su caché y su contención), reducido a `{ ruta, canonico, para }`. Lo usan el
 * `/cast` del bridge y el `cast_agent` del MCP. Nunca frena un cast: ante
 * cualquier problema, `[]` y el cast sale sin puntero.
 */
async function reglasDelProyecto(cwd) {
  if (!cwd) return [];
  try {
    const url = pathToFileURL(path.join(__dirname, '..', '..', 'telegram-bridge', 'web', 'reglas.js')).href;
    const d = await (await import(url)).descubrir(cwd);
    return d ? d.archivos.map(({ ruta, canonico, para }) => ({ ruta, canonico, para })) : [];
  } catch {
    return [];
  }
}

/**
 * ¿Este `conversation_id` es el hilo de algun agente persistido?
 *
 * Lo usa el bot para negarse a retomar ese hilo por un camino que no pase
 * `--agent` (`/resume`, `exec_plan`, texto suelto): retomarlo asi corre el
 * agente por defecto, con escritura, sobre la conversacion de un agente que se
 * declaro de solo lectura.
 */
function esHiloDeAgente(conversationId, homeDir = os.homedir()) {
  return motorDeHiloDeAgente(conversationId, homeDir) !== null;
}

/** BE-039 — El motor dueño de este hilo si es de un agente, o `null`. Busca en todos los motores. */
function motorDeHiloDeAgente(conversationId, homeDir = os.homedir()) {
  if (!conversationId) return null;
  for (const entrada of Object.values(estado.leerEstado(homeDir).agents)) {
    const par = estado.hilosDe(entrada).find(([, id]) => id === conversationId);
    if (par) return par[0];
  }
  return null;
}

/**
 * Castea un agente registrado.
 *
 * Nunca lanza por un fallo del cast: devuelve `{ ok: false, error }`. Solo
 * lanza por un error de programacion del llamante (falta `agyBin` o
 * `ejecutar`), porque sin `agyBin` la verificacion no se puede hacer y seguir
 * sin ella es exactamente el fail-open que este modulo existe para evitar.
 *
 * BE-039 — `registrarUso(llamada)` lo inyecta quien llama (el MCP y el bot) y
 * se llama una vez por cast lanzado, tambien en fallo o cancelacion. Sin
 * inyectar no escribe nada. `motor` y `contextoMotor` tambien se inyectan; el
 * hilo que se retoma es el de ese motor. `opciones.origen` dice quien lo inicio.
 *
 * FEAT-072 — El motor sale del rol `cast:<agente>` (o `cast`) de
 * `contextoMotor.config`, con su modelo y esfuerzo, que ganan sobre los de
 * `opciones`. Un cast en claude necesita `ejecutarClaude`; sin el, se rechaza.
 */
async function castear({
  agent, prompt, cwd, agyBin, ejecutar, ejecutarClaude = null, homeDir = os.homedir(), opciones = {},
  motor: motorExplicito = null, registrarUso = () => {}, contextoMotor = {}, env = process.env
}) {
  if (!agyBin) throw new Error('castear: falta `agyBin`, sin el no se puede verificar el agente.');
  if (typeof ejecutar !== 'function') throw new Error('castear: falta `ejecutar`.');
  if (!agent) return { ok: false, error: 'Falta el nombre del agente.' };
  if (!prompt) return { ok: false, error: 'Falta el pedido.' };

  const entrada = registro.leerRegistro(homeDir).agents[agent];
  if (!entrada) {
    return { ok: false, noRegistrado: true, error: `\`${agent}\` no esta registrado como agente persistido.` };
  }
  if (opciones.soloLectura && !entrada.read_only) {
    return {
      ok: false,
      entrada,
      error: `\`${agent}\` es read/write, y por este canal solo se castean agentes read-only.`
    };
  }

  // FEAT-071 — `lectura` es `--mode plan`, la segunda capa para read-only. El
  // allowlist de tools y esto se cubren mutuamente; ninguno alcanza solo.
  const perfil = entrada.read_only ? 'lectura' : 'edicion';
  const origen = opciones.origen || 'usuario';
  const eleccion = motorExplicito
    ? { motor: motorExplicito, modelo: null, esfuerzo: null, cuenta: null }
    : motores.elegir(contextoMotor.config, `cast:${agent}`);
  const motor = eleccion.motor;
  // FEAT-085 — La cuenta del rol viaja en los dos pedidos y su clave indexa el
  // hilo y el uso: un hilo de una cuenta no se retoma con otra.
  const cuenta = eleccion.cuenta || null;
  const claveHilo = motores.claveDeCuenta(motor.id, cuenta);
  const ejecutores = { ejecutar, ejecutarClaude };
  const falta = motores.faltaEjecutor(motor, ejecutores);
  if (falta) return { ok: false, entrada, error: `No se casteo \`${agent}\`: ${falta}` };
  const model = eleccion.modelo || opciones.model || null;
  const verificacion = await motor.preflight(
    { perfil, cast: agent, modelo: model, origen, ...(cuenta ? { cuenta } : {}) },
    { ...contextoMotor, agyBin, homeDir }
  );
  if (!verificacion.ok) {
    return { ok: false, entrada, error: `No se casteo \`${agent}\`: ${verificacion.motivo}` };
  }

  const usarMemoria = opciones.memory !== false;
  // Solo para tests: apuntar a un servicio falso sin tocar el descubrimiento.
  const opcionesMemoria = opciones.memoriaConfig
    ? { config: opciones.memoriaConfig, timeoutMs: opciones.memoriaTimeoutMs }
    : {};
  let contexto = null;
  let motivoSinMemoria = usarMemoria ? null : 'memoria desactivada';
  if (usarMemoria) {
    const rehidratacion = await memoria.rehidratar(agent, {
      projectId: opciones.projectId || entrada.project_id || undefined,
      taskSummary: prompt,
      budgetTokens: opciones.budgetTokens,
      ...opcionesMemoria
    });
    if (rehidratacion.ok) contexto = rehidratacion.texto;
    else motivoSinMemoria = rehidratacion.motivo;
  }

  const hiloGuardado = opciones.fresh ? null : estado.hiloDe(agent, homeDir, { motor: claveHilo });
  // Cada motor aplica sus reglas de esfuerzo (las de agy no valen para claude).
  const pedidoEsfuerzo = { modelo: model, pedido: eleccion.esfuerzo || opciones.effort, porDefecto: opciones.effortPorDefecto };
  const effort = typeof motor.esfuerzo === 'function' ? motor.esfuerzo(pedidoEsfuerzo) : (pedidoEsfuerzo.pedido || pedidoEsfuerzo.porDefecto || null);
  const timeoutMinutes = opciones.timeoutMinutes || 15;

  // FEAT-054 — `stream` es opt-in: el bot lo pide para mostrar qué hace el
  // agente mientras corre. La tool MCP no lo usa y sigue en json.
  const formato = opciones.stream ? 'stream' : 'json';

  // El contexto rehidratado va antes del pedido y marcado como tal: sin la
  // marca el agente lo lee como parte de la consigna de hoy.
  let promptCast = contexto
    ? `<contexto-recuperado>\nLo que ya sabés de trabajos anteriores:\n\n${contexto}\n</contexto-recuperado>\n\n${prompt}`
    : prompt;

  // El workspace elegido fija desde donde arranca agy, no que puede leer: no
  // hay allowlist de rutas en el CLI, y un agente read-only alcanza cualquier
  // ruta legible por el usuario (visto: arrancado en un frontend, reviso el
  // backend en WSL). Esto es una instruccion, no un control. La usa el bot,
  // donde la respuesta sale del equipo.
  if (opciones.alcance) {
    promptCast += `\n\n<alcance>\nEl usuario eligio trabajar sobre ${opciones.alcance}. `
      + 'Lee solo dentro de esa carpeta. Si para responder necesitas otra ruta (otro repo, WSL, '
      + 'tu home), no la leas: decí cual y para que, y que el usuario decida.\n</alcance>';
  }

  // FEAT-077 — En todo turno: un hilo de agente puede cambiar de proyecto entre casts.
  const reglas = bloqueReglas(opciones.reglas);
  if (reglas) promptCast += `\n\n${reglas}`;

  // Sin esto el agente no acumula nada: la cola estructurada es lo que llena
  // `decisions`, el unico canal que rehidrata con el `agent_id` puesto. Con la
  // memoria apagada no se pide: seria pagar tokens por algo que no se guarda.
  if (usarMemoria) promptCast += `\n${aprendizaje.instruccionDeCierre()}`;
  const pedido = {
    perfil, cast: agent, prompt: promptCast, modelo: model, esfuerzo: effort, hilo: hiloGuardado, formato, origen,
    ...(cuenta ? { cuenta } : {})
  };

  // Reloj de pared de ESTE turno. `duration_seconds` de agy es el acumulado de
  // toda la conversacion: con un hilo continuado, el pie llego a decir 32404 s
  // para un turno de minutos.
  const inicio = Date.now();
  const resultado = await motores.despachar({
    motor,
    pedido,
    pre: verificacion,
    ejecutores,
    env,
    homeDir,
    opciones: { cwd, timeoutMinutes, onSpawn: opciones.onSpawn, onActividad: opciones.onActividad, onTexto: opciones.onTexto }
  });
  const hiloNuevoTurno = resultado.hilo || hiloGuardado || null;

  // SEC-021 — ¿Hubo red? Se decide acá, antes de mirar si el turno salió bien:
  // un turno que leyó la web y después falló igual contamina su hilo, y lo que
  // aprendan los turnos siguientes de ese hilo va a cuarentena ('heredada').
  const hilosDelTurno = [hiloGuardado, hiloNuevoTurno].filter(Boolean);
  const { red, herramientasRed } = redDelTurno({
    herramientas: resultado.herramientas,
    hiloContaminado: hilosDelTurno.some((h) => cuarentena.hiloContaminado(h, { homeDir }))
  });
  if (red === 'usada' || red === 'desconocida') {
    for (const h of new Set(hilosDelTurno)) {
      const m = cuarentena.marcarHilo(h, agent, { homeDir });
      if (!m.ok) process.stderr.write(`[agentes] No se pudo marcar el hilo con red: ${m.motivo}\n`);
    }
  }
  const duracion = (Date.now() - inicio) / 1000;
  const hiloNuevo = resultado.hilo || hiloGuardado || null;

  const base = {
    entrada,
    conversationId: hiloNuevo,
    continuado: Boolean(hiloGuardado),
    duracion,
    usage: resultado.uso,
    model,
    effort,
    motor: motor.id,
    cuenta,
    modeloReal: resultado.modeloReal,
    costoUsd: resultado.costoUsd,
    timeoutMinutes,
    memoria: { usada: usarMemoria, recuperada: Boolean(contexto), motivo: motivoSinMemoria, guardadas: 0 }
  };

  // El hilo se guarda incluso si el turno fallo o se cancelo: si agy llego a
  // abrir conversacion, perderla obliga a re-explicarle todo al agente.
  // Solo un turno exitoso cuenta como cast; uno fallido o cancelado guarda el
  // hilo pero no suma.
  if (hiloNuevo) {
    estado.registrarCast(agent, {
      conversationId: hiloNuevo,
      cwd,
      contar: Boolean(resultado.ok && !resultado.cancelado),
      motor: claveHilo
    }, homeDir);
  }

  // Un registro de uso que falla no puede voltear el cast.
  try {
    registrarUso({
      tool: 'cast',
      motor: claveHilo,
      // FEAT-086 — Para registrar a qué modelo resolvió el alias del rol.
      rol: `cast:${agent}`,
      modelo: model,
      modeloReal: resultado.modeloReal,
      esfuerzo: effort,
      conversationId: hiloNuevo,
      duracion,
      usage: resultado.uso,
      error: resultado.ok ? null : (resultado.error || (resultado.cancelado ? 'Cast cancelado.' : 'El cast fallo sin detalle.')),
      costoUsd: resultado.costoUsd,
      origen,
      cuota: resultado.cuota
    });
  } catch (err) {
    process.stderr.write(`[agentes] No se pudo registrar el uso del cast: ${err.message}
`);
  }

  // Cancelado: no se extrae aprendizaje de una salida trunca ni se cierra la
  // sesion en la memoria. No hay un `outcome` verificado para "abortado".
  if (resultado.cancelado) {
    return { ...base, ok: false, cancelled: true, error: resultado.error || 'Cast cancelado.' };
  }
  if (!resultado.ok) {
    return { ...base, ok: false, error: resultado.error || 'El cast fallo sin detalle.' };
  }

  const crudo = resultado.texto || '(sin respuesta)';
  // El bloque de memoria es plomeria: se saca de lo que ve el usuario.
  const aprendido = usarMemoria
    ? aprendizaje.extraerAprendizaje(crudo)
    : { respuesta: crudo, decisions: [], userCorrections: [] };
  // `extraidas` es lo que el agente emitio; `guardadas`, lo que la memoria
  // acepto. Antes se informaba lo primero como si fuera lo segundo.
  const extraidas = aprendido.decisions.length + aprendido.userCorrections.length;
  let guardadas = 0;
  let motivoCierre = null;
  let enCuarentena = 0;
  let motivoCuarentena = null;

  const prov = {
    agente: agent, motor: claveHilo, cuenta, modeloReal: resultado.modeloReal || null,
    sesion: hiloNuevo, origen, red, herramientasRed
  };
  const textos = [...aprendido.decisions, ...aprendido.userCorrections];
  const anotarProcedencia = (destino, extra = {}) => {
    const r = procedencia.anotar({ ...prov, destino, textos, ...extra }, { homeDir });
    if (!r.ok) process.stderr.write(`[agentes] No se pudo anotar la procedencia del cast: ${r.motivo}\n`);
  };

  if (usarMemoria && extraidas > 0 && red !== 'no') {
    // Retener en vez de guardar. Si retener falla, NO se guarda: se pierde el
    // aprendizaje antes que dejar pasar algo sin revisar.
    const retenido = cuarentena.retener(agent, {
      decisions: aprendido.decisions, userCorrections: aprendido.userCorrections, taskSummary: prompt, procedencia: prov
    }, { homeDir });
    if (retenido.ok) {
      enCuarentena = extraidas;
      motivoCuarentena = MOTIVO_RED[red](herramientasRed);
      anotarProcedencia('cuarentena', { cuarentenaId: retenido.id });
      if (retenido.expulsada) {
        const e = retenido.expulsada;
        procedencia.anotar({
          ...(e.procedencia || {}), agente: e.agente, destino: 'descartada',
          textos: [...(e.decisions || []), ...(e.userCorrections || [])], cuarentenaId: e.id, motivo: 'tope de la cuarentena'
        }, { homeDir });
      }
    } else {
      motivoCierre = `no se guardó: tenía que quedar en cuarentena y no se pudo (${retenido.motivo})`;
    }
  } else if (usarMemoria) {
    // Best-effort: que la memoria no acepte el cierre no invalida el trabajo.
    // `errors` va vacio a proposito: el servicio los convierte en notas sin
    // `agent_id`, y el bootstrap las comparte con TODOS los agentes.
    const cierre = await memoria.cerrarSesion(agent, {
      sessionId: hiloNuevo || undefined,
      taskSummary: prompt,
      outcome: extraidas > 0 ? 'success' : 'partial',
      decisions: aprendido.decisions,
      userCorrections: aprendido.userCorrections
    }, opcionesMemoria);
    if (cierre.ok) {
      guardadas = extraidas;
      if (extraidas > 0) anotarProcedencia('memoria');
    } else motivoCierre = cierre.motivo || 'la memoria no acepto el cierre';
  }

  return {
    ...base,
    ok: true,
    respuesta: aprendido.respuesta,
    memoria: { ...base.memoria, extraidas, guardadas, motivoCierre, enCuarentena, motivoCuarentena, red }
  };
}

module.exports = { castear, esHiloDeAgente, motorDeHiloDeAgente, bloqueReglas, reglasDelProyecto, redDelTurno, HERRAMIENTAS_RED };
