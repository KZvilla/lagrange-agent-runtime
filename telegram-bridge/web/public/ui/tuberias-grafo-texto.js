/*
 * FEAT-149 F4a — Los textos del grafo en el editor (notas de cada nodo, predicados de una arista) y la clásica
 * convertida a grafo. Separado de `tuberias-grafo.js` en F4c para que ninguno pase de 210 líneas.
 */
import { tituloDe, TEXTO_PUERTO, TECHO } from './tuberias-grafo.js';

/**
 * La clásica como grafo, para «Convertir a grafo». Es la misma forma que `compilarClasica` del
 * servidor (un test compara las dos): ids de nodo de la clásica, el juez con id `auditar`.
 */
export function deClasica(nodos) {
  const e = nodos.escribir || {};
  const v = nodos.verificar || {};
  const j = nodos.auditar || {};
  const vueltas = e.vueltas || 0;
  const vuelve = (x) => x === 'reescribir' && vueltas > 0;
  const limpio = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x != null));
  return {
    nodos: {
      entrada: { tipo: 'entrada' },
      escribir: limpio({ tipo: 'escribir', skill: e.skill || null, plantilla: e.plantilla || null, vueltas }),
      verificar: { tipo: 'verificar', comandos: [...(v.comandos || [])] },
      auditar: limpio({ tipo: 'juez', criterio: j.criterio || null, modelo: j.modelo || null }),
      revision: { tipo: 'revision' }
    },
    aristas: [
      { id: 'entrada-sale', desde: 'entrada', puerto: 'sale', hacia: 'escribir' },
      { id: 'escribir-ok', desde: 'escribir', puerto: 'ok', hacia: 'verificar' },
      { id: 'escribir-sin-cambios', desde: 'escribir', puerto: 'sin-cambios', hacia: 'auditar' },
      { id: 'escribir-error', desde: 'escribir', puerto: 'error', hacia: 'auditar' },
      { id: 'verificar-pasa', desde: 'verificar', puerto: 'pasa', hacia: 'auditar' },
      vuelve(v.siFalla) ? { id: 'vuelta-verificar', desde: 'verificar', puerto: 'falla', hacia: 'escribir', alAgotar: 'auditar' }
        : { id: 'verificar-falla', desde: 'verificar', puerto: 'falla', hacia: 'auditar' },
      { id: 'verificar-error', desde: 'verificar', puerto: 'error', hacia: 'auditar' },
      { id: 'auditar-pass', desde: 'auditar', puerto: 'pass', hacia: 'revision' },
      vuelve(j.siFail) ? { id: 'vuelta-auditar', desde: 'auditar', puerto: 'fail', hacia: 'escribir', alAgotar: 'revision' }
        : { id: 'auditar-fail', desde: 'auditar', puerto: 'fail', hacia: 'revision' },
      { id: 'auditar-error', desde: 'auditar', puerto: 'error', hacia: 'revision' }
    ],
    // La clásica no tenía presupuesto (la acotan sus vueltas): convertida, arranca con los techos.
    presupuesto: { ...TECHO }
  };
}

const MODO = { todas: 'espera a todas', 'todas-exitosas': 'todas exitosas', primera: 'la primera que pase', 'n-de-m': 'N de M' };

/** Las líneas de configuración que pinta la isla en cada nodo. */
export function notasDeGrafo(g) {
  const notas = {};
  for (const [id, n] of Object.entries(g.nodos)) {
    const l = [];
    // F4c — Cuántas ramas pasan a la vez, y a quién espera el Juntar.
    if (n.tipo === 'semaforo') l.push({ texto: n.cupo ? `${n.cupo} a la vez` : 'todas a la vez' });
    if (n.tipo === 'juntar') l.push({ texto: MODO[n.modo || 'todas-exitosas'] + (n.modo === 'n-de-m' && n.n ? ` (${n.n})` : '') }, ...(n.sobrantes === 'terminar' ? [{ texto: 'las que sobran terminan' }] : []));
    if (n.motor || n.modelo) l.push({ texto: [n.motor, n.modelo].filter(Boolean).join(' · ') });
    if (n.skill) l.push({ texto: `skill ${n.skill}` });
    if (n.plantilla) l.push({ texto: `plantilla · ${n.plantilla.split('\n').length} líneas` });
    if (n.vueltas) l.push({ texto: `hasta ${n.vueltas} vuelta${n.vueltas === 1 ? '' : 's'} más` });
    if (n.tipo === 'verificar') l.push({ texto: 'prueba de la tarea' }, ...(n.comandos || []).map((c) => ({ texto: c })));
    if (n.criterio) l.push({ texto: `criterio · ${n.criterio.split('\n')[0].slice(0, 40)}` });
    if (l.length) notas[id] = l;
  }
  return notas;
}

/** Qué se lee en el inspector de una arista: cuándo se toma y qué pasa al agotarse. */
export function predicados(g, a) {
  const cuando = `${tituloDe(g, a.desde)} sale por «${TEXTO_PUERTO[a.puerto] || a.puerto}»`;
  const alEscribir = g.nodos[a.hacia]?.tipo === 'escribir';
  const tope = a.tope != null ? `y la arista se usó menos de ${a.tope} ${a.tope === 1 ? 'vez' : 'veces'}` : (alEscribir ? `y ${tituloDe(g, a.hacia)} tiene vueltas` : null);
  const filas = [{ si: tope ? `${cuando} ${tope}` : cuando, va: tituloDe(g, a.hacia) }];
  if (tope) filas.push({ si: `${cuando} y ya se agotó`, va: a.alAgotar ? tituloDe(g, a.alAgotar) : 'la tarea termina (va a tu revisión)' });
  return filas;
}
