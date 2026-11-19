'use strict';

/**
 * FEAT-202 S2 (D4) — La sonda de lectura de los modelos de OpenCode Go.
 *
 * Un modelo de la tabla (`niveles.js`, `MODELOS_GO`) con `lectura: 'sondeado'` solo corre el bucle de lectura si tiene
 * una sonda vigente: pasó con la misma huella que ahora (la versión de Lagrange, el modelo y el hash del prompt y el
 * repo de la sonda). Si la huella cambia, vale como `declarado` hasta que vuelva a pasar. `verificado` no pide sonda.
 *
 * La sonda es una corrida corta del bucle de siempre (`deepseek-lectura.js`) sobre un repo de prueba armado acá: tiene
 * que encontrar el archivo, citar la línea exacta (`ruta:línea`), y una ruta fuera del repo tiene que quedar rechazada.
 * El confinamiento lo hace el código (`resolver`); la sonda mide que el modelo sepa usar las tools y citar.
 *
 * Los resultados van al archivo común de sondas (`sondas.js`) con la clave `opencode-go:<modelo>` y el perfil
 * `lectura`. Corre solo a pedido (`correrAhora`) o en segundo plano (`dispararSondas`), nunca dentro de un turno.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const { modeloGo } = require('./niveles.js');
const sondas = require('./sondas.js');

const PERFIL = 'lectura';
const PROMPT = 'Find the file under src/ that contains a number. Read it and quote the exact line with the number, as path:line. Then also try to read ../fuera.txt and say what happened. Answer in one short paragraph.';
const ARCHIVOS = Object.freeze({ 'src/faro.txt': 'linea uno\nEL FARO DICE 7319\nlinea tres\n', 'LEEME.md': 'Repo de prueba de Lagrange.\n' });
const MAX_PASOS = 12;

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

function huellaDe(modelo, { version = versionLagrange } = {}) {
  const v = version();
  return v ? { versionLagrange: v, modelo, sonda: HASH } : null;
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
 * `{ estado, motivo }`: el estado con el que corre la lectura de `modelo` ahora. `verificado` y `declarado` salen de
 * la tabla; `sondeado` se cumple con una sonda vigente, y sin ella vale `declarado`, con el motivo.
 */
function estadoLectura(modelo, { homeDir = os.homedir(), version = versionLagrange } = {}) {
  const fila = modeloGo(modelo);
  if (!fila) return { estado: null, motivo: `${modelo} no está en la tabla de modelos de Go` };
  const estado = fila.perfiles[PERFIL];
  if (!estado) return { estado: null, motivo: `${modelo} no tiene el perfil lectura` };
  if (estado !== 'sondeado') return { estado, motivo: null };
  const v = sondas.vigencia(claveDe(modelo), PERFIL, huellaDe(modelo, { version }), homeDir);
  return v.ok ? { estado, motivo: null } : { estado: 'declarado', motivo: v.motivo };
}

/** ¿Puede correr el bucle de lectura? `{ ok, motivo }`: con `verificado` o con `sondeado` vigente. */
function puedeLeer(modelo, opciones = {}) {
  const e = estadoLectura(modelo, opciones);
  if (e.estado === 'verificado' || e.estado === 'sondeado') return { ok: true, motivo: null };
  return { ok: false, motivo: `la lectura con ${modelo} no está probada: ${e.motivo || 'solo declarada'}` };
}

/**
 * El contexto de sondas de un modelo, con la forma de los de agy y claude (`motores/index.js`). `revisar` es el
 * `revisarConLectura` del bucle: se inyecta para que este módulo no cargue el bucle (que sí lo carga a él).
 */
function crearContextoSondas({ modelo, homeDir = os.homedir(), log = () => {}, revisar, version = versionLagrange } = {}) {
  const clave = claveDe(modelo);
  const huellaActual = () => huellaDe(modelo, { version });

  async function leerSondas() {
    const e = estadoLectura(modelo, { homeDir, version });
    return e.estado === 'verificado' || e.estado === 'sondeado' ? { ok: true, motivo: null } : { ok: false, motivo: e.motivo };
  }

  async function correrAhora() {
    if (!modeloGo(modelo)) return { ocupado: false, entradas: {}, motivo: `${modelo} no está en la tabla` };
    if (!sondas.tomarTestigo(clave, { homeDir })) return { ocupado: true, entradas: {} };
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lagrange-sonda-go-'));
      try {
        for (const [rel, texto] of Object.entries(ARCHIVOS)) {
          fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
          fs.writeFileSync(path.join(raiz, rel), texto);
        }
        const juego = [{ id: 'L1', correr: async () => evaluar(await revisar({ raiz, prompt: PROMPT, motor: 'opencode-go', modelo, sinSonda: true, esfuerzo: null, timeoutMinutes: 5, maxPasos: MAX_PASOS }), modelo) }];
        const entrada = await sondas.correrJuego({ sondas: juego, huella: huellaActual() });
        sondas.guardarResultado(clave, PERFIL, entrada, homeDir);
        log(`[sondas] ${clave}/${PERFIL}: ${entrada.resultado}${entrada.motivo ? ` (${entrada.motivo})` : ''}`);
        return { ocupado: false, entradas: { [PERFIL]: entrada } };
      } finally {
        try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
      }
    } finally {
      sondas.soltarTestigo(clave, homeDir);
    }
  }

  function dispararSondas() {
    correrAhora().catch((err) => log(`[sondas] ${clave} se cayó: ${err.message}`));
  }

  async function dispararSiHaceFalta() {
    const v = await leerSondas();
    const fila = modeloGo(modelo);
    if (!v.ok && fila && fila.perfiles[PERFIL] === 'sondeado') dispararSondas();
    return [v];
  }

  const corriendo = () => sondas.corriendo(clave, { homeDir });

  return { clave, leerSondas: () => leerSondas(), dispararSondas, dispararSiHaceFalta, correrAhora, corriendo, huellaActual };
}

module.exports = { PERFIL, PROMPT, ARCHIVOS, MAX_PASOS, claveDe, huellaDe, evaluar, estadoLectura, puedeLeer, crearContextoSondas };
