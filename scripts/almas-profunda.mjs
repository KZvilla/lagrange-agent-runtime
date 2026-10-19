#!/usr/bin/env node
/**
 * Memoria profunda de las almas (FEAT-046), desde la terminal.
 *
 *   npm run almas-profunda -- volcar <alma> [--confirmar]  trae al archivo lo que solo vive en el servicio
 *   npm run almas-profunda -- buscar <alma> <consulta…>    diagnóstico: qué devuelve el servicio
 *   npm run almas-profunda -- importar <alma>              OBSOLETO: sube los archivos al servicio
 *
 * FEAT-171 — La memoria profunda es legado: las almas buscan en su `archivo.md`
 * y ya no guardan copias nuevas en el servicio. `volcar` es el comando de
 * transición: lista lo archivado y lo rechazado por tope (del alma y de lo
 * compartido) y lo fusiona en el archivo, conservando ids y fechas, sin
 * duplicar y salteando lo que ya está en la memoria caliente. Sin `--confirmar`
 * solo muestra qué haría. Es idempotente.
 *
 * `importar` queda por compatibilidad con FEAT-046: sube las entradas actuales
 * y lo que el diario registra como `memoria:archivar` y nadie olvidó después
 * (`profunda.planificarImportacion`). Ya no hace falta.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const rutas = require('../mcp-server/almas/rutas.js');
const recuerdos = require('../mcp-server/almas/recuerdos.js');
const profunda = require('../mcp-server/almas/profunda.js');
const archivo = require('../mcp-server/almas/archivo.js');
const historia = require('../mcp-server/lib/historia.js');
const { leerTexto } = require('../mcp-server/almas/archivos.js');

function salir(mensaje, codigo = 1) {
  console.error(mensaje);
  process.exit(codigo);
}

function claveDe(nombre) {
  const clave = rutas.claveDeVoz(nombre || '');
  if (!clave) salir('Falta el alma: `volcar <alma>`, `buscar <alma> <consulta>` o `importar <alma>`.');
  return clave;
}

function lineasJson(texto) {
  const salida = [];
  for (const linea of String(texto || '').split(/\r?\n/)) {
    if (!linea.trim()) continue;
    try { salida.push(JSON.parse(linea)); } catch {}
  }
  return salida;
}

/** Entradas del diario vivo y de sus meses archivados, en orden cronológico. */
function diarioCompleto(clave) {
  const ruta = rutas.rutasDe(clave).diario;
  const dir = path.dirname(ruta);
  const viejas = historia.mesesArchivados(dir).flatMap((mes) => historia.leerMes(dir, mes));
  // `sort` es estable: entradas con el mismo `ts` conservan el orden de escritura.
  return [...viejas, ...lineasJson(leerTexto(ruta))]
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
}

async function volcar(clave, confirmar) {
  if (!profunda.activa()) salir('La memoria profunda está apagada: no hay servicio configurado o LAGRANGE_ALMAS_PROFUNDA=0.');
  const r = await profunda.listarArchivables(clave, { timeoutMs: 15000 });
  if (!r.ok) salir(`No se pudo listar la memoria profunda: ${r.motivo}`);

  // Lo que ya está en la memoria caliente no se archiva: sigue a la vista.
  const calientes = new Set([
    ...recuerdos.entradas(recuerdos.leer(rutas.rutasDe(clave).memoria, 'm')),
    ...recuerdos.entradas(recuerdos.leer(rutas.rutaUsuario(), 'u'))
  ].flatMap((e) => [String(e.id || '').toLowerCase(), e.texto.trim().toLowerCase()]));
  const pendientes = r.entradas.filter((e) => !calientes.has(e.id) && !calientes.has(e.texto.toLowerCase()));
  const salteadas = r.entradas.length - pendientes.length;

  for (const compartido of [false, true]) {
    const grupo = pendientes.filter((e) => e.compartido === compartido);
    const destino = compartido ? 'archivo-usuario.md' : `${clave}/archivo.md`;
    if (!grupo.length) { console.log(`${destino}: nada para traer.`); continue; }
    const res = archivo.fusionar(clave, grupo, { compartido, simular: !confirmar });
    if (!res.ok) { console.log(`${destino}: no se sumó nada (${res.motivo}).`); continue; }
    console.log(`${destino}: ${res.escritas.length} ${confirmar ? 'sumadas' : 'se sumarían'}, ${res.duplicadas.length} ya estaban, ${res.rechazadas.length} rechazadas.`);
    for (const e of grupo.filter((x) => res.escritas.includes(x.id))) console.log(`  + [${e.id}] [${e.fecha || '—'}] ${e.texto}`);
    for (const x of res.rechazadas) console.log(`  ✗ ${x.id}: ${x.motivo}`);
  }
  if (salteadas) console.log(`${salteadas} salteada(s): ya están en la memoria caliente.`);
  if (!confirmar) console.log('Nada se escribió. Para aplicar: `volcar <alma> --confirmar`.');
}

async function importar(clave) {
  console.error('`importar` está obsoleto (FEAT-171): las almas ya no buscan en la memoria profunda. Para pasar lo viejo al archivo, usá `volcar`.');
  if (!profunda.activa()) salir('La memoria profunda está apagada: no hay servicio configurado o LAGRANGE_ALMAS_PROFUNDA=0.');

  const tareas = profunda.planificarImportacion({
    memoria: recuerdos.entradas(recuerdos.leer(rutas.rutasDe(clave).memoria, 'm')),
    usuario: recuerdos.entradas(recuerdos.leer(rutas.rutaUsuario(), 'u')),
    diario: diarioCompleto(clave)
  });

  let nuevas = 0;
  let yaEstaban = 0;
  const fallos = [];
  for (const t of tareas) {
    const r = await profunda.guardar(clave, t);
    if (!r.ok) fallos.push(`${t.id}: ${r.motivo}`);
    else if (r.duplicado) yaEstaban++;
    else nuevas++;
  }
  console.log(`${clave}: ${nuevas} nuevas, ${yaEstaban} ya estaban, ${fallos.length} fallidas (de ${tareas.length}).`);
  for (const f of fallos) console.log(`  no se subió ${f}`);
}

async function buscar(clave, consulta) {
  if (!consulta) salir('Falta la consulta: `buscar <alma> <consulta…>`.');
  if (!profunda.activa()) salir('La memoria profunda está apagada.');
  const encontrados = await profunda.buscar(clave, consulta, { timeoutMs: 15000 });
  if (!encontrados.length) return console.log('(nada: consulta de menos de 3 palabras, o nada guardado)');
  for (const r of encontrados) console.log(`- [${r.id || 'sin id'}] ${r.texto}`);
}

const [accion, alma, ...resto] = process.argv.slice(2);
if (accion === 'volcar') await volcar(claveDe(alma), resto.includes('--confirmar'));
else if (accion === 'importar') await importar(claveDe(alma));
else if (accion === 'buscar') await buscar(claveDe(alma), resto.join(' '));
else salir('Uso: volcar <alma> [--confirmar] | buscar <alma> <consulta…> | importar <alma> (obsoleto)');
