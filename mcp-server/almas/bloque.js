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

/**
 * La consigna que se agrega al prompt. Corta y al final, para no correrle el
 * foco al mensaje. El `encabezado` lo cambia la consolidación de la charla de
 * voz (FEAT-044), que pide el bloque solo y no una respuesta con bloque; la
 * plantilla y los topes son los mismos para las dos superficies.
 */
function instruccionDeCierre({ encabezado = ENCABEZADO_CHARLA, conTema = false, pedidos = [] } = {}) {
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
    ...sobrePedidos
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
function extraerBloque(textoCrudo, { conTema = false } = {}) {
  const texto = String(textoCrudo || '');
  const inicio = texto.lastIndexOf(APERTURA);
  if (inicio === -1) {
    // FEAT-172 — Medido en vivo (agy, 2026-10-20): el alma a veces escribe el
    // pedido suelto, sin el bloque. Si la respuesta entera es una sola línea de
    // pedido, es un pedido; con cualquier otra cosa alrededor, es texto.
    const lineas = texto.split(/\r?\n/).map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
    const suelto = lineas.length === 1 ? parsearPedido(lineas[0]) : null;
    if (suelto) return { respuesta: '', operaciones: [], pedido: suelto };
    return { respuesta: texto.trim(), operaciones: [], pedido: null };
  }

  const finCierre = texto.indexOf(CIERRE, inicio);
  const cuerpo = finCierre === -1
    ? texto.slice(inicio + APERTURA.length)
    : texto.slice(inicio + APERTURA.length, finCierre);
  const antes = texto.slice(0, inicio);
  const despues = finCierre === -1 ? '' : texto.slice(finCierre + CIERRE.length);
  const respuesta = `${antes}\n${despues}`.replace(/\n{3,}/g, '\n\n').trim();

  const operaciones = [];
  // FEAT-172 — Un solo pedido por turno: el primero. Qué tipos valen lo decide quien llama.
  let pedido = null;
  for (const lineaCruda of cuerpo.split(/\r?\n/)) {
    const linea = lineaCruda.replace(/^\s*[-*•]\s*/, '').trim();
    if (!linea) continue;
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

  return { respuesta, operaciones, pedido };
}

module.exports = { APERTURA, CIERRE, MAX_OPERACIONES, MAX_TEXTO, ENCABEZADO_CHARLA, PEDIDOS, instruccionDeCierre, extraerBloque };
