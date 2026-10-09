/**
 * FEAT-148 — `aGrafo`: de la tubería del servidor a nodos y cables. Lo corre
 * `build.mjs --check` (compilado con esbuild), y por eso también el gate `grafo:check`.
 */
import assert from 'node:assert/strict';
import { aGrafo, contar, duracion, estadoCable } from '../src/convertir';
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
    assert.equal(auditar.data.detalle, 'PASS · 23s');
    assert.equal(nodes.find((n) => n.id === 'escribir')?.data.detalle, '1m 37s');
    assert.equal(nodes.find((n) => n.id === 'entrada')?.data.detalle, 'despedida · gritar');
  }],
  ['los cables toman el estado de la etapa a la que llegan', () => {
    const { edges } = aGrafo(tuberia);
    const porId = Object.fromEntries(edges.map((e) => [e.id, e]));
    assert.equal(edges.length, 4);
    assert.equal(porId['verificar->auditar'].className, 'cable cable-corriendo');
    assert.equal(porId['verificar->auditar'].animated, true);
    assert.equal(porId['entrada->escribir'].className, 'cable cable-hecho');
    assert.equal(porId['auditar->revision'].className, 'cable cable-pendiente');
  }],
  ['estadoCable, contar y duracion', () => {
    assert.equal(estadoCable('falla'), 'hecho');
    assert.equal(estadoCable('omitida'), 'pendiente');
    assert.equal(contar([]), 'sin tareas');
    assert.equal(contar(['ok', 'ok']), '2 ok de 2');
    assert.equal(duracion(3_700_000), '1h 01m');
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
