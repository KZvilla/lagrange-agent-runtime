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
import { sesionRemotaV2, configClaudeV2 } from './lecturas.js';
import { motoresV2 } from './motores.js';
import { guardarAjustesV2, caracterVozV2, efectosVozV2, probarVozV2 } from './ajustes.js';

const RE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RE_ID_TURNO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOPE_FOTO_CUERPO = 14 * 1024 * 1024;
// FEAT-214 — Un grafo de hasta 2 MB, con su sobre.
const TOPE_GRAFO_CUERPO = Math.round(2.5 * 1024 * 1024);
const error = (codigo, texto) => ({ codigo, ok: false, error: texto });
const sale = (r) => !(r?.ok === false || (Number.isInteger(r?.codigo) && r.codigo >= 400));

// FEAT-201 F2 — Claude remoto: las respuestas con la forma del contrato (`parada`, `purga`, `errorClaude`).
const CLAVES_SESIONES = ['cuenta_por_defecto', 'max_sesiones', 'directorios', 'ocultos'];
const RE_WS = /^[0-9a-f]{8}$/;
const texto = (v, tope) => String(v ?? '').slice(0, tope);
const ramas = (l) => (Array.isArray(l) ? l : []).map((w) => ({ rama: texto(w.rama, 256), motivo: texto(w.motivo, 256) }));

/** El error de Claude remoto por lista blanca: lo que el contrato declara, nada más. */
export function errorClaudeV2(r, { redactar = (t) => t } = {}) {
  const e = { codigo: Number.isInteger(r?.codigo) ? r.codigo : 500, ok: false, error: texto(r?.error || 'Error de Claude remoto.', 2000) };
  if (r?.elegirCuenta === true) { e.elegirCuenta = true; e.cuentas = (Array.isArray(r.cuentas) ? r.cuentas : []).map((c) => texto(c, 64)); }
  if (r?.tope === true) e.tope = true;
  if (r && 'log' in r) e.log = r.log === null ? null : redactar(String(r.log));
  if (typeof r?.campo === 'string') e.campo = texto(r.campo, 128);
  if (r?.estado && r.estado.ok !== false) e.estado = configClaudeV2(r.estado);
  return e;
}

/** Lo que dejó detener una o todas: sin `pid`. */
export function paradaV2(r) {
  return {
    ok: true,
    detenidas: (r.detenidas || []).map((s) => ({ key: texto(s.key, 256), cuenta: texto(s.cuenta, 64), proyecto: texto(s.proyecto, 256) })),
    proyectos: (r.proyectos || []).map((p) => ({
      wsId: RE_WS.test(String(p.wsId)) ? p.wsId : null, proyecto: texto(p.proyecto, 256),
      limpios: Number.isInteger(p.limpios) ? p.limpios : 0, conCambios: ramas(p.conCambios)
    })),
    inspeccionFallida: (r.inspeccionFallida || []).map((x) => texto(x, 256))
  };
}

export function purgaV2(r) {
  return { ok: true, proyecto: texto(r.proyecto, 256), borrados: Number.isInteger(r.borrados) ? r.borrados : 0, conservados: ramas(r.conservados) };
}

/** `nucleo.*Claude` → la forma de v2, o el error por lista blanca. */
const deClaudeV2 = (r, forma, opciones) => (r && r.ok !== false && !(Number.isInteger(r.codigo) && r.codigo >= 400) ? forma(r) : errorClaudeV2(r, opciones));

export function rutasMutacionV2({ nucleo, cola, ctx, chatTerminal, registro, idem, almacen = null, recorte, topeTexto = 16384, redactar = (t) => t, imagenes = null, comfy = null, conGaleria = false, taller = null }) {
  // FEAT-213 — La galería y el proceso de ComfyUI son de este daemon: en un nodo no están.
  const galeria = conGaleria && imagenes ? imagenes.galeria : null;
  const sinGaleria = () => error(503, 'La galería no está en este proceso.');
  const sinComfy = () => error(503, 'ComfyUI no se maneja desde este proceso.');
  const CODIGOS_COMFY = { apagado: 409, ajeno: 409, ocupado: 409, 'no-se-puede': 409 };
  const deComfy = async (p) => {
    const r = await p;
    return r.ok ? { ok: true } : { ...error(CODIGOS_COMFY[r.codigo] || 500, r.motivo || 'No se pudo.'), motivo: r.codigo || 'error' };
  };
  // FEAT-214 — El taller (perezoso: se crea en el primer pedido). Su respuesta `{ ok: false, status, motivo, mensaje }` → un error.
  const elTaller = () => (typeof taller === 'function' ? taller() : taller);
  const sinTaller = () => error(503, 'El taller no está en este proceso.');
  const deTaller = async (fn) => {
    const tl = elTaller();
    if (!tl) return sinTaller();
    const res = await fn(tl);
    if (res && res.ok === false) return { ...error(res.status || 409, res.mensaje || 'No se pudo.'), motivo: res.motivo || 'error' };
    return res;
  };
  const forzarDe = (cuerpo) => (cuerpo.forzar === undefined || typeof cuerpo.forzar === 'boolean' ? { ok: true, forzar: cuerpo.forzar === true } : { ok: false });
  // FEAT-210 §5 — El turno de una imagen: por tareaId o por tid (la entrada de idempotencia).
  const tareaDeImagen = (id, n) => {
    if (!RE_ID_TURNO.test(id)) return { error: error(400, 'Id de turno inválido.') };
    if (!/^[1-9]\d?$/.test(n)) return { error: error(400, 'Número de imagen inválido.') };
    if (!imagenes) return { error: error(503, 'Sin imágenes en este proceso.') };
    const e = idem.porId(id);
    const tareaId = e ? e.tareaId : id;
    // FEAT-214 — Una imagen del taller no tiene turno: se abre en el taller.
    if (/^t_taller/.test(String(tareaId))) return { error: { ...error(409, 'Esa imagen se hizo en el taller: abrila ahí.'), motivo: 'del-taller' } };
    if (!tareaId || !registro.obtener(tareaId)) return { error: error(410, 'Ese turno ya no está en el registro.') };
    return { tareaId, n: Number(n) };
  };
  const TEXTOS_IMAGEN = {
    'no-existe': [404, 'Esa imagen no existe.'], 'no-en-error': [409, 'Solo se reintenta una imagen que falló.'],
    'tope-turno': [409, 'Ese turno ya tiene 4 imágenes.'], apagada: [409, 'Otra versión está apagada.'],
    'sin-hilo': [409, 'Esa imagen no es de ningún hilo.'],
    'foto-perdida': [409, 'La foto ya no está; mandala de nuevo.'], 'cola-llena': [409, 'Ya hay demasiadas imágenes esperando. Probá en un rato.']
  };
  const deImagen = (r, textos = {}) => {
    if (r.ok) return { ok: true, n: r.n };
    const [codigo, texto] = TEXTOS_IMAGEN[r.codigo] || [409, 'No se pudo.'];
    return { ...error(codigo, textos[r.codigo] || texto), motivo: r.codigo };
  };
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
        // FEAT-214 — «Que lo prepare el alma».
        if (cuerpo.taller !== undefined && typeof cuerpo.taller !== 'boolean') return error(400, 'taller tiene que ser true o false.', 'taller');
        cast = { texto: t, taller: cuerpo.taller === true };
      }
      // Desde acá hasta el despacho, sin await.
      return idempotente(s.clave, String(cuerpo.idCliente), {
        despachar: (alEncolar) => (s.tipo === 'alma'
          ? cola.dispatchCharla(ctx, { clave: s.id, voz: s.voz, texto: cast.texto, alEncolar, ...(cast.taller ? { taller: true } : {}) })
          : cola.dispatchCast(ctx, { ...cast, alEncolar }))
      });
    } },
    { metodo: 'POST', topeCuerpo: TOPE_FOTO_CUERPO, patron: /^\/api\/v2\/sujetos\/([^/]+)\/fotos\/?$/, fn: async ({ p, cuerpo }) => {
      const s = await resolverSujeto(p[0]);
      if (!s || s.tipo !== 'alma') return error(404, 'No existe esa alma.');
      if (!RE_ID_CLIENTE.test(String(cuerpo.idCliente || ''))) return error(400, 'Falta idCliente (un UUID).');
      // FEAT-213 §2 — Una imagen de la galería, por referencia: el turno usa el archivo original. Si es segura lo decide el turno.
      if (cuerpo.referencia !== undefined) {
        if (!galeria) return sinGaleria();
        if (cuerpo.base64 !== undefined) return error(400, 'Va la imagen o la referencia, no las dos.');
        const pie = nucleo.validarPieDeFoto(s.id, cuerpo);
        if (pie.ok === false) return pie;
        let original = null;
        return idempotente(s.clave, String(cuerpo.idCliente), {
          adjunto: true,
          antes: () => { const r = galeria.referencia(cuerpo.referencia); original = r.ruta; return r.ok ? r : error(r.codigo, r.motivo); },
          despachar: (alEncolar) => cola.dispatchCharla(ctx, { clave: pie.alma.clave, voz: pie.alma.voz, texto: pie.pie, imagen: { ruta: original, segura: pie.segura }, alEncolar })
        });
      }
      const v = nucleo.validarFoto(s.id, cuerpo);
      if (v.ok === false) return v;
      let ruta = null;
      // Orden: validar → tope → entrada de idempotencia → guardar el adjunto → despachar. Un reenvío no guarda otro.
      return idempotente(s.clave, String(cuerpo.idCliente), {
        adjunto: true,
        antes: () => { const g = nucleo.guardarFoto(v); if (g.ok !== false) ruta = g.ruta; return g; },
        // FEAT-210 §2.2 — `segura` viaja tal cual; si cuenta lo decide el turno (`imagenes.fotos_seguras`).
        despachar: (alEncolar) => cola.dispatchCharla(ctx, { clave: v.alma.clave, voz: v.alma.voz, texto: v.pie, imagen: { ruta, segura: v.segura === true }, alEncolar })
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
    // ---------------------------------------------------------------- FEAT-210 §5 — Las imágenes de un turno.
    { metodo: 'GET', patron: /^\/api\/v2\/turnos\/([^/:]+)\/imagenes\/([^/:]+)$/, fn: ({ p }) => {
      const t = tareaDeImagen(p[0], p[1]);
      if (t.error) return t.error;
      const r = imagenes.bytesDe(t.tareaId, t.n);
      return r.ok ? { binario: r.bytes, tipo: r.tipo } : error(404, 'La imagen no está lista.');
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/turnos\/([^/:]+)\/imagenes\/([^/:]+):reintentar$/, fn: ({ p }) => {
      const t = tareaDeImagen(p[0], p[1]);
      return t.error || deImagen(imagenes.reintentar(t.tareaId, t.n));
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/turnos\/([^/:]+)\/imagenes\/([^/:]+):otra$/, fn: ({ p }) => {
      const t = tareaDeImagen(p[0], p[1]);
      return t.error || deImagen(imagenes.otra(t.tareaId, t.n));
    } },
    // FEAT-215 — «Variar esta».
    { metodo: 'POST', patron: /^\/api\/v2\/turnos\/([^/:]+)\/imagenes\/([^/:]+):variar$/, fn: ({ p }) => {
      // Numera la nueva: solo el daemon (en un nodo, `capacidades.versiones` es false).
      if (!galeria) return sinGaleria();
      const t = tareaDeImagen(p[0], p[1]);
      return t.error || deImagen(imagenes.variar(t.tareaId, t.n), { apagada: 'Variar está apagada.' });
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/turnos\/([^/:]+)\/imagenes\/([^/:]+):cancelar$/, fn: ({ p }) => {
      const t = tareaDeImagen(p[0], p[1]);
      if (t.error) return t.error;
      return imagenes.cancelar(t.tareaId, t.n) > 0 ? { ok: true, accion: 'imagen' } : error(409, 'Esa imagen no está en la cola ni en curso.');
    } },
    // ---------------------------------------------------------------- FEAT-213 §2 — La galería.
    { metodo: 'GET', patron: /^\/api\/v2\/imagenes\/?$/, fn: ({ url }) => {
      if (!galeria) return sinGaleria();
      const q = (k) => url.searchParams.get(k);
      const r = galeria.listar({ alma: q('alma'), caso: q('caso'), busca: q('texto'), antes: q('antes'), limite: q('limite') });
      return r.ok ? r : { ...error(r.codigo, r.motivo), campo: r.campo };
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/imagenes\/([^/:]+)\/([^/:]+)\/([1-9]\d?)$/, fn: ({ p }) => {
      if (!galeria) return sinGaleria();
      const r = galeria.bytes(p[0], p[1], Number(p[2]));
      return r.ok ? { binario: r.bytes, tipo: r.tipo } : error(r.codigo === 400 ? 400 : 404, 'Esa imagen no está.');
    } },
    // FEAT-215 — «Partir de esta»: la base del próximo cambio en ese hilo.
    { metodo: 'POST', patron: /^\/api\/v2\/imagenes\/([^/:]+)\/([^/:]+)\/([1-9]\d?):partir$/, fn: ({ p, cuerpo }) => {
      if (!galeria) return sinGaleria();
      if (!galeria.valida({ alma: p[0], tareaId: p[1], n: Number(p[2]), intento: 1 })) return error(400, 'Imagen inválida.');
      if (typeof cuerpo.elegida !== 'boolean') return { ...error(400, 'elegida tiene que ser true o false.'), campo: 'elegida' };
      const r = imagenes.partir(p[0], p[1], Number(p[2]), cuerpo.elegida);
      if (r.ok) return { ok: true, elegida: cuerpo.elegida };
      const [codigo, texto] = TEXTOS_IMAGEN[r.codigo] || [409, 'No se pudo.'];
      return { ...error(codigo, r.codigo === 'apagada' ? 'Partir de esta está apagada.' : texto), motivo: r.codigo };
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/imagenes:borrar$/, fn: ({ cuerpo }) => {
      if (!galeria) return sinGaleria();
      const r = galeria.borrar(cuerpo.imagenes);
      return r.ok ? r : { ...error(r.codigo, r.motivo), campo: r.campo };
    } },
    // ---------------------------------------------------------------- FEAT-214 — El taller.
    { metodo: 'POST', patron: /^\/api\/v2\/taller:abrir$/, fn: ({ cuerpo }) => deTaller((tl) => tl.abrir(cuerpo)) },
    { metodo: 'GET', patron: /^\/api\/v2\/taller\/plantillas\/?$/, fn: () => deTaller((tl) => tl.plantillas()) },
    { metodo: 'POST', topeCuerpo: TOPE_GRAFO_CUERPO, patron: /^\/api\/v2\/taller\/plantillas\/?$/, fn: ({ cuerpo }) => deTaller((tl) => tl.guardarPlantilla(cuerpo)) },
    { metodo: 'POST', patron: /^\/api\/v2\/taller\/plantillas:borrar$/, fn: ({ cuerpo }) => deTaller((tl) => tl.borrarPlantilla(cuerpo)) },
    { metodo: 'GET', patron: /^\/api\/v2\/taller\/preparados\/?$/, fn: ({ url }) => deTaller((tl) => tl.preparadoDe(url.searchParams.get('tareaId'))) },
    { metodo: 'GET', patron: /^\/api\/v2\/taller\/([^/:]+)\/?$/, fn: ({ p }) => deTaller((tl) => tl.estado(p[0])) },
    { metodo: 'GET', patron: /^\/api\/v2\/taller\/([^/:]+)\/([^/:]+)$/, fn: ({ p }) => deTaller((tl) => { const res = tl.bytes(p[0], p[1]); return res.ok ? { binario: res.bytes, tipo: res.tipo } : res; }) },
    { metodo: 'POST', patron: /^\/api\/v2\/taller\/([^/:]+):sigue$/, fn: ({ p, cuerpo }) => deTaller((tl) => tl.sigue(p[0], cuerpo)) },
    { metodo: 'POST', patron: /^\/api\/v2\/taller\/([^/:]+):cerrar$/, fn: ({ p, cuerpo }) => deTaller((tl) => tl.cerrar(p[0], cuerpo)) },
    { metodo: 'POST', patron: /^\/api\/v2\/taller\/([^/:]+)\/([^/:]+):quedar$/, fn: ({ p, cuerpo }) => deTaller((tl) => tl.quedar(p[0], p[1], cuerpo)) },
    { metodo: 'POST', patron: /^\/api\/v2\/taller\/([^/:]+)\/([^/:]+):descartar$/, fn: ({ p }) => deTaller((tl) => tl.descartar(p[0], p[1])) },
    // ---------------------------------------------------------------- FEAT-213 §1 — El proceso de ComfyUI.
    { metodo: 'GET', patron: /^\/api\/v2\/comfyui\/?$/, fn: async () => (comfy ? { ok: true, ...(await comfy.estado()) } : sinComfy()) },
    { metodo: 'GET', patron: /^\/api\/v2\/comfyui\/flags\/?$/, fn: async () => {
      if (!comfy) return sinComfy();
      const r = await comfy.flags();
      return r.ok ? { ok: true, flags: r.flags } : { ...error(409, `No se pueden leer las flags: ${r.motivo}.`), motivo: 'sin-flags' };
    } },
    { metodo: 'GET', patron: /^\/api\/v2\/comfyui\/registro\/?$/, fn: () => (comfy ? { ok: true, lineas: comfy.registro() } : sinComfy()) },
    { metodo: 'POST', patron: /^\/api\/v2\/comfyui:levantar$/, fn: () => (comfy ? deComfy(comfy.levantar()) : sinComfy()) },
    ...['apagar', 'reiniciar'].map((que) => ({ metodo: 'POST', patron: new RegExp(`^/api/v2/comfyui:${que}$`), fn: ({ cuerpo }) => {
      if (!comfy) return sinComfy();
      const f = forzarDe(cuerpo);
      return f.ok ? deComfy(comfy[que](f.forzar)) : error(400, 'forzar tiene que ser true o false.');
    } })),
    { metodo: 'POST', patron: /^\/api\/v2\/imagenes:probar$/, fn: async ({ cuerpo }) => {
      if (!imagenes) return error(503, 'Sin imágenes en este proceso.');
      if (cuerpo.url !== undefined && (typeof cuerpo.url !== 'string' || cuerpo.url.length > 300)) return error(400, 'url tiene que ser un texto.', 'url');
      return imagenes.probar(cuerpo.url);
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
    { metodo: 'POST', patron: /^\/api\/v2\/turnos\/([^/:]+):escuchar$/, fn: ({ p, cuerpo }) => {
      const e = idem.porId(p[0]);
      const id = e ? e.tareaId : p[0];
      // FEAT-211 — Con `fragmento`, el audio de ese fragmento (`huella` y `version` vienen de GET …/voz).
      if (cuerpo && cuerpo.fragmento !== undefined) {
        return nucleo.escucharFragmento(id, { fragmento: cuerpo.fragmento, huella: cuerpo.huella, version: cuerpo.version });
      }
      return nucleo.escucharTarea(id);
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
    // FEAT-202 S6 (D9) — Guarda con la validación de siempre y responde con la vista v2.
    { metodo: 'POST', patron: /^\/api\/v2\/motores\/rol\/?$/, fn: async ({ cuerpo }) => {
      const r = await nucleo.guardarMotor(cuerpo, { deV2: true });
      if (!r || r.ok === false) return r;
      return motoresV2(typeof nucleo.motoresV2 === 'function' ? await nucleo.motoresV2() : r);
    } },
    // FEAT-203 S0 — Ajustes (motores y general): validación propia, el núcleo y la respuesta proyectada.
    // FEAT-212 — 256 KB: los perfiles propios llevan reglas largas.
    { metodo: 'POST', topeCuerpo: 256 * 1024, patron: /^\/api\/v2\/ajustes\/?$/, fn: ({ cuerpo }) => guardarAjustesV2(nucleo, cuerpo, { comfy }) },
    { metodo: 'POST', patron: /^\/api\/v2\/voz\/preparar\/?$/, fn: ({ cuerpo }) => nucleo.prepararVoz(cuerpo) },
    // FEAT-204 — El carácter de una voz, en Voicebox, y Probar (el WAV).
    { metodo: 'POST', patron: /^\/api\/v2\/voz\/caracter\/?$/, fn: ({ cuerpo }) => caracterVozV2(nucleo, cuerpo) },
    // FEAT-204 S3 — Los efectos de una voz: un preset de Voicebox o ninguno.
    { metodo: 'POST', patron: /^\/api\/v2\/voz\/efectos\/?$/, fn: ({ cuerpo }) => efectosVozV2(nucleo, cuerpo) },
    { metodo: 'POST', patron: /^\/api\/v2\/voz:probar$/, fn: ({ cuerpo }) => probarVozV2(nucleo, cuerpo) },
    { metodo: 'POST', patron: /^\/api\/v2\/carriles:frenar$/, fn: ({ cuerpo }) => {
      const carril = cuerpo.carril;
      if (!['alma', 'cast', 'todos'].includes(carril)) return error(400, 'carril: alma, cast o todos.');
      return nucleo.cancelar(carril === 'todos' ? undefined : carril);
    } },
    { metodo: 'POST', patron: /^\/api\/v2\/claude\/sesiones\/?$/, fn: async ({ cuerpo }) => {
      const r = await nucleo.lanzarClaude(cuerpo);
      return deClaudeV2(r, (x) => ({ ok: true, ...(x.yaActiva ? { yaActiva: true } : {}), sesion: sesionRemotaV2(x.sesion || {}) }), { redactar });
    } },
    // F2 — Detener todas: la colección. Una sola: la sesión por su clave.
    { metodo: 'DELETE', patron: /^\/api\/v2\/claude\/sesiones\/?$/, fn: async () => deClaudeV2(await nucleo.detenerClaude({ all: true }), paradaV2) },
    { metodo: 'DELETE', patron: /^\/api\/v2\/claude\/sesiones\/([^/]+)$/, fn: async ({ p }) => deClaudeV2(await nucleo.detenerClaude({ key: p[0] }), paradaV2) },
    { metodo: 'POST', patron: /^\/api\/v2\/claude:purgar$/, fn: async ({ cuerpo }) => deClaudeV2(await nucleo.limpiarClaude(cuerpo), purgaV2) },
    // F2 — Claude en la terminal: dónde y con qué cuenta. No lanza nada.
    { metodo: 'POST', patron: /^\/api\/v2\/claude\/local\/?$/, fn: async ({ cuerpo }) => deClaudeV2(await nucleo.claudeLocal(cuerpo),
      (x) => ({ ok: true, ruta: String(x.ruta), cuenta: texto(x.cuenta, 64), configDir: x.configDir ? String(x.configDir) : null })) },
    // F2 — La sección `sesiones` de Ajustes, sola, con su versión. La versión va al final: no se puede pisar desde adentro.
    { metodo: 'POST', patron: /^\/api\/v2\/claude\/config\/?$/, fn: async ({ cuerpo }) => {
      const extra = Object.keys(cuerpo).filter((k) => k !== 'version' && k !== 'sesiones');
      if (extra.length) return error(400, `Claves desconocidas: ${extra.join(', ')}`);
      if (typeof cuerpo.version !== 'string' || !cuerpo.version) return error(400, 'Falta la versión de la configuración.');
      const ses = cuerpo.sesiones;
      if (!ses || typeof ses !== 'object' || Array.isArray(ses)) return error(400, 'sesiones tiene que ser un objeto.');
      const ajenas = Object.keys(ses).filter((k) => !CLAVES_SESIONES.includes(k));
      if (ajenas.length) return error(400, `Claves desconocidas en sesiones: ${ajenas.join(', ')}`);
      const r = await nucleo.guardarAjustes({ sesiones: { ...ses, versionSeccion: cuerpo.version } });
      return deClaudeV2(r, configClaudeV2);
    } }
  ];
}
