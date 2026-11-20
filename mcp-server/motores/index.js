/**
 * FEAT-072 — Registro de motores, elección por rol y despacho.
 *
 * Las superficies (charla, consolidación, cast) no preguntan "¿es claude?":
 * resuelven el motor del rol, le piden `preflight` y `armar`, y entregan lo
 * armado al ejecutor que el motor declara (`motor.ejecutor`). Si ese ejecutor
 * no fue inyectado, rechazan: una superficie nunca lanza un CLI por su cuenta.
 *
 * La validación de `motores.roles` vive en `roles.js` (sin dependencias, para
 * que `lib/config.js` la cargue sin traer los motores).
 */

const os = require('node:os');
const antigravity = require('./antigravity.js');
const claude = require('./claude.js');
const deepseek = require('./deepseek.js');
const opencodeGo = require('./opencode-go.js');
const roles = require('./roles.js');
const { faltaParaRol, perfilesDe, PROBADOS, ROLES_INTENCION } = require('./capacidades.js');
const { nivelesPara, modeloBloqueado, MODELO_DEEPSEEK, MODELO_OPENCODE_GO } = require('./niveles.js');
const { ORIGENES, verificarPoliticas } = require('./politicas.js');
const { destinoManual } = require('./manual.js');
const { prepararAislamiento } = require('./aislamiento.js');

const MOTORES = Object.freeze({ [antigravity.id]: antigravity, [claude.id]: claude, [deepseek.id]: deepseek, [opencodeGo.id]: opencodeGo });

function motorPorId(id) {
  return MOTORES[id] || null;
}

/**
 * `{ motor, modelo, esfuerzo }` para un rol (`alma`, `alma:<clave>`,
 * `consolidar`, `consolidar:<clave>`, `cast`, `cast:<nombre>`). `cast:<nombre>` gana sobre `cast`,
 * `alma:<clave>` sobre `alma` (FEAT-075) y `consolidar:<clave>` sobre `consolidar` (FEAT-079), por entrada completa: el rol propio
 * no hereda campos sueltos del general. Sin configuración, o con una sección
 * inválida (que `loadConfig` ya descartó), es `antigravity` sin modelo ni
 * esfuerzo propios: lo de siempre.
 */
function elegir(config, rol) {
  const tabla = (config && config.motores && config.motores.roles) || {};
  let entrada = tabla[rol] || null;
  if (!entrada && rol.startsWith('cast:')) entrada = tabla.cast || null;
  if (!entrada && rol.startsWith('alma:')) entrada = tabla.alma || null;
  if (!entrada && rol.startsWith('consolidar:')) entrada = tabla.consolidar || null;
  const motor = (entrada && motorPorId(entrada.motor)) || antigravity;
  return {
    motor,
    modelo: (entrada && entrada.modelo) || null,
    esfuerzo: (entrada && entrada.esfuerzo) || null,
    // FEAT-085 — La cuenta viaja con la entrada completa, como el modelo.
    cuenta: (entrada && motor.id === claude.id && entrada.cuenta) || null,
    // FEAT-097 — Un rol con motor en `motores.roles` no usa el fallback de agy.
    fijo: Boolean(entrada && motorPorId(entrada.motor)),
    // FEAT-202 S0 — De dónde salió la elección: `rol` (una entrada en motores.roles) o `defecto`. `engine` (el
    // parámetro de la llamada) lo suma S3, y también es fijo.
    seleccion: entrada && motorPorId(entrada.motor) ? 'rol' : 'defecto'
  };
}

/** FEAT-202 S3 (D1, D11) — Lo que `engine` puede pedir, y el motor de cada valor. `agy` es el camino de siempre. */
const ENGINE_A_MOTOR = Object.freeze({ agy: antigravity.id, deepseek: deepseek.id, 'opencode-go': opencodeGo.id });
/** El modelo de cada motor de API cuando no lo dicen ni la llamada ni el rol (D1). */
const MODELO_POR_DEFECTO = Object.freeze({ [deepseek.id]: MODELO_DEEPSEEK, [opencodeGo.id]: MODELO_OPENCODE_GO });
/** D11 — El esfuerzo por defecto de cada rol de lectura (antes, por herramienta): `max` para auditar y revisar. */
const ESFUERZO_DEL_ROL = Object.freeze({ audit: 'max', review: 'max', plan: 'high' });

/**
 * Los valores de `engine` para un rol: `agy` (el camino de siempre, exento) y los motores con el perfil del rol
 * verificado o sondeado en algún modelo.
 */
function enginesPara(rol) {
  const req = ROLES_INTENCION[rol];
  return Object.keys(ENGINE_A_MOTOR).filter((e) => {
    const id = ENGINE_A_MOTOR[e];
    if (id === antigravity.id) return true;
    return Boolean(req && req.perfil && PROBADOS.includes(perfilesDe(id)[req.perfil]));
  });
}

/**
 * FEAT-202 S3 — La elección de una llamada a un rol de lectura (`audit`, `review`, `plan`), con la precedencia de D1:
 * `engine`, después el rol, después el defecto. Devuelve la elección (la de `elegir`, más `aviso`) o `{ error }`,
 * siempre antes de lanzar nada.
 *
 *   - `engine: "agy"`, o sin rol configurado: antigravity, el camino de siempre (con su respaldo).
 *   - Con `conversation_id` y sin `engine`, el motor sale del hilo: hoy todo hilo retomable es de agy (D3).
 *   - Un motor de API (por `engine` o por el rol) es fijo: no cae a otro. No retoma hilos ni acepta `isolation`.
 *   - El modelo: el de la llamada (tiene que ser de ese motor), el del rol si es del mismo motor, o el por defecto.
 *     El esfuerzo: el de la llamada, el del rol, o el del rol por defecto; uno que el modelo no admite baja al
 *     implícito, con aviso.
 */
function elegirLlamada(config, rol, args = {}, { perfil = null, dueno = null } = {}) {
  let motor;
  let seleccion;
  // FEAT-202 S6 (D3) — Con `conversation_id`, el dueño del hilo se resuelve antes de elegir: uno de otro motor se
  // rechaza (las tools solo retoman hilos de agy). Un hilo sin registro es de agy, como antes.
  if (args.conversation_id && dueno && dueno.motor && dueno.motor !== antigravity.id) {
    return { error: errorDeDueno(args.conversation_id, dueno, args.engine ? ENGINE_A_MOTOR[args.engine] || args.engine : antigravity.id, rol) };
  }
  const delRol = elegir(config, rol);
  if (args.engine !== undefined && args.engine !== null) {
    const id = ENGINE_A_MOTOR[args.engine];
    if (!id) return { error: `engine inválido: "${args.engine}" (${Object.keys(ENGINE_A_MOTOR).map((e) => `"${e}"`).join(', ')}).` };
    if (id === antigravity.id) return { ...elegir(null, rol), seleccion: 'engine', aviso: null };
    motor = MOTORES[id];
    seleccion = 'engine';
  } else if (args.conversation_id || delRol.motor.id === antigravity.id) {
    return { ...(delRol.motor.id === antigravity.id ? delRol : elegir(null, rol)), aviso: null };
  } else {
    motor = delRol.motor;
    seleccion = 'rol';
  }
  const origen = seleccion === 'engine' ? `engine "${args.engine}"` : `motores.roles.${rol}`;
  if (args.conversation_id) return { error: `${origen} no retoma hilos: el motor ${motor.id} corre de una vez, sin conversation_id.` };
  if (args.isolation) return { error: `${origen} no corre en contenedor ni en el host (el motor ${motor.id} son tools de Node sobre una instantánea): sacá isolation "${args.isolation}".` };
  const mismo = delRol.motor.id === motor.id;
  const modelo = args.model || (mismo ? delRol.modelo : null) || MODELO_POR_DEFECTO[motor.id] || null;
  if (!modelo) return { error: `${origen}: el motor ${motor.id} exige un modelo y no hay ninguno para el rol ${rol}.` };
  const bloqueado = modeloBloqueado(motor.id, modelo);
  if (bloqueado) {
    // `run` no tiene `engine` (S5): para agy, se quita el rol.
    const salida = rol === 'run' ? 'para agy, quitá motores.roles.run' : 'para agy pasá engine: "agy"';
    const pista = args.model && seleccion === 'rol' ? ` (el rol ${rol} corre en ${motor.id}; ${salida})` : '';
    return { error: `${origen}: ${bloqueado}${pista}.` };
  }
  const falta = faltaPerfil(motor.id, rol, modelo, perfil);
  if (falta) return { error: `${origen}: ${falta}.` };
  const pedido = args.effort || (mismo ? delRol.esfuerzo : null) || ESFUERZO_DEL_ROL[rol] || null;
  const n = nivelesPara(motor.id, modelo);
  let esfuerzo = null;
  let aviso = null;
  if (n.admite) {
    const p = pedido ? String(pedido).toLowerCase() : null;
    esfuerzo = p && n.niveles.includes(p) ? p : n.implicito;
    if (p && esfuerzo !== p) aviso = `${modelo} no admite el esfuerzo "${pedido}"; se usa "${esfuerzo}"`;
  } else if (args.effort || (mismo && delRol.esfuerzo)) {
    aviso = `${modelo} no usa esfuerzo; se ignoró "${args.effort || delRol.esfuerzo}"`;
  }
  return { motor, modelo, esfuerzo, cuenta: null, fijo: true, seleccion, aviso };
}

/**
 * FEAT-202 S6 (D3) — El rechazo de un hilo que es de otro motor: un hilo no cambia de motor (ni por `engine`, ni por el
 * rol, ni por el respaldo, FEAT-167).
 */
function errorDeDueno(conversationId, dueno, pedido, rol = null) {
  const de = `${dueno.motor}${dueno.cuenta ? `@${dueno.cuenta}` : ''}`;
  const donde = rol ? `el rol ${rol} en ${pedido}` : pedido;
  return `el hilo ${conversationId} es de ${de}, y un hilo no cambia de motor: ${donde} no lo retoma. `
    + 'Abrí un hilo nuevo (sin conversation_id) y pasale un resumen de lo hecho.';
}

/**
 * FEAT-202 S5 — Lo que le falta al motor para el rol, o para `perfil` si la llamada pide otro que el del rol (`run` con
 * `mode: "plan"` o sin el permiso `edit` corre con `lectura`). `null` si puede.
 */
function faltaPerfil(motorId, rol, modelo, perfil = null) {
  const req = ROLES_INTENCION[rol];
  if (!perfil || !req || req.perfil === perfil) return faltaParaRol(motorId, rol, modelo);
  const estado = perfilesDe(motorId, modelo)[perfil];
  const quien = modelo ? `${motorId} con ${modelo}` : motorId;
  if (!estado) return `el motor ${quien} no tiene el perfil ${perfil}, que pide el rol ${rol} así`;
  if (!PROBADOS.includes(estado)) return `el motor ${quien} tiene el perfil ${perfil} solo declarado, sin sondas; el rol ${rol} pide uno verificado o sondeado`;
  return null;
}

/** Un error de `despacharLectura`: `motivo` nombra el motor y el rol. */
function errorDespacho(codigo, motivo) {
  return { ok: false, codigo, motivo, error: motivo, pasos: 0, herramientas: 0 };
}

/**
 * FEAT-202 S3 — El contrato de `despachar` para el perfil `lectura` de los motores de API (D11), en el orden del plan:
 * modo manual, capacidades, preflight (políticas y disponibilidad), aislamiento, armar y ejecutor (el bucle de
 * `lectura-api.js`), interpretar y registrar el uso. Los turnos sin tools siguen por `despachar`; S6 los junta.
 *
 * `contexto`: `{ config, signal, leerCuota, ejecutores: { lectura }, registrarUso, homeDir, modelosServidos, cupoSinEsperar,
 * saldoSinEsperar }` (los dos últimos reemplazan la caché de cupo en los tests, FEAT-202 S4).
 * Devuelve el resultado del bucle con `{ ok, codigo, motivo, motor, modelo, esfuerzo }`; un rechazo, sin lanzar.
 */
async function despacharLectura({ eleccion, pedido, contexto = {} }) {
  return despacharApi({ eleccion, pedido, contexto, perfilEsperado: 'lectura' });
}

/**
 * FEAT-202 S5 (D7) — El mismo contrato para el perfil `edicion` (`run` por rol): escribe en el árbol vivo con las tools
 * de `edicion-api.js`. `pedido.permisos` (`{ edit }`) los aplica el plugin en cada tool. `contexto.ejecutores.edicion`
 * reemplaza al bucle en los tests. Devuelve además `tocados` (`[{ path, accion, diff }]`).
 */
async function despacharEdicion({ eleccion, pedido, contexto = {} }) {
  return despacharApi({ eleccion, pedido, contexto, perfilEsperado: 'edicion' });
}

async function despacharApi({ eleccion, pedido, contexto = {}, perfilEsperado }) {
  // El contrato: una elección completa de `elegirLlamada` y un pedido con su rol, perfil, prompt, origen y cwd.
  if (!eleccion || !eleccion.motor || !eleccion.seleccion || !eleccion.modelo) {
    return errorDespacho('contrato', 'despachar: la elección viene incompleta (falta motor, modelo o seleccion; la arma elegirLlamada)');
  }
  const faltan = ['rol', 'perfil', 'prompt', 'origen', 'cwd'].filter((k) => !pedido || !pedido[k]);
  if (faltan.length) return errorDespacho('contrato', `despachar: al pedido le falta ${faltan.join(', ')}`);
  if (!ORIGENES.includes(pedido.origen)) return errorDespacho('contrato', `despachar: origen inválido "${pedido.origen}" (${ORIGENES.join(', ')})`);
  if (pedido.perfil !== perfilEsperado) {
    const quien = perfilEsperado === 'edicion' ? 'despacharEdicion' : 'despacharLectura';
    return errorDespacho('contrato', `despachar: ${quien} atiende el perfil ${perfilEsperado} (pidió "${pedido.perfil}")`);
  }
  const motor = eleccion.motor;
  const { modelo, esfuerzo } = eleccion;

  // 1. Modo manual: un motor de API nunca lanza agy, así que da `normal`; se consulta igual (D8).
  if (destinoManual({ herramienta: pedido.herramienta, args: {}, eleccion }) !== 'normal') {
    return errorDespacho('manual', `agy está en modo manual y el rol ${pedido.rol} resolvió a ${motor.id}`);
  }
  // 2. Capacidades.
  const falta = faltaPerfil(motor.id, pedido.rol, modelo, pedido.perfil);
  if (falta) return errorDespacho('capacidad', falta);
  // 3. Preflight: políticas comunes (con `origen`) y, en Go, que el modelo siga servido.
  const politicas = verificarPoliticas(motor, { ...pedido, modelo }, { config: contexto.config || null, leerCuota: contexto.leerCuota || null, cupoSinEsperar: contexto.cupoSinEsperar || null });
  if (!politicas.ok) return errorDespacho(politicas.frenado ? 'freno' : 'politicas', politicas.motivo);
  if (typeof motor.disponible === 'function') {
    const pruebas = Object.fromEntries(['modelosServidos', 'cupoSinEsperar', 'saldoSinEsperar'].filter((k) => contexto[k]).map((k) => [k, contexto[k]]));
    const d = await motor.disponible(modelo, pruebas);
    // FEAT-202 S4 (D5) — Sin cupo es su propio código: el respaldo lo trata como «no puede».
    if (!d.ok) return errorDespacho(d.sinCupo ? 'sin-cupo' : 'disponible', d.motivo);
  }
  // 4. Aislamiento.
  const aislamiento = await prepararAislamiento(motor, pedido, { config: contexto.config || null });
  if (!aislamiento.ok) return errorDespacho(aislamiento.codigo, aislamiento.motivo);
  // 5-7. Armar, ejecutar e interpretar: el bucle arma cada paso y devuelve su resultado neutral.
  const edicion = perfilEsperado === 'edicion';
  const correr = (contexto.ejecutores && contexto.ejecutores[edicion ? 'edicion' : 'lectura'])
    || (edicion ? require('./edicion-api.js').editarRepo : require('./lectura-api.js').revisarRepo);
  const r = await correr({
    repo: pedido.cwd, denyPaths: aislamiento.denyPaths, prompt: pedido.prompt, esfuerzo, motor: motor.id, modelo,
    timeoutMinutes: pedido.timeoutMinutes || 25, signal: contexto.signal || null, ...(contexto.homeDir ? { homeDir: contexto.homeDir } : {}),
    ...(edicion ? { permisos: { edit: Boolean(pedido.permisos && pedido.permisos.edit) } } : {})
  });
  const resultado = { ...r, ok: Boolean(r.ok), codigo: r.ok ? null : 'motor', motivo: r.ok ? null : r.error, motor: motor.id, modelo, esfuerzo, aviso: eleccion.aviso || null };
  // 8. El uso, con `origen`. Los perfiles de API que no retoman no registran hilo (D3).
  if (r.pasos > 0 && typeof contexto.registrarUso === 'function') {
    try { contexto.registrarUso({ resultado, pedido, eleccion }); } catch {}
  }
  return resultado;
}

/**
 * FEAT-202 S6 (D8) — Lo que lanza agy por fuera de `despacharAgy`, con su motivo. Es una lista cerrada: el test
 * `feat-202-s6` falla si aparece un lanzamiento de agy que no pasa por la puerta ni está acá.
 */
const EXCEPCIONES_AGY = Object.freeze({
  agy_image: 'el subagente image-generator no tiene perfil',
  agy_voice_stream: 'stream con un hilo vivo (agy-stream.js)',
  agy_fanout: 'congelado (decisión del 2026-11-17): entra en un FEAT aparte',
  agy_lote: 'congelado (decisión del 2026-11-17): entra en un FEAT aparte'
});

/**
 * FEAT-202 S6 (D8) — La puerta de agy de las tools: `run` y `research` sin rol, `plan`/`review`/`audit` en agy (host y
 * contenedor), los textos (`say`, `narrate`, su pulido, `session_summary`) y los casts. Cada lanzamiento declara su
 * herramienta y su perfil de antigravity (`sin-tools`, `lectura`, `edicion`), y en modo manual nunca lanza: devuelve el
 * error con la forma de `executeAgy`, sin llamar a `lanzar`.
 *
 * El modelo, el esfuerzo, el agente, `output_schema` y el tope de concurrencia de `run` siguen en los `cliArgs` y en el
 * handler: son campos propios de antigravity (D8). `lanzar` es el ejecutor (`executeAgy` o `executeAgyStdin`).
 */
async function despacharAgy({ pedido, lanzar, manual = null }) {
  const agyModo = require('./antigravity/modo.js');
  if (!pedido || typeof pedido.herramienta !== 'string' || !pedido.herramienta || typeof pedido.perfil !== 'string') {
    return { success: false, error: 'despacharAgy: al pedido le falta la herramienta o el perfil', lanzado: false };
  }
  if (!Object.prototype.hasOwnProperty.call(antigravity.perfiles, pedido.perfil)) {
    return { success: false, error: `despacharAgy: antigravity no tiene el perfil "${pedido.perfil}"`, lanzado: false };
  }
  if (Object.prototype.hasOwnProperty.call(EXCEPCIONES_AGY, pedido.herramienta)) {
    return { success: false, error: `despacharAgy: ${pedido.herramienta} lanza agy por su cuenta (${EXCEPCIONES_AGY[pedido.herramienta]})`, lanzado: false };
  }
  if (manual === null ? agyModo.enModoManual() : manual) return { success: false, error: agyModo.MENSAJE, manual: true, lanzado: false };
  if (typeof lanzar !== 'function') return { success: false, error: 'despacharAgy: falta el ejecutor de agy', lanzado: false };
  return lanzar();
}

/** FEAT-085 — Nombres de cuenta que usa algún rol de claude, sin repetir. */
function cuentasEnUso(config) {
  const tabla = (config && config.motores && config.motores.roles) || {};
  return [...new Set(Object.values(tabla).filter(r => r && r.motor === claude.id && r.cuenta).map(r => r.cuenta))].sort();
}

/** Motivo de rechazo si el motor no tiene su ejecutor en este proceso; `null` si lo tiene. */
function faltaEjecutor(motor, ejecutores) {
  return typeof (ejecutores || {})[motor.ejecutor] === 'function'
    ? null
    : `el motor ${motor.id} no está disponible en este proceso`;
}

/**
 * Arma, ejecuta con el ejecutor del motor e interpreta. `limpiar()` corre
 * siempre. Si Claude arrancó pero no informó hilo (watchdog), el resultado se
 * queda con el previsto: el hilo existe y perderlo obliga a re-explicar todo.
 * Si no arrancó (`lanzado: false`), no hay hilo que registrar.
 */
async function despachar({ motor, pedido, pre = {}, ejecutores, opciones = {}, env = process.env, homeDir = os.homedir() }) {
  // FEAT-085 — `configDir` lo resolvió el `preflight` de la cuenta del pedido.
  const armado = motor.armar(pedido, { bin: pre.bin || null, env, homeDir, configDir: pre.configDir || null });
  let crudo;
  try {
    crudo = await ejecutores[motor.ejecutor](armado, opciones);
  } finally {
    if (armado && typeof armado.limpiar === 'function') armado.limpiar();
  }
  const resultado = motor.interpretar(crudo, pedido);
  if (!resultado.hilo && crudo && crudo.lanzado && armado.hiloPrevisto) resultado.hilo = armado.hiloPrevisto;
  return resultado;
}

/** ¿Algún rol de la configuración corre en este motor? */
function usaMotor(config, id) {
  const tabla = (config && config.motores && config.motores.roles) || {};
  return Object.values(tabla).some(r => r && r.motor === id);
}

const ESPERA_CUPO_MS = 6000;

/**
 * FEAT-202 S4 (D5) — El estado de cada motor para `status`: `[{ id, disponible, motivo, cupo, roles }]`. Nunca una ruta,
 * un `configDir`, el nombre de una variable de key ni un error crudo del proveedor: los motivos son fijos.
 *
 * - `agyDisponible`: si el que llama ya sabe si agy responde (su `--version`). En modo manual, agy no se lanza.
 * - `leerCuota`: el archivo de uso (agy y claude). Go y deepseek consultan su API (5 s, caché de 5 min) solo con key.
 * - `dependencias`: `resolverBinClaude` y `leerKey(motor)` para los tests.
 */
async function estadoDeMotores({ config = null, leerCuota = null, agyDisponible = true, modoManual = false, dependencias = {} } = {}) {
  const resolverBin = dependencias.resolverBinClaude || ((c) => require('./claude-ejecutar.js').resolverBinario(c));
  const { normalizarKey } = require('./deepseek-ejecutar.js');
  const leerKey = dependencias.leerKey || (async (id) => (id === deepseek.id
    ? require('./deepseek-ejecutar.js').leerKeyConMotivo()
    : require('./opencode-go-ejecutar.js').leerKeyConMotivo()));
  const conTope = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, motivo: 'sin respuesta' }), ESPERA_CUPO_MS).unref())]);
  const tabla = (config && config.motores && config.motores.roles) || {};
  const rolesDe = (id) => Object.entries(tabla).filter(([, r]) => r && r.motor === id).map(([rol]) => rol).sort();

  const estados = await Promise.all(Object.values(MOTORES).map(async (motor) => {
    let disponible = true;
    let motivo = null;
    // FEAT-202 S6 (D9) — El código del motivo, para la proyección v2: el texto de acá es fijo, pero el contrato es el código.
    let motivoCodigo = null;
    if (motor.id === antigravity.id) {
      if (modoManual) { disponible = false; motivo = 'manual mode: Lagrange does not launch agy'; motivoCodigo = 'manual'; }
      else if (!agyDisponible) { disponible = false; motivo = 'the agy executable did not answer'; motivoCodigo = 'sin-cli'; }
    } else if (motor.id === claude.id) {
      let bin = { ok: false };
      try { bin = resolverBin(config); } catch {}
      if (!bin.ok) { disponible = false; motivo = 'claude executable not found (see motores.claude.bin)'; motivoCodigo = 'sin-cli'; }
    } else {
      let key = null;
      try { key = normalizarKey(await leerKey(motor.id)).key; } catch {}
      if (!key) { disponible = false; motivo = 'no API key configured'; motivoCodigo = 'sin-key'; }
    }
    const conRed = motor.id === deepseek.id || motor.id === opencodeGo.id;
    let cupo = { ok: false, motivo: 'not read' };
    if (typeof motor.consultarCupo === 'function' && (!conRed || disponible)) {
      try { cupo = await conTope(motor.consultarCupo({ leerCuota })); } catch { cupo = { ok: false, motivo: 'error' }; }
    }
    return {
      id: motor.id, disponible, motivo, motivoCodigo, tipoCupo: motor.capacidades.cupo, cupo, roles: rolesDe(motor.id),
      capacidades: motor.capacidades, modelos: modelosDe(motor.id, config)
    };
  }));
  return estados;
}

/**
 * FEAT-202 S6 (D9, D4) — Los modelos de un motor, del catálogo de `niveles.js` (más los que usa algún rol), con sus
 * niveles y sus perfiles. `sonda` lo suma quien sabe leerla (el bridge, para los modelos de Go con perfil sondeado).
 */
function modelosDe(motorId, config = null) {
  const { catalogo } = require('./niveles.js');
  const tabla = (config && config.motores && config.motores.roles) || {};
  const extras = Object.values(tabla).filter((r) => r && r.motor === motorId && r.modelo).map((r) => ({ motor: motorId, modelo: r.modelo }));
  const fila = catalogo(extras).find((c) => c.motor === motorId);
  return fila ? fila.modelos.map((m) => ({ ...m, perfiles: m.modelo ? perfilesDe(motorId, m.modelo) : perfilesDe(motorId) })) : [];
}

/**
 * FEAT-202 S6 (D9) — La tabla de roles resuelta: cada rol por intención y cada rol de la config, con el motor, el
 * modelo, el esfuerzo y de dónde salió (`config`, una entrada de `motores.roles`, o `defecto`).
 */
function rolesResueltos(config = null) {
  const tabla = (config && config.motores && config.motores.roles) || {};
  const nombres = [...new Set([...Object.keys(ROLES_INTENCION), ...Object.keys(tabla)])];
  return nombres.map((rol) => {
    const e = elegir(config, rol);
    return { rol, motor: e.motor.id, modelo: e.modelo, esfuerzo: e.esfuerzo, cuenta: e.cuenta || null, origen: e.seleccion === 'rol' ? 'config' : 'defecto' };
  });
}

/** Las líneas de `status` para `estadoDeMotores`. */
function lineasDeMotores(estados, ahora = Date.now()) {
  const { resumen } = require('./cupo.js');
  // FEAT-202 S6 (D5) — El cupo pasa por la misma proyección que la API v2 (`proyeccion.js`).
  const { cupoV2 } = require('./proyeccion.js');
  return estados.map((e) => {
    const estado = e.disponible ? 'available' : `not available (${e.motivo})`;
    const roles = e.roles.length ? `; roles: ${e.roles.join(', ')}` : '';
    return `  * ${e.id}: ${estado}; quota: ${resumen(cupoV2(e.cupo), ahora)}${roles}`;
  });
}

/**
 * Un contexto de sondas por proceso para todos los motores, perezoso por
 * motor: `leerSondas(motor, perfil)` y `dispararSondas(motor, perfil)` como los
 * espera el `preflight`. Sin motor es `antigravity` (su `preflight` lo pasa
 * explícito igual).
 *
 * `config` puede ser un valor o una función (para leerla al momento): de ahí
 * sale `motores.claude.bin`.
 *
 * FEAT-085 — `claude@<cuenta>` es un contexto propio, con la carpeta de la
 * cuenta leída de la config al momento (si cambia la carpeta, nace otro). Una
 * cuenta que no está en `motores.cuentas` da un contexto que siempre rechaza y
 * nunca lanza nada.
 *
 * FEAT-202 S2 (D4) — `opencode-go:<modelo>` es la sonda de lectura de un modelo de Go (`sondas-opencode-go.js`). Un
 * modelo que no está en la tabla da un contexto que rechaza. `sin-tools` no usa este contexto.
 */
function crearContextoSondas({ agyBin, homeDir = os.homedir(), log = () => {}, config = null } = {}) {
  let deAgy = null;
  const deClaude = new Map();
  const deGo = new Map();
  const leerConfig = () => (typeof config === 'function' ? config() : config);
  const obtenerBin = () => require('./claude-ejecutar.js').resolverBinario(leerConfig());
  const rechazante = (motivo) => {
    const rechazo = async () => ({ ok: false, motivo });
    return {
      leerSondas: rechazo, dispararSondas: () => {}, dispararSiHaceFalta: async () => [], correrAhora: async () => ({ ocupado: false, entradas: {} }),
      corriendo: () => false, huellaActual: () => null
    };
  };
  const sinCuenta = (cuenta) => rechazante(`la cuenta "${cuenta}" no está en motores.cuentas`);
  // BE-151 — Un motor sin sondas acá (deepseek, uno futuro, un alias) no lee la
  // evidencia de agy: rechaza, y nunca lanza nada.
  const sinSondas = (motor) => rechazante(`el motor "${motor}" no tiene sondas en este proceso`);
  const de = (id) => {
    const go = /^opencode-go:(.+)$/.exec(String(id));
    if (go) {
      const modelo = go[1];
      if (!require('./niveles.js').modeloGo(modelo)) return sinSondas(id);
      if (!deGo.has(modelo)) {
        deGo.set(modelo, require('./sondas-opencode-go.js').crearContextoSondas({
          modelo, homeDir, log, revisar: (o) => require('./lectura-api.js').revisarConLectura({ ...o, homeDir }),
          // S5 — La sonda de edición corre el bucle de edición sobre su repo de prueba.
          editar: (o) => require('./edicion-api.js').editarRepo({ ...o, homeDir })
        }));
      }
      return deGo.get(modelo);
    }
    const [motor, cuenta = null] = String(id).split('@');
    if (motor === claude.id) {
      let configDir = null;
      if (cuenta) {
        const c = leerConfig();
        configDir = (c && c.motores && c.motores.cuentas && c.motores.cuentas[cuenta] && c.motores.cuentas[cuenta].configDir) || null;
        if (!configDir) return sinCuenta(cuenta);
      }
      const clave = `${cuenta || ''}|${configDir || ''}`;
      if (!deClaude.has(clave)) {
        deClaude.set(clave, require('./sondas-claude.js').crearContextoSondas({ homeDir, log, obtenerBin, cuenta, configDir }));
      }
      return deClaude.get(clave);
    }
    if (motor !== antigravity.id || cuenta) return sinSondas(id);
    return (deAgy ||= require('./sondas-antigravity.js').crearContextoSondas({ agyBin, homeDir, log }));
  };
  return {
    leerSondas: (motor = antigravity.id, perfil) => de(motor).leerSondas(perfil),
    dispararSondas: (motor = antigravity.id, perfil) => (/^opencode-go:/.test(String(motor)) ? de(motor).dispararSondas(perfil) : de(motor).dispararSondas()),
    correrAhora: (motor = antigravity.id) => de(motor).correrAhora(),
    // Al arrancar un proceso (el bot): agy siempre; claude solo si algún rol lo
    // usa, así nadie paga sondas de un motor que no configuró. Cada cuenta en
    // uso, lo mismo.
    dispararSiHaceFalta: async () => {
      const v = await de(antigravity.id).dispararSiHaceFalta();
      const config = leerConfig();
      if (usaMotor(config, claude.id)) {
        const cuentas = cuentasEnUso(config);
        const tabla = (config && config.motores && config.motores.roles) || {};
        const sinCuentaEnUso = Object.values(tabla).some(r => r && r.motor === claude.id && !r.cuenta);
        if (sinCuentaEnUso) await de(claude.id).dispararSiHaceFalta();
        for (const cuenta of cuentas) await de(roles.claveDeCuenta(claude.id, cuenta)).dispararSiHaceFalta();
      }
      // S2 — Cada modelo de Go que usa algún rol: solo corre si su lectura es `sondeado` y la sonda no está vigente.
      const tablaGo = (config && config.motores && config.motores.roles) || {};
      const modelosGo = new Set(Object.values(tablaGo).filter((r) => r && r.motor === 'opencode-go' && r.modelo).map((r) => r.modelo));
      for (const modelo of modelosGo) await de(`opencode-go:${modelo}`).dispararSiHaceFalta();
      return v;
    },
    deMotor: de
  };
}

module.exports = {
  MOTORES,
  ROLES_BASE: roles.ROLES_BASE,
  motorPorId,
  elegir,
  usaMotor,
  cuentasEnUso,
  claveDeCuenta: roles.claveDeCuenta,
  faltaEjecutor,
  despachar,
  ENGINE_A_MOTOR,
  ESFUERZO_DEL_ROL,
  enginesPara,
  elegirLlamada,
  errorDeDueno,
  despacharLectura,
  despacharEdicion,
  despacharAgy,
  EXCEPCIONES_AGY,
  faltaPerfil,
  estadoDeMotores,
  lineasDeMotores,
  modelosDe,
  rolesResueltos,
  crearContextoSondas
};
