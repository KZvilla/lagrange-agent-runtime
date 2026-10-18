/**
 * BE-152 — En un nodo, la herramienta `consola` dice que ahí no hay consola (se orquesta desde el servidor), en vez de
 * mandar a reiniciar un daemon que nunca la va a levantar; y el daemon en rol nodo borra la credencial del orquestador
 * que haya quedado de cuando era `solo`.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');
const { temporalQueSeBorra } = require('./lib/temporales');
const consolaApi = require('../mcp-server/lib/consola-api.js');

const conCredencial = temporalQueSeBorra('lagrange-be-152-');
fs.writeFileSync(path.join(conCredencial, consolaApi.ARCHIVO), JSON.stringify({ url: 'http://127.0.0.1:1/', token: 'x'.repeat(48), pid: process.pid }));
const vacio = temporalQueSeBorra('lagrange-be-152-');

function mensaje(opciones) {
  try { consolaApi.leerAcceso(opciones); return null; } catch (err) { return err instanceof consolaApi.ErrorConsola ? err.message : `otro error: ${err.message}`; }
}

group('BE-152 — leerAcceso en un nodo', () => {
  const nodo = mensaje({ dataDir: conCredencial, enlace: () => ({ rol: 'nodo' }) });
  check('en un nodo, el diagnóstico dice que es un nodo aunque haya credencial válida', /nodo/.test(nodo || '') && /servidor/.test(nodo || ''));
  check('y no manda a reiniciar el daemon', !/reinici/i.test(nodo || ''));

  const enlaceReal = temporalQueSeBorra('lagrange-be-152-');
  fs.writeFileSync(path.join(enlaceReal, 'enlace.json'), JSON.stringify({ rol: 'nodo', url: 'http://127.0.0.1:1', token: 't', pid: process.pid }));
  check('con el enlaceDeNodo real: lee enlace.json del mismo dataDir', /nodo de una red/.test(mensaje({ dataDir: enlaceReal }) || ''));
  check('con el enlace.json de un daemon muerto no se toma como nodo', !/nodo de una red/.test(mensaje({ dataDir: enlaceReal, vivo: () => false }) || ''));

  check('fuera de un nodo y sin credencial: el mensaje de siempre', /no hay credencial de orquestador/.test(mensaje({ dataDir: vacio, enlace: () => null }) || ''));
  const acceso = consolaApi.leerAcceso({ dataDir: conCredencial, enlace: () => null });
  check('fuera de un nodo y con credencial: { url, token }', acceso.url === 'http://127.0.0.1:1' && acceso.token === 'x'.repeat(48));
});

group('BE-152 — el daemon en rol nodo borra la credencial vieja', () => {
  const bot = fs.readFileSync(path.join(__dirname, '..', 'telegram-bridge', 'bot.js'), 'utf8').replace(/\r\n/g, '\n');
  const i = bot.indexOf('  if (esNodo) {\n    // Un `web-token.json` en un nodo');
  const bloque = i === -1 ? '' : bot.slice(i, bot.indexOf('  } else {', i));
  check('el bloque de arranque del nodo existe', Boolean(bloque));
  check('borra web-token.json y orquestador-token.json', bloque.includes("'web-token.json'") && bloque.includes("'orquestador-token.json'"));
});

report();
