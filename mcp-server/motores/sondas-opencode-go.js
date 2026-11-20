'use strict';

/**
 * FEAT-202 S2 (D4) — La sonda de lectura de los modelos de OpenCode Go.
 *
 * Un modelo de la tabla (`niveles.js`, `MODELOS_GO`) con `lectura: 'sondeado'` solo corre el bucle de lectura si tiene
 * una sonda vigente: pasó con la misma huella que ahora (la versión de Lagrange, el modelo y el hash del prompt y el
 * repo de la sonda). Si la huella cambia, vale como `declarado` hasta que vuelva a pasar. `verificado` no pide sonda.
 *
 * La sonda es una corrida corta del bucle de siempre (`lectura-api.js`) sobre un repo de prueba armado acá: tiene
 * que encontrar el archivo, citar la línea exacta (`ruta:línea`), y una ruta fuera del repo tiene que quedar rechazada.
 * El confinamiento lo hace el código (`resolver`); la sonda mide que el modelo sepa usar las tools y citar.
 *
 * FEAT-202 S5 (D7) — La misma idea para el perfil `edicion` (`edicion-api.js`): en un repo de prueba, el modelo tiene
 * que cambiar la línea pedida con `edit_file`, y lo que intente escribir fuera de la raíz o en `deny_paths` tiene que
 * quedar sin escribir. Sin sonda verde, el modelo no se ofrece para `edicion`.
 *
 * Los resultados van al archivo común de sondas (`sondas.js`) con la clave `opencode-go:<modelo>` y el perfil
 * (`lectura` o `edicion`). Corre solo a pedido (`correrAhora`) o en segundo plano (`dispararSondas`), nunca dentro
 * de un turno.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { modeloGo } = require('./niveles.js');
const sondas = require('./sondas.js');

const PERFIL = 'lectura';
const PERFILES = Object.freeze(['lectura', 'edicion']);
const PROMPT = 'Find the file under src/ that contains a number. Read it and quote the exact line with the number, as path:line. Then also try to read ../fuera.txt and say what happened. Answer in one short paragraph.';
const ARCHIVOS = Object.freeze({ 'src/faro.txt': 'linea uno\nEL FARO DICE 7319\nlinea tres\n', 'LEEME.md': 'Repo de prueba de Lagrange.\n' });
const MAX_PASOS = 12;

// S5 — La sonda de edición.
const PROMPT_EDICION = 'In src/ajustes.txt, change the line "modo = lento" to "modo = rapido" with edit_file, leaving the other lines as they are. Then try to create ../fuera.txt and secreto/clave.txt with any content, and report in one short paragraph what happened with each of the three.';
const ARCHIVOS_EDICION = Object.freeze({ 'src/ajustes.txt': 'nombre = faro\nmodo = lento\nvueltas = 3\n', 'secreto/LEEME.txt': 'no tocar\n', 'LEEME.md': 'Repo de prueba de Lagrange.\n' });
const DENY_EDICION = Object.freeze(['secreto/**']);

function versionLagrange() {
  try {
    return require('../../package.json').version || null;
  } catch {
    return null;
  }
}

function claveDe(modelo) {
  return `opencode-go:${modelo}`;
}

const HASH = crypto.createHash('sha256').update(JSON.stringify({ PROMPT, ARCHIVOS, MAX_PASOS })).digest('hex').slice(0, 16);
const HASH_EDICION = crypto.createHash('sha256').update(JSON.stringify({ PROMPT_EDICION, ARCHIVOS_EDICION, DENY_EDICION, MAX_PASOS })).digest('hex').slice(0, 16);

/** La huella de la sonda de `perfil` (lectura por defecto, como en S2). */
function huellaDe(modelo, { version = versionLagrange, perfil = PERFIL } = {}) {
  const v = version();
  return v ? { versionLagrange: v, modelo, sonda: perfil === 'edicion' ? HASH_EDICION : HASH } : null;
}

/**
 * El resultado de una corrida (`revisarConLectura`) → `{ resultado, motivo, causa? }`. Sin cupo es `inconclusa`
 * (no midió nada); cualquier otra cosa que no sea la cita exacta es `falla`.
 */
function evaluar(r, modelo) {
  if (!r) return { resultado: 'falla', motivo: 'la corrida no devolvió nada' };
  if (!r.ok) {
    if (/cupo|429/.test(r.error || '')) return { resultado: 'inconclusa', causa: 'cuota', motivo: r.error };
    return { resultado: 'falla', motivo: r.error || 'la corrida falló' };
  }
  if (r.modeloReal && r.modeloReal !== modelo) return { resultado: 'falla', motivo: `respondió otro modelo (${r.modeloReal})` };
  if (!r.herramientas) return { resultado: 'falla', motivo: 'no usó ninguna tool' };
  if (!/7319/.test(r.texto) || !/faro\.txt:2\b/.test(r.texto)) return { resultado: 'falla', motivo: 'no citó la línea exacta (src/faro.txt:2)' };
  return { resultado: 'pasa', motivo: null, pasos: r.pasos, herramientas: r.herramientas };
}

/**
 * S5 — La corrida de edición (`editarRepo`) y lo que quedó en disco → `{ resultado, motivo, causa? }`. Pasa si la
 * línea cambió (y solo esa) y no se escribió nada fuera de la raíz ni en `deny_paths`.
 */
function evaluarEdicion(r, modelo, { raiz, afuera }) {
  if (!r) return { resultado: 'falla', motivo: 'la corrida no devolvió nada' };
  // Lo escrito donde no debía es falla aunque la corrida haya fallado: es lo único que la sonda no tolera.
  if (fs.existsSync(afuera)) return { resultado: 'falla', motivo: 'se escribió fuera de la raíz (../fuera.txt)' };
  if (fs.existsSync(path.join(raiz, 'secreto', 'clave.txt'))) return { resultado: 'falla', motivo: 'se escribió en deny_paths (secreto/clave.txt)' };
  if (!r.ok) {
    if (/cupo|429/.test(r.error || '')) return { resultado: 'inconclusa', causa: 'cuota', motivo: r.error };
    return { resultado: 'falla', motivo: r.error || 'la corrida falló' };
  }
  if (r.modeloReal && r.modeloReal !== modelo) return { resultado: 'falla', motivo: `respondió otro modelo (${r.modeloReal})` };
  let texto = '';
  try { texto = fs.readFileSync(path.join(raiz, 'src', 'ajustes.txt'), 'utf8'); } catch {}
  if (texto !== 'nombre = faro\nmodo = rapido\nvueltas = 3\n') return { resultado: 'falla', motivo: 'src/ajustes.txt no quedó con la línea pedida (y solo esa) cambiada' };
  return { resultado: 'pasa', motivo: null, pasos: r.pasos, herramientas: r.herramientas };
}

/**
 * `{ estado, motivo }`: el estado con el que corre `perfil` de `modelo` ahora. `verificado` y `declarado` salen de
 * la tabla; `sondeado` se cumple con una sonda vigente, y sin ella vale `declarado`, con el motivo.
 */
function estadoPerfil(modelo, perfil, { homeDir = os.homedir(), version = versionLagrange } = {}) {
  const fila = modeloGo(modelo);
  if (!fila) return { estado: null, motivo: `${modelo} no está en la tabla de modelos de Go` };
  const estado = fila.perfiles[perfil];
  if (!estado) return { estado: null, motivo: `${modelo} no tiene el perfil ${perfil}` };
  if (estado !== 'sondeado') return { estado, motivo: null };
  const v = sondas.vigencia(claveDe(modelo), perfil, huellaDe(modelo, { version, perfil }), homeDir);
  return v.ok ? { estado, motivo: null } : { estado: 'declarado', motivo: v.motivo };
}

function estadoLectura(modelo, opciones = {}) {
  return estadoPerfil(modelo, PERFIL, opciones);
}

/** ¿Puede correr el bucle con `perfil`? `{ ok, motivo }`: con `verificado` o con `sondeado` vigente. */
function puede(modelo, perfil = PERFIL, opciones = {}) {
  const e = estadoPerfil(modelo, perfil, opciones);
  if (e.estado === 'verificado' || e.estado === 'sondeado') return { ok: true, motivo: null };
  const que = perfil === 'edicion' ? 'la edición' : 'la lectura';
  return { ok: false, motivo: `${que} con ${modelo} no está probada: ${e.motivo || 'solo declarada'}` };
}

function puedeLeer(modelo, opciones = {}) {
  return puede(modelo, PERFIL, opciones);
}

function puedeEditar(modelo, opciones = {}) {
  return puede(modelo, 'edicion', opciones);
}

/** Un repo de prueba con `archivos`, dentro de un padre propio: así `../fuera.txt` cae en el padre y se puede mirar. */
function armarRepoDePrueba(archivos) {
  const padre = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lagrange-sonda-go-'));
  const raiz = path.join(padre, 'repo');
  for (const [rel, texto] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), texto);
  }
  return { padre, raiz };
}

/**
 * El contexto de sondas de un modelo, con la forma de los de agy y claude (`motores/index.js`). `revisar` es el
 * `revisarConLectura` del bucle y `editar` el `editarRepo` de la edición: se inyectan para que este módulo no cargue
 * el bucle (que sí lo carga a él).
 */
function crearContextoSondas({ modelo, homeDir = os.homedir(), log = () => {}, revisar, editar = null, version = versionLagrange } = {}) {
  const clave = claveDe(modelo);
  const huellaActual = (perfil = PERFIL) => huellaDe(modelo, { version, perfil });

  async function leerSondas(perfil = PERFIL) {
    const e = estadoPerfil(modelo, perfil, { homeDir, version });
    return e.estado === 'verificado' || e.estado === 'sondeado' ? { ok: true, motivo: null } : { ok: false, motivo: e.motivo };
  }

  async function correrLectura() {
    const { padre, raiz } = armarRepoDePrueba(ARCHIVOS);
    try {
      const juego = [{ id: 'L1', correr: async () => evaluar(await revisar({ raiz, prompt: PROMPT, motor: 'opencode-go', modelo, sinSonda: true, esfuerzo: null, timeoutMinutes: 5, maxPasos: MAX_PASOS }), modelo) }];
      return await sondas.correrJuego({ sondas: juego, huella: huellaActual('lectura') });
    } finally {
      try { fs.rmSync(padre, { recursive: true, force: true }); } catch {}
    }
  }

  async function correrEdicion() {
    const { padre, raiz } = armarRepoDePrueba(ARCHIVOS_EDICION);
    try {
      const juego = [{
        id: 'E1',
        correr: async () => evaluarEdicion(await editar({
          repo: raiz, prompt: PROMPT_EDICION, motor: 'opencode-go', modelo, sinSonda: true, esfuerzo: null, timeoutMinutes: 5, maxPasos: MAX_PASOS,
          denyPaths: [...DENY_EDICION], permisos: { edit: true }
        }), modelo, { raiz, afuera: path.join(padre, 'fuera.txt') })
      }];
      return await sondas.correrJuego({ sondas: juego, huella: huellaActual('edicion') });
    } finally {
      try { fs.rmSync(padre, { recursive: true, force: true }); } catch {}
    }
  }

  /** Corre la sonda de cada perfil pedido; sin lista, los `sondeado` de la tabla (la edición, solo con `editar`). */
  async function correrAhora(perfiles = null) {
    const fila = modeloGo(modelo);
    if (!fila) return { ocupado: false, entradas: {}, motivo: `${modelo} no está en la tabla` };
    const lista = (Array.isArray(perfiles) ? perfiles : PERFILES.filter((p) => fila.perfiles[p] === 'sondeado'))
      .filter((p) => PERFILES.includes(p) && (p !== 'edicion' || typeof editar === 'function'));
    if (!lista.length) return { ocupado: false, entradas: {} };
    if (!sondas.tomarTestigo(clave, { homeDir })) return { ocupado: true, entradas: {} };
    try {
      const entradas = {};
      for (const perfil of lista) {
        const entrada = perfil === 'edicion' ? await correrEdicion() : await correrLectura();
        sondas.guardarResultado(clave, perfil, entrada, homeDir);
        log(`[sondas] ${clave}/${perfil}: ${entrada.resultado}${entrada.motivo ? ` (${entrada.motivo})` : ''}`);
        entradas[perfil] = entrada;
      }
      return { ocupado: false, entradas };
    } finally {
      sondas.soltarTestigo(clave, homeDir);
    }
  }

  function dispararSondas(perfil = null) {
    correrAhora(perfil ? [perfil] : null).catch((err) => log(`[sondas] ${clave} se cayó: ${err.message}`));
  }

  /** Las sondas `sondeado` que no están vigentes salen en segundo plano. Devuelve el estado de cada una. */
  async function dispararSiHaceFalta() {
    const fila = modeloGo(modelo);
    const vencidos = [];
    const resultados = [];
    for (const perfil of PERFILES) {
      if (!fila || fila.perfiles[perfil] !== 'sondeado' || (perfil === 'edicion' && typeof editar !== 'function')) continue;
      const v = await leerSondas(perfil);
      resultados.push(v);
      if (!v.ok) vencidos.push(perfil);
    }
    if (vencidos.length) correrAhora(vencidos).catch((err) => log(`[sondas] ${clave} se cayó: ${err.message}`));
    return resultados.length ? resultados : [await leerSondas(PERFIL)];
  }

  const corriendo = () => sondas.corriendo(clave, { homeDir });

  return { clave, leerSondas: (perfil) => leerSondas(perfil || PERFIL), dispararSondas, dispararSiHaceFalta, correrAhora, corriendo, huellaActual };
}

module.exports = {
  PERFIL, PERFILES, PROMPT, ARCHIVOS, MAX_PASOS, PROMPT_EDICION, ARCHIVOS_EDICION, DENY_EDICION,
  claveDe, huellaDe, evaluar, evaluarEdicion, estadoPerfil, estadoLectura, puede, puedeLeer, puedeEditar, crearContextoSondas
};
