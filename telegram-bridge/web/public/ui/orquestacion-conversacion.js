/*
 * FEAT-162 F3 — La conversación con la sesión que orquesta: tus notas (a la derecha) le llegan a su buzón como
 * «nota del usuario desde la consola»; sus respuestas y preguntas (a la izquierda) las deja con la herramienta
 * `consola`. Una pregunta se contesta con «Responder». Llega por el SSE `orquestacion`, sin rutas de lectura nuevas.
 */
import { useState } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { api, avisar } from './nucleo.js';
import { fechaCorta } from './fechas.js';

const enc = encodeURIComponent;
const TOPE_BYTES = 4 * 1024;

function Globo({ n, porId, alResponder, abierta, elegida }) {
  // BE-133 — Lo que anota la consola (`de: 'consola'`, solo el daemon): centrado, ni tuyo ni de la sesión.
  if (n.de === 'consola') {
    return html`<li class="orq-globo orq-globo-sistema"><span>${n.texto}</span> <time datetime=${n.t}>${fechaCorta(n.t)}</time></li>`;
  }
  const deUsuario = n.de === 'usuario';
  const original = n.respuestaA ? porId.get(n.respuestaA) : null;
  return html`<li class=${`orq-globo ${deUsuario ? 'orq-globo-usuario' : 'orq-globo-sesion'}${n.pregunta ? ' orq-globo-pregunta' : ''}${elegida ? ' orq-globo-elegida' : ''}`}>
    <div class="orq-globo-cab">
      <span>${deUsuario ? 'Vos' : n.pregunta ? 'Pregunta de la sesión' : 'La sesión'}</span>
      <time datetime=${n.t}>${fechaCorta(n.t)}</time>
    </div>
    ${original ? html`<div class="orq-globo-cita">${String(original.texto).slice(0, 140)}</div>` : null}
    <div class="orq-globo-texto">${n.texto}</div>
    ${n.pregunta && abierta && !elegida ? html`<button type="button" class="boton chico" onClick=${() => alResponder(n)}>Responder</button>` : null}
  </li>`;
}

export function Conversacion({ o }) {
  const [texto, setTexto] = useState('');
  const [respuestaA, setRespuestaA] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const conv = o.conversacion || [];
  const abierta = o.estado !== 'terminada';
  if (!abierta && !conv.length) return null;
  const porId = new Map(conv.map((n) => [n.id, n]));
  const pesado = new TextEncoder().encode(texto.trim()).length > TOPE_BYTES;

  const enviar = async () => {
    const limpio = texto.trim();
    if (!limpio || pesado || enviando) return;
    setEnviando(true);
    try {
      const r = await api(`/api/orquestaciones/${enc(o.id)}/notas`, { texto: limpio, ...(respuestaA ? { respuestaA: respuestaA.id } : {}) });
      setTexto('');
      setRespuestaA(null);
      if (!r.entregada) avisar('Nota guardada. La sesión no recibe mensajes: la verá cuando mire su estado.');
    } catch (err) { avisar(err.message, 'error'); }
    setEnviando(false);
  };

  return html`<section class="orq-conversacion" aria-label=${`Conversación con ${o.quien}`}>
    <h3>Conversación con ${o.quien}</h3>
    ${conv.length ? html`<ol class="orq-globos desplazable">${conv.map((n) => html`<${Globo} key=${n.id} n=${n} porId=${porId} abierta=${abierta} elegida=${respuestaA?.id === n.id} alResponder=${setRespuestaA} />`)}</ol>`
      : html`<p class="tenue">Escribile a la sesión: le llega como una nota tuya, aunque esté ocupada.</p>`}
    ${abierta ? html`<form class="orq-escribir" onSubmit=${(e) => { e.preventDefault(); enviar(); }}>
      ${respuestaA ? html`<div class="orq-respondiendo">Respondiendo: «${String(respuestaA.texto).slice(0, 80)}»
        <button type="button" class="boton chico" onClick=${() => setRespuestaA(null)}>Quitar</button></div>` : null}
      ${o.entrega ? null : html`<p class="tenue">Esta sesión no recibe mensajes: verá tu nota cuando mire su estado.</p>`}
      <textarea rows="2" placeholder=${`Nota para ${o.quien}… (Ctrl+Enter envía)`} aria-label=${`Nota para ${o.quien}`} value=${texto}
        onInput=${(e) => setTexto(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(); } }}></textarea>
      ${pesado ? html`<p class="error">Pasa de 4 KB.</p>` : null}
      <button type="submit" class="boton primario" disabled=${!texto.trim() || pesado || enviando}>${enviando ? 'Enviando…' : 'Enviar'}</button>
    </form>` : null}
  </section>`;
}
