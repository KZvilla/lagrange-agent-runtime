/**
 * FEAT-052 — Lectura del archivo de acceso de la consola web
 * (`web-token.json`, que escribe `arrancarWeb` en bot.js).
 *
 * Lo usan `npm run bridge:web` (que imprime el link) y el diagnóstico del
 * bridge (que solo dice si la consola está activa, nunca el token). Solo lee:
 * importarlo no crea directorios.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeDataDirPath } from '../paths.js';

export const ARCHIVO_ACCESO_WEB = 'web-token.json';

const dirBridge = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * `null` si no hay archivo. Si lo hay, `vivo` dice si el daemon que lo
 * escribió sigue corriendo: un archivo de un proceso muerto no sirve.
 * `resolveDataFile` cae a la carpeta del bridge cuando no puede usar el
 * directorio de datos, así que se mira también ahí.
 */
export function leerAccesoWeb({ dataDir = bridgeDataDirPath(), estaVivo = pidVivo } = {}) {
  for (const dir of [dataDir, dirBridge]) {
    let datos;
    try {
      datos = JSON.parse(fs.readFileSync(path.join(dir, ARCHIVO_ACCESO_WEB), 'utf8'));
    } catch {
      continue;
    }
    if (!datos || typeof datos.url !== 'string') continue;
    return {
      url: datos.url,
      login: typeof datos.login === 'string' ? datos.login : null,
      pid: datos.pid ?? null,
      creado: datos.creado || null,
      vivo: Boolean(estaVivo(datos.pid))
    };
  }
  return null;
}
