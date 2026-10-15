/**
 * FEAT-162 F2 — `orquestacionAGrafo` y `debeFestejar`. Lo corre `build.mjs --check`, y por
 * eso también el gate `grafo:check`. Además: el confeti solo se crea en src/festejo.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COLUMNA, PASO_HIJO, SEPARACION_SUB, Y_HIJOS, claveDeSujeto, debeFestejar, orquestacionAGrafo, type DatosOrquestacion, type Orquestacion } from '../src/orquestacion-convertir';

const base: Orquestacion = {
  id: 'o_1', quien: 'Spica', titulo: 'Filtros', modo: 'pedir', estado: 'activa',
  pasos: [
    { id: 'p1', texto: 'Leer', estado: 'hecho', enlaces: [] },
    { id: 'p2', texto: 'Crear', estado: 'en_curso', enlaces: [{ tipo: 'tarjeta', id: 't_a' }, { tipo: 'tarjeta', id: 't_b' }] },
    { id: 'p3', texto: 'Lanzar', estado: 'pendiente', enlaces: [{ tipo: 'lote', id: 'l_1' }, { tipo: 'tarjeta', id: 't_gone' }] }
  ],
  aprobaciones: [{ id: 'a_1', metodo: 'partirTarjeta', ruta: '/api/tarjetas/t_a/partir', estado: 'pendiente' }, { id: 'a_0', metodo: 'x', ruta: '/', estado: 'aprobada' }]
};
const datos: DatosOrquestacion = {
  orquestacion: base,
  tarjetas: {
    t_a: { titulo: 'A', estado: 'en_curso', sujeto: { tipo: 'agente', nombre: 'lagrange-architect' } },
    t_b: { titulo: 'B', estado: 'por_hacer', sujeto: { tipo: 'agente', nombre: 'lagrange-architect' } },
    t_gone: { titulo: null, estado: 'x', sujeto: null, noExiste: true }
  },
  lotes: { l_1: { titulo: 'Lote', estado: 'para revisar', modelo: 'gemini-3.8-flash' } }
};

const { nodes, edges } = orquestacionAGrafo(datos);
const ids = nodes.map((n) => n.id);
assert.deepEqual(ids.filter((i) => i.startsWith('paso:')), ['paso:p1', 'paso:p2', 'paso:p3'], 'los pasos, en orden');
assert.ok(ids.includes('quien'), 'el orquestador');
assert.ok(edges.some((e) => e.source === 'quien' && e.target === 'paso:p1'), 'el orquestador lleva al primer paso');
assert.ok(edges.some((e) => e.source === 'paso:p1' && e.target === 'paso:p2' && e.animated), 'la arista hacia el paso en curso se anima');
assert.ok(edges.some((e) => e.source === 'paso:p2' && e.target === 'paso:p3' && !e.animated), 'hacia uno pendiente, no');

// Tarjetas apiladas bajo su paso, sin encimarse.
const pos = (id: string) => nodes.find((n) => n.id === id)!.position;
assert.equal(pos('tarjeta:t_a').x, pos('paso:p2').x, 'la tarjeta bajo su paso');
assert.equal(pos('tarjeta:t_b').y - pos('tarjeta:t_a').y, PASO_HIJO, 'la segunda, apilada debajo');
assert.ok(ids.includes('aprob:a_1') && !ids.includes('aprob:a_0'), 'solo la aprobación pendiente es nodo');
assert.equal(pos('aprob:a_1').x, pos('paso:p2').x, 'la aprobación va bajo el paso en curso');
assert.equal(nodes.find((n) => n.id === 'tarjeta:t_gone')!.data.estado, 'no_existe', 'una tarjeta borrada se pinta como «ya no existe»');

// Subagentes: uno por sujeto, compartido; el lote por su modelo; sin sujeto, ninguno.
const subs = nodes.filter((n) => n.data.tipo === 'sub');
assert.deepEqual(subs.map((n) => n.id).sort(), ['sub:agente:lagrange-architect', 'sub:lote:gemini-3.8-flash'], 'un subagente por sujeto y uno por modelo de lote');
const arq = subs.find((n) => n.id === 'sub:agente:lagrange-architect')!;
assert.equal(arq.data.cuenta, 2, 'el arquitecto tiene dos encargos');
assert.equal(arq.data.corriendo, true, 'y uno corre');
assert.ok(edges.filter((e) => e.target === arq.id).length === 2, 'cada encargo se une a su subagente');
assert.ok(subs.every((s) => s.position.y > Y_HIJOS + PASO_HIJO * 2), 'los subagentes, debajo de la pila más alta');

// Las asas, en la función pura: lo que baja de un paso sale por abajo; lo que va al subagente, por el costado.
assert.ok(edges.filter((e) => e.source.startsWith('paso:') && !e.target.startsWith('paso:')).every((e) => e.sourceHandle === 'abajo'), 'del paso hacia abajo, por el asa de abajo');
assert.ok(edges.filter((e) => e.target.startsWith('sub:')).every((e) => e.sourceHandle === 'lado'), 'hacia el subagente, por el costado');

// Sin solapes con las alturas reales (una tarjeta ~70 px, una aprobación ~100 px): 10 hijos, 2 aprobaciones y 6 subagentes.
const ALTO: Record<string, number> = { quien: 110, paso: 70, hijo: 70, aprob: 100, sub: 70 };
const muchos: DatosOrquestacion = {
  orquestacion: { ...base, aprobaciones: [{ id: 'a1', metodo: 'partirTarjeta', ruta: '/', estado: 'pendiente' }, { id: 'a2', metodo: 'lanzarLote', ruta: '/', estado: 'pendiente' }],
    pasos: [{ id: 'p', texto: 'Mucho', estado: 'en_curso', enlaces: Array.from({ length: 10 }, (_, i) => ({ tipo: 'tarjeta' as const, id: `t${i}` })) }] },
  tarjetas: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, { titulo: `T${i}`, estado: 'por_hacer', sujeto: { tipo: 'agente', nombre: `ag${i % 6}` } }])),
  lotes: {}
};
const g2 = orquestacionAGrafo(muchos);
const cajas = g2.nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, alto: ALTO[n.data.tipo] }));
for (let i = 0; i < cajas.length; i++) for (let j = i + 1; j < cajas.length; j++) {
  const [a, b] = cajas[i].y <= cajas[j].y ? [cajas[i], cajas[j]] : [cajas[j], cajas[i]];
  assert.ok(Math.abs(a.x - b.x) >= 150 || b.y - a.y >= a.alto, `sin solapes: ${a.id} y ${b.id}`);
}
assert.equal(g2.nodes.filter((n) => n.data.tipo === 'aprob').length, 2, 'las dos aprobaciones');

// Sin pasos, las aprobaciones cuelgan del orquestador.
const sinPasos = orquestacionAGrafo({ orquestacion: { ...base, pasos: [], aprobaciones: [{ id: 'a9', metodo: 'castear', ruta: '/', estado: 'pendiente' }] }, tarjetas: {}, lotes: {} });
assert.ok(sinPasos.nodes.some((n) => n.id === 'aprob:a9') && sinPasos.edges.some((e) => e.source === 'quien' && e.target === 'aprob:a9'), 'sin pasos, la aprobación bajo el orquestador');
const xsSub = g2.nodes.filter((n) => n.data.tipo === 'sub').map((n) => n.position.x).sort((a, b) => a - b);
assert.equal(xsSub.length, 6, 'seis subagentes');
for (let i = 1; i < xsSub.length; i++) assert.ok(xsSub[i] - xsSub[i - 1] >= SEPARACION_SUB, 'separados al menos 190 px');
assert.ok(COLUMNA >= 200, 'columnas anchas');

// BE-131 — La misma tarjeta en dos pasos (crear → partir): un nodo por paso, ids únicos, un solo encargo.
const repetida: DatosOrquestacion = {
  orquestacion: { ...base, aprobaciones: [], pasos: [
    { id: 'q1', texto: 'Crear', estado: 'hecho', enlaces: [{ tipo: 'tarjeta', id: 't_a' }] },
    { id: 'q2', texto: 'Partir', estado: 'en_curso', enlaces: [{ tipo: 'tarjeta', id: 't_a' }] }
  ] },
  tarjetas: { t_a: datos.tarjetas.t_a }, lotes: {}
};
const g3 = orquestacionAGrafo(repetida);
const pos3 = (id: string) => g3.nodes.find((n) => n.id === id)!.position;
assert.equal(new Set(g3.nodes.map((n) => n.id)).size, g3.nodes.length, 'ids de nodos únicos');
assert.equal(new Set(g3.edges.map((e) => e.id)).size, g3.edges.length, 'ids de aristas únicos');
assert.equal(pos3('tarjeta:t_a').x, pos3('paso:q1').x, 'la primera, bajo el primer paso');
assert.equal(pos3('tarjeta:t_a@q2').x, pos3('paso:q2').x, 'la repetida, bajo el segundo');
assert.equal(g3.nodes.find((n) => n.id === 'sub:agente:lagrange-architect')!.data.cuenta, 1, 'el subagente cuenta un solo encargo');
assert.equal(g3.edges.filter((e) => e.target === 'sub:agente:lagrange-architect').length, 2, 'y lo unen las dos');
const triple = orquestacionAGrafo({ ...repetida, orquestacion: { ...repetida.orquestacion, pasos: [
  { id: 'q1', texto: 'Uno', estado: 'en_curso', enlaces: [{ tipo: 'tarjeta', id: 't_a' }, { tipo: 'tarjeta', id: 't_a' }, { tipo: 'tarjeta', id: 't_a' }] }
] } });
assert.equal(new Set(triple.nodes.map((n) => n.id)).size, triple.nodes.length, 'repetida en el mismo paso: ids únicos igual');

// Claves de sujeto.
assert.equal(claveDeSujeto({ tipo: 'alma', clave: 'alya' }), 'alma:alya');
assert.equal(claveDeSujeto(null), null);

// Festejos.
const hecho = (o: Orquestacion, id: string): Orquestacion => ({ ...o, pasos: o.pasos.map((p) => (p.id === id ? { ...p, estado: 'hecho' } : p)) });
assert.equal(debeFestejar(null, base, false), null, 'nunca en el primer render');
assert.equal(debeFestejar(base, hecho(base, 'p2'), false), 'corto', 'un paso que pasa a hecho');
assert.equal(debeFestejar(base, hecho(base, 'p2'), true), null, 'nada con reduced-motion');
assert.equal(debeFestejar(base, base, false), null, 'sin cambios, nada');
const todoHecho = { ...base, pasos: base.pasos.map((p) => ({ ...p, estado: 'hecho' as const })) };
assert.equal(debeFestejar(todoHecho, { ...todoHecho, estado: 'terminada' }, false), 'grande', 'terminar con todo hecho');
assert.equal(debeFestejar(base, { ...base, estado: 'terminada' }, false), null, 'terminar con pasos sin hacer, no');

// El confeti solo en festejo.ts, y sin worker (la CSP no deja).
// La prueba corre compilada en una carpeta temporal: se busca src/ desde donde se lanzó el build.
const src = [path.join(process.cwd(), 'src'), path.join(process.cwd(), 'telegram-bridge', 'web', 'grafo', 'src')].find((d) => fs.existsSync(path.join(d, 'festejo.ts')))!;
const sinComentarios = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
for (const f of fs.readdirSync(src)) {
  const t = sinComentarios(fs.readFileSync(path.join(src, f), 'utf8'));
  if (f !== 'festejo.ts') assert.ok(!/\bconfetti\s*[.(]/.test(t) && !/canvas-confetti/.test(t), `${f}: el confeti solo en festejo.ts`);
}
const festejo = sinComentarios(fs.readFileSync(path.join(src, 'festejo.ts'), 'utf8'));
assert.ok(/confetti\.create\([^)]*useWorker:\s*false/.test(festejo), 'festejo.ts crea la instancia con useWorker: false');
assert.ok(!/\bconfetti\(/.test(festejo), 'y nunca usa la función global');
console.log('orquestacion: ok');
