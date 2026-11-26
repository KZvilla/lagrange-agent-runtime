/**
 * FEAT-043 — El bloque `<alma>`: cómo un alma pide guardar algo.
 *
 * agy no puede llamar a una tool del plugin (no está en el `mcp_config.json`
 * del usuario), así que se usa el patrón que ya funciona en
 * `mcp-server/agents/aprendizaje.js`: una cola estructurada al final de la
 * respuesta. Es lo más barato —no hay una segunda llamada al modelo— y lo más
 * fiel: el alma sabe mejor que un parser qué vale la pena recordar. A cambio no
 * es garantía, así que el parser es tolerante y la ausencia del bloque no es un
 * error.
 *
 * Las entradas se direccionan por id (`m3`, `u2`) y no por texto: cada turno es
 * una llamada sin reintento, y un substring con una letra de diferencia
 * fallaría en silencio.
 */

const APERTURA = '<alma>';
const CIERRE = '</alma>';
const MAX_OPERACIONES = 4;
const MAX_TEXTO = 300;

const ENCABEZADO_CHARLA = 'Si algo de esta conversación te sirve para la próxima vez, agregá al final un bloque así:';

/**
 * FEAT-172 — Lo que un alma puede pedir antes de contestar. El alma no tiene
 * tools: pide en el bloque y el código ejecuta. `tipo` es el nombre con el que
 * quien llama habilita el pedido (`opciones.herramientas`).
 */
const PEDIDOS = Object.freeze({
  archivo: { prefijo: 'buscar', campo: 'consulta', ayuda: 'buscar: <palabras>        (en tu archivo de recuerdos)' },
  web: { prefijo: 'buscar-web', campo: 'consulta', ayuda: 'buscar-web: <consulta>    (en internet; la consulta se le muestra al usuario)' },
  link: { prefijo: 'leer-link', campo: 'url', ayuda: 'leer-link: <url>          (una página que te pasó el usuario)' }
});
const MAX_PEDIDO = 300;
// FEAT-210 — El pedido de una imagen: qué y para qué, en palabras del alma (el prompt técnico lo escribe el refinador).
const MAX_IMAGEN = 600;
const RE_IMAGEN = /^imagen(-desde-foto|-desde-anterior)?\s*:\s*(.+)$/i;
// FEAT-215 — Una o varias suyas, por su número: `imagen-desde #7: …`, `imagen-desde #7 y #8: …`.
// En dos pasos y sin cuantificadores anidados: la línea la escribe un modelo.
const RE_IMAGEN_NUM = /^imagen-desde ([^:]{1,120}):(.+)$/i;
const RE_NUMEROS = /^#?\d{1,6}(?:(?: ?, ?(?:y )?| y | e | and | )#?\d{1,6})*$/i;
const MAX_BASES = 4;
/** FEAT-215 — «#7, #8», y las que no tienen número (de antes de numerar) se cuentan. */
const listaDeVersiones = (nums) => {
  const con = nums.filter(Boolean);
  const sin = nums.length - con.length;
  return [...con.map((n) => `#${n}`), ...(sin ? [`${sin} sin número`] : [])].join(', ');
};

/** FEAT-210 — `{ texto, desdeFoto, desdeAnterior }` si la línea pide una imagen, o `null`. FEAT-213 — `desdeAnterior`: la última del hilo. */
function parsearImagen(linea) {
  let porNumero = /^imagen-desde\s/i.test(linea) ? RE_IMAGEN_NUM.exec(linea.slice(0, 4000).replace(/\s+/g, ' ')) : null;
  if (porNumero && !RE_NUMEROS.test(porNumero[1].trim())) porNumero = null;
  const m = porNumero ? [porNumero[0], '', porNumero[2]] : RE_IMAGEN.exec(linea);
  if (!m) return null;
  const texto = m[2].trim().replace(/\s+/g, ' ').slice(0, MAX_IMAGEN);
  if (!texto || esPlantilla(texto)) return null;
  const desde = (m[1] || '').toLowerCase();
  const nums = porNumero ? [...new Set(porNumero[1].match(/\d+/g).map(Number))].filter((n) => n > 0) : [];
  if (porNumero && !nums.length) return null;
  return { texto, desdeFoto: desde === '-desde-foto', desdeAnterior: desde === '-desde-anterior', ...(nums.length ? { nums } : {}) };
}

/**
 * La consigna que se agrega al prompt. Corta y al final, para no correrle el
 * foco al mensaje. El `encabezado` lo cambia la consolidación de la charla de
 * voz (FEAT-044), que pide el bloque solo y no una respuesta con bloque; la
 * plantilla y los topes son los mismos para las dos superficies.
 */
function instruccionDeCierre({ encabezado = ENCABEZADO_CHARLA, conTema = false, pedidos = [], puedePedirImagen = false, puedePedirAnterior = false, pideImagen = false, versiones = null, hiloExterno = false } = {}) {
  // FEAT-171 — El tema es solo de la charla: la consolidación de voz no lo pide.
  const archivar = conTema ? 'archivar m5 #tema' : 'archivar m5';
  const sobreTema = conTema
    ? ['`#tema` es opcional: una palabra en minúsculas que agrupe lo archivado (`#juegos`).']
    : [];
  // FEAT-172 — Solo con pedidos habilitados: sin ellos, la consigna es la de siempre.
  const habilitados = pedidos.filter(t => PEDIDOS[t]);
  const sobrePedidos = habilitados.length
    ? [
        '',
        'Antes de contestar podés pedir UNA de estas cosas. Si la necesitás, respondé SOLO con el',
        'bloque y esa línea, sin nada más: te llega el resultado y ahí contestás.',
        '',
        ...habilitados.map(t => PEDIDOS[t].ayuda),
        '',
        'Por ejemplo, toda tu respuesta sería:',
        APERTURA,
        `${PEDIDOS[habilitados[0]].prefijo}: ${habilitados[0] === 'link' ? 'https://ejemplo.com/nota' : 'tus palabras de búsqueda'}`,
        CIERRE
      ]
    : [];
  // FEAT-210 — Solo si las imágenes están habilitadas para esta alma y algún proveedor puede andar.
  // Un hilo con contenido de afuera, sin que el usuario la pida en este mensaje: no hay imagen, y el alma lo sabe.
  const sobreImagen = puedePedirImagen && hiloExterno
    ? [
        '',
        'En este hilo no podés hacer imágenes: trajo contenido de afuera (internet, un link o una foto que no es segura), y',
        'ahí solo se hace una si el usuario la pide en el mismo mensaje. No anuncies ni prometas una imagen: si te la',
        'pide, decile que te la pida de nuevo con «haceme una imagen de…» o que abra un hilo nuevo.'
      ]
    : puedePedirImagen
    ? [
        '',
        'También podés hacer UNA imagen por respuesta, cuando el usuario te la pide o cuando una imagen',
        'suma de verdad (nunca por costumbre). Sumá al bloque una de estas líneas:',
        'imagen: <qué imagen querés y para qué, en tus palabras>',
        'imagen-desde-foto: <qué cambiar de la foto que te mandó>   (solo si el usuario te mandó una foto)',
        // FEAT-213 — Solo si en este hilo hay una imagen suya de la que partir.
        ...(puedePedirAnterior ? ['imagen-desde-anterior: <qué cambiar de la última imagen que hiciste en este hilo>   (si te pide otra parecida o un cambio)'] : []),
        // FEAT-215 — Por su número, y cuáles hay sin elegir.
        ...(versiones && versiones.porNumero ? [`imagen-desde #7: <qué cambiar>   (una imagen tuya, por su número${versiones.varias ? '; con `#7 #8`, una edición por cada una' : ''})`] : []),
        'El prompt técnico lo escribe otro modelo; la imagen llega después de tu respuesta.',
        ...(versiones && versiones.sinElegir.length > 1
          ? [
              '',
              `La última imagen tiene varias versiones sin elegir: ${listaDeVersiones(versiones.sinElegir)}. Si el usuario pide un cambio y no dice sobre cuál,`,
              `preguntale y no pidas la imagen. Si dice cuál, usá su número${versiones.varias ? '; si dice todas, todos' : ''}.`
            ]
          : versiones && versiones.elegida ? ['', `El usuario eligió partir de la #${versiones.elegida}: \`imagen-desde-anterior\` usa esa.`] : []),
        // Medido (2026-11-25, deepseek-v4.1-flash): anunciaba la imagen y omitía la línea en 6 de 21 intentos; con esto, en 0 de 16.
        ...(pideImagen
          ? [
              '',
              'El usuario te pide una imagen en este mensaje. Si la vas a hacer, el bloque tiene que llevar su línea, y va',
              'PRIMERA: sin esa línea no se hace ninguna, aunque la anuncies en la respuesta. No cuenta entre las',
              `${MAX_OPERACIONES} operaciones.`
            ]
          : [])
      ]
    : [];
  return [
    '',
    '---',
    encabezado,
    '',
    APERTURA,
    'recordar: <algo que quieras recordar vos>',
    'sobre-vos: <algo que aprendiste del usuario>',
    'reemplazar m3: <la versión corregida>',
    archivar,
    'olvidar u2',
    CIERRE,
    '',
    `Una operación por línea, máximo ${MAX_OPERACIONES}. Los ids salen de tu memoria, tal como`,
    'aparecen ahí. `archivar` saca una entrada para hacer lugar, pero la podés volver a',
    'encontrar más adelante; `olvidar` la borra de verdad, también de lo archivado: usalo',
    'cuando te piden olvidar algo. Si no aprendiste nada nuevo, omití el bloque entero:',
    'una memoria vacía es peor que ninguna. Lo que escribas ahí no se le muestra al usuario.',
    ...sobreTema,
    ...sobrePedidos,
    ...sobreImagen
  ].join('\n');
}

/** FEAT-172 — `{tipo, consulta|url}` si la línea es un pedido, o `null`. El más largo primero: `buscar-web` empieza con `buscar`. */
function parsearPedido(linea) {
  const tipos = Object.keys(PEDIDOS).sort((a, b) => PEDIDOS[b].prefijo.length - PEDIDOS[a].prefijo.length);
  for (const tipo of tipos) {
    const { prefijo, campo } = PEDIDOS[tipo];
    const m = new RegExp(`^${prefijo}\\s*:\\s*(.+)$`, 'i').exec(linea);
    if (!m) continue;
    const valor = m[1].trim().replace(/\s+/g, ' ').slice(0, MAX_PEDIDO);
    if (!valor || esPlantilla(valor)) return null;
    return { tipo, [campo]: valor };
  }
  return null;
}

function recortar(texto) {
  return String(texto || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXTO);
}

/** Los marcadores de la plantilla no son contenido: si vuelven, no se guardan. */
function esPlantilla(texto) {
  return /^<[^>]*>$/.test(texto.trim());
}

function parsearLinea(linea) {
  let m = /^recordar\s*:\s*(.+)$/i.exec(linea);
  if (m) return { tipo: 'agregar', prefijo: 'm', texto: recortar(m[1]) };

  m = /^sobre[\s-]?vos\s*:\s*(.+)$/i.exec(linea);
  if (m) return { tipo: 'agregar', prefijo: 'u', texto: recortar(m[1]) };

  m = /^reemplaz[aá]r?\s+([mu])(\d+)\s*:\s*(.+)$/i.exec(linea);
  if (m) return { tipo: 'reemplazar', prefijo: m[1].toLowerCase(), id: `${m[1].toLowerCase()}${m[2]}`, texto: recortar(m[3]) };

  // FEAT-171 — También un id del archivo (`tm…`/`tu…`), que el alma ve entre
  // los recuerdos archivados.
  m = /^olvid[aá]r?\s+(t?)([mu])([0-9a-z]+)\s*$/i.exec(linea);
  if (m && (m[1] || /^\d+$/.test(m[3]))) {
    return { tipo: 'olvidar', prefijo: m[2].toLowerCase(), id: `${m[1]}${m[2]}${m[3]}`.toLowerCase() };
  }

  // FEAT-171 — Sale de la memoria caliente y queda en el archivo, con tema opcional.
  m = /^archiv[aá]r?\s+([mu])(\d+)(?:\s+#([a-z0-9-]{1,30}))?\s*$/i.exec(linea);
  if (m) return { tipo: 'archivar', prefijo: m[1].toLowerCase(), id: `${m[1].toLowerCase()}${m[2]}`, ...(m[3] ? { tema: m[3].toLowerCase() } : {}) };
  // Un tema inválido no tira la operación: se archiva sin él.
  m = /^archiv[aá]r?\s+([mu])(\d+)\s+#\S*\s*$/i.exec(linea);
  if (m) return { tipo: 'archivar', prefijo: m[1].toLowerCase(), id: `${m[1].toLowerCase()}${m[2]}` };

  return null;
}

/**
 * Separa la respuesta visible del bloque.
 *
 * El texto que el modelo escriba DESPUÉS del cierre se conserva: recortar hasta
 * el final borraría una despedida legítima. Solo un bloque sin cerrar se lleva
 * lo que queda.
 */
/**
 * FEAT-210 — Medido en vivo (2026-11-24): en un hilo con contenido de afuera el alma a veces omite el bloque (sabe que
 * la memoria no se guarda) y deja la línea de imagen al final del texto. Solo la ÚLTIMA línea, y solo si es una línea
 * de imagen entera: se toma como el pedido y sale de lo visible. Los filtros de `charlar` (apagadas, hilo de afuera)
 * se aplican igual.
 */
function imagenAlFinal(respuesta) {
  const lineas = respuesta.replace(/\s+$/, '').split(/\r?\n/);
  const ultima = (lineas[lineas.length - 1] || '').replace(/^\s*[-*•]\s*/, '').trim();
  const imagen = parsearImagen(ultima);
  if (!imagen) return null;
  return { respuesta: lineas.slice(0, -1).join('\n').trim(), imagen };
}

function extraerBloque(textoCrudo, { conTema = false } = {}) {
  const r = extraerBloqueCrudo(textoCrudo, { conTema });
  if (r.imagenPedida || r.pedido || !r.respuesta) return r;
  const alFinal = imagenAlFinal(r.respuesta);
  return alFinal ? { ...r, respuesta: alFinal.respuesta, imagenPedida: alFinal.imagen } : r;
}

/** Un bloque completo, con la apertura sola en su línea: una mención en la prosa no lo es. */
const BLOQUE_ENTERO = /(^|\n)[ \t]*<alma>[ \t]*\r?\n((?:(?!<alma>)[\s\S])*?)<\/alma>/g;

function extraerBloqueCrudo(textoCrudo, { conTema = false } = {}) {
  const texto = String(textoCrudo || '');
  const inicio = texto.lastIndexOf(APERTURA);
  if (inicio === -1) {
    // FEAT-172 — Medido en vivo (agy, 2026-10-20): el alma a veces escribe el
    // pedido suelto, sin el bloque. Si la respuesta entera es una sola línea de
    // pedido, es un pedido; con cualquier otra cosa alrededor, es texto.
    const lineas = texto.split(/\r?\n/).map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
    const suelto = lineas.length === 1 ? parsearPedido(lineas[0]) : null;
    if (suelto) return { respuesta: '', operaciones: [], pedido: suelto, imagenPedida: null, imagenRechazos: [] };
    // FEAT-210 — También una imagen suelta: la respuesta entera es solo la línea.
    const imagenSuelta = lineas.length === 1 ? parsearImagen(lineas[0]) : null;
    if (imagenSuelta) return { respuesta: '', operaciones: [], pedido: null, imagenPedida: imagenSuelta, imagenRechazos: [] };
    return { respuesta: texto.trim(), operaciones: [], pedido: null, imagenPedida: null, imagenRechazos: [] };
  }

  const finCierre = texto.indexOf(CIERRE, inicio);
  const cuerpo = finCierre === -1
    ? texto.slice(inicio + APERTURA.length)
    : texto.slice(inicio + APERTURA.length, finCierre);
  // Medido (2026-11-25): a veces escribe dos bloques seguidos. Los de antes también se leen, y no quedan a la vista.
  const previos = [];
  const antes = texto.slice(0, inicio).replace(BLOQUE_ENTERO, (_, salto, interior) => { previos.push(interior); return salto; });
  const despues = finCierre === -1 ? '' : texto.slice(finCierre + CIERRE.length);
  const respuesta = `${antes}\n${despues}`.replace(/\n{3,}/g, '\n\n').trim();

  const operaciones = [];
  // FEAT-172 — Un solo pedido por turno: el primero. Qué tipos valen lo decide quien llama.
  let pedido = null;
  // FEAT-210 — Una imagen por respuesta, fuera de las operaciones: no cuenta para MAX_OPERACIONES y se reconoce antes.
  let imagenPedida = null;
  const imagenRechazos = [];
  for (const lineaCruda of [...previos, cuerpo].join('\n').split(/\r?\n/)) {
    const linea = lineaCruda.replace(/^\s*[-*•]\s*/, '').trim();
    if (!linea) continue;
    const imagen = parsearImagen(linea);
    if (imagen) {
      if (!imagenPedida) imagenPedida = imagen;
      else imagenRechazos.push('una-por-turno');
      continue;
    }
    const pedida = parsearPedido(linea);
    if (pedida) {
      if (!pedido) pedido = pedida;
      continue;
    }
    if (operaciones.length >= MAX_OPERACIONES) continue;
    const op = parsearLinea(linea);
    if (!op) continue;
    if (op.texto !== undefined && (!op.texto || esPlantilla(op.texto))) continue;
    if (!conTema) delete op.tema;
    operaciones.push(op);
  }

  return { respuesta, operaciones, pedido, imagenPedida, imagenRechazos };
}

module.exports = { APERTURA, CIERRE, MAX_OPERACIONES, MAX_TEXTO, MAX_IMAGEN, MAX_BASES, ENCABEZADO_CHARLA, PEDIDOS, instruccionDeCierre, extraerBloque, parsearImagen };
