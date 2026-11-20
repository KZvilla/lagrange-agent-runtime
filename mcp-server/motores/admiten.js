'use strict';

/**
 * FEAT-203 S0 — Qué motor, qué modelo y qué esfuerzo admite cada rol, para que la terminal ofrezca solo lo que el
 * núcleo acepta al guardar.
 *
 * No es una regla paralela: cada candidato pasa por `validarRoles` estricto, el mismo validador que escribe
 * (`config-motores.aplicarRol`). Así entran juntos el perfil y las capacidades del rol (`faltaParaRol`), los modelos
 * bloqueados (`modeloBloqueado`), el modelo obligatorio y los esfuerzos que admite cada modelo. Si el núcleo cambia
 * una regla, esta lista cambia sola.
 *
 * agy no entra nunca: sin regla, el rol ya corre en agy, y volver a agy es quitar la regla.
 */

const { CAPACIDADES } = require('./capacidades.js');
const { MODELOS, nivelesPara } = require('./niveles.js');
const { validarRoles } = require('./roles.js');

const pasa = (rol, entrada, cuentas) => validarRoles({ [rol]: entrada }, { estricto: true, cuentas }).ok;

/**
 * `[{ motor, modelos: [{ id, esfuerzos: [<nivel>…] }…] }…]`. Un modelo entra si pasa sin esfuerzo; `esfuerzos` son
 * los niveles que también pasan (vacío: el modelo no admite esfuerzo, o no está medido). Un motor sin ningún modelo
 * válido no aparece.
 */
function admitenDe(rol, { cuentas = null } = {}) {
  const salida = [];
  for (const motor of Object.keys(CAPACIDADES)) {
    if (motor === 'antigravity') continue;
    const modelos = [];
    for (const id of MODELOS[motor] || []) {
      if (typeof id !== 'string' || !pasa(rol, { motor, modelo: id, esfuerzo: null }, cuentas)) continue;
      const n = nivelesPara(motor, id);
      const esfuerzos = n && n.admite ? n.niveles.filter((nivel) => pasa(rol, { motor, modelo: id, esfuerzo: nivel }, cuentas)) : [];
      modelos.push({ id, esfuerzos });
    }
    if (modelos.length) salida.push({ motor, modelos });
  }
  return salida;
}

module.exports = { admitenDe };
