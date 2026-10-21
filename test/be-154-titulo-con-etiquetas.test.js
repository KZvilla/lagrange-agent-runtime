/**
 * BE-154 — Un alma tomó el marcador `<título corto>` de la plantilla por una etiqueta y la cerró: la tarjeta se creó
 * con título «<título corto>Contrato de la primera herramienta agéntica</título>». El parser se queda con el
 * contenido, y la plantilla usa corchetes, que no parecen etiquetas.
 */
const { check, group, report } = require('./lib/assert');
const tablero = require('../mcp-server/almas/bloque-tablero.js');
const orquestador = require('../mcp-server/agents/orquestador.js');

const propuestas = (cuerpo) => tablero.extraerBloque(`Hola.\n<tablero>\n<propuesta para="yo">\n${cuerpo}\n</propuesta>\n</tablero>`).operaciones;

group('BE-154 — el marcador cerrado como etiqueta', () => {
  const [alya] = propuestas('<título corto>Contrato de la primera herramienta agéntica</título>\n<qué hay que hacer>Definir el contrato.\nCon ejemplos.</qué>');
  check('el título de Alya sale sin las etiquetas', alya && alya.titulo === 'Contrato de la primera herramienta agéntica', JSON.stringify(alya));
  check('el pedido envuelto también, con sus saltos', alya && alya.pedido === 'Definir el contrato.\nCon ejemplos.', JSON.stringify(alya));

  const [soloApertura] = propuestas('<título corto> Revisar la cola\nMirá la cola.');
  check('en el título basta una punta', soloApertura && soloApertura.titulo === 'Revisar la cola', JSON.stringify(soloApertura));

  const [pedidoLibre] = propuestas('Revisar la CSP\n<b>ojo</b> con el inline\nque no se rompa');
  check('un pedido con etiquetas sueltas queda intacto', pedidoLibre && pedidoLibre.pedido === '<b>ojo</b> con el inline\nque no se rompa', JSON.stringify(pedidoLibre));

  check('un título que es solo el marcador viejo se descarta', propuestas('<título corto>\n<qué hay que hacer>').length === 0);
  check('y uno que es solo el marcador nuevo, también', propuestas('[título corto]\n[qué hay que hacer, en las líneas que haga falta]').length === 0);
});

group('BE-154 — la plantilla no usa ángulos para los marcadores', () => {
  const consigna = tablero.instruccionDeCierre();
  check('las almas ven [título corto]', consigna.includes('[título corto]') && !consigna.includes('<título corto>'));
  check('la plantilla devuelta tal cual sigue sin producir nada', tablero.extraerBloque(`Hola.\n${consigna}`).operaciones.length === 0);
  const fuente = require('fs').readFileSync(require.resolve('../mcp-server/agents/orquestador.js'), 'utf8');
  check('la orquestación también', fuente.includes("'[título corto]'") && !fuente.includes('<título corto>'));
  check('el módulo de la orquestación carga', typeof orquestador === 'object');
});

report();
