/**
 * BE-157 — piezas puras del publicador de la wiki.
 *
 * El CLI vive en `scripts/wiki-publicar.mjs`; esto se separa para poder probar
 * el marcador, la detección de ediciones externas y el plan de cambios sin
 * clonar nada ni tocar la red.
 */

export const PREFIJO = 'Publish wiki from ';
export const FUENTE = 'Source:';

/** Convierte el remoto del repo en el remoto de su wiki. */
export function urlWiki(remoto) {
  const r = String(remoto || '').trim();
  if (!r) throw new Error('falta el remoto de git');
  if (!/github\.com[:/]/i.test(r)) {
    throw new Error(`el remoto no es de GitHub: ${r}`);
  }
  if (/\.wiki\.git$/i.test(r)) return r;
  if (/\.git$/i.test(r)) return r.replace(/\.git$/i, '.wiki.git');
  return `${r.replace(/\/$/, '')}.wiki.git`;
}

/** Compara nombres y contenidos. Los mapas van de nombre a texto (o null). */
export function planificar(locales, remotos) {
  const agregar = [];
  const actualizar = [];
  const borrar = [];
  const iguales = [];

  for (const [nombre, contenido] of locales) {
    if (!remotos.has(nombre)) agregar.push(nombre);
    else if (remotos.get(nombre) === contenido) iguales.push(nombre);
    else actualizar.push(nombre);
  }
  for (const nombre of remotos.keys()) {
    if (!locales.has(nombre)) borrar.push(nombre);
  }
  return {
    agregar: agregar.sort(),
    actualizar: actualizar.sort(),
    borrar: borrar.sort(),
    iguales: iguales.sort()
  };
}

/** El commit más reciente del script, o null si la wiki nunca se publicó así. */
export function leerMarcador(commits) {
  for (const commit of commits) {
    if (!String(commit.subject || '').startsWith(PREFIJO)) continue;
    if (!new RegExp(`^${FUENTE}\\s*[0-9a-f]{7,40}$`, 'm').test(commit.body || '')) continue;
    return { sha: commit.sha, source: (commit.body.match(new RegExp(`^${FUENTE}\\s*([0-9a-f]{7,40})$`, 'm')) || [])[1] };
  }
  return null;
}

/** Commits posteriores al marcador que no escribió este script. */
export function edicionesExternas(commits, marcadorSha) {
  const i = commits.findIndex((c) => c.sha === marcadorSha);
  if (i < 0) return [];
  return commits.slice(0, i).filter(
    (c) => !String(c.subject || '').startsWith(PREFIJO) || !new RegExp(`^${FUENTE}\\s*[0-9a-f]{7,40}$`, 'm').test(c.body || '')
  );
}

export function mensajeDeCommit(sha) {
  return `${PREFIJO}${sha}\n\n${FUENTE} ${sha}`;
}
