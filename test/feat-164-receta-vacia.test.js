/**
 * FEAT-164 — «+ Recipe vacía»: el esqueleto que manda la consola (Entrada → Juez → Revisión) pasa el mismo
 * `validarGrafo` del servidor, el botón está al pie de Recipes y el diálogo crea con POST /api/recetas y abre el editor.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');
const grafoReceta = require('../mcp-server/lotes/grafo-receta');

const UI = path.join(__dirname, '..', 'telegram-bridge', 'web', 'public', 'ui');
const leer = (rel) => fs.readFileSync(path.join(UI, rel), 'utf8').replace(/\r\n/g, '\n');
const acciones = leer('tuberias-receta-acciones.js');
const lateral = leer('tuberias-lateral.js');

/** `GRAFO_VACIO` tal como está en la fuente (un literal sin dependencias). */
function grafoVacio() {
  const m = acciones.match(/export const GRAFO_VACIO = Object\.freeze\((\{[\s\S]*?\n\})\);/);
  return m ? new Function(`return (${m[1]});`)() : null;
}

group('FEAT-164 — el esqueleto', () => {
  const g = grafoVacio();
  check('GRAFO_VACIO está en la fuente', Boolean(g));
  const { errores } = grafoReceta.revisarGrafo(g || {});
  const graves = errores.filter((e) => e.severidad === 'error');
  check(`pasa revisarGrafo sin errores${graves.length ? ` (${graves.map((e) => e.codigo).join(', ')})` : ''}`, Boolean(g) && !graves.length);
  let ok = false;
  try { grafoReceta.validarGrafo(g); ok = true; } catch { ok = false; }
  check('validarGrafo lo acepta (lo que guarda el servidor)', ok);
  check('Entrada → Juez → Revisión', g && Object.values(g.nodos).map((n) => n.tipo).join(',') === 'entrada,juez,revision');
});

group('FEAT-164 — botón y diálogo', () => {
  check('«+ Recipe vacía» al pie de Recipes, abre el diálogo', lateral.includes('<div class="tub-recetas-pie">')
    && lateral.includes("onClick=${() => setDialogo({ tipo: 'vacia', r: null })}>+ Recipe vacía</button>"));
  check('crea con POST /api/recetas y abre el editor', acciones.includes("await api('/api/recetas', { id: idDeTitulo(titulo, usados), titulo: titulo.trim(), grafo: GRAFO_VACIO });")
    && /crearVacia = \(\) => correr\(async \(\) => \{[\s\S]*?recetaEditada\.value = \{ id: res\.receta\.id, madreId: null \};\n\s*borradorElegido\.value = null;/.test(acciones));
  check('el diálogo no lee r.titulo si es una vacía', acciones.includes("useState(vacia ? '' :") && acciones.includes("etiqueta=${vacia ? 'Recipe vacía' :")
    && acciones.includes("const encabezado = vacia ? 'Recipe vacía' :"));
  check('nombre, nota y «Crear y editar»; Enter acepta', acciones.includes("placeholder=${vacia ? 'Mi recipe' : null}") && acciones.includes('Nace con Entrada → Juez → Revisión; agregá los pasos en el editor.')
    && acciones.includes("${vacia ? 'Crear y editar' :") && acciones.includes("if (e.key === 'Enter' && valido) aceptar();"));
  check('tuberias-* ≤ 210 líneas', [acciones, lateral].every((s) => s.split('\n').length <= 210));
});

report();
