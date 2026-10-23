'use strict';

const os = require('node:os');
const path = require('node:path');

const NOMBRE_VIEJO = 'claude-plugin-antigravity';

const PERMITIDOS = [
  'C:/work/my-project',
  'C:\\work\\my-project',
  '/home/you/',
  '/Users/you/',
  'C:/Users/you',
  'C:\\Users\\you',
  'my-pc.tail1234.ts.net',
  '~/.claude/',
  '$HOME',
  '%USERPROFILE%',
  '<plugin>',
  '<ruta>'
];

function escaparRegex(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quitarPermitidos(linea, permitidos) {
  let limpia = linea;
  for (const permitido of permitidos) limpia = limpia.split(permitido).join('');
  return limpia;
}

function escanearPrivacidad(texto, opciones = {}) {
  const permitidos = opciones.permitidos || PERMITIDOS;
  const usuario = opciones.usuario || os.userInfo().username;
  const home = opciones.home || os.homedir();
  const repo = opciones.repo || path.resolve(__dirname, '..', '..');
  const violaciones = [];

  const lineas = String(texto).replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lineas.length; i += 1) {
    const original = lineas[i];
    const limpia = quitarPermitidos(original, permitidos);
    const motivos = [];

    // Ojo con el lookbehind: sin él, `https://` parece una ruta `s:/`.
    if (/(?<![\w+.-])[A-Za-z]:[\\/]/.test(limpia)) motivos.push('ruta de máquina');
    if (/(?<![\w.-])\/home\/[A-Za-z0-9._-]+\//.test(limpia)) motivos.push('home POSIX');
    if (/(?<![\w.-])\/Users\/[A-Za-z0-9._-]+\//.test(limpia)) motivos.push('home macOS');
    if (/\\\\wsl/.test(limpia)) motivos.push('ruta WSL');
    if (/file:\/\/\//.test(limpia)) motivos.push('file:///');
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(limpia)) motivos.push('correo');
    if (/[A-Za-z0-9.-]+\.ts\.net/.test(limpia)) motivos.push('nombre de Tailscale');
    if (/(^|[\s`(])docs\//.test(limpia)) motivos.push('enlace a docs/');

    if (usuario && new RegExp(`\\b${escaparRegex(usuario)}\\b`, 'i').test(original)) {
      motivos.push('usuario real');
    }
    if (home && original.toLowerCase().includes(String(home).toLowerCase())) {
      motivos.push('home real');
    }
    if (repo && original.toLowerCase().includes(String(repo).toLowerCase())) {
      motivos.push('path del repo');
    }

    if (motivos.length) {
      violaciones.push({ linea: i + 1, motivos, texto: original.trim() });
    }
  }
  return violaciones;
}

function escanearNombreViejo(texto) {
  const salida = [];
  const lineas = String(texto).replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lineas.length; i += 1) {
    if (lineas[i].includes(NOMBRE_VIEJO)) salida.push(i + 1);
  }
  return salida;
}

module.exports = { PERMITIDOS, escanearPrivacidad, escanearNombreViejo };
