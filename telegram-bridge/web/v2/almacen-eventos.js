/**
 * FEAT-201 F0 S3 — El almacén de eventos del contrato v2.
 *
 * Separado del canal de la consola (`web/canal.js`), que es por chat. Acá hay
 * una secuencia global por arranque y un ring buffer por tema. Cada evento
 * lleva el id `<arranque>:<seq>`: `arranque` es un UUID sin «:», así que el id
 * se parte por el último «:».
 *
 * `publicar` redacta los datos adentro: nadie puede publicar texto sin pasar
 * por la redacción. Un evento efímero (`turno.texto`) llega a quien está
 * conectado pero no entra al buffer.
 *
 * Reanudar con `Last-Event-ID`: si el id es de otro arranque, está mal formado
 * o el buffer de algún tema pedido ya descartó lo posterior, ese tema recibe
 * `resync` y el cliente vuelve a pedir su estado por REST.
 */
const TOPES = Object.freeze({ sujeto: 200, carriles: 50, salud: 60, log: 500, claude: 100 });
const TOPE_POR_DEFECTO = 100;
export const RE_TEMA = /^(sujeto:([a-z0-9][a-z0-9._-]{0,63}|\*)|carriles|salud|log|claude)$/;

/** El tema de buffer de un tema concreto: `sujeto:alya` → `sujeto`. */
const familiaDe = (tema) => tema.split(':')[0];

/** `sujeto:*` suscribe a todos los `sujeto:<id>`. */
export function temaCoincide(pedido, tema) {
  if (pedido === tema) return true;
  return pedido.endsWith(':*') && tema.startsWith(pedido.slice(0, -1));
}

export function partirId(id) {
  const s = String(id || '');
  const i = s.lastIndexOf(':');
  if (i <= 0) return null;
  const seq = Number(s.slice(i + 1));
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return { arranque: s.slice(0, i), seq };
}

function redactarProfundo(valor, redactar) {
  if (typeof valor === 'string') return redactar(valor);
  if (Array.isArray(valor)) return valor.map((v) => redactarProfundo(v, redactar));
  if (valor && typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = redactarProfundo(v, redactar);
    return out;
  }
  return valor;
}

export function crearAlmacenEventos({ arranque, redactar = (t) => t, ahora = Date.now, topes = TOPES } = {}) {
  if (typeof arranque !== 'string' || !arranque || arranque.includes(':')) throw new Error('El almacén necesita un arranque opaco, sin «:».');
  let seq = 0;
  // tema concreto → { eventos: [], descartadoHasta: seq del último evento que salió del buffer }
  const buffers = new Map();
  const suscriptores = new Set();
  const alCambiarSuscriptores = new Set();

  const bufferDe = (tema) => {
    let b = buffers.get(tema);
    if (!b) { b = { eventos: [], descartadoHasta: 0 }; buffers.set(tema, b); }
    return b;
  };

  function publicar(tema, tipo, datos, { efimero = false } = {}) {
    if (!RE_TEMA.test(tema) || tema === 'sujeto:*') throw new Error(`Tema inválido: ${tema}`);
    seq += 1;
    const evento = { id: `${arranque}:${seq}`, tema, tipo, ts: ahora(), datos: redactarProfundo(datos, redactar) };
    if (!efimero) {
      const b = bufferDe(tema);
      b.eventos.push({ seq, evento });
      const tope = topes[familiaDe(tema)] || TOPE_POR_DEFECTO;
      while (b.eventos.length > tope) b.descartadoHasta = b.eventos.shift().seq;
    }
    for (const s of [...suscriptores]) {
      if (!s.temas.some((t) => temaCoincide(t, tema))) continue;
      try { s.fn(evento); } catch {}
    }
    return evento;
  }

  /**
   * Lo pendiente desde `ultimoId` para los temas pedidos:
   * `{ eventos, resync: [temas] }`. Sin `ultimoId`, no hay nada pendiente.
   */
  function pendientes(temas, ultimoId) {
    if (ultimoId === null || ultimoId === undefined || ultimoId === '') return { eventos: [], resync: [] };
    const p = partirId(ultimoId);
    if (!p || p.arranque !== arranque || p.seq > seq) return { eventos: [], resync: [...temas] };
    const resync = [];
    const eventos = [];
    for (const pedido of temas) {
      const concretos = [...buffers.keys()].filter((t) => temaCoincide(pedido, t));
      let perdio = false;
      for (const tema of concretos) {
        const b = buffers.get(tema);
        if (p.seq < b.descartadoHasta) { perdio = true; continue; }
        for (const e of b.eventos) if (e.seq > p.seq) eventos.push(e);
      }
      if (perdio) resync.push(pedido);
    }
    // Un tema puede caer en dos pedidos (`sujeto:*` y `sujeto:alya`): sin repetidos, en orden.
    const vistos = new Set();
    const unicos = eventos.filter((e) => (vistos.has(e.seq) ? false : vistos.add(e.seq))).sort((a, b) => a.seq - b.seq);
    return { eventos: unicos.map((e) => e.evento), resync };
  }

  function suscribir(temas, fn) {
    const s = { temas: [...temas], fn };
    suscriptores.add(s);
    for (const cb of alCambiarSuscriptores) try { cb(); } catch {}
    return () => {
      if (!suscriptores.delete(s)) return;
      for (const cb of alCambiarSuscriptores) try { cb(); } catch {}
    };
  }

  /** ¿Alguien escucha este tema? Para encender y apagar productores caros (log, salud). */
  function hayInteres(tema) {
    for (const s of suscriptores) if (s.temas.some((t) => temaCoincide(t, tema))) return true;
    return false;
  }

  return {
    arranque, publicar, pendientes, suscribir, hayInteres,
    alCambiarSuscriptores: (cb) => { alCambiarSuscriptores.add(cb); return () => alCambiarSuscriptores.delete(cb); },
    ultimoSeq: () => seq
  };
}
