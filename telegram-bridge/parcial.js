/**
 * FEAT-055 — La respuesta de un alma o de un cast mientras se escribe.
 *
 * agy manda el texto en pedazos (`text_delta`, incremental y cortado en mitad
 * de las palabras). Este módulo los junta, oculta el bloque de memoria que el
 * agente agrega al final y decide cuándo publicar. No sabe nada del canal:
 * recibe `publicar(texto)`.
 *
 * Nada de esto se guarda: la respuesta que queda es la final, que ya pasa por
 * `extraerBloque` / `extraerAprendizaje`.
 */

import { redactSecrets } from './policy.js';

// Los marcadores exactos que buscan `mcp-server/almas/bloque.js` y
// `mcp-server/agents/aprendizaje.js`. Una variante (`<ALMA>`) tampoco se
// extrae al final, así que en vivo tampoco se oculta.
export const MARCADOR_ALMA = '<alma>';
export const MARCADOR_CAST = '<memoria>';
// FEAT-058 — Un alma cierra con dos bloques: el del tablero y el de memoria.
export const MARCADORES_ALMA = Object.freeze(['<tablero>', MARCADOR_ALMA]);
// FEAT-059 — Un cast de orquestación cierra con el bloque del tablero.
export const MARCADORES_CAST = Object.freeze(['<tablero>', MARCADOR_CAST]);

export const INTERVALO_CORTO_MS = 300;
export const INTERVALO_LARGO_MS = 1000;
// Pasado este tamaño se publica más espaciado: cada publicación redacta el
// texto entero, y redactar por tramos no es seguro (un secreto puede quedar
// partido entre dos pedazos).
export const UMBRAL_LARGO = 8 * 1024;
export const TOPE_ACUMULADO = 32 * 1024;

/**
 * Lo que se puede mostrar de `acumulado`.
 *
 * Corta en la PRIMERA aparición del marcador: la extracción final usa la
 * última, así que el bloque real siempre queda dentro de lo oculto. Si el
 * texto termina en un prefijo del marcador (`<`, `<al`), esa cola se retiene
 * hasta saber si sigue el marcador.
 */
export function textoVisibleEnVivo(acumulado, marcador) {
  const texto = String(acumulado ?? '');
  // FEAT-058 — Con varios marcadores: corta en el primero que aparezca, y la
  // cola que se retiene es la más larga que sea prefijo de cualquiera.
  const marcadores = Array.isArray(marcador) ? marcador : [marcador];
  let corte = -1;
  for (const m of marcadores) {
    const i = texto.indexOf(m);
    if (i >= 0 && (corte === -1 || i < corte)) corte = i;
  }
  if (corte >= 0) return texto.slice(0, corte);
  let cola = 0;
  for (const m of marcadores) {
    for (let n = Math.min(m.length - 1, texto.length); n > cola; n--) {
      if (texto.endsWith(m.slice(0, n))) { cola = n; break; }
    }
  }
  return texto.slice(0, texto.length - cola);
}

/**
 * Junta los pedazos de una tarea y publica el texto visible entero (no el
 * pedazo): una pestaña que pierde un evento se corrige con el siguiente.
 *
 * Como mucho una publicación por intervalo; la última pendiente siempre sale
 * con el temporizador. Pasado el tope deja de publicar. `cerrar()` cancela lo
 * pendiente y apaga el acumulador.
 */
export function crearAcumuladorParcial({
  marcador,
  publicar,
  intervaloCortoMs = INTERVALO_CORTO_MS,
  intervaloLargoMs = INTERVALO_LARGO_MS,
  umbralLargo = UMBRAL_LARGO,
  tope = TOPE_ACUMULADO,
  ahora = Date.now
}) {
  let acumulado = '';
  let ultimoPublicado = null;
  let ultimaVez = -Infinity;
  let temporizador = null;
  let cerrado = false;
  let excedido = false;

  const intervalo = () => (acumulado.length > umbralLargo ? intervaloLargoMs : intervaloCortoMs);

  const emitir = () => {
    temporizador = null;
    if (cerrado || excedido) return;
    const visible = redactSecrets(textoVisibleEnVivo(acumulado, marcador));
    ultimaVez = ahora();
    if (visible === ultimoPublicado || !visible.trim()) return;
    ultimoPublicado = visible;
    try {
      publicar(visible);
    } catch (err) {
      console.warn(`[parcial] No se pudo publicar: ${redactSecrets(err.message)}`);
    }
  };

  return {
    agregar(pedazo) {
      if (cerrado || excedido || !pedazo) return;
      acumulado += String(pedazo);
      if (acumulado.length > tope) {
        excedido = true;
        if (temporizador) clearTimeout(temporizador);
        temporizador = null;
        return;
      }
      if (temporizador) return;
      const espera = ultimaVez + intervalo() - ahora();
      if (espera <= 0) emitir();
      else temporizador = setTimeout(emitir, espera);
    },
    cerrar() {
      cerrado = true;
      if (temporizador) clearTimeout(temporizador);
      temporizador = null;
    },
    get excedido() { return excedido; }
  };
}
