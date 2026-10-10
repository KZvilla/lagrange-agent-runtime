/**
 * FEAT-149 F4a — `libreAGrafo`: el grafo de una receta a nodos con puertos y cables. Lo corre
 * `build.mjs --check` (y por eso el gate `grafo:check`).
 */
import assert from 'node:assert/strict';
import { aristaDeCable, capas, enCamino, libreAGrafo } from '../src/libre';
import type { GrafoReceta } from '../src/tipos';

const g: GrafoReceta = {
  nodos: {
    entrada: { tipo: 'entrada' }, esc: { tipo: 'escribir', vueltas: 2 }, ver: { tipo: 'verificar' }, juez: { tipo: 'juez' },
    planb: { tipo: 'escribir', titulo: 'Plan B' }, vos: { tipo: 'revision' }
  },
  aristas: [
    { id: 'e-in', desde: 'entrada', puerto: 'sale', hacia: 'esc' },
    { id: 'esc-ok', desde: 'esc', puerto: 'ok', hacia: 'ver' },
    { id: 'ver-pasa', desde: 'ver', puerto: 'pasa', hacia: 'juez' },
    { id: 'ver-falla', desde: 'ver', puerto: 'falla', hacia: 'esc', tope: 2, alAgotar: 'planb' },
    { id: 'pb-ok', desde: 'planb', puerto: 'ok', hacia: 'juez' },
    { id: 'j-pass', desde: 'juez', puerto: 'pass', hacia: 'vos' }
  ]
};

const c = capas(g);
assert.equal(c.entrada, 0);
assert.ok(c.esc < c.ver && c.ver < c.juez, 'las capas siguen el flujo, no los cables de vuelta');
assert.ok(c.vos >= c.juez, 'Vos queda al final');

const { nodes, edges } = libreAGrafo(g, { editor: true });
const esc = nodes.find((n) => n.id === 'esc');
assert.deepEqual(esc?.data.puertos.map((p) => p.id), ['ok', 'sin-cambios', 'error'], 'un puerto por resultado, en orden');
assert.equal(esc?.data.puertos.find((p) => p.id === 'error')?.falla, true, 'los puertos de falla se marcan');
assert.equal(nodes.find((n) => n.id === 'entrada')?.deletable, false, 'la Entrada no se quita');
const vuelta = edges.find((e) => e.id === 'ver-falla');
assert.equal(vuelta?.sourceHandle, 'falla');
assert.equal(vuelta?.type, 'smoothstep', 'un cable que vuelve va escalonado');
assert.match(String(vuelta?.label), /falla · máx 2/);
const desvio = edges.find((e) => e.id === 'ver-falla~agotar');
assert.equal(desvio?.target, 'planb', 'el desvío al agotar es un cable propio');
assert.equal(aristaDeCable('ver-falla~agotar'), 'ver-falla');

const camino = enCamino(g, 'planb');
assert.ok(camino && camino.nodos.has('juez') && camino.nodos.has('entrada'), 'lo de antes y lo de después del elegido');
const resaltado = libreAGrafo(g, { seleccion: 'pb-ok', resaltar: true });
assert.equal(resaltado.nodes.find((n) => n.id === 'planb')?.data.atenuado, false);
assert.equal(resaltado.edges.find((e) => e.id === 'pb-ok')?.className?.includes('cable-atenuado'), false);

const vivo = {
  nodos: { entrada: 'ok', esc: 'ok', ver: 'falla', juez: 'corriendo', planb: 'omitida', vos: 'pendiente' } as const,
  aristas: { 'e-in': 1, 'esc-ok': 2, 'ver-falla': 1, 'ver-pasa': 1 },
  tareas: { t1: { nodos: { esc: 'ok' } as Record<string, 'ok'>, aristas: { 'ver-falla': 1 }, contadores: { 'ver-falla': 1 } } }
};
const enVivo = libreAGrafo(g, { vivo, tareaElegida: 't1' });
assert.match(String(enVivo.edges.find((e) => e.id === 'ver-falla')?.label), /· 1\/2/, 'el contador de la tarea elegida');
assert.equal(libreAGrafo(g, { vivo }).nodes.find((n) => n.id === 'juez')?.data.estado, 'corriendo');

const fija = libreAGrafo(g, { disposicion: { esc: [5, 7] } });
assert.deepEqual(fija.nodes.find((n) => n.id === 'esc')?.position, { x: 5, y: 7 }, 'la disposición gana al acomodo');

console.log('libre: ok');
