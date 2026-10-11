/**
 * FEAT-156 — Recetas incorporadas genéricas (además de la Clásica). Son plantillas: no se borran ni se versionan; se
 * usan tal cual o se duplican para cambiarlas. Las estructuras salen de patrones documentados de pipelines de código
 * con agentes (evaluator-optimizer, TDD, escalada de modelo, revisor independiente, best-of-N, human-in-the-loop),
 * llevados a los nodos de `grafo-v1`. Ninguna fija modelos (un modelo fijo puede chocar con el auditor del lote).
 */
const a = (id, desde, puerto, hacia, extra = {}) => ({ id, desde, puerto, hacia, ...extra });

/** Las salidas de un Escribir que no sean `ok`: sin cambios al Juez (juzga el commit anterior), error a Vos. */
const escribirResto = (e, juez, vos) => [a(`${e}-sin`, e, 'sin-cambios', juez), a(`${e}-err`, e, 'error', vos)];
const juezAVos = (j, vos) => [a(`${j}-pass`, j, 'pass', vos), a(`${j}-err`, j, 'error', vos)];

const PLANTILLAS = Object.freeze([
  {
    id: 'ciclo-rapido', titulo: 'Ciclo rápido',
    descripcion: 'Escribe, prueba y corrige hasta 2 veces; el Juez puede devolverlo una vez. Para bugfix y cambios chicos con tests.',
    grafo: {
      nodos: { entrada: { tipo: 'entrada' }, esc: { tipo: 'escribir', vueltas: 2 }, ver: { tipo: 'verificar' }, juez: { tipo: 'juez' }, vos: { tipo: 'revision' } },
      aristas: [
        a('in', 'entrada', 'sale', 'esc'), a('esc-ok', 'esc', 'ok', 'ver'), ...escribirResto('esc', 'juez', 'vos'),
        a('ver-pasa', 'ver', 'pasa', 'juez'), a('ver-falla', 'ver', 'falla', 'esc', { alAgotar: 'juez' }), a('ver-err', 'ver', 'error', 'vos'),
        ...juezAVos('juez', 'vos'), a('juez-fail', 'juez', 'fail', 'esc', { tope: 1, alAgotar: 'vos' })
      ]
    }
  },
  {
    id: 'tdd-base', titulo: 'TDD',
    descripcion: 'Primero los tests (tienen que fallar), después la implementación hasta que pasen. Para funcionalidad nueva o un bug sin test.',
    grafo: {
      nodos: {
        entrada: { tipo: 'entrada' },
        tests: { tipo: 'escribir', titulo: 'Escribir tests', vueltas: 1, plantilla: '{tarea.prompt}\n\nEn este paso escribí SOLO los tests que prueban lo pedido (en {archivos}). No implementes nada: los tests tienen que fallar.' },
        rojo: { tipo: 'verificar', titulo: 'Verificar · rojo' },
        impl: { tipo: 'escribir', titulo: 'Implementar', vueltas: 3, plantilla: '{tarea.prompt}\n\nLos tests ya están escritos: implementá lo necesario para que pasen. No cambies los tests.' },
        verde: { tipo: 'verificar', titulo: 'Verificar · verde' },
        juez: { tipo: 'juez' },
        humano: { tipo: 'humano', titulo: 'Los tests ya pasan' },
        vos: { tipo: 'revision' }
      },
      aristas: [
        a('in', 'entrada', 'sale', 'tests'), a('tests-ok', 'tests', 'ok', 'rojo'), a('tests-sin', 'tests', 'sin-cambios', 'vos'), a('tests-err', 'tests', 'error', 'vos'),
        a('rojo-falla', 'rojo', 'falla', 'impl'), a('rojo-pasa', 'rojo', 'pasa', 'humano'), a('rojo-err', 'rojo', 'error', 'vos'),
        a('hum-corr', 'humano', 'corregir', 'tests', { alAgotar: 'vos' }), a('hum-apr', 'humano', 'aprobar', 'juez'), a('hum-can', 'humano', 'cancelar', 'vos'),
        a('impl-ok', 'impl', 'ok', 'verde'), ...escribirResto('impl', 'juez', 'vos'),
        a('verde-pasa', 'verde', 'pasa', 'juez'), a('verde-falla', 'verde', 'falla', 'impl', { alAgotar: 'juez' }), a('verde-err', 'verde', 'error', 'vos'),
        ...juezAVos('juez', 'vos'), a('juez-fail', 'juez', 'fail', 'impl', { tope: 1, alAgotar: 'vos' })
      ]
    }
  },
  {
    id: 'plan-b', titulo: 'Plan B con modelo grande',
    descripcion: 'El primer escritor prueba dos veces; si no pasa la prueba, un plan B retoma con todo lo hecho. Duplicala y elegí un modelo grande para el plan B.',
    grafo: {
      nodos: {
        entrada: { tipo: 'entrada' }, esc: { tipo: 'escribir', vueltas: 1 }, ver: { tipo: 'verificar' },
        escb: { tipo: 'escribir', titulo: 'Escribir · plan B' }, verb: { tipo: 'verificar', titulo: 'Verificar · B' },
        juez: { tipo: 'juez' }, vos: { tipo: 'revision' }
      },
      aristas: [
        a('in', 'entrada', 'sale', 'esc'), a('esc-ok', 'esc', 'ok', 'ver'), ...escribirResto('esc', 'juez', 'vos'),
        a('ver-pasa', 'ver', 'pasa', 'juez'), a('ver-falla', 'ver', 'falla', 'esc', { alAgotar: 'escb' }), a('ver-err', 'ver', 'error', 'vos'),
        a('escb-ok', 'escb', 'ok', 'verb'), ...escribirResto('escb', 'juez', 'vos'),
        a('verb-pasa', 'verb', 'pasa', 'juez'), a('verb-falla', 'verb', 'falla', 'juez'), a('verb-err', 'verb', 'error', 'vos'),
        ...juezAVos('juez', 'vos'), a('juez-fail', 'juez', 'fail', 'vos')
      ]
    }
  },
  {
    id: 'revision-advisor', titulo: 'Revisión con Advisor',
    descripcion: 'Un revisor lee el cambio y lo devuelve con indicaciones o te pregunta; el Juez decide al final. Para código sensible.',
    grafo: {
      nodos: {
        entrada: { tipo: 'entrada' }, esc: { tipo: 'escribir', vueltas: 3 }, ver: { tipo: 'verificar' }, adv: { tipo: 'advisor' },
        humano: { tipo: 'humano' }, juez: { tipo: 'juez' }, vos: { tipo: 'revision' }
      },
      aristas: [
        a('in', 'entrada', 'sale', 'esc'), a('esc-ok', 'esc', 'ok', 'ver'), ...escribirResto('esc', 'juez', 'vos'),
        a('ver-pasa', 'ver', 'pasa', 'adv'), a('ver-falla', 'ver', 'falla', 'esc', { tope: 1, alAgotar: 'juez' }), a('ver-err', 'ver', 'error', 'vos'),
        a('adv-ok', 'adv', 'aprobado', 'juez'), a('adv-corr', 'adv', 'corregir', 'esc', { tope: 1, alAgotar: 'juez' }), a('adv-hum', 'adv', 'humano', 'humano'), a('adv-err', 'adv', 'error', 'vos'),
        a('hum-corr', 'humano', 'corregir', 'esc', { alAgotar: 'vos' }), a('hum-apr', 'humano', 'aprobar', 'juez'), a('hum-can', 'humano', 'cancelar', 'vos'),
        ...juezAVos('juez', 'vos'), a('juez-fail', 'juez', 'fail', 'vos')
      ]
    }
  },
  {
    id: 'mejor-de-dos', titulo: 'Mejor de dos',
    descripcion: 'Dos intentos en paralelo; gana el primero que pasa su prueba y el otro se cancela. Para problemas difíciles (duplicala y poné otro modelo en la rama B).',
    grafo: {
      nodos: {
        entrada: { tipo: 'entrada' }, sem: { tipo: 'semaforo', cupo: 2 },
        ea: { tipo: 'escribir', titulo: 'Escribir · A', vueltas: 1 }, va: { tipo: 'verificar', titulo: 'Verificar · A' },
        eb: { tipo: 'escribir', titulo: 'Escribir · B', vueltas: 1 }, vb: { tipo: 'verificar', titulo: 'Verificar · B' },
        juntar: { tipo: 'juntar', modo: 'primera' }, todo: { tipo: 'verificar', titulo: 'Verificar · elegido' },
        juez: { tipo: 'juez' }, vos: { tipo: 'revision' }, vosno: { tipo: 'revision', titulo: 'Vos · no integrable' }
      },
      aristas: [
        a('in', 'entrada', 'sale', 'sem'), a('sem-a', 'sem', 'rama', 'ea'), a('sem-b', 'sem', 'rama', 'eb'),
        ...['a', 'b'].flatMap((k) => [
          a(`e${k}-ok`, `e${k}`, 'ok', `v${k}`), a(`e${k}-sin`, `e${k}`, 'sin-cambios', 'vosno'), a(`e${k}-err`, `e${k}`, 'error', 'vosno'),
          a(`v${k}-pasa`, `v${k}`, 'pasa', 'juntar'), a(`v${k}-falla`, `v${k}`, 'falla', `e${k}`, { alAgotar: 'vosno' }), a(`v${k}-err`, `v${k}`, 'error', 'vosno')
        ]),
        // Con «primera» no hay merge, así que no hay conflicto: el puerto va a Vos (lo admite el validador en este modo).
        a('j-listo', 'juntar', 'listo', 'todo'), a('j-conf', 'juntar', 'conflicto', 'vosno'), a('j-insuf', 'juntar', 'insuficiente', 'vosno'), a('j-err', 'juntar', 'error', 'vosno'),
        a('todo-pasa', 'todo', 'pasa', 'juez'), a('todo-falla', 'todo', 'falla', 'vosno'), a('todo-err', 'todo', 'error', 'vosno'),
        ...juezAVos('juez', 'vos'), a('juez-fail', 'juez', 'fail', 'vos')
      ]
    }
  },
  {
    id: 'escalar-a-vos', titulo: 'Escalar a vos',
    descripcion: 'Si la prueba sigue fallando después de 2 correcciones, la tarea te espera en lugar de descartarse. Para requisitos ambiguos.',
    grafo: {
      nodos: { entrada: { tipo: 'entrada' }, esc: { tipo: 'escribir', vueltas: 3 }, ver: { tipo: 'verificar' }, humano: { tipo: 'humano' }, juez: { tipo: 'juez' }, vos: { tipo: 'revision' } },
      aristas: [
        a('in', 'entrada', 'sale', 'esc'), a('esc-ok', 'esc', 'ok', 'ver'), ...escribirResto('esc', 'juez', 'vos'),
        a('ver-pasa', 'ver', 'pasa', 'juez'), a('ver-falla', 'ver', 'falla', 'esc', { tope: 2, alAgotar: 'humano' }), a('ver-err', 'ver', 'error', 'vos'),
        a('hum-corr', 'humano', 'corregir', 'esc', { alAgotar: 'vos' }), a('hum-apr', 'humano', 'aprobar', 'juez'), a('hum-can', 'humano', 'cancelar', 'vos'),
        ...juezAVos('juez', 'vos'), a('juez-fail', 'juez', 'fail', 'vos')
      ]
    }
  }
]);

module.exports = { PLANTILLAS };
