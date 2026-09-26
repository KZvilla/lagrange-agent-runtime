/**
 * FEAT-091 — Los bots de Telegram de una instalación.
 *
 * `TELEGRAM_BOT_TOKEN` es el bot general (vínculo `servidor`) y el principal de
 * BE-051. Los demás se declaran por nombre en el mismo `.env`:
 *
 *   TELEGRAM_BOTS=alya,wsl
 *   TELEGRAM_BOT_ALYA_TOKEN=333:CCC
 *   TELEGRAM_BOT_ALYA_VINCULO=alma:alya
 *   TELEGRAM_BOT_ALYA_USUARIOS=12345      (opcional; por defecto ALLOWED_USER_IDS)
 *
 * Cada bot extra se vincula a UNA cosa: un `alma` o un `nodo`. `agente` está
 * reservado. Sin red: lo usan `bot.js`, `notify.js` (proceso corto) y el MCP.
 * El secreto de un token no aparece nunca en `errores`: solo nombres y el ID.
 */

import { botIdDeToken } from './state.js';

const FORMA_NOMBRE = /^[a-z0-9][a-z0-9-]{0,19}$/;
// La clave de un alma y el nombre de un nodo: sin `:` ni espacios.
const FORMA_VINCULO = /^(servidor|alma|nodo|agente):([a-z0-9][a-z0-9_-]{0,63})$/;

function listaDeIds(crudo) {
  return String(crudo ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Prefijo de las variables de un bot: `casa-wsl` → `TELEGRAM_BOT_CASA_WSL_`. */
export function prefijoDeBot(nombre) {
  return `TELEGRAM_BOT_${nombre.toUpperCase().replace(/-/g, '_')}_`;
}

/**
 * Lee los bots del entorno. Un error en un bot extra lo deja afuera y sigue
 * con los demás: un tipeo en el bot de un alma no puede dejar sin Telegram a
 * toda la instalación. El general falta solo si falta `TELEGRAM_BOT_TOKEN`, y
 * eso lo trata quien arranca (en `solo` es fatal, como siempre).
 *
 * @returns {{ bots: Array<{ nombre: string, botId: string, token: string, vinculo: { tipo: string, ref: string|null }, usuarios: Set<string>, general: boolean }>, errores: string[] }}
 */
export function leerBots(env = process.env, { rol = 'solo' } = {}) {
  const errores = [];
  const bots = [];
  const extras = listaDeIds(env.TELEGRAM_BOTS);

  // BE-053 — Un nodo no lee tokens: sus bots los corre el servidor.
  if (rol === 'nodo') {
    if (extras.length) errores.push('TELEGRAM_BOTS se ignora en rol nodo: los bots los corre el servidor.');
    return { bots, errores };
  }

  const permitidos = new Set(listaDeIds(env.ALLOWED_USER_IDS));
  const idGeneral = botIdDeToken(env.TELEGRAM_BOT_TOKEN);
  if (idGeneral) {
    bots.push({
      nombre: 'general',
      botId: idGeneral,
      token: String(env.TELEGRAM_BOT_TOKEN).trim(),
      vinculo: { tipo: 'servidor', ref: null },
      usuarios: permitidos,
      general: true
    });
  } else {
    errores.push('TELEGRAM_BOT_TOKEN falta o no tiene la forma <id>:<secreto>.');
  }

  const nombresVistos = new Set();
  for (const nombre of extras) {
    const descartar = (motivo) => errores.push(`Bot ${nombre} descartado: ${motivo}.`);
    if (!FORMA_NOMBRE.test(nombre)) { descartar('nombre inválido (a-z, 0-9 y guiones, hasta 20)'); continue; }
    if (nombresVistos.has(nombre)) { descartar('nombre repetido en TELEGRAM_BOTS'); continue; }
    nombresVistos.add(nombre);

    const prefijo = prefijoDeBot(nombre);
    const token = String(env[`${prefijo}TOKEN`] ?? '').trim();
    const botId = botIdDeToken(token);
    if (!botId) { descartar(`${prefijo}TOKEN falta o no tiene la forma <id>:<secreto>`); continue; }

    const m = FORMA_VINCULO.exec(String(env[`${prefijo}VINCULO`] ?? '').trim());
    if (!m) { descartar(`${prefijo}VINCULO tiene que ser alma:<clave> o nodo:<nombre>`); continue; }
    const vinculo = { tipo: m[1], ref: m[2] };
    if (vinculo.tipo === 'servidor') { descartar('el vínculo servidor es solo del bot general (TELEGRAM_BOT_TOKEN)'); continue; }
    if (vinculo.tipo === 'agente') { descartar('vínculo agente reservado, sin implementar'); continue; }
    if (vinculo.tipo === 'nodo' && rol !== 'servidor') { descartar('los vínculos de nodo necesitan rol servidor'); continue; }

    const repetido = bots.find((b) => b.botId === botId);
    if (repetido) { descartar(`usa el mismo bot (${botId}) que ${repetido.nombre}: dos getUpdates con un token dan 409`); continue; }
    const mismoVinculo = bots.find((b) => b.vinculo.tipo === vinculo.tipo && b.vinculo.ref === vinculo.ref);
    if (mismoVinculo) { descartar(`el vínculo ${vinculo.tipo}:${vinculo.ref} ya es de ${mismoVinculo.nombre}`); continue; }

    const crudos = env[`${prefijo}USUARIOS`];
    let usuarios = permitidos;
    if (crudos !== undefined && String(crudos).trim() !== '') {
      const lista = listaDeIds(crudos);
      const ajenos = lista.filter((id) => !permitidos.has(id));
      if (ajenos.length) { descartar(`${prefijo}USUARIOS tiene IDs fuera de ALLOWED_USER_IDS (${ajenos.join(', ')})`); continue; }
      usuarios = new Set(lista);
    }

    bots.push({ nombre, botId, token, vinculo, usuarios, general: false });
  }

  return { bots, errores };
}

/**
 * Por qué bot sale algo que no responde a un pedido: con `alma`, el bot de esa
 * alma; si no hay, el del nodo (con `nodo`); si no, el general. Un bot marcado
 * `caido` se salta: el aviso no se pierde porque un bot extra no arrancó.
 */
export function botParaSalida(bots, { alma = null, nodo = null } = {}) {
  const vivos = bots.filter((b) => !b.caido);
  const de = (tipo, ref) => (ref ? vivos.find((b) => b.vinculo.tipo === tipo && b.vinculo.ref === ref) : null);
  return de('alma', alma) || de('nodo', nodo) || bots.find((b) => b.general) || null;
}

/**
 * El chat al que escribe un bot por su cuenta: `TELEGRAM_NOTIFY_CHAT_ID` si es
 * uno de sus usuarios; si no, el primero. Para el general es lo mismo que
 * `getDefaultChatId()` de `notify.js`.
 */
export function chatPorDefecto(bot, env = process.env) {
  if (!bot) return null;
  const fijado = String(env.TELEGRAM_NOTIFY_CHAT_ID ?? '').trim();
  if (fijado && bot.usuarios.has(fijado)) return fijado;
  const [primero] = bot.usuarios;
  return primero ?? null;
}

/** Descripción para el banner y el diagnóstico. Sin token. */
export function describirBot(b) {
  const vinculo = b.general ? 'general' : `${b.vinculo.tipo} ${b.vinculo.ref}`;
  const n = b.usuarios.size;
  return `${b.nombre} (${b.botId}): ${vinculo}, ${n} usuario${n === 1 ? '' : 's'}`;
}
