/**
 * FEAT-128 — Las metas del proyecto (FEAT-126, `metas.json` en la base de conocimiento) vistas desde el tablero.
 *
 * - Un `metas.json` por proyecto: cada workspace conocido se mapea a su slug una vez, sin git sincrónico.
 * - Caché en memoria por `mtime`, leída sin frenar el event loop: así un `metaId` (también el de una tarjeta de
 *   alma, sin proyecto) se resuelve sin escanear el disco.
 * - El progreso de las metas de tarjetas lo calcula la consola; acá solo se deja una foto en `metas.json`, con
 *   rebote, para que `/meta` y el panel de la terminal muestren lo mismo. Nunca en el camino del SSE de tareas.
 * - La consola nunca ve ni crea comandos: solo `tieneComando`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { conteoDeMetas } from './public/ui/reglas-metas.js';

const REBOTE_FOTO_MS = 10 * 1000;
const VIGILAR_MS = 15 * 1000;

/**
 * @param {object} deps
 * @param {Function} deps.workspaces  () => [{ id, name, displayName, path }]
 * @param {object} deps.tareas        telegram-bridge/tareas.js (listar, asignarMeta, desvincularMeta)
 * @param {Function} deps.publicar    (evento) => void: el SSE de la consola
 * @param {object} deps.lib           mcp-server/lib/metas.js
 * @param {object} deps.rutas         mcp-server/conocimiento/rutas.js
 */
export function crearMetasWeb({ workspaces, tareas, publicar = () => {}, lib, rutas, ahora = Date.now, reboteMs = REBOTE_FOTO_MS, vigilarMs = VIGILAR_MS }) {
  const raices = new Map(); // path del workspace → Promise<raíz>
  const cache = new Map(); // ruta de metas.json → { mtimeMs, metas }
  let temporizador = null;
  let vigia = null;
  let cerrado = false;

  async function proyectos() {
    const vistos = new Map();
    for (const w of workspaces() || []) {
      if (!w || !w.path) continue;
      if (!raices.has(w.path)) raices.set(w.path, rutas.raizDeProyecto(w.path));
      const raiz = await raices.get(w.path);
      const slug = rutas.slugDeProyecto(raiz);
      if (vistos.has(slug)) continue;
      vistos.set(slug, { id: String(w.id), nombre: w.displayName || w.name || slug, slug, ruta: path.join(rutas.dirProyecto(slug), 'metas.json') });
    }
    return [...vistos.values()];
  }

  async function leerRuta(ruta) {
    let st = null;
    try { st = await fs.promises.stat(ruta); } catch { cache.set(ruta, { mtimeMs: 0, metas: [] }); return []; }
    const previo = cache.get(ruta);
    if (previo && previo.mtimeMs === st.mtimeMs) return previo.metas;
    let metas = [];
    try {
      const d = JSON.parse(await fs.promises.readFile(ruta, 'utf8'));
      if (d && Array.isArray(d.metas)) metas = d.metas.filter((m) => m && typeof m.id === 'string');
    } catch { metas = previo ? previo.metas : []; }
    cache.set(ruta, { mtimeMs: st.mtimeMs, metas });
    return metas;
  }

  /** Después de escribir: se toma lo escrito como la caché, sin re-leerlo en la próxima consulta. */
  function recordar(ruta) {
    try {
      const st = fs.statSync(ruta);
      cache.set(ruta, { mtimeMs: st.mtimeMs, metas: lib.leer(ruta).metas });
    } catch { cache.delete(ruta); }
  }

  const publica = (m, p) => ({
    id: m.id, nombre: m.nombre, tipo: m.tipo, creada: m.creada, fin: m.fin ?? null, objetivo: m.objetivo ?? null,
    cerrada: Boolean(m.cerrada), tieneComando: Array.isArray(m.medir) || Array.isArray(m.riesgo),
    estado: m.estado || {}, proyecto: { id: p.id, nombre: p.nombre }
  });

  async function todas() {
    const ps = await proyectos();
    const out = [];
    for (const p of ps) for (const m of await leerRuta(p.ruta)) out.push({ meta: m, proyecto: p });
    return { ps, out };
  }

  async function listar() {
    const { ps, out } = await todas();
    return { ok: true, proyectos: ps.map(({ id, nombre }) => ({ id, nombre })), metas: out.map(({ meta, proyecto }) => publica(meta, proyecto)) };
  }

  async function buscar(id) {
    const { out } = await todas();
    return out.find((x) => x.meta.id === id) || null;
  }

  async function avisar() {
    if (cerrado) return;
    try { publicar({ tipo: 'metas', ...(await listar()) }); } catch {}
  }

  const fallo = (codigo, error) => ({ ok: false, codigo, error });
  const intentar = async (fn) => {
    try { return await fn(); } catch (err) { return fallo(400, err.message); }
  };

  async function crear({ workspaceId = null, tipo, nombre, fin = null } = {}) {
    const ps = await proyectos();
    const p = workspaceId ? ps.find((x) => x.id === String(workspaceId)) : ps.length === 1 ? ps[0] : null;
    if (!p) return fallo(400, ps.length ? 'Elegí el proyecto de la meta.' : 'No hay ningún proyecto conocido.');
    return intentar(async () => {
      const meta = lib.crearDesdeWeb({ ruta: p.ruta, tipo, nombre, fin, ahora: ahora() });
      recordar(p.ruta);
      await avisar();
      return { ok: true, meta: publica(meta, p) };
    });
  }

  async function editar(id, { nombre, fin, cerrada } = {}) {
    const x = await buscar(id);
    if (!x) return fallo(404, 'No existe esa meta.');
    const cambios = {};
    if (nombre !== undefined) cambios.nombre = nombre;
    if (fin !== undefined) cambios.fin = fin;
    if (cerrada !== undefined) cambios.cerrada = cerrada === true;
    return intentar(async () => {
      const meta = lib.editar({ ruta: x.proyecto.ruta, id, cambios, ahora: ahora() });
      recordar(x.proyecto.ruta);
      await avisar();
      return { ok: true, meta: publica(meta, x.proyecto) };
    });
  }

  async function borrar(id) {
    const x = await buscar(id);
    if (!x) return fallo(404, 'No existe esa meta.');
    return intentar(async () => {
      lib.borrarDeRuta({ ruta: x.proyecto.ruta, id });
      recordar(x.proyecto.ruta);
      tareas.desvincularMeta(id);
      await avisar();
      return { ok: true };
    });
  }

  async function asignar(tareaId, { metaId = null, familia = false } = {}) {
    if (metaId && !(await buscar(metaId))) return fallo(404, 'No existe esa meta.');
    const r = tareas.asignarMeta(tareaId, { metaId: metaId || null, familia: familia === true });
    if (!r.ok) return r;
    programarFoto();
    return { ok: true, tareas: r.tareas.map((t) => ({ id: t.id, metaId: t.metaId ?? null })) };
  }

  /** La foto para la terminal: una escritura por proyecto, solo si cambió, ≥ `reboteMs` después del último cambio. */
  async function sacarFoto() {
    const conteos = conteoDeMetas(tareas.listar());
    const { ps } = await todas();
    for (const p of ps) {
      const propias = {};
      for (const m of await leerRuta(p.ruta)) {
        if (m.tipo === 'tarjetas') propias[m.id] = conteos[m.id] || { hechas: 0, total: 0 };
      }
      if (!Object.keys(propias).length) continue;
      try {
        if (lib.sincronizarTarjetas({ ruta: p.ruta, conteos: propias, ahora: ahora() }).cambiado) recordar(p.ruta);
      } catch {}
    }
  }

  function programarFoto() {
    if (cerrado) return;
    if (temporizador) clearTimeout(temporizador);
    temporizador = setTimeout(() => { temporizador = null; sacarFoto().catch(() => {}); }, reboteMs);
    temporizador.unref?.();
  }

  /** Lo que cambia la terminal (`/meta`, la medición del mod) llega a la consola sin recargar. */
  function vigilar() {
    if (vigia || cerrado) return;
    vigia = setInterval(async () => {
      const antes = new Map([...cache].map(([r, c]) => [r, c.mtimeMs]));
      try {
        const { ps } = await todas();
        if (ps.some((p) => antes.has(p.ruta) && antes.get(p.ruta) !== cache.get(p.ruta)?.mtimeMs)) await avisar();
      } catch {}
    }, vigilarMs);
    vigia.unref?.();
  }

  function cerrar() {
    cerrado = true;
    if (temporizador) clearTimeout(temporizador);
    if (vigia) clearInterval(vigia);
    temporizador = null;
    vigia = null;
  }

  return { listar, crear, editar, borrar, asignar, programarFoto, sacarFoto, vigilar, cerrar };
}
