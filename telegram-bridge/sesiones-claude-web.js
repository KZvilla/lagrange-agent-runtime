/**
 * FEAT-169 F4 — Las sesiones /claude desde la consola web: catálogo, lanzar,
 * detener, purgar worktrees limpios y leer el log de cada sesión. Lo mismo que
 * `/claude` de Telegram, sin Telegram: devuelve datos y la UI los pinta.
 *
 * Todo se revalida en el servidor (como `rc_acct:`): el proyecto tiene que
 * seguir en la lista, la cuenta configurada y confiable ahí. Las dependencias
 * son inyectables para los tests; bot.js cablea las reales.
 */
import path from 'node:path';
import { RE_CLAVE_SESION_CLAUDE } from './claude-launcher.js';

const RE_WS = /^[0-9a-f]{8}$/;
const RE_URL = /https:\/\/claude\.ai\/code\?environment=env_[A-Za-z0-9_-]+/g;
const LINEAS_LOG = [30, 100, 300];
const ESPERA_ARRANQUE_MS = 800;

const mismaRuta = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Por cada proyecto de las sesiones detenidas, sus worktrees de Claude limpios
 * y con cambios. Lo comparten la consola y el mensaje de Telegram.
 * Un proyecto que falla al inspeccionarse se salta (se avisa por `alFallar`).
 *
 * @returns {Array<{ projectPath: string, wsId: string|null, cleanWorktrees: object[], dirtyWorktrees: object[] }>}
 */
export function inspeccionarParada(stopRes, workspaces, inspectFn, alFallar = () => {}) {
  const detenidas = Array.isArray(stopRes?.stopped) && stopRes.stopped.length > 0
    ? stopRes.stopped
    : [{ projectPath: stopRes?.projectPath }];
  const proyectos = [];
  for (const s of detenidas) {
    if (s.projectPath && !proyectos.some((p) => mismaRuta(p, s.projectPath))) proyectos.push(s.projectPath);
  }
  const salida = [];
  for (const projectPath of proyectos) {
    try {
      const { cleanWorktrees, dirtyWorktrees } = inspectFn(projectPath);
      const ws = workspaces.find((w) => mismaRuta(w.path, projectPath));
      salida.push({ projectPath, wsId: ws ? ws.id : null, cleanWorktrees: cleanWorktrees || [], dirtyWorktrees: dirtyWorktrees || [] });
    } catch (err) {
      alFallar(err);
    }
  }
  return salida;
}

/** El último enlace de Remote Control que escribió la sesión, o null. */
export function urlDeLog(texto) {
  const m = String(texto || '').match(RE_URL);
  return m && m.length ? m[m.length - 1] : null;
}

/**
 * @param {object} deps
 * @param {() => object[]} deps.workspaces       getKnownWorkspaces
 * @param {() => object|null} deps.config        configDeLagrange
 * @param {(config) => object[]} deps.cuentas    getConfiguredClaudeAccounts({ config })
 * @param {() => object[]} deps.activas          getActiveClaudeSessions
 * @param {Function} deps.lanzar                 launchClaudeRemoteSession
 * @param {Function} deps.detener                stopClaudeRemoteSession
 * @param {Function} deps.inspeccionar           inspectClaudeWorktrees
 * @param {Function} deps.purgar                 pruneCleanClaudeWorktrees
 * @param {(key, lineas) => string[]|null} deps.leerLog  la cola del log de esa clave (null: no hay)
 * @param {(pid) => boolean} deps.pidVivo
 * @param {(ms) => Promise} [deps.esperar]
 * @param {(texto) => string} [deps.redactar]   redactSecrets
 */
export function crearSesionesClaudeWeb({
  workspaces, config, cuentas, activas, lanzar, detener, inspeccionar, purgar, leerLog, pidVivo,
  esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
  redactar = (t) => t
}) {
  const fallo = (codigo, error, extra = {}) => ({ ok: false, codigo, error, ...extra });
  const etiquetas = (lista) => lista.map((c) => ({ cuenta: c.account, etiqueta: c.label && c.label !== c.account ? c.label : null }));
  const nombre = (p) => path.basename(p || '');
  const urlDe = (key) => {
    try { return urlDeLog((leerLog(key, 300) || []).join('\n')); } catch { return null; }
  };
  const sesionPublica = (s, lista) => {
    const ws = lista.find((w) => s.projectPath && mismaRuta(w.path, s.projectPath));
    return {
      key: s.key, cuenta: s.account, proyecto: nombre(s.projectPath), wsId: ws ? ws.id : null,
      sessionName: s.sessionName, pid: s.pid, modo: s.spawnMode || null, desde: s.startedAt || null, url: urlDe(s.key)
    };
  };
  const contexto = () => {
    const cfg = config();
    return { cfg, lista: cuentas(cfg), sc: (cfg && cfg.sesionesClaude) || null };
  };
  const colaDeLog = (key, lineas) => {
    const cola = leerLog(key, lineas);
    return cola === null ? null : redactar(cola.join('\n'));
  };

  return {
    vista() {
      const { lista, sc } = contexto();
      const ws = workspaces();
      const porDefecto = (sc && sc.cuentaPorDefecto) || null;
      return {
        ok: true,
        cuentas: etiquetas(lista),
        cuentaPorDefecto: porDefecto,
        maxSesiones: (sc && sc.maxSesiones) || 3,
        proyectos: ws.map((w) => ({
          id: w.id,
          nombre: w.displayName || w.name || nombre(w.path),
          ruta: w.path,
          cuentas: w.trustedAccounts || [],
          // La que usaría `/claude <proyecto>` sin cuenta: la fija, si no la por defecto si es confiable, si no la primera.
          cuentaSugerida: w.preferredAccount || ((w.trustedAccounts || []).includes(porDefecto) ? porDefecto : (w.trustedAccounts || [])[0] || null),
          modo: w.spawnMode || null
        })),
        sesiones: activas().map((s) => sesionPublica(s, ws))
      };
    },

    async lanzar(cuerpo) {
      const wsId = typeof cuerpo?.wsId === 'string' ? cuerpo.wsId : '';
      if (!RE_WS.test(wsId)) return fallo(400, 'Elegí un proyecto.');
      const { cfg, lista } = contexto();
      const ws = workspaces().find((w) => w.id === wsId);
      if (!ws) return fallo(404, 'Ese proyecto ya no está en la lista: recargá.');
      let cuenta = cuerpo?.cuenta === undefined || cuerpo?.cuenta === null || cuerpo?.cuenta === '' ? null : cuerpo.cuenta;
      const confiables = ws.trustedAccounts || [];
      if (cuenta !== null) {
        if (typeof cuenta !== 'string' || !lista.some((c) => c.account === cuenta)) return fallo(400, 'Esa cuenta no está configurada.');
        if (!confiables.includes(cuenta)) return fallo(400, `El proyecto no es confiable en la cuenta "${cuenta}".`);
      } else if (confiables.length > 1 && !ws.preferredAccount) {
        // La consola siempre dice con cuál; sin cuenta y con varias, que elija.
        return fallo(409, 'Elegí con qué cuenta abrirlo.', { elegirCuenta: true, cuentas: confiables });
      }
      const r = lanzar({ workspacePath: ws.path, account: cuenta, accounts: lista, config: cfg });
      if (!r.success) {
        if (r.limitReached) return fallo(409, r.error, { tope: true });
        return fallo(400, r.error);
      }
      const sesion = { key: r.key, cuenta: r.account, proyecto: nombre(r.projectPath), wsId, sessionName: r.sessionName, pid: r.pid, modo: r.spawnMode || null };
      if (r.alreadyRunning) return { ok: true, yaActiva: true, sesion: { ...sesion, url: r.key ? urlDe(r.key) : null } };
      // Como Telegram: si muere en los primeros 800 ms, es confianza o login; el log lo dice.
      await esperar(ESPERA_ARRANQUE_MS);
      if (!pidVivo(r.pid)) {
        return fallo(502, 'El proceso de Claude Code se cerró al arrancar.', { log: colaDeLog(r.key, 30) });
      }
      return { ok: true, sesion: { ...sesion, url: urlDe(r.key) } };
    },

    detener(cuerpo) {
      const todas = cuerpo?.all === true;
      const key = typeof cuerpo?.key === 'string' ? cuerpo.key : null;
      if (!todas && (!key || !RE_CLAVE_SESION_CLAUDE.test(key))) return fallo(400, 'Decí qué sesión detener.');
      const r = detener(todas ? { all: true } : { key });
      if (!r.success) return fallo(404, r.error || 'No se pudo detener la sesión.');
      const proyectos = inspeccionarParada(r, workspaces(), inspeccionar, (err) => console.warn(`[claude-stop] Error inspeccionando worktrees: ${err.message}`))
        .map((p) => ({
          wsId: p.wsId,
          proyecto: nombre(p.projectPath),
          limpios: p.cleanWorktrees.length,
          conCambios: p.dirtyWorktrees.map((w) => ({ rama: w.branch, motivo: w.reason }))
        }));
      return {
        ok: true,
        detenidas: (r.stopped || []).map((s) => ({ key: s.key, cuenta: s.account, pid: s.pid, proyecto: nombre(s.projectPath) })),
        proyectos
      };
    },

    limpiar(cuerpo) {
      const wsId = typeof cuerpo?.wsId === 'string' ? cuerpo.wsId : '';
      if (!RE_WS.test(wsId)) return fallo(400, 'Proyecto inválido.');
      const ws = workspaces().find((w) => w.id === wsId);
      if (!ws) return fallo(404, 'No se encontró el proyecto.');
      const r = purgar(ws.path);
      return {
        ok: true,
        proyecto: nombre(ws.path),
        borrados: r.removedCount || 0,
        conservados: (r.preservedWorktrees || []).map((w) => ({ rama: w.branch, motivo: w.reason }))
      };
    },

    log(key, n) {
      if (typeof key !== 'string' || !RE_CLAVE_SESION_CLAUDE.test(key)) return fallo(400, 'Sesión inválida.');
      const lineas = LINEAS_LOG.includes(Number(n)) ? Number(n) : LINEAS_LOG[0];
      const contenido = colaDeLog(key, lineas);
      return contenido === null ? { ok: true, contenido: null, aviso: 'Esa sesión no tiene log.' } : { ok: true, contenido };
    }
  };
}
