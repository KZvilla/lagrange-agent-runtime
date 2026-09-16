/**
 * FEAT-052 — Páginas de la consola web. HTML y JS inline, sin dependencias,
 * con el mismo aspecto que Lagrange Watch.
 *
 * Reglas del cliente: todo dato se pinta con `textContent`. El único HTML que
 * se interpreta es el acotado de Telegram (lo que arma `sendSafeChunk`), y se
 * reconstruye nodo por nodo con una lista blanca, nunca con `innerHTML`. Los
 * scripts llevan el nonce de la CSP; nada de handlers inline.
 */

export const PAGINAS = Object.freeze({
  '/': 'charla',
  '/cast': 'cast',
  '/cola': 'cola',
  '/memoria': 'memoria',
  '/sesiones': 'sesiones'
});

const CSS = `
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#11131a;color:#d7dae0;font:13px/1.5 ui-monospace,"Cascadia Code",Consolas,monospace}
header{padding:12px 16px;border-bottom:1px solid #2a2f3a;display:flex;align-items:center;gap:16px;flex-wrap:wrap}h1{font-size:15px;margin:0}
nav{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}nav a{color:#9aa3b5;text-decoration:none;border:1px solid #3d4350;border-radius:999px;padding:2px 9px}nav a.activa{color:#58a6ff;border-color:#58a6ff}
main{padding:16px;max-width:1000px;margin:0 auto}.panel{border:1px solid #2a2f3a;border-radius:7px;background:#161922;padding:12px;margin-bottom:12px}
.meta{color:#9aa3b5}.error{color:#f85149}.ok{color:#3fb950}.vacio{color:#7d8596;font-style:italic}
button,select,textarea{font:inherit;background:#1a2030;color:#d7dae0;border:1px solid #3d4350;border-radius:4px;padding:4px 9px}
button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button.peligro{border-color:#8b3a3a;color:#f0a0a0}
textarea{width:100%;min-height:80px;resize:vertical;margin:8px 0}select{max-width:100%}
:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}
label{display:block;color:#9aa3b5;margin:8px 0 2px}.fila{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
pre{white-space:pre-wrap;word-break:break-word;background:#0d0f15;padding:10px;border-radius:5px;overflow:auto;margin:6px 0}
code{background:#0d0f15;padding:0 3px;border-radius:3px}
h3{font-size:11px;color:#7d8596;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px}h3:first-child{margin-top:0}
#feed{display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto}
.msg{border-left:2px solid #2a2f3a;padding:4px 0 4px 10px;white-space:pre-wrap;word-break:break-word}
.msg.estado{color:#9aa3b5;border-color:#3d4350}.msg .hora{font-size:11px;color:#7d8596;display:block}
.msg blockquote{border-left:2px solid #3d4350;margin:4px 0;padding-left:8px;color:#b9bfcb}
#escribiendo{min-height:1.5em}
.entrada{display:flex;gap:10px;align-items:baseline;border-left:2px solid #2a2f3a;padding:4px 0 4px 10px;margin-top:6px}.entrada .cuerpo{flex:1;white-space:pre-wrap;word-break:break-word}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #2a2f3a;vertical-align:top;word-break:break-word}th{color:#9aa3b5;font-weight:normal}
`;

// Utilidades compartidas por todas las páginas.
const JS_COMUN = `
const $=(s)=>document.querySelector(s);
function el(tag,props,...hijos){const e=document.createElement(tag);if(props)for(const[k,v]of Object.entries(props)){if(k==='class')e.className=v;else if(k==='text')e.textContent=v;else e.setAttribute(k,v)}for(const h of hijos)if(h!=null)e.append(h);return e}
async function api(ruta,cuerpo){const op=cuerpo===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(cuerpo)};const r=await fetch(ruta,{credentials:'same-origin',...op});let d;try{d=await r.json()}catch{d={ok:false,error:'HTTP '+r.status}}if(r.status===401)throw new Error('La sesión venció (¿se reinició el daemon?). Pedí un link nuevo.');if(!r.ok||d.ok===false)throw new Error(d.error||('HTTP '+r.status));return d}
function aviso(nodo,texto,clase){nodo.textContent=texto;nodo.className=clase||'meta'}
const PERMITIDAS=new Set(['B','STRONG','I','EM','U','INS','S','STRIKE','DEL','CODE','PRE','BLOCKQUOTE','BR','SPAN','TG-SPOILER']);
function copiarSeguro(origen,destino){for(const n of origen.childNodes){if(n.nodeType===3){destino.append(n.textContent);continue}if(n.nodeType!==1)continue;if(n.tagName==='A'){const href=n.getAttribute('href')||'';const a=el('a',{rel:'noopener noreferrer',target:'_blank'});if(/^https?:\\/\\//i.test(href))a.setAttribute('href',href);copiarSeguro(n,a);destino.append(a);continue}if(PERMITIDAS.has(n.tagName)){const tag=n.tagName==='TG-SPOILER'?'span':n.tagName.toLowerCase();const c=document.createElement(tag);copiarSeguro(n,c);destino.append(c)}else copiarSeguro(n,destino)}}
function pintarMensaje(nodo,evento){nodo.textContent='';if(evento.formato==='html'){const doc=new DOMParser().parseFromString('<body>'+evento.texto+'</body>','text/html');copiarSeguro(doc.body,nodo)}else nodo.textContent=evento.texto}
function conectarFeed(){const feed=$('#feed'),escribiendo=$('#escribiendo');if(!feed)return;const porId=new Map();let apagar=null;
const fuente=new EventSource('/api/eventos');
fuente.onmessage=(m)=>{let e;try{e=JSON.parse(m.data)}catch{return}
if(e.tipo==='accion'){escribiendo.textContent='escribiendo…';clearTimeout(apagar);apagar=setTimeout(()=>{escribiendo.textContent=''},6000);return}
if(e.tipo==='progreso'){const previo=porId.get(e.ref);if(previo){previo.cuerpo.textContent=e.texto;return}}
escribiendo.textContent='';
const cuerpo=el('div');const caja=el('div',{class:'msg'+(e.tipo==='progreso'?' estado':'')},el('span',{class:'hora',text:new Date(e.ts).toLocaleTimeString()}),cuerpo);
if(e.tipo==='mensaje'){pintarMensaje(cuerpo,e);porId.set(e.seq,{cuerpo});if(/^[⏳💬🎭]/u.test(e.texto)&&e.texto.length<120)caja.classList.add('estado')}else cuerpo.textContent=e.texto;
const alFondo=feed.scrollHeight-feed.scrollTop-feed.clientHeight<40;feed.append(caja);if(alFondo)feed.scrollTop=feed.scrollHeight};
fuente.onerror=()=>{escribiendo.textContent='conexión perdida, reintentando…'};
fuente.onopen=()=>{if(escribiendo.textContent.startsWith('conexión'))escribiendo.textContent=''}}
function atajoEnviar(area,boton){area.addEventListener('keydown',(ev)=>{if(ev.key==='Enter'&&(ev.ctrlKey||ev.metaKey)){ev.preventDefault();boton.click()}})}
`;

const FEED = '<div class="panel"><h3>conversación</h3><div id="feed" aria-live="polite"></div><div id="escribiendo" class="meta"></div></div>';

const CUERPOS = {
  charla: {
    titulo: 'Charla con las almas',
    html: `<div class="panel">
<div class="fila"><label for="alma" style="margin:0">alma</label><select id="alma"></select><button id="nuevo" type="button">hilo nuevo</button><span id="estado" class="meta" aria-live="polite"></span></div>
<textarea id="texto" placeholder="Escribile… (Ctrl+Enter para enviar)" maxlength="4096"></textarea>
<button id="enviar" type="button">enviar</button>
</div>${FEED}`,
    js: `
const sel=$('#alma'),estado=$('#estado'),texto=$('#texto'),enviar=$('#enviar'),nuevo=$('#nuevo');
api('/api/almas').then(r=>{if(!r.almas.length){aviso(estado,'No hay almas. Sembralas desde Claude Code (agy_alma).','error');enviar.disabled=nuevo.disabled=true;return}for(const a of r.almas)sel.append(el('option',{value:a.clave,text:a.voz}))}).catch(e=>aviso(estado,e.message,'error'));
const alma=()=>encodeURIComponent(sel.value);
enviar.addEventListener('click',async()=>{const t=texto.value.trim();if(!t||!sel.value)return;enviar.disabled=true;try{await api('/api/almas/'+alma()+'/mensaje',{texto:t});texto.value='';aviso(estado,'enviado')}catch(e){aviso(estado,e.message,'error')}finally{enviar.disabled=false;texto.focus()}});
nuevo.addEventListener('click',async()=>{if(!sel.value)return;try{await api('/api/almas/'+alma()+'/nuevo',{});aviso(estado,'el próximo mensaje arranca un hilo limpio','ok')}catch(e){aviso(estado,e.message,'error')}});
atajoEnviar(texto,enviar);conectarFeed();`
  },

  cast: {
    titulo: 'Cast de agentes',
    html: `<div class="panel">
<label for="agente">agente (solo los de lectura)</label><select id="agente"></select>
<div id="descripcion" class="meta"></div>
<label for="ws">proyecto</label><select id="ws"></select>
<p class="meta">Se le pide que lea solo esa carpeta, pero es una instrucción, no un permiso: puede leer cualquier ruta de tu usuario.</p>
<textarea id="pedido" placeholder="¿Qué le pedís? (Ctrl+Enter para enviar)" maxlength="4096"></textarea>
<div class="fila"><button id="enviar" type="button">castear</button><span id="estado" class="meta" aria-live="polite"></span></div>
</div>${FEED}`,
    js: `
const agente=$('#agente'),ws=$('#ws'),pedido=$('#pedido'),enviar=$('#enviar'),estado=$('#estado'),desc=$('#descripcion');
const descripciones=new Map();
Promise.all([api('/api/agentes'),api('/api/workspaces')]).then(([a,w])=>{
if(!a.agentes.length){aviso(estado,'No hay agentes de lectura registrados (cast_agent action:"register").','error');enviar.disabled=true}
for(const x of a.agentes){descripciones.set(x.nombre,x.descripcion||'');agente.append(el('option',{value:x.nombre,text:x.nombre}))}
desc.textContent=descripciones.get(agente.value)||'';
const orden=[...w.workspaces].sort((x,y)=>Number(y.favorito)-Number(x.favorito));
if(!orden.length){aviso(estado,'No hay proyectos conocidos en ~/.claude.json.','error');enviar.disabled=true}
for(const x of orden)ws.append(el('option',{value:x.id,text:(x.favorito?'⭐ ':'')+x.nombre}))
}).catch(e=>aviso(estado,e.message,'error'));
agente.addEventListener('change',()=>{desc.textContent=descripciones.get(agente.value)||''});
enviar.addEventListener('click',async()=>{const t=pedido.value.trim();if(!t||!agente.value||!ws.value)return;enviar.disabled=true;try{await api('/api/cast',{agente:agente.value,workspaceId:ws.value,pedido:t});pedido.value='';aviso(estado,'encolado')}catch(e){aviso(estado,e.message,'error')}finally{enviar.disabled=false}});
atajoEnviar(pedido,enviar);conectarFeed();`
  },

  cola: {
    titulo: 'Cola y logs',
    html: `<div class="panel"><div class="fila"><h3 style="margin:0">carriles</h3><span id="actualizado" class="meta"></span></div><div id="carriles"></div>
<div class="fila" style="margin-top:10px"><button class="peligro" data-carril="alma" type="button">cancelar charla</button><button class="peligro" data-carril="cast" type="button">cancelar cast</button><button class="peligro" data-carril="" type="button">cancelar ambos</button><span id="estado" class="meta" aria-live="polite"></span></div>
<p class="meta">El carril principal (/run, /plan de Telegram) se ve pero no se cancela desde acá.</p></div>
<div class="panel"><div class="fila"><h3 style="margin:0">daemon.log</h3><select id="n"><option>30</option><option>100</option><option>300</option></select><button id="leer" type="button">leer</button></div><div id="logs"></div></div>`,
    js: `
const carriles=$('#carriles'),estado=$('#estado'),logs=$('#logs');
const nombres={principal:'principal',cast:'casts',alma:'charla'};
const que=(t)=>t.kind==='cast'?'agente '+t.agent:t.kind==='alma'?'charla con '+t.voz:'modo '+t.mode;
async function refrescar(){try{const r=await api('/api/cola');carriles.textContent='';for(const c of r.carriles){const caja=el('div',{class:'panel'},el('strong',{text:nombres[c.carril]||c.carril}));if(!c.enCurso&&!c.pendientes.length)caja.append(el('div',{class:'vacio',text:'libre'}));if(c.enCurso)caja.append(el('div',{text:'▶ '+que(c.enCurso)+' · desde '+new Date(c.enCurso.desde).toLocaleTimeString()}),el('div',{class:'meta',text:c.enCurso.extracto}));c.pendientes.forEach((t,i)=>caja.append(el('div',{text:(i+1)+'. '+que(t)+' — '+t.extracto})));carriles.append(caja)}$('#actualizado').textContent='actualizado '+new Date().toLocaleTimeString()}catch(e){aviso(estado,e.message,'error')}}
for(const b of document.querySelectorAll('button[data-carril]')){let armado=false,t=null;const original=b.textContent;b.addEventListener('click',async()=>{if(!armado){armado=true;b.textContent='¿seguro?';t=setTimeout(()=>{armado=false;b.textContent=original},4000);return}clearTimeout(t);armado=false;b.textContent=original;try{const r=await api('/api/cancelar',b.dataset.carril?{carril:b.dataset.carril}:{});aviso(estado,r.abortados.length||r.descartadas?('cancelado: '+[r.abortados.join(', '),r.descartadas?r.descartadas+' en cola':''].filter(Boolean).join(' · ')):'no había nada que cancelar','ok');refrescar()}catch(e){aviso(estado,e.message,'error')}})}
$('#leer').addEventListener('click',async()=>{logs.textContent='';try{const r=await api('/api/logs?n='+encodeURIComponent($('#n').value));if(r.aviso)logs.append(el('p',{class:'meta',text:r.aviso}));if(r.contenido!=null)logs.append(el('pre',{text:r.contenido}))}catch(e){logs.append(el('p',{class:'error',text:e.message}))}});
refrescar();setInterval(()=>{if(!document.hidden)refrescar()},3000);`
  },

  memoria: {
    titulo: 'Memoria de las almas',
    html: `<div class="panel"><div class="fila"><label for="alma" style="margin:0">alma</label><select id="alma"></select><span id="estado" class="meta" aria-live="polite"></span></div><div id="datos"></div></div>`,
    js: `
const sel=$('#alma'),estado=$('#estado'),datos=$('#datos');
function seccion(titulo,bloque,clave){const caja=el('div');caja.append(el('h3',{text:titulo+' ('+bloque.usado+'/'+bloque.tope+' car.)'}));if(!bloque.entradas.length)caja.append(el('p',{class:'vacio',text:'vacía'}));for(const e of bloque.entradas){const boton=el('button',{type:'button',class:'peligro',text:'olvidar'});if(!e.id)boton.disabled=true;let armado=false;boton.addEventListener('click',async()=>{if(!armado){armado=true;boton.textContent='¿seguro?';setTimeout(()=>{armado=false;boton.textContent='olvidar'},4000);return}boton.disabled=true;try{const r=await api('/api/almas/'+encodeURIComponent(clave)+'/olvidar',{id:e.id});aviso(estado,'olvidado: '+r.olvidado,'ok');cargar()}catch(err){aviso(estado,err.message,'error');boton.disabled=false}});caja.append(el('div',{class:'entrada'},el('code',{text:e.id||'—'}),el('span',{class:'cuerpo',text:e.texto}),boton))}return caja}
async function cargar(){if(!sel.value)return;try{const r=await api('/api/almas/'+encodeURIComponent(sel.value)+'/memoria');datos.textContent='';datos.append(seccion('su memoria',r.memoria,r.clave),seccion('lo que sabe de vos (compartido entre almas)',r.usuario,r.clave))}catch(e){aviso(estado,e.message,'error')}}
api('/api/almas').then(r=>{if(!r.almas.length){aviso(estado,'No hay almas.','error');return}for(const a of r.almas)sel.append(el('option',{value:a.clave,text:a.voz}));cargar()}).catch(e=>aviso(estado,e.message,'error'));
sel.addEventListener('change',()=>{aviso(estado,'');cargar()});`
  },

  sesiones: {
    titulo: 'Sesiones',
    html: `<div class="panel"><p class="meta">Solo metadatos: qué hilos existen. Las transcripciones no se muestran.</p><div id="estado" class="meta" aria-live="polite"></div><div id="datos"></div></div>`,
    js: `
const datos=$('#datos'),estado=$('#estado');
const fecha=(v)=>v?new Date(v).toLocaleString():'—';
function tabla(titulo,columnas,filas){const caja=el('div');caja.append(el('h3',{text:titulo}));if(!filas.length){caja.append(el('p',{class:'vacio',text:'nada'}));return caja}const t=el('table');const cab=el('tr');for(const[c]of columnas)cab.append(el('th',{text:c}));t.append(cab);for(const f of filas){const tr=el('tr');for(const[,fn]of columnas)tr.append(el('td',{text:String(fn(f)??'—')}));t.append(tr)}caja.append(t);return caja}
api('/api/sesiones').then(r=>{
datos.append(
tabla('sesiones de trabajo por chat',[['canal',f=>f.canal],['conversación',f=>f.conversationId],['actualizada',f=>fecha(f.actualizado)]],r.chats),
tabla('hilos de almas',[['alma',f=>f.clave],['conversación',f=>f.conversationId],['último turno',f=>fecha(f.ultimoTurno)],['turnos',f=>f.turnos]],r.almas),
tabla('hilos de agentes',[['agente',f=>f.nombre],['conversación',f=>f.conversationId],['último cast',f=>fecha(f.ultimoCast)],['proyecto',f=>f.proyecto],['casts',f=>f.casts]],r.agentes),
tabla('Claude Code remoto',[['sesión',f=>f.sessionName],['proyecto',f=>f.proyecto]],r.claude?[r.claude]:[]))
}).catch(e=>aviso(estado,e.message,'error'));`
  }
};

function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function paginaWeb(ruta, nonce) {
  const nombre = PAGINAS[ruta];
  const pagina = CUERPOS[nombre];
  if (!pagina) throw new Error(`Página desconocida: ${ruta}`);
  const nav = Object.entries(PAGINAS)
    .map(([r, n]) => `<a${r === ruta ? ' class="activa" aria-current="page"' : ''} href="${r}">${n}</a>`)
    .join('');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lagrange · ${escapar(nombre)}</title><style>${CSS}</style></head>
<body><header><h1>${escapar(pagina.titulo)}</h1><nav>${nav}</nav></header><main>${pagina.html}</main>
<script nonce="${escapar(nonce)}">${JS_COMUN}${pagina.js}</script></body></html>`;
}
