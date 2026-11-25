/**
 * FEAT-210 §3 — El proveedor agy de la charla.
 *
 * Vive en el bridge, con lo que el bridge ya usa para lanzar agy (`runAgyArgs`,
 * la ventana de cuota compartida con el MCP, el modo manual). `agy_image` (MCP)
 * no se toca: este proveedor copia sus guardas (las reglas de imagen, sin
 * edición ni comandos, `--output-format json --dangerously-skip-permissions
 * --mode plan`, `--disable-slash-commands` si agy lo soporta y el `--model` de
 * la config) y comparte de `motores/antigravity/image.js` lo que no tiene
 * estado del MCP.
 *
 * Lo que agy no tiene: `negativo`, `fuerza` y la semilla. Ignora los dos
 * primeros, y «otra versión» vuelve a correr el mismo prompt (`semilla: null`).
 * No hace img2img: con una foto, genera desde el prompt y lo anota
 * (`fotoIgnorada`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { opcionesDeAgy } = require('../../mcp-server/motores/antigravity/opciones.js');
const agyImage = require('../../mcp-server/motores/antigravity/image.js');
const respaldo = require('../../mcp-server/motores/respaldo.js');

/** Los args de `agy_image` (`mcp-server/index.js`); un test los compara con su fuente para que no diverjan. */
export const ARGS_BASE = Object.freeze(['--output-format', 'json', '--dangerously-skip-permissions', '--mode', 'plan']);
/** Las tres reglas de imagen de `agy_image`, tal cual. */
export const REGLAS_IMAGEN = Object.freeze([
  '- The built-in `image-generator` subagent and its `generate_image` tool are allowed and expected.',
  '- Do NOT call `generate_image` directly, read files, run commands, search the web, fetch URLs, or inspect tools/binaries.',
  '- Do not copy, convert or post-process the image; the subagent saves it in the main agent artifact directory.'
]);
/** Lo que `buildSecurityRules` agrega para `agy_image` (`deny: ['edit', 'commands']`). */
export const REGLAS_PERMISOS = Object.freeze([
  '- EDIT PERMISSION DENIED: You are operating in STRICT READ-ONLY mode. Do not write or edit any files.',
  '- COMMAND EXECUTION DENIED: Do not run or propose any shell/terminal commands.'
]);
const TIEMPO_MIN = 10;

/** La proporción de `ASPECTOS` más cercana a `ancho/alto`. */
export function aspectoMasCercano(ancho, alto) {
  const r = ancho > 0 && alto > 0 ? ancho / alto : 1;
  let mejor = '1:1';
  let dif = Infinity;
  for (const a of agyImage.ASPECTOS) {
    const [x, y] = a.split(':').map(Number);
    const d = Math.abs(Math.log(x / y) - Math.log(r));
    if (d < dif) { dif = d; mejor = a; }
  }
  return mejor;
}

let cacheSlash = null;
/** ¿Este agy acepta `--disable-slash-commands`? Se pregunta una vez por proceso (`agy --help`). */
export function soportaDisableSlash({ agyBin, leerAyuda = null } = {}) {
  if (cacheSlash !== null) return cacheSlash;
  let ayuda = null;
  try {
    ayuda = leerAyuda ? leerAyuda() : execFileSync(agyBin, ['--help'], opcionesDeAgy({ timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], local: true }));
  } catch { ayuda = null; }
  cacheSlash = typeof ayuda === 'string' && /--disable-slash-commands\b/.test(ayuda);
  return cacheSlash;
}
export function olvidarSlashParaTests() { cacheSlash = null; }

/**
 * Crea el proveedor. Se inyecta todo lo del bridge:
 * - `runAgyArgs(args, { cwd, timeoutMinutes, onSpawn })`, el mismo de la charla;
 * - `enModoManual()`; `estadoCuota` (`respaldo.crearEstado`) y `revisarCuota(modelo)`, la ventana compartida;
 * - `modelo()` → `{ model, effortPorDefecto }` (`modeloPorDefecto`);
 * - `guardrails(prompt)`, que envuelve con `buildGuardrailedPrompt` y la política del bridge;
 * - `registrarUso(llamada)`.
 */
export function crearAntigravity({
  runAgyArgs, enModoManual, estadoCuota = null, revisarCuota = null, refrescarCuota = null, cooldownRefrescos = null, modelo = () => ({ model: null, effortPorDefecto: null }),
  guardrails = (p) => p, registrarUso = () => {}, agyBin = 'agy', leerAyuda = null, log = () => {}
}) {
  async function generar({ prompt, ancho = 1024, alto = 1024, foto = null, signal, destino, origen = 'usuario', rol = 'imagen' }) {
    const fin = (codigo, extra = {}) => ({ ok: false, codigo, proveedor: 'antigravity', modelo: null, ...extra });
    // 1. El modo manual: el freno real del bridge.
    if (enModoManual()) return fin('manual');
    const { model, effortPorDefecto } = modelo();
    // 2. La cuota: la ventana compartida con el MCP.
    // Con el refresco de /usage del preflight, como la charla: una captura vieja no frena ni deja pasar de más.
    const plan = await respaldo.planDeLanzamientoConRefresco({
      modeloParaCuota: model || null, estado: estadoCuota, revisarCuota, refrescarCuota, cooldownRefrescos, signal: signal || null
    });
    if (plan.bloquea) return fin('cupo');
    if (signal && signal.aborted) return fin('cancelada');

    const proporcion = aspectoMasCercano(ancho, alto);
    // El contrato de archivo: un .jpg concreto dentro de `<alma>/imagenes/.tmp/` (no deja copia en lagrange-images).
    const pedida = agyImage.prepararSolicitud({ prompt, aspect_ratio: proporcion, output_path: `${destino}.jpg`, overwrite: false }, { baseDir: path.dirname(destino) });
    if (!pedida.ok) return fin('error', { detalle: pedida.error });
    // agy hoy devuelve JPEG, pero si devuelve otro formato la extensión se ajusta (sigue en `.tmp/`): sin esto,
    // `ajustarDestino` rechaza un PNG porque el destino termina en `.jpg`.
    const solicitud = { ...pedida, output: { ...pedida.output, auto: true } };
    const cuerpo = [...REGLAS_IMAGEN, ...REGLAS_PERMISOS, '', agyImage.promptDeImagen(solicitud)].join('\n');
    const promptFinal = guardrails(cuerpo);
    const args = [...ARGS_BASE];
    if (soportaDisableSlash({ agyBin, leerAyuda })) args.push('--disable-slash-commands');
    if (model) args.push('--model', model);
    if (effortPorDefecto) args.push('--effort', effortPorDefecto);

    // El adaptador sobre runAgyArgs: `onSpawn` guarda el corte, y el `abort` del `signal` lo llama. Si el abort llegó
    // entre el chequeo y el spawn, `onSpawn` lo ve y corta en el acto.
    let cortar = null;
    const alAbortar = () => { if (cortar) { try { cortar(); } catch {} } };
    if (signal) signal.addEventListener('abort', alAbortar, { once: true });
    const ejecutar = (cliArgs, { cwd, timeoutMinutes }) => {
      if (signal && signal.aborted) return Promise.resolve({ success: false, cancelled: true, data: null, error: 'Cancelada antes de lanzar agy.' });
      return runAgyArgs(cliArgs, {
        cwd, timeoutMinutes,
        onSpawn: (cancel) => { cortar = cancel; if (signal && signal.aborted) { try { cancel(); } catch {} } }
      });
    };
    const inicio = Date.now();
    let salida;
    try {
      salida = await agyImage.generarImagen({ solicitud, promptFinal, baseArgs: args, timeoutMinutes: TIEMPO_MIN, ejecutar, signal });
    } catch (err) {
      log(`[imagenes] agy falló: ${err.message}`);
      return fin('error');
    } finally {
      if (signal) signal.removeEventListener('abort', alAbortar);
    }
    const r = salida && salida.result;
    try {
      registrarUso({
        tool: 'imagen_charla', motor: 'antigravity', rol, modelo: model || null, modeloReal: null, esfuerzo: effortPorDefecto || null,
        conversationId: (salida && salida.conversationId) || null, duracion: (Date.now() - inicio) / 1000, usage: (salida && salida.usage) || null,
        error: salida && salida.ok ? null : 'imagen', costoUsd: null, origen, cuota: null
      });
    } catch {}
    if (salida && salida.ok) {
      const ruta = salida.path || salida.output || null;
      const real = ruta && fs.existsSync(ruta) ? ruta : null;
      if (!real) return fin('error');
      return { ok: true, ruta: real, tipo: ({ png: 'image/png', webp: 'image/webp' })[salida.format] || 'image/jpeg', ancho: salida.width || ancho, alto: salida.height || alto, semilla: null, proveedor: 'antigravity', modelo: model || null, fotoIgnorada: Boolean(foto) };
    }
    if ((signal && signal.aborted) || (r && r.cancelled)) return fin('cancelada');
    // Sin cuota al generar: se anota en la ventana compartida, como tras un turno de charla.
    if (respaldo.motivoAgy(r) === 'cuota') {
      respaldo.registrarCuotaAgotada({ estado: estadoCuota, modelo: model || null, error: (r && r.error) || '' });
      return fin('cupo');
    }
    if (respaldo.motivoAgy(r) === 'sin_agy' || respaldo.motivoAgy(r) === 'caido') return fin('no-responde');
    return fin('error');
  }

  return { id: 'antigravity', generar };
}
