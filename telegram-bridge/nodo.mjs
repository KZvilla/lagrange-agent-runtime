#!/usr/bin/env node
/**
 * FEAT-089 §4.1 — `npm run bridge:nodo -- <subcomando>`.
 *
 *   En el servidor:  invitar [nombre] · listar · revocar <nombre|id> · almas <nodo> lectura|escritura
 *   En el nodo:      unirse <url> <código> [--nombre N] · estado · salir · migrar-almas [--simular]
 *
 * Escriben archivos del directorio de datos. El daemon del servidor los relee
 * solo; el del nodo, al reiniciarse (el comando lo dice).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBridgeEnv, bridgeDataDirPath, leerRol, esWsl } from './paths.js';
import { leerAccesoWeb } from './web/acceso.js';
import * as admin from './red/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadBridgeEnv(__dirname);
const dataDir = bridgeDataDirPath();
const [sub, ...resto] = process.argv.slice(2);
const { rol } = leerRol(process.env);

function avisarRol(esperado) {
  if (rol !== esperado) console.warn(`[!] Este .env dice BRIDGE_ROL=${rol || '?'}; este comando es para rol ${esperado}.`);
}

function opcion(nombre) {
  const i = resto.indexOf(nombre);
  if (i === -1) return null;
  const v = resto[i + 1];
  resto.splice(i, 2);
  return v ?? '';
}

async function nodosEnVivo() {
  const acceso = leerAccesoWeb();
  if (!acceso?.vivo || !acceso.url || !acceso.login) return null;
  try {
    const token = new URL(acceso.login).searchParams.get('t');
    const r = await fetch(new URL('/api/nodos', acceso.url), { headers: { 'x-lagrange-token': token } });
    const j = await r.json();
    return Array.isArray(j.nodos) ? j.nodos : null;
  } catch {
    return null;
  }
}

async function main() {
  switch (sub) {
    case 'invitar': {
      avisarRol('servidor');
      const { codigo, vence } = admin.invitar(dataDir, resto[0] || null);
      const acceso = leerAccesoWeb();
      const url = acceso?.url || 'http://127.0.0.1:<puerto de la consola>';
      console.log(`Código de invitación: ${codigo}`);
      console.log(`Vence: ${new Date(vence).toLocaleString()} (un solo uso, 5 intentos).`);
      console.log('\nPor defecto el nodo solo lee las almas: npm run bridge:nodo -- almas <nombre> escritura para que pueda escribirlas.');
      console.log('\nEn el nodo:');
      console.log(`  npm run bridge:nodo -- unirse ${url} ${codigo}${resto[0] ? '' : ' [--nombre <nombre>]'}`);
      // SEC-022 §5.5 — Con la segunda dirección puesta, la regla de firewall (no se ejecuta).
      const escuchar = String(process.env.BRIDGE_NODOS_ESCUCHAR || '').trim();
      if (escuchar) {
        console.log(`\nDesde otra máquina: npm run bridge:nodo -- unirse http://${escuchar} ${codigo}`);
        const ayuda = admin.ayudaFirewall(escuchar);
        if (ayuda) console.log(`\n${ayuda}`);
      }
      return 0;
    }
    case 'listar': {
      avisarRol('servidor');
      const lista = admin.listar(dataDir);
      if (!lista.length) { console.log('No hay nodos emparejados. `npm run bridge:nodo -- invitar` para sumar uno.'); return 0; }
      const vivos = await nodosEnVivo();
      for (const n of lista) {
        const v = vivos?.find((x) => x.id === n.id);
        const conexion = vivos ? (v?.conectado ? 'conectado' : 'desconectado') : 'daemon sin consola: conexión desconocida';
        console.log(`• ${n.nombre} (${n.id}) — ${conexion}; versión ${n.version || '?'}; almas: ${n.almas}; última conexión ${n.ultimaConexion || 'nunca'}`);
      }
      return 0;
    }
    case 'almas': {
      avisarRol('servidor');
      const [quien, nivel] = resto;
      if (!quien || !nivel) { console.error('Uso: npm run bridge:nodo -- almas <nodo> lectura|escritura'); return 1; }
      const n = admin.nivelDeAlmas(dataDir, quien, nivel);
      if (!n) { console.error(`No hay un nodo "${quien}".`); return 1; }
      console.log(`${n.nombre}: almas en ${nivel}.${nivel === 'escritura' ? ' Puede anotar el diario, consolidar, olvidar, sembrar e importar.' : ' Solo lee.'}`);
      return 0;
    }
    case 'migrar-almas': {
      avisarRol('nodo');
      const simular = resto.includes('--simular');
      const { enlaceDeNodo } = await import('./notify.js');
      const enlace = enlaceDeNodo();
      if (!enlace) { console.error('El daemon de este nodo no está corriendo (o no está en rol nodo).'); return 1; }
      const r = await fetch(new URL('/almas/migrar', enlace.url), { method: 'POST', headers: { 'x-lagrange-token': enlace.token, 'content-type': 'application/json' }, body: JSON.stringify({ simular }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { console.error(`[X] ${j.error || `el daemon respondió ${r.status}`}`); return 1; }
      const inf = j.informe;
      console.log(simular ? 'Simulación (no se escribió nada):' : 'Migración:');
      for (const a of inf.almas) console.log(`• ${a.clave}: ${a.accion}, ${a.sumadas} entrada(s)${a.rechazadas ? `, ${a.rechazadas} rechazada(s)` : ''}${a.identidadEnConflicto ? ` — identidad distinta: la de este nodo queda en alma.md.nodo-<nombre> en el servidor` : ''}`);
      if (inf.usuario) console.log(`• usuario.md: ${inf.usuario.sumadas} entrada(s) sumada(s)`);
      for (const t of inf.tarjetas) console.log(`• tarjeta ${t.id} "${t.titulo}"${t.enServidor ? ` → ${t.enServidor} en el servidor` : ' (se movería)'}`);
      for (const p of inf.programaciones) console.log(`• programación ${p.id} "${p.titulo}"${p.enServidor ? ` → ${p.enServidor} en el servidor` : ' (se movería)'}`);
      for (const e of inf.errores) console.log(`⚠️ ${e}`);
      if (!simular) console.log('\nEl directorio local de almas no se borra: queda de respaldo, y en rol nodo nadie lo lee.');
      return inf.errores.length ? 1 : 0;
    }
    case 'revocar': {
      avisarRol('servidor');
      if (!resto[0]) { console.error('Uso: npm run bridge:nodo -- revocar <nombre|id>'); return 1; }
      const quitado = admin.revocar(dataDir, resto[0]);
      if (!quitado) { console.error(`No hay un nodo "${resto[0]}".`); return 1; }
      console.log(`Revocado ${quitado.nombre} (${quitado.id}). Si estaba conectado, el daemon corta su flujo en menos de 30 s.`);
      return 0;
    }
    case 'unirse': {
      avisarRol('nodo');
      const nombre = opcion('--nombre');
      const interfazCifrada = opcion('--interfaz-cifrada');
      const [url, codigo] = resto;
      if (!url || !codigo) { console.error('Uso: npm run bridge:nodo -- unirse <url> <código> [--nombre N] [--interfaz-cifrada <interfaz>]'); return 1; }
      const r = await admin.unirse(dataDir, url, codigo, { nombre: nombre || process.env.BRIDGE_NOMBRE_NODO || null, wsl: esWsl(), interfazCifrada: interfazCifrada || '' });
      console.log(`Emparejado como "${r.nombre}" con ${r.servidor}.`);
      console.log('Reiniciá el daemon de este nodo para que se conecte: npm run bridge:daemon:update');
      return 0;
    }
    case 'estado': {
      const e = admin.estado(dataDir);
      if (!e.emparejado) { console.log('Este nodo no está emparejado. `npm run bridge:nodo -- unirse <url> <código>`.'); return 0; }
      console.log(`Nodo "${e.nombre}" (${e.id}), servidor ${e.servidor}.`);
      if (!e.daemonVivo) console.log('El daemon del nodo no está corriendo (o no arrancó en rol nodo).');
      else if (e.conectado) console.log('Conectado.');
      else if (e.estado === 'desconocido-para-el-servidor') console.log('El servidor no reconoce este nodo; si lo revocaste, corré `npm run bridge:nodo -- salir`.');
      else console.log(`Desconectado (${e.estado || 'sin datos'}).`);
      return 0;
    }
    case 'salir': {
      console.log(admin.salir(dataDir)
        ? 'Se borró nodo.json. El servidor lo sigue listando hasta un `revocar` allá. Reiniciá el daemon.'
        : 'Este nodo no estaba emparejado.');
      return 0;
    }
    default:
      console.log('Uso: npm run bridge:nodo -- <invitar [nombre] | listar | revocar <nombre|id> | almas <nodo> lectura|escritura | unirse <url> <código> [--nombre N] | estado | salir | migrar-almas [--simular]>');
      return sub ? 1 : 0;
  }
}

main().then((c) => process.exit(c)).catch((err) => {
  console.error(`[X] ${err.message}`);
  process.exit(1);
});
