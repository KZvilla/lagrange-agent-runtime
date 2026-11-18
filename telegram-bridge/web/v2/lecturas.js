/**
 * FEAT-201 F0 S4 — Las rutas de lectura del contrato v2 y los productores que
 * las acompañan (salud y sesiones de Claude remoto).
 *
 * Las que tienen agregado en el contrato (sujetos, turnos, carriles, sesiones
 * remotas, salud) se devuelven con esa forma. Las demás delegan en el núcleo y
 * devuelven lo mismo que su ruta v1: un test lo compara fila por fila.
 *
 * El id de un sujeto en v2 es su clave (alma) o su nombre (agente). Si un alma
 * y un agente se llamaran igual, gana el alma: es lo que hace la consola al
 * resolver `sujeto:<id>`.
 */
import { turnoDe, carrilesDe } from './productores.js';

const RE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECCIONES = Object.freeze({
  alma: ['memoria', 'hilo', 'diario'],
  agente: ['contexto', 'criterio', 'cuarentena', 'reglas']
});
const TOPE_TURNOS = 50;
const INTERVALO_CLAUDE_MS = 5000;
const PAUSA_SALUD_MS = 5 * 60 * 1000;
const INTERVALO_SALUD_MS = 5000;

const error = (codigo, texto) => ({ codigo, ok: false, error: texto });

export function sujetoV2(s, tipo) {
  const enCurso = Boolean(s.enCurso);
  if (tipo === 'alma') {
    return { tipo, id: String(s.clave), nombre: String(s.voz || s.clave), voz: s.voz ? String(s.voz) : null, ultimaActividad: s.ultima || null, pensando: enCurso };
  }
  return { tipo, id: String(s.nombre), nombre: String(s.nombre), voz: null, ultimaActividad: s.ultima || null, pensando: enCurso };
}

export function sesionRemotaV2(s) {
  return {
    key: String(s.key), nombre: String(s.sessionName || s.key), cuenta: String(s.cuenta || ''), proyecto: String(s.proyecto || ''),
    modo: s.modo || null, desde: s.desde ? String(s.desde) : null, url: s.url || null
  };
}

/** La salud del proceso, con la última muestra del recolector v2 si está muestreando. */
export function saludV2({ recolector, arranque, version, secretos = null, proceso = process }) {
  const m = proceso.memoryUsage();
  const inst = recolector ? recolector.instantanea() : null;
  const ultima = inst && inst.enabled ? inst.muestras.at(-1) : null;
  const elu = ultima?.eventLoop?.utilizacion;
  return {
    pid: proceso.pid, arranque, version: version || null, arribaSegundos: proceso.uptime(),
    memoria: { rss: m.rss, heapUsed: m.heapUsed },
    eventLoop: Number.isFinite(elu) ? { utilizacion: Math.min(1, Math.max(0, elu)), muestras: inst.muestras.length } : null,
    // S6 — El intermediario de secretos, si está encendido: entradas, contadores y lecturas, nunca el valor.
    ...(secretos ? { secretos: secretos.estado() } : {})
  };
}

/** F1 S0 — Un workspace con la forma del agregado `workspace`. */
export function workspaceV2(w) {
  return { id: String(w.id).slice(0, 200), nombre: String(w.nombre ?? w.id).slice(0, 200), favorito: w.favorito === true };
}

export function rutasLecturaV2({ nucleo, estadoDeCarriles, recorte, extras = null, recolector = null, arranque, version = null, secretos = null, chatTerminal = null }) {
  async function resolverSujeto(id) {
    if (!RE_ID.test(String(id))) return null;
    const s = await nucleo.sujetos();
    const alma = (s.almas || []).find((a) => a.clave === id);
    if (alma) return { tipo: 'alma', id, clave: `alma:${id}`, datos: alma };
    const agente = (s.agentes || []).find((a) => a.nombre === id);
    if (agente) return { tipo: 'agente', id, clave: `agente:${id}`, datos: agente };
    return null;
  }

  const seccion = {
    memoria: (id) => nucleo.memoria(id),
    hilo: (id) => nucleo.hiloAlma(id),
    diario: (id) => nucleo.diarioAlma(id),
    contexto: (id) => nucleo.contextoAgente(id),
    criterio: (id) => nucleo.criterioAgente(id),
    cuarentena: (id) => nucleo.cuarentenaAgente(id),
    reglas: (id) => nucleo.reglasAgente(id)
  };

  return [
    { metodo: 'GET', patron: /^\/api\/v2\/sujetos\/?$/, fn: async () => {
      const s = await nucleo.sujetos();
      return { ok: true, sujetos: [...(s.almas || []).map((a) => sujetoV2(a, 'alma')), ...(s.agentes || []).map((a) => sujetoV2(a, 'agente'))] };
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/sujetos\/([^/]+)\/turnos\/?$/, fn: async ({ p, url }) => {
      const s = await resolverSujeto(p[0]);
      if (!s) return error(404, 'No existe ese sujeto.');
      const r = await nucleo.tareas(s.clave);
      if (r.ok === false) return r;
      let lista = [...r.tareas].sort((a, b) => String(a.creada).localeCompare(String(b.creada)));
      const antes = url.searchParams.get('antes');
      if (antes) {
        const i = lista.findIndex((t) => t.id === antes);
        lista = i >= 0 ? lista.slice(0, i) : [];
      }
      const n = Math.min(TOPE_TURNOS, Math.max(1, Number(url.searchParams.get('n')) || TOPE_TURNOS));
      const pagina = lista.slice(-n);
      return { ok: true, sujeto: { tipo: s.tipo, id: s.id }, turnos: pagina.map((t) => turnoDe(t, { recorte, extras })), hayMas: lista.length > pagina.length };
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/sujetos\/([^/]+)\/panel\/?$/, fn: async ({ p, url }) => {
      const s = await resolverSujeto(p[0]);
      if (!s) return error(404, 'No existe ese sujeto.');
      const validas = SECCIONES[s.tipo];
      const pedidas = (url.searchParams.get('secciones') || validas.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
      const desconocidas = pedidas.filter((x) => !validas.includes(x));
      if (desconocidas.length) return error(400, `Secciones de ${s.tipo}: ${validas.join(', ')}.`);
      // Un fallo de sección no tumba las demás.
      const secciones = {};
      await Promise.all(pedidas.map(async (x) => {
        try { secciones[x] = await seccion[x](s.id); } catch (err) { secciones[x] = { ok: false, error: String(err?.message || err).slice(0, 300) }; }
      }));
      return { ok: true, sujeto: { tipo: s.tipo, id: s.id }, secciones };
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/sujetos\/([^/]+)\/archivo\/?$/, fn: async ({ p, url }) => {
      const s = await resolverSujeto(p[0]);
      if (!s || s.tipo !== 'alma') return error(404, 'No existe esa alma.');
      return nucleo.buscarProfunda(s.id, url.searchParams.get('q'));
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/agentes\/([^/]+)\/reglas\/?$/, fn: ({ p }) => nucleo.reglasAgente(p[0]) },
    { metodo: 'GET', patron: /^\/api\/v2\/agentes\/([^/]+)\/reglas\/([^/]+)\/?$/, fn: ({ p }) => nucleo.reglaAgente(p[0], p[1]) },
    // F1 S0 — El favorito es el del chat de la terminal, no el de la consola.
    { metodo: 'GET', patron: /^\/api\/v2\/workspaces\/?$/, fn: () => {
      const r = nucleo.workspaces({ chat: chatTerminal });
      if (!r || r.ok === false) return r;
      return { ok: true, workspaces: (r.workspaces || []).map(workspaceV2) };
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/motores\/?$/, fn: () => nucleo.motores() },
    { metodo: 'GET', patron: /^\/api\/v2\/motores\/cupo\/?$/, fn: ({ url }) => nucleo.cupoMotor(url.searchParams.get('motor')) },
    { metodo: 'GET', patron: /^\/api\/v2\/carriles\/?$/, fn: () => ({ ok: true, carriles: carrilesDe(estadoDeCarriles()) }) },
    { metodo: 'GET', patron: /^\/api\/v2\/claude\/sesiones\/?$/, fn: async () => {
      const v = await nucleo.claude();
      if (!v || v.ok === false || v.error) return v?.codigo ? v : error(503, String(v?.error || 'Claude remoto no disponible.'));
      return { ok: true, sesiones: (v.sesiones || []).map(sesionRemotaV2), maxSesiones: v.maxSesiones ?? null };
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/telegram\/hilos\/?$/, fn: async () => {
      const r = await nucleo.sesiones();
      return { ok: true, hilos: Array.isArray(r.chats) ? r.chats : [] };
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/logs\/?$/, fn: ({ url }) => nucleo.logs(url.searchParams.get('n')) },
    { metodo: 'GET', patron: /^\/api\/v2\/salud\/?$/, fn: () => ({ ok: true, ...saludV2({ recolector, arranque, version, secretos }) }) }
  ];
}

/**
 * Salud y Claude remoto: productores que solo trabajan mientras alguien escucha
 * su tema. El recolector se reanuda con el primer suscriptor a `salud` y se
 * pausa a los 5 minutos sin suscriptores. Claude remoto se compara cada 5 s.
 */
export function crearProductoresLectura({
  almacen, recolector = null, nucleo, arranque, version = null, secretos = null,
  pausaMs = PAUSA_SALUD_MS, intervaloSaludMs = INTERVALO_SALUD_MS, intervaloClaudeMs = INTERVALO_CLAUDE_MS
}) {
  let relojSalud = null;
  let relojPausa = null;
  let relojClaude = null;
  let previas = null;

  const publicarSalud = () => almacen.publicar('salud', 'salud', saludV2({ recolector, arranque, version, secretos }));
  const compararClaude = async () => {
    let v;
    try { v = await nucleo.claude(); } catch { return; }
    if (!v || !Array.isArray(v.sesiones)) return;
    const ahora = new Map(v.sesiones.map((s) => [String(s.key), sesionRemotaV2(s)]));
    if (previas) {
      for (const [key, s] of ahora) {
        const antes = previas.get(key);
        if (!antes) almacen.publicar('claude', 'claude.sesion.alta', s);
        else if (!antes.url && s.url) almacen.publicar('claude', 'claude.sesion.enlace', s);
      }
      for (const key of previas.keys()) if (!ahora.has(key)) almacen.publicar('claude', 'claude.sesion.baja', { key });
    }
    previas = ahora;
  };

  const ajustar = () => {
    if (almacen.hayInteres('salud')) {
      if (relojPausa) { clearTimeout(relojPausa); relojPausa = null; }
      if (recolector) recolector.reanudar();
      if (!relojSalud) { relojSalud = setInterval(publicarSalud, intervaloSaludMs); relojSalud.unref?.(); }
    } else if (relojSalud) {
      clearInterval(relojSalud);
      relojSalud = null;
      if (recolector && !relojPausa) {
        relojPausa = setTimeout(() => { relojPausa = null; recolector.pausar(); }, pausaMs);
        relojPausa.unref?.();
      }
    }
    if (almacen.hayInteres('claude')) {
      if (!relojClaude) { previas = null; compararClaude(); relojClaude = setInterval(compararClaude, intervaloClaudeMs); relojClaude.unref?.(); }
    } else if (relojClaude) {
      clearInterval(relojClaude);
      relojClaude = null;
    }
  };
  const baja = almacen.alCambiarSuscriptores(ajustar);

  return {
    compararClaude,
    cerrar() {
      baja();
      for (const r of [relojSalud, relojClaude]) if (r) clearInterval(r);
      if (relojPausa) clearTimeout(relojPausa);
      relojSalud = relojClaude = relojPausa = null;
    }
  };
}
