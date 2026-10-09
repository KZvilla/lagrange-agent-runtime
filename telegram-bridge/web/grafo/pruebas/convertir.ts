/**
 * FEAT-148 — `aGrafo`: de la tubería del servidor a nodos y cables. Lo corre
 * `build.mjs --check` (compilado con esbuild), y por eso también el gate `grafo:check`.
 */
import assert from 'node:assert/strict';
import { aGrafo, borradorAGrafo, contar, duracion, estadoCable, etiquetaCable } from '../src/convertir';
import { escalarReloj, pasoDeMarcas } from '../src/reloj';
import type { Tuberia } from '../src/tipos';

const receta: Tuberia['receta'] = {
  id: 'lote', version: 1, etapas: [
    { id: 'escribir', tipo: 'escribir', titulo: 'Escribir' },
    { id: 'verificar', tipo: 'verificar', titulo: 'Verificar' },
    { id: 'auditar', tipo: 'auditar', titulo: 'Auditar' },
    { id: 'revision', tipo: 'humano', titulo: 'Revisión', salidas: ['integrar', 'descartar'] }
  ]
};

const tuberia: Tuberia = {
  receta,
  estado: 'auditando',
  escrituraMs: 96815,
  resumen: { escribir: 'ok', verificar: 'ok', auditar: 'corriendo', revision: 'pendiente' },
  cruces: { escribir: 2, verificar: 2, auditar: 2, revision: 0 },
  tareas: [
    { id: 'despedida', etapas: {
      escribir: { estado: 'ok', actor: { motor: 'antigravity', modelo: 'gemini-3.8-flash' } },
      verificar: { estado: 'ok', duracionMs: 1200 },
      auditar: { estado: 'ok', actor: { motor: 'antigravity', modelo: 'gemini-3.1-pro' }, duracionMs: 23000, veredicto: 'PASS' } } },
    { id: 'gritar', etapas: {
      escribir: { estado: 'ok', actor: { motor: 'antigravity', modelo: 'gemini-3.8-flash' } },
      verificar: { estado: 'ok', duracionMs: 900 },
      auditar: { estado: 'corriendo', actor: { motor: 'antigravity', modelo: 'gemini-3.1-pro' } } } }
  ],
  revision: { estado: 'pendiente' },
  historial: []
};

const casos: [string, () => void][] = [
  ['un nodo de entrada más uno por etapa, en el orden de la receta', () => {
    const { nodes } = aGrafo(tuberia);
    assert.deepEqual(nodes.map((n) => n.id), ['entrada', 'escribir', 'verificar', 'auditar', 'revision']);
    assert.ok(nodes.every((n, i) => i === 0 || n.position.x > nodes[i - 1].position.x), 'de izquierda a derecha');
  }],
  ['el estado de cada nodo es el resumen del servidor, sin derivar', () => {
    const { nodes } = aGrafo(tuberia);
    assert.equal(nodes.find((n) => n.id === 'auditar')?.data.estado, 'corriendo');
    assert.equal(nodes.find((n) => n.id === 'revision')?.data.estado, 'pendiente');
  }],
  ['los actores se agrupan sin repetir', () => {
    const { nodes } = aGrafo(tuberia);
    assert.deepEqual(nodes.find((n) => n.id === 'escribir')?.data.actores, ['antigravity · gemini-3.8-flash']);
  }],
  ['conteo y detalle del nodo', () => {
    const { nodes } = aGrafo(tuberia);
    const auditar = nodes.find((n) => n.id === 'auditar')!;
    assert.equal(auditar.data.conteo, '1 en curso · 1 ok de 2');
    assert.equal(auditar.data.detalle, '23s');
    assert.equal(nodes.find((n) => n.id === 'escribir')?.data.detalle, '1m 37s');
    assert.deepEqual(nodes.find((n) => n.id === 'entrada')?.data.chips.map((c) => c.id), ['despedida', 'gritar']);
  }],
  ['los cables toman la forma del estado de la etapa a la que llegan, con su etiqueta', () => {
    const { edges } = aGrafo(tuberia);
    const porId = Object.fromEntries(edges.map((e) => [e.id, e]));
    assert.equal(edges.length, 4);
    assert.equal(porId['verificar->auditar'].className, 'cable cable-corriendo');
    assert.equal(porId['verificar->auditar'].animated, false, 'la animación es la raya-punto propia, no la de React Flow');
    assert.equal(porId['entrada->escribir'].className, 'cable cable-hecho');
    assert.equal(porId['auditar->revision'].className, 'cable cable-pendiente');
    assert.equal(porId['entrada->escribir'].label, '2');
    assert.equal(porId['escribir->verificar'].label, '2 de 2');
    assert.equal(porId['auditar->revision'].label, '1 PASS');
  }],
  ['estadoCable, contar y duracion', () => {
    assert.equal(estadoCable('falla'), 'falla');
    assert.equal(estadoCable('omitida'), 'omitida');
    assert.equal(estadoCable('esperando'), 'hecho');
    assert.equal(estadoCable('pendiente'), 'pendiente');
    assert.equal(contar([]), 'sin tareas');
    assert.equal(contar(['ok', 'ok']), '2 ok de 2');
    assert.equal(duracion(3_700_000), '1h 01m');
    assert.equal(etiquetaCable({ ...tuberia, tareas: [] }, 'verificar'), null);
  }],
  ['chips por tarea con su estado y veredicto; la revisión en espera los recibe en ámbar', () => {
    const { nodes } = aGrafo(tuberia);
    assert.deepEqual(nodes.find((n) => n.id === 'auditar')?.data.chips, [
      { id: 'despedida', estado: 'ok', veredicto: 'PASS' }, { id: 'gritar', estado: 'corriendo', veredicto: null }]);
    assert.deepEqual(nodes.find((n) => n.id === 'revision')?.data.chips, []);
    const espera: Tuberia = { ...tuberia, revision: { estado: 'esperando', motivo: 'esperando tu decisión' },
      tareas: tuberia.tareas.map((x) => ({ ...x, etapas: { ...x.etapas, auditar: { ...x.etapas.auditar, estado: 'ok', veredicto: 'PASS' } } })) };
    const rev = aGrafo(espera).nodes.find((n) => n.id === 'revision')!;
    assert.deepEqual(rev.data.chips.map((c) => c.estado), ['esperando', 'esperando']);
    assert.equal(rev.data.detalle, null, 'el motivo no se repite: el estado ya dice que espera');
  }],
  ['la selección marca un solo nodo', () => {
    const { nodes } = aGrafo(tuberia, 'auditar');
    assert.deepEqual(nodes.filter((n) => n.data.seleccionado).map((n) => n.id), ['auditar']);
  }],
  ['reloj: filas, posiciones, esperas y la línea ahora', () => {
    const t0 = Date.parse('2026-10-09T10:00:00Z');
    const r = {
      inicioMs: t0, finMs: null, esperaMs: 10_000,
      fases: [{ etapa: 'escribir', desde: t0, hasta: t0 + 60_000 }],
      tareas: [{ id: 'a', tramos: [{ etapa: 'verificar', desde: t0 + 60_000, hasta: t0 + 70_000, tipo: 'espera' as const },
        { etapa: 'verificar', desde: t0 + 70_000, hasta: null, tipo: 'trabajo' as const }] }]
    };
    const e = escalarReloj(r, t0 + 100_000);
    assert.deepEqual(e.filas.map((f) => f.id), ['escribir', 'a']);
    assert.equal(e.totalMs, 100_000);
    assert.equal(e.filas[0].segmentos[0].ancho, 60);
    assert.equal(e.filas[1].segmentos[0].tipo, 'espera');
    assert.equal(e.filas[1].segmentos[1].sigue, true);
    assert.equal(e.filas[1].segmentos[1].ancho, 30);
    assert.equal(e.ahora, 100);
    const viejo = escalarReloj({ ...r, finMs: t0 + 100_000, tareas: [] }, t0 + 999_000);
    assert.equal(viejo.soloFases, true);
    assert.equal(viejo.ahora, null);
    const escribiendo = escalarReloj({ ...r, tareas: [] }, t0 + 30_000);
    assert.equal(escribiendo.soloFases, false, 'mientras escribe no es un lote viejo');
    assert.deepEqual(escribiendo.filas.map((f) => f.id), ['escribir']);
    assert.equal(pasoDeMarcas(100_000), 15_000);
    assert.equal(pasoDeMarcas(150_000), 30_000);
  }],
  ['G3: el borrador dibuja la receta con los actores elegidos, todo pendiente y punteado', () => {
    const { nodes, edges } = borradorAGrafo({ tareas: ['saludo', 'suma'], conPrueba: ['saludo'], escribir: 'claude@trabajo · sonnet · medium', auditar: 'agy · gemini-3.1-pro · high' }, 'escribir');
    assert.deepEqual(nodes.map((n) => n.id), ['entrada', 'escribir', 'verificar', 'auditar', 'revision']);
    assert.deepEqual(nodes.find((n) => n.id === 'escribir')?.data.actores, ['claude@trabajo · sonnet · medium']);
    assert.ok(nodes.filter((n) => n.id !== 'entrada').every((n) => n.data.estado === 'pendiente'));
    assert.deepEqual(nodes.find((n) => n.id === 'verificar')?.data.chips.map((c) => c.veredicto), ['prueba', 'sin prueba']);
    assert.ok(edges.every((e) => e.className === 'cable cable-pendiente'));
    assert.equal(edges[0].label, '2');
    assert.deepEqual(nodes.filter((n) => n.data.seleccionado).map((n) => n.id), ['escribir']);
  }],
  ['la revisión muestra la salida tomada', () => {
    const { nodes } = aGrafo({ ...tuberia, revision: { estado: 'ok', salida: 'integrar' }, resumen: { ...tuberia.resumen, revision: 'ok' } });
    assert.equal(nodes.find((n) => n.id === 'revision')?.data.detalle, '→ integrar');
  }]
];

let fallas = 0;
for (const [nombre, fn] of casos) {
  try { fn(); console.log(`  PASS  ${nombre}`); } catch (err) { fallas++; console.log(`  FAIL  ${nombre} — ${(err as Error).message}`); }
}
console.log(`\n${casos.length - fallas}/${casos.length} checks passed`);
if (fallas) process.exitCode = 1;
