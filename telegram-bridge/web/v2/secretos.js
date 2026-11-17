/**
 * FEAT-201 F0.8 (S6) — El daemon como intermediario de secretos, con caché de sesión.
 *
 * Apagado por defecto: se enciende con `LAGRANGE_SECRETOS_INTERMEDIARIO=1` en
 * el `.env` del bridge. El TTL sale de `LAGRANGE_SECRETOS_CACHE` (`5m` a `24h`,
 * o `daemon` para toda la vida del proceso; 12 h por defecto).
 *
 * - Credencial propia (`secretos.json`), distinta de la de la API v2 y de la
 *   consola: la interfaz no puede pedir secretos.
 * - Lista blanca por dominio: las ENTRADAS a las que apuntan las variables del
 *   dominio (`keepassxc:<entrada>`), no los nombres de las variables. `motores`:
 *   KEYS_DE_MOTORES; `bots`: los TELEGRAM_BOT*_TOKEN.
 * - Single-flight: dos pedidos de la misma entrada mientras se lee producen una
 *   sola consulta a KeePassXC.
 * - Contadores y registro de lecturas, sin el valor. «Olvidar todo».
 * - Si la base está bloqueada y no hay copia en caché, el pedido falla con el
 *   motivo y se avisa una vez por hora por entrada.
 *
 * Riesgo aceptado (plan padre, F0.8): mientras dura la caché, un proceso del
 * usuario que lea `secretos.json` obtiene la key sin el diálogo de KeePassXC.
 */
export const ARCHIVO_SECRETOS = 'secretos.json';
export const TTL_POR_DEFECTO_MS = 12 * 60 * 60 * 1000;
const DOMINIOS = new Set(['motores', 'bots']);
const TOPE_REGISTRO = 50;
const AVISO_CADA_MS = 60 * 60 * 1000;

export function intermediarioEncendido(env = process.env) {
  return String(env.LAGRANGE_SECRETOS_INTERMEDIARIO || '').trim() === '1';
}

/** `5m`…`24h` → ms; `daemon` → Infinity; otra cosa → 12 h. */
export function ttlDesde(valor) {
  const v = String(valor || '').trim().toLowerCase();
  if (v === 'daemon') return Infinity;
  const m = /^(\d+)(m|h)$/.exec(v);
  if (!m) return TTL_POR_DEFECTO_MS;
  const ms = Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000);
  return ms >= 5 * 60_000 && ms <= 24 * 3_600_000 ? ms : TTL_POR_DEFECTO_MS;
}

/**
 * `secretos`: el módulo `mcp-server/lib/secretos.js` (resolver, entradaDe,
 * esReferencia, KEYS_DE_MOTORES, RE_TOKEN_TELEGRAM). `reEntrada`: la de
 * keepassxc.js. `avisarBloqueada(entrada)`: el aviso por Telegram.
 * `env`: un objeto o una función que lo devuelve. El daemon pasa una función que lee el `.env` del bridge en cada
 * pedido: las keys de motor no están en su entorno (FEAT-166) y los tokens de bots ya están resueltos ahí.
 */
export function crearIntermediario({ env: envFuente = process.env, secretos, reEntrada, ttlMs = TTL_POR_DEFECTO_MS, ahora = Date.now, avisarBloqueada = () => {} }) {
  const cache = new Map(); // entrada → { valor, hasta }
  const enCurso = new Map(); // entrada → promesa
  const contadores = new Map(); // entrada → { dominio, lecturas, desdeCache, fallos, ultima, ultimoCliente }
  const registro = [];
  const avisos = new Map();

  function listaBlanca(dominio) {
    const env = typeof envFuente === 'function' ? (envFuente() || {}) : envFuente;
    const variables = dominio === 'motores'
      ? secretos.KEYS_DE_MOTORES
      : Object.keys(env).filter((k) => secretos.RE_TOKEN_TELEGRAM.test(k));
    const entradas = new Set();
    for (const v of variables) {
      const valor = env[v];
      if (!secretos.esReferencia(valor)) continue;
      const entrada = secretos.entradaDe(valor);
      if (reEntrada.test(entrada)) entradas.add(entrada);
    }
    return entradas;
  }

  const contador = (entrada, dominio) => {
    let c = contadores.get(entrada);
    if (!c) { c = { dominio, lecturas: 0, desdeCache: 0, fallos: 0, ultima: null, ultimoCliente: null }; contadores.set(entrada, c); }
    return c;
  };
  const anotar = (entrada, cliente, resultado) => {
    registro.push({ hora: new Date(ahora()).toISOString(), entrada, cliente: cliente || null, resultado });
    if (registro.length > TOPE_REGISTRO) registro.shift();
  };

  async function leer(dominio, entrada, { cliente = null } = {}) {
    if (!DOMINIOS.has(dominio)) return { ok: false, codigo: 400, error: 'dominio: motores o bots.' };
    if (!reEntrada.test(String(entrada)) || !listaBlanca(dominio).has(entrada)) {
      return { ok: false, codigo: 403, error: 'Esa entrada no la referencia ninguna variable de ese dominio.' };
    }
    const c = contador(entrada, dominio);
    c.lecturas += 1;
    c.ultima = new Date(ahora()).toISOString();
    c.ultimoCliente = cliente;
    const guardado = cache.get(entrada);
    if (guardado && guardado.hasta > ahora()) {
      c.desdeCache += 1;
      anotar(entrada, cliente, 'cache');
      return { ok: true, valor: guardado.valor };
    }
    if (!enCurso.has(entrada)) {
      enCurso.set(entrada, secretos.resolver(`${secretos.PREFIJO}${entrada}`, { usarCache: false })
        .finally(() => enCurso.delete(entrada)));
    }
    const r = await enCurso.get(entrada);
    if (!r.valor) {
      c.fallos += 1;
      anotar(entrada, cliente, 'fallo');
      if (r.codigo === 'bloqueada' || /bloquead/i.test(String(r.motivo || ''))) {
        const ultimo = avisos.get(entrada);
        if (ultimo === undefined || ahora() - ultimo >= AVISO_CADA_MS) { avisos.set(entrada, ahora()); try { avisarBloqueada(entrada); } catch {} }
      }
      return { ok: false, codigo: 503, error: r.motivo || 'No se pudo leer de KeePassXC.' };
    }
    cache.set(entrada, { valor: r.valor, hasta: ttlMs === Infinity ? Infinity : ahora() + ttlMs });
    anotar(entrada, cliente, 'keepassxc');
    return { ok: true, valor: r.valor };
  }

  return {
    leer,
    olvidarTodo() { cache.clear(); return { ok: true }; },
    /** Para la pestaña Salud: nunca el valor. */
    estado() {
      return {
        activo: true,
        ttlSegundos: ttlMs === Infinity ? null : Math.round(ttlMs / 1000),
        entradas: [...contadores.entries()].map(([entrada, c]) => {
          const g = cache.get(entrada);
          const queda = g && g.hasta > ahora() ? (g.hasta === Infinity ? null : Math.round((g.hasta - ahora()) / 1000)) : 0;
          return { entrada, dominio: c.dominio, enCache: Boolean(g && g.hasta > ahora()), quedaSegundos: queda, lecturas: c.lecturas, desdeCache: c.desdeCache, fallos: c.fallos, ultima: c.ultima, ultimoCliente: c.ultimoCliente };
        }),
        lecturas: registro.slice(-10)
      };
    }
  };
}
