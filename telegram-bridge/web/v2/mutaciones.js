/**
 * FEAT-201 F0 S5 — Las mutaciones de la API v2.
 *
 * Turnos y fotos son idempotentes por `(sujeto, idCliente)` (ver
 * `idempotencia.js`): todo lo que necesita `await` (resolver el sujeto,
 * validar) va antes; desde `buscar` hasta el despacho no hay ningún `await`, y
 * el despacho entrega el `tareaId` por `alEncolar` antes de ceder el control.
 *
 * Despachan con el ctx del chat `web:terminal`: el origen queda 'terminal' y el
 * modo charla no se mezcla con el de la consola congelada.
 *
 * Las demás delegan en el núcleo, igual que su ruta v1, y las de memoria avisan
 * `memoria.cambio` cuando salen bien.
 */
import { turnoDe } from './productores.js';
import { RE_ID_CLIENTE } from './idempotencia.js';

const RE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RE_ID_TURNO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOPE_FOTO_CUERPO = 14 * 1024 * 1024;
const error = (codigo, texto) => ({ codigo, ok: false, error: texto });
const sale = (r) => !(r?.ok === false || (Number.isInteger(r?.codigo) && r.codigo >= 400));

export function rutasMutacionV2({ nucleo, cola, ctx, chatTerminal, registro, idem, almacen = null, recorte, topeTexto = 16384 }) {
  async function resolverSujeto(id) {
    if (!RE_ID.test(String(id))) return null;
    const s = await nucleo.sujetos();
    const alma = (s.almas || []).find((a) => a.clave === id);
    if (alma) return { tipo: 'alma', id, clave: `alma:${id}`, voz: alma.voz };
    const agente = (s.agentes || []).find((a) => a.nombre === id);
    if (agente) return { tipo: 'agente', id, clave: `agente:${id}` };
    return null;
  }

  /** La respuesta de un turno: su forma de contrato, con el estado leído del registro. */
  function respuestaTurno(e, codigo) {
    const t = e.tareaId ? registro.obtener(e.tareaId) : null;
    if (!t) return error(410, 'Ese turno ya no está en el registro.');
    return { codigo, ok: true, turno: turnoDe(t, { recorte, extras: idem.extras }) };
  }

  /** La parte sin `await`: buscar, reservar y despachar. `despachar(alEncolar)` devuelve la promesa del despacho. */
  function idempotente(sujeto, idCliente, { adjunto = false, antes = null, despachar }) {
    const previa = idem.buscar(sujeto, idCliente);
    if (previa) {
      if (idem.vencida(previa)) return Promise.resolve(error(409, 'Ese idCliente venció: mandalo con uno nuevo si todavía querés enviarlo.'));
      return Promise.resolve(respuestaTurno(previa, 200));
    }
    const e = idem.reservar({ sujeto, idCliente, adjunto });
    if (antes) {
      const a = antes();
      if (a.ok === false) { idem.deshacer(e); return Promise.resolve(a); }
    }
    const promesa = despachar((tareaId) => idem.asignarTareaId(e, tareaId));
    return promesa.then((r) => {
      if (!r?.ok || !e.tareaId) {
        idem.deshacer(e);
        return error(409, 'No se pudo encolar el turno.');
      }
      return respuestaTurno(e, 202);
    }, (err) => {
      idem.deshacer(e);
      throw err;
    });
  }

  const memoriaCambio = (id, r) => {
    if (sale(r) && almacen) almacen.publicar(`sujeto:${id}`, 'memoria.cambio', { sujeto: id });
    return r;
  };

  return [
    { metodo: 'POST', patron: /^\/api\/v2\/sujetos\/([^/]+)\/turnos\/?$/, fn: async ({ p, cuerpo }) => {
      const s = await resolverSujeto(p[0]);
      if (!s) return error(404, 'No existe ese sujeto.');
      if (!RE_ID_CLIENTE.test(String(cuerpo.idCliente || ''))) return error(400, 'Falta idCliente (un UUID).');
      let cast = null;
      if (s.tipo === 'agente') {
        const c = nucleo.prepararCast({ agente: s.id, workspaceId: cuerpo.workspaceId, pedido: cuerpo.texto }, { chat: chatTerminal });
        if (c.ok === false) return c;
        cast = c.cast;
      } else {
        const t = typeof cuerpo.texto === 'string' ? cuerpo.texto.trim() : '';
        if (!t || t.length > topeTexto) return error(400, `El mensaje tiene que tener entre 1 y ${topeTexto} caracteres.`);
        cast = { texto: t };
      }
      // Desde acá hasta el despacho, sin await.
      return idempotente(s.clave, String(cuerpo.idCliente), {
        despachar: (alEncolar) => (s.tipo === 'alma'
          ? cola.dispatchCharla(ctx, { clave: s.id, voz: s.voz, texto: cast.texto, alEncolar })
          : cola.dispatchCast(ctx, { ...cast, alEncolar }))
      });
    } },
    { metodo: 'POST', topeCuerpo: TOPE_FOTO_CUERPO, patron: /^\/api\/v2\/sujetos\/([^/]+)\/fotos\/?$/, fn: async ({ p, cuerpo }) => {
      const s = await resolverSujeto(p[0]);
      if (!s || s.tipo !== 'alma') return error(404, 'No existe esa alma.');
      if (!RE_ID_CLIENTE.test(String(cuerpo.idCliente || ''))) return error(400, 'Falta idCliente (un UUID).');
      const v = nucleo.validarFoto(s.id, cuerpo);
      if (v.ok === false) return v;
      let ruta = null;
      // Orden: validar → tope → entrada de idempotencia → guardar el adjunto → despachar. Un reenvío no guarda otro.
      return idempotente(s.clave, String(cuerpo.idCliente), {
        adjunto: true,
        antes: () => { const g = nucleo.guardarFoto(v); if (g.ok !== false) ruta = g.ruta; return g; },
        despachar: (alEncolar) => cola.dispatchCharla(ctx, { clave: v.alma.clave, voz: v.alma.voz, texto: v.pie, imagen: { ruta }, alEncolar })
      });
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/turnos\/([^/:]+):cancelar$/, fn: ({ p }) => {
      if (!RE_ID_TURNO.test(p[0])) return error(400, 'Id de turno inválido.');
      const e = idem.porId(p[0]);
      const tareaId = e ? e.tareaId : p[0];
      if (!tareaId || !registro.obtener(tareaId)) return error(410, 'Ese turno ya no está en el registro.');
      const r = cola.cancelarTarea(tareaId);
      return r.ok ? { ok: true, accion: r.accion } : error(r.codigo, r.error);
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/turnos\/([^/:]+):reintentar$/, fn: async ({ p }) => {
      if (!RE_ID_TURNO.test(p[0])) return error(400, 'Id de turno inválido.');
      const previa = idem.porId(p[0]);
      const tareaId = previa ? previa.tareaId : p[0];
      const t = tareaId ? registro.obtener(tareaId) : null;
      if (!t) return error(410, 'Ese turno ya no está en el registro.');
      // El registro no guarda la imagen: reintentar reenviaría solo el pie.
      if (previa?.adjunto || String(t.pedido || '').startsWith('🖼️ foto')) return error(409, 'Una foto no se reintenta: reenviala.');
      const sujeto = t.sujeto?.tipo === 'alma' ? `alma:${t.sujeto.clave}` : `agente:${t.sujeto?.nombre}`;
      const e = idem.reservar({ sujeto, reintentoDe: previa ? previa.tid : tareaId });
      let r;
      try {
        r = await cola.reintentarTarea(tareaId, ctx, { alEncolar: (id) => idem.asignarTareaId(e, id) });
      } catch (err) {
        idem.deshacer(e);
        throw err;
      }
      if (!r.ok || !e.tareaId) {
        idem.deshacer(e);
        return error(r.codigo || 409, r.error || 'No se pudo reintentar.');
      }
      return respuestaTurno(e, 202);
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/turnos\/([^/:]+):escuchar$/, fn: ({ p }) => {
      const e = idem.porId(p[0]);
      return nucleo.escucharTarea(e ? e.tareaId : p[0]);
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/sujetos\/([^/]+)\/memoria\/?$/, fn: async ({ p, cuerpo }) =>
      memoriaCambio(p[0], await nucleo.recordar(p[0], { texto: cuerpo.texto, sobre: cuerpo.sobre })) },
    { metodo: 'DELETE', patron: /^\/api\/v2\/sujetos\/([^/]+)\/memoria\/([^/]+)$/, fn: async ({ p }) =>
      memoriaCambio(p[0], await nucleo.olvidar(p[0], p[1])) },
    { metodo: 'POST', patron: /^\/api\/v2\/sujetos\/([^/]+)\/cuarentena\/([^/:]+):promover$/, fn: async ({ p }) =>
      memoriaCambio(p[0], await nucleo.promoverCuarentena(p[0], p[1])) },
    { metodo: 'POST', patron: /^\/api\/v2\/sujetos\/([^/]+)\/cuarentena\/([^/:]+):descartar$/, fn: async ({ p }) =>
      memoriaCambio(p[0], await nucleo.descartarCuarentena(p[0], p[1])) },
    { metodo: 'POST', patron: /^\/api\/v2\/sujetos\/([^/]+)\/hilos\/?$/, fn: ({ p }) => nucleo.hiloNuevo(p[0]) },
    { metodo: 'POST', patron: /^\/api\/v2\/motores\/rol\/?$/, fn: ({ cuerpo }) => nucleo.guardarMotor(cuerpo) },
    { metodo: 'POST', patron: /^\/api\/v2\/voz\/preparar\/?$/, fn: ({ cuerpo }) => nucleo.prepararVoz(cuerpo) },
    { metodo: 'POST', patron: /^\/api\/v2\/carriles:frenar$/, fn: ({ cuerpo }) => {
      const carril = cuerpo.carril;
      if (!['alma', 'cast', 'todos'].includes(carril)) return error(400, 'carril: alma, cast o todos.');
      return nucleo.cancelar(carril === 'todos' ? undefined : carril);
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/claude\/sesiones\/?$/, fn: ({ cuerpo }) => nucleo.lanzarClaude(cuerpo) },
    { metodo: 'DELETE', patron: /^\/api\/v2\/claude\/sesiones\/([^/]+)$/, fn: ({ p }) => nucleo.detenerClaude({ key: p[0] }) },
    { metodo: 'POST', patron: /^\/api\/v2\/claude:purgar$/, fn: ({ cuerpo }) => nucleo.limpiarClaude(cuerpo) }
  ];
}
