/*
 * FEAT-136 F1 — La vista Proveedores (FEAT-069/137) en componentes: informa y
 * nunca actualiza (la web no ejecuta nada en el host, D4 de FEAT-057).
 *
 * El estado es la señal `proveedores` (lista | { error } | null). `app.js` la
 * sigue escribiendo como `estado.proveedores` (accesor), así el punto de la
 * barra y la línea de Inicio no cambian; la vista se redibuja sola.
 */
import { signal } from '../vendor/signals-core.module.js';
import { useEffect } from '../vendor/hooks.module.js';
import { html } from './html.js';
import { Relativo, BotonCopiar, Externo, Cabecera } from './comp-base.js';
import { fechaCorta } from './fechas.js';

export const proveedores = signal(null);

const CHIP = { 'al-dia': ['al día', 'est-ok'], disponible: ['actualización disponible', 'est-aviso'], desconocido: ['sin datos', ''] };
const miles = (n) => Number(n || 0).toLocaleString('es');
const millones = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('es', { maximumFractionDigits: 1 })} M` : miles(n));
const TEXTO_SONDAR = 'Después de cada versión de Claude Code o de Lagrange: npm run lotes -- sondar-claude <cuenta>.';
const TEXTO_ALINEAR = 'Para alinearla: subí CLAUDE_CODE_VERSION en Dockerfile.claude, después npm run lotes -- imagenes-claude y sondar-claude <cuenta>.';

function Dato({ etiqueta, valor, clase }) {
  return html`<div class="proveedor-dato"><dt>${etiqueta}</dt><dd class=${clase || null}>${valor}</dd></div>`;
}

/** FEAT-074 — Lo que queda de cada grupo de cuota de agy. */
function SaldoAgy({ c }) {
  if (!c || !c.grupos) return html`<dd class="tenue">sin dato: agy_usage refresh_quota (o pegá /usage con quota_text)</dd>`;
  const nombres = { gemini: 'Gemini', claude_gpt: 'Claude/GPT' };
  const resto = (v) => (Number.isFinite(v) ? `${Math.round((1 - v) * 100)} %` : '—');
  const grupos = Object.entries(c.grupos).map(([g, v]) => `${nombres[g] || g} ${resto(v.ventana7d)} sem · ${resto(v.ventana5h)} 5 h`).join(' — ');
  return html`<dd class="mono">${grupos} restante${c.vistoEn ? html` · <${Relativo} iso=${c.vistoEn} />` : ''}</dd>`;
}

function Notas({ p }) {
  if (p.estado === 'al-dia') return html`<p class="tenue">Estás en la última versión publicada. Cuando salga una nueva vas a ver acá qué cambia, antes de decidir.</p>`;
  if (p.estado !== 'disponible') return null;
  if (!p.notas?.length) return html`<p class="tenue">No se pudieron traer las notas. <${Externo} href=${p.enlaceNotas}>Verlas en GitHub<//></p>`;
  return p.notas.map((n) => html`
    <div class="proveedor-notas" key=${n.version}>
      <div class="proveedor-notas-titulo">
        <h3>Qué trae la ${n.version}</h3>
        ${n.fecha ? html`<span class="tenue">${fechaCorta(n.fecha)} · ${n.cambios.length} cambios</span>` : null}
        <${Externo} href=${n.enlace}>en GitHub<//>
      </div>
      <ul>${n.cambios.map((c, i) => html`<li key=${i}>${c}</li>`)}</ul>
    </div>`);
}

function Actualizar({ p }) {
  return html`<div class="proveedor-bloque"><h3>Actualizar</h3>
    ${p.estado === 'disponible'
      ? html`<p>Cuando quieras, en tu terminal:</p>
        <div class="comando-copiable"><code class="mono">${p.comando}</code><${BotonCopiar} texto=${p.comando} /></div>
        <p class="tenue nota-chica">Lagrange no lo corre por vos. Si hay algo trabajando, conviene esperar a que termine. Al volver a esta vista aparece la versión nueva.</p>`
      : html`<p class="tenue">${p.estado === 'al-dia' ? 'Nada que actualizar.' : 'No se pudo comparar la versión instalada con la publicada.'}</p>`}
  </div>`;
}

function Uso({ u }) {
  if (!u) return html`<div class="proveedor-bloque"><h3>Uso desde Lagrange</h3><p class="tenue">Sin datos todavía.</p></div>`;
  const top = Object.entries(u.porHerramienta || {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${miles(v)}`).join(' · ');
  return html`<div class="proveedor-bloque">
    <h3>Uso desde Lagrange${u.desde ? html`<span class="tenue"> desde el ${fechaCorta(u.desde)}</span>` : null}</h3>
    <div class="proveedor-cifras">
      <div><span class="tenue">Llamadas</span><strong class="mono">${miles(u.llamadas)}</strong><span class="tenue">${miles(u.hoy?.llamadas)} hoy</span></div>
      <div><span class="tenue">Tokens</span><strong class="mono">${millones(u.tokens)}</strong><span class="tenue">${millones(u.hoy?.tokens)} hoy</span></div>
    </div>
    <dl class="proveedor-filas">
      <dt>Salud de cuota</dt><dd class=${u.cuota === 'HEALTHY' ? 'ok' : 'error'}>${u.cuota === 'HEALTHY' ? 'sin 429 recientes' : (u.cuota || '—')}</dd>
      <dt>Plan y saldo</dt><${SaldoAgy} c=${u.cuotaAntigravity} />
      ${top ? html`<dt>Más usadas</dt><dd class="mono">${top}</dd>` : null}
    </dl>
  </div>`;
}

function textoSonda(s) {
  if (!s.ok) return 'en rojo';
  if (!s.vigente) return 'vencidas: hay que volver a sondear';
  return html`verdes · <${Relativo} iso=${s.en} />`;
}

/** FEAT-137 — Claude Code: la imagen de lotes y las sondas, en lugar del uso. */
function LotesClaude({ p }) {
  const sondas = p.sondas || [];
  const imagen = p.imagen ? `${p.imagen.version}${p.imagen.atrasada ? ` · atrás de la instalada (${p.instalada})` : ''}` : 'sin dato';
  let nota = null;
  if (p.imagen?.atrasada) nota = TEXTO_ALINEAR;
  else if (sondas.some((s) => !s.vigente || !s.ok)) nota = TEXTO_SONDAR;
  return html`<div class="proveedor-bloque"><h3>Lotes confinados</h3>
    <dl class="proveedor-filas">
      <dt>Imagen</dt><dd class=${`mono${p.imagen?.atrasada ? ' error' : ''}`}>${imagen}</dd>
      ${sondas.map((s) => [html`<dt key=${`t-${s.cuenta}`}>Sondas ${s.cuenta}</dt>`, html`<dd key=${`d-${s.cuenta}`} class=${s.ok && s.vigente ? 'ok' : 'error'}>${textoSonda(s)}</dd>`])}
    </dl>
    ${sondas.length ? null : html`<p class="tenue">Ninguna cuenta sondeada para escribir en lotes con Claude.</p>`}
    ${nota ? html`<p class="tenue nota-chica">${nota}</p>` : null}
  </div>`;
}

export function TarjetaProveedor({ p }) {
  const [textoChip, claseChip] = CHIP[p.estado] || CHIP.desconocido;
  let consulta = '';
  if (p.verificado) consulta = html`última consulta <${Relativo} iso=${p.verificado} />${p.sinConexion ? ' · sin conexión ahora' : ''}`;
  else if (p.sinConexion) consulta = 'sin conexión: no se pudo saber la última versión';
  return html`<section class="proveedor" aria-label=${p.nombre}>
    <div class="proveedor-principal">
      <div class="proveedor-cabecera">
        <div>
          <div class="proveedor-nombre">${p.nombre}</div>
          <div class="mono tenue">${consulta}</div>
        </div>
        <span class=${`chip-estado ${claseChip}`}>${textoChip}</span>
      </div>
      <dl class="proveedor-datos">
        <${Dato} etiqueta="Instalada" valor=${p.instalada || 'no se pudo consultar'} clase="mono" />
        <${Dato} etiqueta="Última publicada" valor=${p.ultima || '—'} clase=${`mono${p.estado === 'disponible' ? ' destacado' : ''}`} />
        <${Dato} etiqueta="Auto-actualización" valor=${p.autoActualizacion === 'propia' ? 'la de Claude Code (Lagrange no la toca)' : 'apagada por Lagrange'} />
      </dl>
      ${p.enlaceRepo
        ? html`<p class="tenue nota-chica">Changelog completo: <${Externo} href=${p.enlaceRepo}>anthropics/claude-code en GitHub<//></p>`
        : html`<p class="tenue nota-chica">El agy que corrés a mano en tu terminal se sigue actualizando solo.</p>`}
      <${Notas} p=${p} />
    </div>
    <div class="proveedor-lateral">
      <${Actualizar} p=${p} />
      ${p.id === 'claude' ? html`<${LotesClaude} p=${p} />` : html`<${Uso} u=${p.uso} />`}
    </div>
  </section>`;
}

/** La página. `cargar` la provee `app.js` (también alimenta el punto de la barra). */
export function VistaProveedores({ cargar }) {
  useEffect(() => { cargar?.(); }, []);
  const lista = proveedores.value;
  let cuerpo;
  if (lista === null) cuerpo = html`<div class="vacio">consultando…</div>`;
  else if (!Array.isArray(lista)) cuerpo = html`<div class="error">${lista.error}</div>`;
  else cuerpo = lista.map((p) => html`<${TarjetaProveedor} key=${p.id} p=${p} />`);
  return html`<div class="pagina proveedores">
    <${Cabecera} titulo="Proveedores" meta="Los agentes con los que trabaja Lagrange: qué versión corre, si hay una nueva y cuánto se usó. Lagrange nunca actualiza: te avisa y vos decidís." />
    <div class="proveedores-lista" id="proveedores-lista" aria-live="polite">${cuerpo}</div>
  </div>`;
}
