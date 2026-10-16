/**
 * BE-133 — Pulido de la vista Orquestación (prueba en vivo de FEAT-162 F3) y FEAT-163 — botones de dos pasos con
 * texto corto y borde que pulsa. Lo visual se mira en vivo; acá, el código (leído como texto) y el registro.
 */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-be-133-'));
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(dir, 'state.json');
const WEB = path.join(__dirname, '..', 'telegram-bridge', 'web');
const leer = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  const comp = leer('public/ui/comp-base.js');
  const css = leer('public/app.css');
  const isla = leer('grafo/src/orquestacion.tsx');
  const islaCss = leer('grafo/src/estilos.css');
  const conv = leer('public/ui/orquestacion-conversacion.js');
  const vista = leer('public/ui/vista-orquestacion.js');
  const bundle = leer('public/vendor/grafo.module.js');

  try {
    await group('FEAT-163 — BotonDosPasos', () => {
      check('armado muestra un texto corto (confirmar, «¿Seguro?»)', comp.includes("confirmar = '¿Seguro?'") && comp.includes('${listo ? (frase ? confirmar : armado) : texto}'));
      check('la frase de armado va a title y aria-label', comp.includes("{ title: frase, 'aria-label': frase"));
      check('mantiene su ancho mientras está armado', comp.includes('setAncho(e.currentTarget.offsetWidth || null)') && comp.includes('minWidth: `${ancho}px`'));
      check('un armado que no es texto (la barra) se muestra tal cual', comp.includes("const frase = typeof armado === 'string' ? armado : null;"));
      check('el armado pulsa en su borde y respeta reduced-motion', /\.boton\.armado \{[^}]*animation: armado-pulso/.test(css) && /prefers-reduced-motion: reduce\) \{ \.boton\.armado \{ animation: none/.test(css));
    });

    await group('FEAT-163 — DosPasos de la isla', () => {
      check('«¿Seguro?» con la frase en title y aria-label', isla.includes("{listo ? '¿Seguro?' : texto}") && isla.includes('title={listo ? armado : undefined}') && isla.includes('aria-label={listo ? armado : undefined}'));
      check('ancho estable', isla.includes('minWidth: `${ancho}px`'));
      check('borde que pulsa, sin animación con reduced-motion', /\.go-boton\.armado \{[^}]*animation: go-armado/.test(islaCss) && islaCss.includes('.go-aprob, .go-boton.armado { animation: none; }'));
      check('el bundle lo trae', bundle.includes('¿Seguro?'));
    });

    await group('BE-133 — Conversación', () => {
      check('«Responder» se esconde en la pregunta elegida', conv.includes('n.pregunta && abierta && !elegida') && conv.includes('elegida=${respuestaA?.id === n.id}'));
      check('la elegida se marca', css.includes('.orq-globo-elegida {'));
      check('la cita ya no usa --tenue (no llega a 4.5:1 sobre --mia)', /\.orq-globo-cita \{[^}]*color: var\(--texto-2\)/.test(css) && !/\.orq-globo-cita \{[^}]*--tenue/.test(css));
      check('el campo usa el estilo de los campos de la consola', css.includes('.nota-nueva textarea, .orq-escribir textarea, .edicion textarea'));
      check('lo que anota la consola se ve centrado (de: consola)', conv.includes("if (n.de === 'consola')") && css.includes('.orq-globo-sistema {'));
    });

    await group('BE-133 — Vista', () => {
      check('las terminadas van al lateral, plegadas', vista.includes('<details class="orq-terminadas">') && vista.includes('<${Lateral} terminadas=${terminadas} />'));
      check('la que se acaba de terminar mirándola queda a la vista (BE-132)', vista.includes("const enFoco = (o) => o.estado !== 'terminada' || o.id === conGrafo;"));
      check('dos columnas solo en pantalla ancha', /@media \(min-width: 1400px\) \{\s*\.orq-layout \{ display: grid;/.test(css));
      check('separador entre la ruta y el resultado', vista.includes('<span class="orq-sep" aria-hidden="true">·</span>') && css.includes('.orq-sep {'));
      check('vista-orquestacion.js: 210 líneas o menos', vista.split('\n').length <= 210, String(vista.split('\n').length));
    });

    await group('BE-133 — Frenar', async () => {
      const orq = await import('../telegram-bridge/orquestaciones.js');
      const { crearNucleoWeb } = await import('../telegram-bridge/web/nucleo.js');
      const { crearCanalWeb } = await import('../telegram-bridge/web/canal.js');
      const tareas = await import('../telegram-bridge/tareas.js');
      const entregas = [];
      const nucleo = crearNucleoWeb({
        canal: crearCanalWeb(), bot: {}, almas: {}, tareas, orquestaciones: orq,
        entregarNota: (sesion, datos) => { entregas.push({ sesion, ...datos }); return { ok: true }; },
        workspaces: () => [], ultimoWorkspace: () => null,
        logs: () => ({ ok: true, lineas: [] }), sesiones: () => ({ ok: true }), estadoDaemon: () => ({}), estadoAgente: () => ({}), nombreAgenteValido: () => true
      });
      const a = orq.abrir({ quien: 'Spica', titulo: 'Con buzón', modo: 'pedir', sesion: 'ses-1' });
      const r = await nucleo.frenarOrquestacion(a.orquestacion.id);
      check('frenar responde sin el buzón ni datos internos', r.ok && !('sesion' in r) && !('nota' in r) && r.orquestacion.estado === 'frenada');
      const o = orq.obtener(a.orquestacion.id);
      check('deja la entrada de la consola en la conversación', o.conversacion.at(-1).de === 'consola' && /frenó/.test(o.conversacion.at(-1).texto));
      check('y le avisa a la sesión por su buzón, pidiéndole un último mensaje', entregas.length === 1 && entregas[0].sesion === 'ses-1' && /último mensaje con consola responder/.test(entregas[0].texto));
      check('notasSinVer no la cuenta como nota del usuario', orq.notasSinVer(o).length === 0);
      check('la sesión puede contestarle (conversación abierta en frenada)', orq.anotarConversacion(o.id, { de: 'sesion', texto: 'Quedé en el paso 2.', respuestaA: o.conversacion.at(-1).id }, 'Spica').ok);
      const b = orq.abrir({ quien: 'Epikouros', titulo: 'Sin buzón', modo: 'pedir' });
      await nucleo.frenarOrquestacion(b.orquestacion.id);
      check('sin buzón, no entrega nada', entregas.length === 1);
      tareas.reiniciarParaTests();
      orq.reiniciarParaTests();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  report();
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
