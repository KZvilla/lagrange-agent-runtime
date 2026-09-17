/**
 * BE-028 — Archivo append-only de lo que el sistema descarta.
 *
 * Hasta acá, dos topes bien puestos destruían historia de forma irreversible:
 * `tareas.js` expulsa las tareas cerradas más viejas (con su `resultado`
 * completo) al pasar de `TOPE_TAREAS`, y `almas/diario.js` trunca el diario de
 * 500 a 200 líneas al rotar. Los dos topes existen por el mismo motivo: son
 * archivos que se reescriben **enteros** en cada cambio y no pueden crecer sin
 * límite.
 *
 * Este módulo es la otra mitad: lo expulsado se **anexa** a un archivo mensual
 * en JSONL antes de desaparecer. Un JSONL no se reescribe nunca, no se carga
 * en memoria y se consulta desde el día uno con `grep` o `jq` — no hace falta
 * un índice para que valga la pena (esa es `FEAT-063`, y es otra discusión).
 *
 * Reglas, en orden de importancia:
 *
 * 1. **Archivar nunca puede romper al que archiva.** Ninguna función de acá
 *    lanza. Si el disco falla, se avisa por consola y el llamador sigue con lo
 *    suyo: perder una línea de historia es malo, perder el guardado del
 *    registro o del diario es peor.
 * 2. **Solo append.** `appendFileSync` sobre un archivo que nadie reescribe.
 *    No hay temporal ni rename: un `escribirAtomico` acá reescribiría el
 *    archivo entero, que es justamente lo que se quiere evitar.
 * 3. **Se archiva lo que ya está saneado.** Las tareas pasan por
 *    `redactSecrets` al entrar al registro y las entradas del diario ya vienen
 *    recortadas. Este módulo no vuelve a sanear: no es su trabajo y hacerlo
 *    dos veces esconde de dónde salió lo que se guardó.
 * 4. **At-least-once: el archivo tolera duplicados, a propósito.** En
 *    `tareas.js` se archiva ANTES de `guardarJson`. Si el archivado sale bien
 *    y el guardado falla (disco lleno, I/O), las tareas quedaron anexadas pero
 *    siguen en `tareas.json`, y la próxima expulsión las anexa otra vez. Es el
 *    lado correcto del compromiso: archivar después perdería la historia justo
 *    cuando el disco falla, que es cuando más importa. Quien lea el archivo
 *    tiene que contar con repetidos (la clave natural es `id` + `terminada`).
 *
 * SEC-016 — El archivo hereda la clasificación de su origen: es tan sensible
 * como el registro de tareas y como el diario de un alma, vive en el mismo
 * directorio de datos del usuario, nunca sale de la máquina y queda fuera de
 * toda exportación (incluido el sobre de identidad de FEAT-051).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Subdirectorio, relativo al del origen, donde vive el archivo. */
const DIR_HISTORIA = 'historia';

/**
 * `YYYY-MM` de una fecha ISO, o `null` si no se puede leer. Deliberadamente no
 * cae a "hoy" ante una fecha ilegible: una entrada sin fecha archivada en el
 * mes en curso miente sobre cuándo pasó. Van a `sin-fecha.jsonl`.
 */
function mesDe(iso) {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Ruta del archivo mensual dentro del directorio de historia de un origen. */
function archivoDelMes(dirOrigen, mes) {
  return path.join(dirOrigen, DIR_HISTORIA, `${mes || 'sin-fecha'}.jsonl`);
}

/**
 * Anexa entradas al archivo mensual que a cada una le corresponde.
 *
 * @param {string}   dirOrigen  directorio del archivo que está perdiendo datos
 * @param {object[]} entradas   lo que se va a descartar
 * @param {(entrada: object) => string|null} fechaDe  de dónde sale el mes
 * @returns {{ archivadas: number, fallidas: number }}
 */
function archivar(dirOrigen, entradas, fechaDe) {
  if (!Array.isArray(entradas) || entradas.length === 0) return { archivadas: 0, fallidas: 0 };
  // Un destino que no es una ruta se rechaza acá y no más abajo: `path.join`
  // lanza ante un `null`, y lanzar es exactamente lo que este módulo no puede
  // hacer.
  if (typeof dirOrigen !== 'string' || !dirOrigen) {
    console.error(`[historia] Destino inválido (${typeof dirOrigen}): no se archivan ${entradas.length} entrada(s).`);
    return { archivadas: 0, fallidas: entradas.length };
  }

  // Agrupar antes de escribir: una tanda puede cruzar el cambio de mes, y así
  // se abre cada archivo una sola vez.
  const porMes = new Map();
  let fallidas = 0;
  for (const entrada of entradas) {
    let linea;
    let mes;
    try {
      // Todo lo que depende de la entrada va acá adentro: serializarla puede
      // fallar por un ciclo o un getter que lanza, y `fechaDe` es código del
      // llamador que puede tropezar con una entrada rara (o no ser función).
      linea = JSON.stringify(entrada);
      mes = mesDe(typeof fechaDe === 'function' ? fechaDe(entrada) : null);
    } catch (err) {
      // Una entrada mala no puede tumbar la tanda entera.
      fallidas++;
      console.error(`[historia] Entrada descartada al archivar: ${err.message}`);
      continue;
    }
    if (typeof linea !== 'string') { fallidas++; continue; }
    const lista = porMes.get(mes) || [];
    lista.push(linea);
    porMes.set(mes, lista);
  }

  let archivadas = 0;
  for (const [mes, lineas] of porMes) {
    try {
      const ruta = archivoDelMes(dirOrigen, mes);
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fs.appendFileSync(ruta, lineas.join('\n') + '\n', 'utf8');
      archivadas += lineas.length;
    } catch (err) {
      fallidas += lineas.length;
      console.error(`[historia] No se pudo archivar en ${dirOrigen} (${mes}): ${err.message}`);
    }
  }
  return { archivadas, fallidas };
}

/**
 * Las entradas de un mes, para leer el archivo sin conocer su formato.
 *
 * `leerMes` y `mesesArchivados` son el lado de lectura de este módulo, no un
 * anticipo de `FEAT-063` (la búsqueda, que sigue fuera de la iteración). Se
 * quedan por dos motivos: hoy los usan las dos suites que verifican que nada
 * se pierde, y sin ellos cada consumidor —incluido un `node -e` a mano— se
 * reimplementa el parseo tolerante de JSONL, que es justo donde se cuela el
 * error de tirar el mes entero por una línea rota.
 */
function leerMes(dirOrigen, mes) {
  let texto;
  try {
    texto = fs.readFileSync(archivoDelMes(dirOrigen, mes), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error(`[historia] No se pudo leer el mes ${mes} de ${dirOrigen}: ${err.message}`);
    return [];
  }
  const salida = [];
  for (const linea of texto.split(/\r?\n/)) {
    if (!linea.trim()) continue;
    // Una línea rota se saltea: un append interrumpido no puede inutilizar el
    // resto del mes.
    try {
      const obj = JSON.parse(linea);
      if (obj && typeof obj === 'object') salida.push(obj);
    } catch {}
  }
  return salida;
}

/** Los meses archivados de un origen, del más viejo al más nuevo. */
function mesesArchivados(dirOrigen) {
  try {
    return fs.readdirSync(path.join(dirOrigen, DIR_HISTORIA))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort();
  } catch {
    return [];
  }
}

module.exports = { DIR_HISTORIA, mesDe, archivoDelMes, archivar, leerMes, mesesArchivados };
