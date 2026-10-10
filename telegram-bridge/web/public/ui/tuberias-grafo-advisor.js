/*
 * FEAT-149 F4b — «Pasar a Advisor» desde el menú de un Verificar o un Juez: un Advisor en su arista de
 * falla. La arista pasa a llevar al Advisor y, si iba a un Escribir, el «corregir» del Advisor va a ese
 * Escribir con el tope y el desvío que tenía (es el mismo bucle, ahora con indicaciones). Los demás
 * puertos quedan sueltos: la validación en vivo los marca. Pura, como `tuberias-grafo.js`.
 */
import * as G from './tuberias-grafo.js';

const FALLA = Object.freeze({ verificar: 'falla', juez: 'fail' });

export function puedePasarAAdvisor(g, id) { return Boolean(FALLA[g.nodos[id]?.tipo]); }

export function pasarAAdvisor(g, id) {
  const puerto = FALLA[g.nodos[id]?.tipo];
  if (!puerto) return { grafo: g, id: null };
  const { grafo, id: nuevo } = G.agregarNodo(g, 'advisor');
  const previa = grafo.aristas.find((x) => x.desde === id && x.puerto === puerto);
  if (!previa) return { grafo: G.conectar(grafo, id, puerto, nuevo), id: nuevo };
  const { hacia: destino, tope, alAgotar } = previa;
  previa.hacia = nuevo;
  delete previa.tope;
  delete previa.alAgotar;
  if (grafo.nodos[destino]?.tipo !== 'escribir') return { grafo, id: nuevo };
  const r = G.conectar(grafo, nuevo, 'corregir', destino);
  const corregir = r.aristas.find((x) => x.desde === nuevo && x.puerto === 'corregir');
  if (tope != null) corregir.tope = tope;
  if (alAgotar) corregir.alAgotar = alAgotar;
  return { grafo: r, id: nuevo };
}
