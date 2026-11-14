#!/usr/bin/env node
/**
 * FEAT-193 — Status line standalone de Lagrange para Antigravity CLI (`agy`).
 *
 * No importa nada de `mcp-server/` ni spawnea `agy` ni `git`: `npm run agy:plugin`
 * copia solo `agy-plugin/` a `~/.gemini/config/plugins/lagrange/`.
 *
 * Lee el JSON de estado de `agy` por `stdin` y muestra:
 * - Línea 1: modelo, proyecto y rama git (`.git/HEAD`), barra de contexto (usado y libre), cuota por bucket y costo opcional.
 * - Línea 2 (si aplica): pedidos manuales pendientes en `.lagrange/agy/pedidos/` (FEAT-192).
 * Con `--solo-lagrange` (pensado para `stack_with_default: true`) omite modelo, proyecto/rama y costo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIMER_BYTE_TIMEOUT_MS = 250;
const INACTIVIDAD_TIMEOUT_MS = 30;
const MAX_BYTES_STDIN = 256 * 1024;
const CELDAS = 10;
const CELDAS_COMPACTO = 6;
const ANCHO_COMPACTO = 115;
const UMBRAL_RESET_PCT = 50;
const RE_ID = /^([0-9a-f]{6})\.md$/;

const SKILLS_PEDIDO = {
  audit: 'lagrange-audit',
  review: 'lagrange-review',
  plan: 'lagrange-plan'
};

const ANSI = {
  verde: '\x1b[32m',
  amarillo: '\x1b[33m',
  ambar: '\x1b[38;5;208m',
  rojo: '\x1b[31m',
  cian: '\x1b[36m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  fin: '\x1b[0m'
};

const SEP = `${ANSI.dim} │ ${ANSI.fin}`;
const SEP_CUOTA = `${ANSI.dim} · ${ANSI.fin}`;

const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function colorDe(pctUsado) {
  if (pctUsado >= 90) return ANSI.rojo;
  if (pctUsado >= 75) return ANSI.ambar;
  if (pctUsado >= 50) return ANSI.amarillo;
  return ANSI.verde;
}

const pintarUso = (pctUsado, texto) => `${colorDe(pctUsado)}${texto}${ANSI.fin}`;
const conColor = (sec, texto) => (sec ? `${sec}${texto}${ANSI.fin}` : texto);

function barra(pctUsado, celdas = CELDAS) {
  const llenas = Math.max(0, Math.min(celdas, Math.round((pctUsado / 100) * celdas)));
  return '█'.repeat(llenas) + '░'.repeat(celdas - llenas);
}

/** Formatea segundos restantes hasta el reinicio de cuota. */
export function formatearReset(segundos) {
  const s = numero(segundos);
  if (s === null || s <= 0) return null;
  if (s < 60) return '(<1m)';
  if (s < 3600) return `(${Math.floor(s / 60)}m)`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `(${h}h${String(m).padStart(2, '0')}m)`;
  }
  return `(${Math.floor(s / 86400)}d)`;
}

/**
 * Sube desde `base` buscando `.git` (carpeta o archivo `gitdir:` de worktree) para leer `HEAD`.
 * Si no encuentra `.git`, conserva `raiz = base` (nunca `/` ni `C:\`).
 */
export function leerRamaYRaiz(base) {
  if (typeof base !== 'string' || !base.trim()) return { raiz: '', rama: null };
  const inicial = path.resolve(base);
  let dir = inicial;
  for (;;) {
    const git = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(git); } catch {}
    if (st) {
      let rama = null;
      try {
        let gitDir = git;
        if (st.isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'));
          if (m) gitDir = path.resolve(dir, m[1].trim());
          else gitDir = null;
        }
        if (gitDir) {
          const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
          const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
          if (ref) rama = ref[1];
          else if (/^[0-9a-f]{7,}$/i.test(head)) rama = head.slice(0, 7);
        }
      } catch {}
      return { raiz: dir, rama };
    }
    const padre = path.dirname(dir);
    if (padre === dir) return { raiz: inicial, rama: null };
    dir = padre;
  }
}

function parsearFrontmatter(texto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(texto || ''));
  if (!m) return {};
  const campos = {};
  for (const linea of m[1].split(/\r?\n/)) {
    const c = /^([a-z_]+):\s*(.*)$/.exec(linea);
    if (c) campos[c[1]] = c[2].trim();
  }
  return campos;
}

/** Lista los pedidos FEAT-192 pendientes (sin informe), del más reciente al más viejo. */
export function listarPedidosPendientes(raiz) {
  if (typeof raiz !== 'string' || !raiz) return [];
  const baseAgy = path.join(raiz, '.lagrange', 'agy');
  const dirPedidos = path.join(baseAgy, 'pedidos');
  const dirInformes = path.join(baseAgy, 'informes');
  let entradas = [];
  try { entradas = fs.readdirSync(dirPedidos); } catch { return []; }

  const salida = [];
  for (const nombre of entradas) {
    const m = RE_ID.exec(nombre);
    if (!m) continue;
    const id = m[1];
    if (fs.existsSync(path.join(dirInformes, `${id}.md`))) continue;
    try {
      const fm = parsearFrontmatter(fs.readFileSync(path.join(dirPedidos, nombre), 'utf8'));
      const skill = SKILLS_PEDIDO[fm.tipo];
      if (!skill) continue;
      salida.push({ id, tipo: fm.tipo, skill, creado: fm.creado || '' });
    } catch {}
  }
  return salida.sort((a, b) => String(b.creado).localeCompare(String(a.creado)) || b.id.localeCompare(a.id));
}

function formatearBucketIndividual(etiqueta, info) {
  const frac = numero(info && info.remaining_fraction);
  if (frac === null) return null;
  const clamped = Math.max(0, Math.min(1, frac));
  const restante = Math.round(clamped * 100);
  const usado = 100 - restante;
  const reset = restante <= UMBRAL_RESET_PCT ? formatearReset(info.reset_in_seconds) : null;
  const base = pintarUso(usado, `${etiqueta}:${restante}%`);
  return reset ? `${base} ${conColor(ANSI.dim, reset)}` : base;
}

function formatearFamilia(nombre, bucket5h, bucket7d) {
  const f5 = bucket5h ? numero(bucket5h.remaining_fraction) : null;
  const f7 = bucket7d ? numero(bucket7d.remaining_fraction) : null;
  if (f5 === null && f7 === null) return null;

  if (f5 !== null && f7 !== null) {
    const r5 = Math.round(Math.max(0, Math.min(1, f5)) * 100);
    const r7 = Math.round(Math.max(0, Math.min(1, f7)) * 100);
    if (r5 === 100 && r7 === 100) return pintarUso(0, `${nombre} 100%`);
    const p5 = formatearBucketIndividual('5h', bucket5h);
    const p7 = formatearBucketIndividual('7d', bucket7d);
    return `${nombre} ${[p5, p7].filter(Boolean).join(SEP_CUOTA)}`;
  }
  return bucket5h
    ? formatearBucketIndividual(`${nombre} 5h`, bucket5h)
    : formatearBucketIndividual(`${nombre} 7d`, bucket7d);
}

/** Renderiza los buckets activos de `stdin.quota` agrupando las familias de `agy` sin colisiones. */
export function formatearCuotas(quota) {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return [];
  const activos = Object.entries(quota).filter(([, v]) => v && typeof v === 'object' && v.disabled !== true);
  if (!activos.length) return [];

  const mapa = new Map(activos);
  const usados = new Set();
  const partes = [];

  const gem5 = mapa.get('gemini-5h');
  const gem7 = mapa.get('gemini-weekly');
  if (gem5 || gem7) {
    usados.add('gemini-5h');
    usados.add('gemini-weekly');
    const txt = formatearFamilia('gem', gem5, gem7);
    if (txt) partes.push(txt);
  }

  const argon7 = mapa.get('gemini-argon-wtu-weekly');
  if (argon7) {
    usados.add('gemini-argon-wtu-weekly');
    const frac = numero(argon7.remaining_fraction);
    if (frac !== null) {
      const r = Math.round(Math.max(0, Math.min(1, frac)) * 100);
      partes.push(r === 100 ? pintarUso(0, 'argon 100%') : formatearBucketIndividual('argon 7d', argon7));
    }
  }

  const tp5 = mapa.get('3p-5h');
  const tp7 = mapa.get('3p-weekly');
  if (tp5 || tp7) {
    usados.add('3p-5h');
    usados.add('3p-weekly');
    const txt = formatearFamilia('3p', tp5, tp7);
    if (txt) partes.push(txt);
  }

  for (const [k, v] of activos) {
    if (usados.has(k)) continue;
    const txt = formatearBucketIndividual(k, v);
    if (txt) partes.push(txt);
  }

  return partes.filter(Boolean);
}

function esfuerzoDe(stdin) {
  const m = stdin.model && typeof stdin.model === 'object' ? stdin.model : {};
  const raw = m.effort !== undefined ? m.effort : stdin.effort;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object' && typeof raw.level === 'string' && raw.level.trim()) return raw.level.trim();
  return null;
}

function textoModelo(stdin) {
  const m = stdin.model && typeof stdin.model === 'object' ? stdin.model : null;
  if (!m) return null;
  const nombre = (typeof m.display_name === 'string' && m.display_name.trim()) || (typeof m.id === 'string' && m.id.trim()) || null;
  if (!nombre) return null;
  const esfuerzo = esfuerzoDe(stdin);
  const yaIncluye = esfuerzo && nombre.toLowerCase().endsWith(`(${esfuerzo.toLowerCase()})`);
  return esfuerzo && !yaIncluye ? `${conColor(ANSI.cian, nombre)} · ${esfuerzo}` : conColor(ANSI.cian, nombre);
}

function textoContexto(stdin, { compacto = false } = {}) {
  const cw = stdin.context_window && typeof stdin.context_window === 'object' ? stdin.context_window : null;
  let usado = cw ? numero(cw.used_percentage) : null;
  let libre = cw ? numero(cw.remaining_percentage) : null;
  if (usado === null && libre !== null) usado = Math.max(0, Math.min(100, 100 - libre));
  if (libre === null && usado !== null) libre = Math.max(0, Math.min(100, 100 - usado));

  if (usado !== null) {
    const pctU = Math.round(Math.max(0, Math.min(100, usado)));
    const pctL = Math.round(Math.max(0, Math.min(100, libre)));
    if (compacto) return pintarUso(pctU, `ctx ${barra(pctU, CELDAS_COMPACTO)} ${pctU}%`);
    return `${pintarUso(pctU, `ctx ${barra(pctU, CELDAS)} ${pctU}%`)} ${conColor(ANSI.dim, `(${pctL}% libre)`)}`;
  }
  if (stdin.exceeds_200k_tokens === true) {
    return conColor(ANSI.amarillo, 'ctx >200k');
  }
  return null;
}

function textoPedidos(raiz) {
  const pedidos = listarPedidosPendientes(raiz);
  if (!pedidos.length) return '';
  const top = pedidos[0];
  const tag = conColor(ANSI.amarillo, '[lagrange]');
  if (pedidos.length === 1) return `${tag} pedido ${top.id} (/${top.skill})`;
  return `${tag} ${pedidos.length} pedidos pendientes (más reciente: ${top.id} /${top.skill})`;
}

/** Construye la salida completa (una o dos líneas) a partir del JSON de `stdin`. */
export function armarLineas(stdin, { soloLagrange = false } = {}) {
  if (!stdin || typeof stdin !== 'object' || Array.isArray(stdin)) return '';

  const ws = stdin.workspace && typeof stdin.workspace === 'object' ? stdin.workspace : {};
  const base =
    (typeof ws.project_dir === 'string' && ws.project_dir.trim()) ||
    (typeof ws.current_dir === 'string' && ws.current_dir.trim()) ||
    (typeof stdin.cwd === 'string' && stdin.cwd.trim()) ||
    '';

  if (soloLagrange) {
    if (!stdin.context_window && !stdin.quota && !base) return '';
  } else if (!stdin.model && !stdin.context_window && !stdin.quota) {
    return '';
  }

  const ancho = numero(stdin.terminal_width);
  const compacto = ancho !== null && ancho < ANCHO_COMPACTO;
  const { raiz, rama } = base ? leerRamaYRaiz(base) : { raiz: '', rama: null };
  const partes = [];

  if (!soloLagrange) {
    const mod = textoModelo(stdin);
    if (mod) partes.push(mod);
    if (raiz) {
      const nombreProy = path.basename(raiz.replace(/[\\/]+$/, '')) || raiz;
      let seg = conColor(ANSI.amarillo, nombreProy);
      if (rama) seg += ` ${conColor(ANSI.magenta, `(${rama})`)}`;
      partes.push(seg);
    }
  }

  const ctx = textoContexto(stdin, { compacto });
  if (ctx) partes.push(ctx);

  const cuotas = formatearCuotas(stdin.quota);
  if (cuotas.length) partes.push(cuotas.join(SEP_CUOTA));

  if (!soloLagrange && stdin.cost && typeof stdin.cost === 'object') {
    const usd = numero(stdin.cost.total_usd);
    if (usd !== null) partes.push(`${stdin.cost.estimated === true ? '~' : ''}$${usd.toFixed(2)}`);
  }

  const linea1 = partes.join(SEP);
  const linea2 = textoPedidos(raiz);
  return [linea1, linea2].filter(Boolean).join('\n');
}

export function leerStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let crudo = '';
    let asentado = false;
    let timerPrimerByte;
    let timerInactividad;

    const terminar = () => {
      if (asentado) return;
      asentado = true;
      clearTimeout(timerPrimerByte);
      clearTimeout(timerInactividad);
      try { process.stdin.pause(); } catch {}
      const texto = crudo.trim();
      if (!texto) return resolve(null);
      try { resolve(JSON.parse(texto)); } catch { resolve(null); }
    };

    const reprogramar = () => {
      clearTimeout(timerInactividad);
      timerInactividad = setTimeout(terminar, INACTIVIDAD_TIMEOUT_MS);
    };

    timerPrimerByte = setTimeout(terminar, PRIMER_BYTE_TIMEOUT_MS);
    try { process.stdin.setEncoding('utf8'); } catch { return terminar(); }
    process.stdin.on('data', (chunk) => {
      clearTimeout(timerPrimerByte);
      crudo += chunk;
      if (crudo.length > MAX_BYTES_STDIN) return terminar();
      reprogramar();
    });
    process.stdin.on('end', terminar);
    process.stdin.on('error', terminar);
  });
}

function esEntrypoint() {
  try {
    if (!process.argv[1]) return false;
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

async function main() {
  const soloLagrange = process.argv.includes('--solo-lagrange');
  const datos = await leerStdin();
  process.stdout.write(armarLineas(datos, { soloLagrange }));
}

if (esEntrypoint()) {
  main().catch(() => {
    process.stdout.write('');
  });
}
