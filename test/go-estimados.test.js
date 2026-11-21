/**
 * Lo que rinde cada modelo de OpenCode Go (`go-estimados.js`) y cómo llega a la terminal:
 *
 *   - cada modelo de la tabla trae `pedidos5h` y `gratis`; los demás del catálogo van en `otrosModelos`, en orden;
 *   - sin el catálogo vivo, la lista sale de las estimaciones; un id sin estimación sale igual, sin número;
 *   - la proyección v2 deja pasar solo esos campos, y nunca una fuente que no sea de opencode.ai.
 */
const path = require('node:path');

const { check, group, report } = require('./lib/assert');
const MCP = path.join(__dirname, '..', 'mcp-server');
const M = (f) => require(path.join(MCP, 'motores', f));
const est = M('go-estimados.js');
const niveles = M('niveles.js');
const motores = M('index.js');
const proy = M('proyeccion.js');

async function main() {
  await group('la tabla de estimaciones', async () => {
    check('los modelos de MODELOS_GO tienen estimación', Object.keys(niveles.MODELOS_GO).every((id) => est.estimadoDe(id).nombre));
    check('DeepSeek V4.1 Flash: 43 300 cada 5 h', est.estimadoDe('deepseek-v4.1-flash').pedidos5h === 43300);
    check('hy4-flash-free: gratis, sin número', est.estimadoDe('hy4-flash-free').gratis && est.estimadoDe('hy4-flash-free').pedidos5h === null);
    check('un id desconocido: sin nombre ni número', JSON.stringify(est.estimadoDe('nuevo-1')) === JSON.stringify({ id: 'nuevo-1', nombre: null, pedidos5h: null, gratis: false }));
    check('la fecha tiene forma de día', /^\d{4}-\d{2}-\d{2}$/.test(est.FECHA));
  });

  await group('otrosModelos', async () => {
    const enTabla = Object.keys(niveles.MODELOS_GO);
    const otros = est.otrosModelos(['kimi-k3', 'glm-5.3', 'beam-free', 'mimo-v2.6-flash', 'nuevo-1', 'kimi-k3'], enTabla);
    check('saca los de la tabla y repite una sola vez', otros.map((m) => m.id).join() === 'beam-free,mimo-v2.6-flash,kimi-k3,nuevo-1', otros.map((m) => m.id).join());
    const sinCatalogo = est.otrosModelos(null, enTabla);
    check('sin catálogo: los de las estimaciones, sin los de la tabla',
      sinCatalogo.length === Object.keys(est.ESTIMADOS).length - enTabla.length && !sinCatalogo.some((m) => enTabla.includes(m.id)));
  });

  await group('estadoDeMotores', async () => {
    const estados = await motores.estadoDeMotores({
      config: null, modoManual: true,
      dependencias: { leerKey: async () => ({ key: null }), catalogoGo: () => ({ ok: true, ids: ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3', 'deepseek-v4-pro'] }) }
    });
    const go = estados.find((e) => e.id === 'opencode-go');
    check('los de la tabla traen pedidos5h', go.modelos.find((m) => m.modelo === 'glm-5.3').pedidos5h === 6600);
    check('otrosModelos del catálogo, de más a menos', go.otrosModelos.map((m) => m.id).join() === 'deepseek-v4-pro,kimi-k3', JSON.stringify(go.otrosModelos));
    check('estimados con fecha y fuente', go.estimados.fecha === est.FECHA && go.estimados.fuente === est.FUENTE);
    check('los otros motores no los traen', estados.filter((e) => e.id !== 'opencode-go').every((e) => e.otrosModelos === undefined));
    const v2 = proy.motorV2(go);
    check('v2: modelos con pedidos5h y gratis', v2.modelos.every((m) => 'pedidos5h' in m && typeof m.gratis === 'boolean'));
    check('v2: otrosModelos con cuatro campos', v2.otrosModelos.every((m) => Object.keys(m).join() === 'id,nombre,pedidos5h,gratis'));
    check('v2: otro motor sale con lista vacía y sin estimados', (() => { const a = proy.motorV2(estados.find((e) => e.id === 'deepseek')); return a.otrosModelos.length === 0 && a.estimados === null; })());
  });

  await group('la proyección filtra', async () => {
    const v2 = proy.motorV2({
      id: 'opencode-go', disponible: true,
      otrosModelos: [{ id: 'x', nombre: 'X', pedidos5h: '12', gratis: 1, ruta: 'C:\\secreto' }, { nombre: 'sin id' }],
      estimados: { fecha: 'ayer', fuente: 'https://otro.example/go' }
    });
    check('un número como texto no pasa', v2.otrosModelos[0].pedidos5h === null && v2.otrosModelos[0].gratis === true);
    check('sin id, afuera', v2.otrosModelos.length === 1);
    check('campos de más, afuera', !JSON.stringify(v2).includes('secreto'));
    check('fecha y fuente inválidas, null', v2.estimados.fecha === null && v2.estimados.fuente === null);
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
