/**
 * FEAT-069 — Los proveedores con los que trabaja Lagrange: qué versión corre,
 * si hay una nueva y qué trae. Informa; nunca actualiza.
 *
 * Desde BE-034, Lagrange lanza agy con el actualizador apagado. Actualizar es
 * decisión del usuario, en su terminal (`agy update`); acá solo se le avisa.
 * La web no ejecuta nada en el host (D4 de FEAT-057).
 *
 * Sumar un proveedor es agregar una entrada a `PROVEEDORES`; no hay clases ni
 * interfaz a propósito. FEAT-137 — Claude Code es el segundo, si quien crea la
 * lista sabe consultar su versión (`versionClaude`).
 *
 * Red: dos fuentes públicas, cada una con URL fija, sin seguir redirecciones,
 * con timeout y un tope de tamaño que corta la descarga (se lee el cuerpo por
 * partes; `res.text()` bajaría todo antes de poder medir). Se consultan solo
 * cuando alguien las pide: un éxito vale 6 h, un fallo 10 min (GitHub sin
 * autenticar da 60 pedidos por hora: reintentar en cada recarga los agotaría).
 * CommonJS: lo usan el MCP (`agy_status`) y el bridge (con `createRequire`).
 */
const { resumenUso } = require('./uso-agy.js');

const BASE_MANIFIESTO = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/';
const URL_RELEASES = 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases?per_page=10';
const URL_REPO = 'https://github.com/google-antigravity/antigravity-cli';
// FEAT-137 — Claude Code: la última versión y las notas salen de sus releases.
// Publica casi a diario y cada release trae un changelog largo (~30 KB): el
// tope es más alto que el de agy.
const URL_RELEASES_CLAUDE = 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=10';
const URL_REPO_CLAUDE = 'https://github.com/anthropics/claude-code';
const TOPE_RELEASES_CLAUDE = 1024 * 1024;
const VALIDEZ_MS = 6 * 60 * 60 * 1000;
const VALIDEZ_FALLO_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;
const TOPE_MANIFIESTO = 64 * 1024;
const TOPE_RELEASES = 256 * 1024;
const TOPE_CAMBIOS = 40;
const TOPE_TEXTO_CAMBIO = 600;
const AGENTE_HTTP = 'lagrange-agent-runtime';
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** Nombre del manifiesto como lo arma el instalador oficial (`<os>_<arch>`). */
function nombrePlataforma(platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  return os && cpu ? `${os}_${cpu}` : null;
}

/** `x.y.z` dentro de un texto (`agy --version` imprime solo el número). */
function extraerVersion(texto) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(texto || ''));
  return m ? m[1] : null;
}

/** <0, 0 o >0; `null` si alguna no es x.y.z. */
function compararVersiones(a, b) {
  const x = VERSION.exec(String(a || ''));
  const y = VERSION.exec(String(b || ''));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  return 0;
}

/**
 * GET acotado: sin redirecciones, con timeout y cortando al pasar el tope.
 * Devuelve el texto o lanza.
 */
async function pedirAcotado(url, { pedir = fetch, timeoutMs = TIMEOUT_MS, tope, headers = {} } = {}) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), timeoutMs);
  try {
    const res = await pedir(url, { redirect: 'error', signal: control.signal, headers: { 'User-Agent': AGENTE_HTTP, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body || typeof res.body.getReader !== 'function') throw new Error('respuesta sin cuerpo legible');
    const lector = res.body.getReader();
    const partes = [];
    let total = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > tope) {
        control.abort();
        throw new Error(`respuesta de más de ${tope} bytes`);
      }
      partes.push(value);
    }
    return Buffer.concat(partes.map((p) => Buffer.from(p))).toString('utf8');
  } finally {
    clearTimeout(reloj);
  }
}

/** Solo la versión del manifiesto; `url` y `sha512` se descartan. */
function versionDeManifiesto(texto) {
  const datos = JSON.parse(texto);
  const v = datos && typeof datos.version === 'string' ? datos.version.trim() : '';
  if (!VERSION.test(v)) throw new Error('versión inválida en el manifiesto');
  return v;
}

/** Texto plano de una viñeta: sin HTML ni saltos, acotado. */
function limpiar(texto) {
  return String(texto)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TOPE_TEXTO_CAMBIO);
}

/**
 * Las notas de las versiones posteriores a `instalada` y hasta `ultima`,
 * de la más nueva a la más vieja. Cada cambio es una viñeta (`- `) del release.
 */
function notasEntre(texto, instalada, ultima, repo = URL_REPO) {
  const releases = JSON.parse(texto);
  if (!Array.isArray(releases)) throw new Error('lista de releases inválida');
  const notas = [];
  for (const r of releases) {
    const version = typeof r?.tag_name === 'string' ? r.tag_name.replace(/^v/, '') : '';
    if (!VERSION.test(version) || r.draft || r.prerelease) continue;
    if (instalada && compararVersiones(version, instalada) <= 0) continue;
    if (ultima && compararVersiones(version, ultima) > 0) continue;
    const cambios = String(r.body || '')
      .split(/\r?\n/)
      .filter((l) => /^\s*[-*]\s+/.test(l))
      .map((l) => limpiar(l.replace(/^\s*[-*]\s+/, '')))
      .filter(Boolean)
      .slice(0, TOPE_CAMBIOS);
    const fecha = typeof r.published_at === 'string' && !Number.isNaN(Date.parse(r.published_at)) ? r.published_at : null;
    notas.push({ version, fecha, cambios, enlace: `${repo}/releases/tag/${encodeURIComponent(r.tag_name)}` });
  }
  return notas.sort((a, b) => compararVersiones(b.version, a.version));
}

/** FEAT-137 — La versión más nueva publicada (sin borradores ni prereleases) de una lista de releases. */
function ultimaDeReleases(texto) {
  const releases = JSON.parse(texto);
  if (!Array.isArray(releases)) throw new Error('lista de releases inválida');
  let ultima = null;
  for (const r of releases) {
    const version = typeof r?.tag_name === 'string' ? r.tag_name.replace(/^v/, '') : '';
    if (!VERSION.test(version) || r.draft || r.prerelease) continue;
    if (!ultima || compararVersiones(version, ultima) > 0) ultima = version;
  }
  if (!ultima) throw new Error('sin versiones publicadas');
  return ultima;
}

/** Una fuente con caché: un éxito dura 6 h, un fallo 10 min. */
function fuente(obtener, ahora) {
  let cache = null; // { valor, error, vence, cuando }
  let ultimoBueno = null; // { valor, cuando }
  let enVuelo = null;
  return async () => {
    const t = ahora();
    if (cache && t < cache.vence) return { ...cache, ultimoBueno };
    if (!enVuelo) {
      enVuelo = (async () => {
        try {
          const valor = await obtener();
          cache = { valor, error: null, vence: ahora() + VALIDEZ_MS, cuando: ahora() };
          ultimoBueno = { valor, cuando: cache.cuando };
        } catch (err) {
          cache = { valor: null, error: String(err?.message || err).slice(0, 200), vence: ahora() + VALIDEZ_FALLO_MS, cuando: ahora() };
        } finally {
          enVuelo = null;
        }
      })();
    }
    await enVuelo;
    return { ...cache, ultimoBueno };
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.versionInstalada  () => texto de `agy --version` (o de su fallo)
 * @param {Function} [deps.pedir]           fetch
 * @param {Function} [deps.ahora]           () => ms
 * @param {Function} [deps.uso]             () => resumenUso() o null
 * @param {string}   [deps.plataforma]      nombre del manifiesto; por defecto el de este equipo
 * @param {Function} [deps.versionClaude]   FEAT-137 — () => texto de `claude --version`; sin él no hay tarjeta de Claude Code
 * @param {Function} [deps.imagenClaude]    () => versión de Claude Code que fija la imagen de lotes, o null
 * @param {Function} [deps.sondasClaude]    () => { cuentas: { <cuenta>: { ok, huella, en } } } de las sondas de lotes
 * @param {string}   [deps.versionLagrange] para saber si la huella de una sonda sigue vigente
 */
function crearProveedores({
  versionInstalada, pedir = fetch, ahora = Date.now, uso = () => resumenUso(), plataforma = nombrePlataforma(),
  versionClaude = null, imagenClaude = () => null, sondasClaude = () => null, versionLagrange = null
} = {}) {
  const manifiesto = fuente(async () => {
    if (!plataforma) throw new Error('plataforma sin build publicada');
    return versionDeManifiesto(await pedirAcotado(`${BASE_MANIFIESTO}${plataforma}.json`, { pedir, tope: TOPE_MANIFIESTO }));
  }, ahora);
  const releases = fuente(() => pedirAcotado(URL_RELEASES, {
    pedir, tope: TOPE_RELEASES, headers: { Accept: 'application/vnd.github+json' }
  }), ahora);

  async function antigravity() {
    const instalada = extraerVersion(versionInstalada());
    const m = await manifiesto();
    const ultima = m.valor || m.ultimoBueno?.valor || null;
    const cmp = instalada && ultima ? compararVersiones(ultima, instalada) : null;
    const estado = cmp === null ? 'desconocido' : cmp > 0 ? 'disponible' : 'al-dia';

    let notas = [];
    let notasError = null;
    if (estado === 'disponible') {
      const r = await releases();
      const texto = r.valor || r.ultimoBueno?.valor;
      if (texto) {
        try { notas = notasEntre(texto, instalada, ultima); } catch (err) { notasError = err.message; }
      } else {
        notasError = r.error;
      }
    }

    return {
      id: 'antigravity',
      nombre: 'Antigravity CLI',
      instalada,
      ultima,
      estado,
      // Cuándo se supo la última versión; `sinConexion` si ese dato no es de ahora.
      verificado: m.ultimoBueno ? new Date(m.ultimoBueno.cuando).toISOString() : null,
      sinConexion: Boolean(m.error),
      notas,
      notasError,
      enlaceNotas: `${URL_REPO}/releases`,
      autoActualizacion: 'apagada',
      uso: uso(),
      comando: 'agy update'
    };
  }

  const releasesClaude = fuente(() => pedirAcotado(URL_RELEASES_CLAUDE, {
    pedir, tope: TOPE_RELEASES_CLAUDE, headers: { Accept: 'application/vnd.github+json' }
  }), ahora);

  /**
   * FEAT-137 — Lagrange no apaga el actualizador de Claude Code (al de agy sí,
   * BE-034): la tarjeta lo dice. Suma lo propio de Claude: la versión que fija
   * la imagen de lotes y si las sondas de cada cuenta siguen vigentes.
   */
  async function claude() {
    const instalada = extraerVersion(versionClaude());
    const r = await releasesClaude();
    const texto = r.valor || r.ultimoBueno?.valor || null;
    let ultima = null;
    let notas = [];
    let notasError = r.error;
    if (texto) {
      try { ultima = ultimaDeReleases(texto); notasError = null; } catch (err) { notasError = err.message; }
    }
    const cmp = instalada && ultima ? compararVersiones(ultima, instalada) : null;
    const estado = cmp === null ? 'desconocido' : cmp > 0 ? 'disponible' : 'al-dia';
    if (estado === 'disponible') {
      try { notas = notasEntre(texto, instalada, ultima, URL_REPO_CLAUDE); } catch (err) { notasError = err.message; }
    }

    let imagen = null;
    try { imagen = extraerVersion(imagenClaude()); } catch {}
    let cuentas = {};
    try { cuentas = sondasClaude()?.cuentas || {}; } catch {}
    const huellaVigente = imagen && versionLagrange ? `claude ${imagen} · lagrange ${versionLagrange}` : null;
    const sondas = Object.entries(cuentas)
      .filter(([cuenta, s]) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(cuenta) && s && typeof s === 'object')
      .map(([cuenta, s]) => {
        const huella = typeof s.huella === 'string' ? s.huella.slice(0, 80) : null;
        return { cuenta, ok: s.ok === true, huella, en: typeof s.en === 'string' ? s.en : null, vigente: Boolean(huellaVigente && huella === huellaVigente) };
      });

    return {
      id: 'claude',
      nombre: 'Claude Code',
      instalada,
      ultima,
      estado,
      verificado: r.ultimoBueno ? new Date(r.ultimoBueno.cuando).toISOString() : null,
      sinConexion: Boolean(r.error),
      notas,
      notasError,
      enlaceNotas: `${URL_REPO_CLAUDE}/releases`,
      enlaceRepo: URL_REPO_CLAUDE,
      autoActualizacion: 'propia',
      uso: null,
      comando: 'claude update',
      imagen: imagen ? { version: imagen, atrasada: Boolean(instalada && compararVersiones(instalada, imagen) > 0) } : null,
      sondas
    };
  }

  const PROVEEDORES = versionClaude ? [antigravity, claude] : [antigravity];
  return {
    lista: async () => Promise.all(PROVEEDORES.map((p) => p()))
  };
}

module.exports = {
  crearProveedores,
  nombrePlataforma,
  extraerVersion,
  compararVersiones,
  pedirAcotado,
  versionDeManifiesto,
  notasEntre,
  ultimaDeReleases,
  VALIDEZ_MS,
  VALIDEZ_FALLO_MS,
  TOPE_MANIFIESTO,
  TOPE_RELEASES
};
