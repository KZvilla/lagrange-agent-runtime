/*
 * FEAT-136 F4 — Lo que rodea a la charla en el centro: la cabecera del sujeto
 * (voz, foco y el botón Panel) y la bienvenida cuando no hay sujeto, con el
 * aviso de un proveedor para actualizar (FEAT-069).
 */
import { html } from './html.js';
import { tono, ICONOS } from './nucleo.js';
import { Avatar, Icono } from './comp-base.js';
import { ControlesVoz } from './voz.js';
import { ruta, daemon, foco, cajon } from './estado.js';
import { proveedores } from './vista-proveedores.js';

/** Los proveedores con una versión nueva disponible. */
export const conActualizacion = () => (Array.isArray(proveedores.value) ? proveedores.value.filter((p) => p.estado === 'disponible') : []);

export function AvisoActualizacion() {
  const p = conActualizacion()[0];
  if (!p) return null;
  return html`<p class="aviso-actualizacion" role="status">
    <span class="punto-aviso" aria-hidden="true"></span>${`${p.nombre} `}<span class="mono">${`${p.instalada} → ${p.ultima}`}</span>${' disponible · '}<a href="/proveedores" data-ruta>ver</a>
  </p>`;
}

/** El punto del segmento Proveedores (va dentro del enlace de la barra). */
export function PuntoProveedores() {
  const hay = conActualizacion().length > 0;
  return html`<span class="punto-aviso" id="aviso-proveedores" aria-hidden="true" hidden=${!hay}></span>`;
}

export function Bienvenida() {
  const noEsta = ruta.value.vista === 'charla' && daemon.value !== null;
  return html`<div class="bienvenida">
    <h2>${noEsta ? 'No encontré ese sujeto' : 'Elegí con quién hablar'}</h2>
    <p>${noEsta
      ? 'Puede que el alma o el agente ya no exista, o que el agente no sea de solo lectura.'
      : 'Las almas responden en personaje y recuerdan lo tuyo. Los agentes leen un proyecto y te devuelven su revisión. Nada de esto usa el modelo principal.'}</p>
    <${AvisoActualizacion} />
  </div>`;
}

// FEAT-076 — "Hilo nuevo" se mudó al bloque Hilo del panel. FEAT-082 — El botón Panel solo se ve cuando
// el panel no tiene columna (CSS).
export function CabeceraCharla({ s, alFoco, alPanel }) {
  const esAlma = s.tipo === 'alma';
  const enFoco = foco.value;
  return html`<div class=${`cabecera ${esAlma ? tono(s.clave) : ''}`}>
    <${Avatar} s=${s} tam="grande" />
    <div>
      <div class=${`cabecera-titulo${esAlma ? '' : ' mono'}`}>${esAlma ? s.voz : s.nombre}</div>
      <div class="cabecera-sub" id="cabecera-sub">${esAlma ? 'alma · responde en personaje' : 'agente de solo lectura'}</div>
    </div>
    <div class="cabecera-acciones">
      <${ControlesVoz} s=${s} />
      <button type="button" class="boton fantasma boton-foco" title="Modo foco (F)" onClick=${() => alFoco()}>
        <${Icono} d=${ICONOS.foco} />${enFoco ? 'Salir de foco' : 'Foco'}<span class="tecla">${enFoco ? 'Esc' : 'F'}</span>
      </button>
      <button type="button" class="boton fantasma boton-panel" title="Panel (P)" aria-label="Abrir panel (P)" aria-controls="panel"
        aria-expanded=${String(cajon.value?.tipo === 'panel')} onClick=${() => alPanel()}>
        <${Icono} d=${ICONOS.panel} /><span class="texto-boton">Panel</span><span class="tecla">P</span>
      </button>
    </div>
  </div>`;
}
