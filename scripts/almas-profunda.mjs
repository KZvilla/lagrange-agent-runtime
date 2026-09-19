#!/usr/bin/env node
/**
 * Memoria profunda de las almas (FEAT-046), desde la terminal.
 *
 *   npm run almas-profunda -- importar <alma>            sube lo que hoy está en los archivos
 *   npm run almas-profunda -- buscar <alma> <consulta…>  lo que la charla recibiría al nacer un hilo
 *
 * `importar` es para las almas que ya tenían memoria antes de esta fase. Sube
 * las entradas actuales de `memoria.md` y `usuario.md`, y lo que el diario (y su
 * historia de BE-028) registra como `memoria:archivar` y nadie olvidó después
 * (`profunda.planificarImportacion`). NO resucita los `olvidar` viejos: antes de
 * esta fase no se distinguía un olvido pedido por el usuario de uno para hacer
 * lugar, y ante la duda gana el olvido. Es idempotente: el servicio rechaza un
 * contenido idéntico ya guardado.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const rutas = require('../mcp-server/almas/rutas.js');
const recuerdos = require('../mcp-server/almas/recuerdos.js');
const profunda = require('../mcp-server/almas/profunda.js');
const historia = require('../mcp-server/lib/historia.js');
const { leerTexto } = require('../mcp-server/almas/archivos.js');

function salir(mensaje, codigo = 1) {
  console.error(mensaje);
  process.exit(codigo);
}

function claveDe(nombre) {
  const clave = rutas.claveDeVoz(nombre || '');
  if (!clave) salir('Falta el alma: `importar <alma>` o `buscar <alma> <consulta>`.');
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

async function importar(clave) {
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
if (accion === 'importar') await importar(claveDe(alma));
else if (accion === 'buscar') await buscar(claveDe(alma), resto.join(' '));
else salir('Uso: importar <alma> | buscar <alma> <consulta…>');
