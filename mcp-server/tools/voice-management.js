'use strict';

/**
 * BE-173 - Tercera rebanada: inventario y ciclo de vida de la voz.
 *
 * `narrate_voices` (perfiles y roles) y `voice_model` (estado, arranque,
 * activacion, pin y descarga) vivian en `index.js`. Se mueven juntos porque
 * comparten `vb`/`om`/`vr` y los helpers de diagnostico y formato, pero no
 * tienen relacion con la narracion (`narrate`, `say`) ni con el streaming
 * (`agy_voice_stream`).
 *
 * El cuerpo se movio 1:1. Las dependencias entran por parametro para inyectar
 * dobles en los tests; el `switch` de `handleToolCall` sigue siendo la tabla
 * de ruteo y delega aca.
 */

/**
 * `voice_model` action "status". Solo lee: nunca levanta Voicebox.
 */
async function describirEstadoVoicebox(voiceboxUrl, config, { vb, om }) {
  const h = await vb.salud(voiceboxUrl);
  const k = vb.leerKeeper();
  const pin = vb.leerPin();
  const vram = vb.vramNvidia();
  let out = '### 🎙️ Voicebox\n\n';
  if (!h.ok) {
    out += `- **Servidor**: apagado (${h.error})\n`;
    out += `- **Autoarranque**: ${config.voiceboxAutostart === false ? 'desactivado' : 'se levanta solo, sin GUI, al primer uso de voz'}\n`;
  } else {
    out += `- **Servidor**: \`${voiceboxUrl}\` · ${h.info.backend_variant || '?'}${h.info.gpu_type ? ` (${h.info.gpu_type})` : ''}\n`;
    let lanzadoPor = 'la GUI (sin keeper)';
    if (k && k.vivo) lanzadoPor = k.ownsServer ? `el plugin (keeper ${k.pid})` : `la GUI (keeper ${k.pid} en solo lectura)`;
    out += `- **Lanzado por**: ${lanzadoPor}\n`;
    let modelos = [];
    try { modelos = await vb.estadoModelos(voiceboxUrl); } catch {}
    const usos = vb.leerUsos();
    const ahora = Date.now();
    const cargados = modelos.filter(m => m.loaded).map(m => {
      let d = `\`${m.model_name}\``;
      if (m.size_mb) d += ` (${Math.round(m.size_mb)} MB)`;
      if (pin && pin.model === m.model_name) d += ' 📌';
      if (usos[m.model_name]) d += `, usado hace ${Math.round((ahora - usos[m.model_name]) / 60000)} min`;
      return d;
    });
    out += `- **Modelos cargados**: ${cargados.length ? cargados.join('; ') : 'ninguno'}\n`;
  }
  out += `- **Fijado**: ${pin ? `\`${pin.model}\`${pin.voice ? ` (voz ${pin.voice})` : ''} desde ${pin.since}` : 'nada'}\n`;
  out += `- **VRAM**: ${vram ? `${(vram.libreMb / 1024).toFixed(1)} GB libres de ${(vram.totalMb / 1024).toFixed(1)} GB` : 'sin nvidia-smi'}\n`;
  out += `- **Inactividad**: descarga a los ${config.voiceboxIdleUnloadMinutes} min y apaga a los ${config.voiceboxIdleShutdownMinutes || '∞'} min (solo si lo levantó el plugin)\n`;
  if (om.omniInstalado({ config })) {
    const urlO = om.urlOmni(config);
    const ho = await vb.salud(urlO, 2000);
    if (!ho.ok) {
      out += `- **OmniVoice**: apagado (se levanta solo al narrar en modo inmediato) · \`${urlO}\`\n`;
    } else {
      const eo = await vb.estadoOmniServidor(urlO);
      const cargado = eo.models.some(m => m.loaded);
      out += `- **OmniVoice**: \`${urlO}\` · ${ho.info.variant || '?'} · ${cargado ? 'modelo cargado' : 'sin modelo cargado'}${eo.generando ? ' · generando' : ''}\n`;
    }
  } else {
    out += '- **OmniVoice**: no instalado (`npm run omnivoice:install`)\n';
  }
  out += `- **Estado y logs**: \`${vb.dirEstado()}\`\n`;
  return out;
}

/** Salida común de `voice_model` activate/pin, para los dos proveedores. */
function formatearActivacion(r, action, deVoz) {
  let out = action === 'pin'
    ? `📌 \`${r.objetivo}\` fijado${deVoz}: queda cargado hasta \`release\` o \`unload\`.`
    : `✅ Modelo activo: \`${r.objetivo}\`${deVoz}.`;
  if (r.descargados.length) out += `\n- Descargados antes: ${r.descargados.map(n => `\`${n}\``).join(', ')}`;
  if (r.postergados.length) out += `\n- Siguen cargados (en uso hace <30 s, se descargan por inactividad): ${r.postergados.map(n => `\`${n}\``).join(', ')}`;
  if (r.guarda === 'ok') out += '\n- Guarda de VRAM: hay espacio.';
  else if (r.guarda === 'omitida') out += '\n- Guarda de VRAM: omitida (sin nvidia-smi o sin tamaño del modelo).';
  return out;
}

function resolveVoiceProfile(profiles, requestedVoice, requestedLang) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error('No voice profiles found in Voicebox.');
  }

  const voiceStr = (requestedVoice || '').trim().toLowerCase();
  let lang = (requestedLang || '').trim().toLowerCase();
  if (lang.startsWith('en')) lang = 'en';
  else if (lang.startsWith('es')) lang = 'es';
  else if (lang) lang = '';

  // 1. Exact or partial match by profile name first (inherits profile language dynamically)
  if (voiceStr) {
    const exact = profiles.find(p => p.name.toLowerCase() === voiceStr);
    if (exact) {
      const pLang = (exact.language || '').toLowerCase().slice(0, 2);
      const effectiveLang = lang || (['en', 'es'].includes(pLang) ? pLang : 'es');
      return { profile: exact, isFallback: false, reason: 'exact_name_match', language: effectiveLang };
    }
    const partial = profiles.find(p => p.name.toLowerCase().includes(voiceStr));
    if (partial) {
      const pLang = (partial.language || '').toLowerCase().slice(0, 2);
      const effectiveLang = lang || (['en', 'es'].includes(pLang) ? pLang : 'es');
      return { profile: partial, isFallback: false, reason: 'partial_name_match', language: effectiveLang };
    }
  }

  // 2. Detect language from voice keyword if not matched and no explicit language
  if (voiceStr && !lang) {
    if (['emily', 'aria', 'aiden'].some(k => voiceStr.includes(k))) {
      lang = 'en';
    } else if (['diego', 'alvarez', 'isabel', 'anna', 'ono'].some(k => voiceStr.includes(k))) {
      lang = 'es';
    }
  }

  if (!lang) lang = 'es';

  // 3. Fallbacks
  if (lang === 'en') {
    const emily = profiles.find(p => p.name.toLowerCase() === 'emily');
    if (emily && (!voiceStr || voiceStr.includes('emily'))) {
      return { profile: emily, isFallback: false, reason: 'default_english_voice', language: 'en' };
    }
    const aria = profiles.find(p => p.name.toLowerCase() === 'aria');
    if (aria) return { profile: aria, isFallback: true, reason: 'fallback_english_aria', language: 'en' };

    const aiden = profiles.find(p => p.name.toLowerCase() === 'aiden');
    if (aiden) return { profile: aiden, isFallback: true, reason: 'fallback_english_aiden', language: 'en' };

    const anyEn = profiles.find(p => (p.language || '').toLowerCase().startsWith('en'));
    if (anyEn) return { profile: anyEn, isFallback: true, reason: 'fallback_any_english', language: 'en' };
  } else {
    const diego = profiles.find(p => p.name.toLowerCase().includes('diego'));
    if (diego && (!voiceStr || voiceStr.includes('diego'))) {
      return { profile: diego, isFallback: false, reason: 'default_spanish_voice', language: 'es' };
    }
    const isabel = profiles.find(p => p.name.toLowerCase() === 'isabel');
    if (isabel) return { profile: isabel, isFallback: true, reason: 'fallback_spanish_isabel', language: 'es' };

    const anna = profiles.find(p => p.name.toLowerCase().includes('anna') || p.name.toLowerCase().includes('ono'));
    if (anna) return { profile: anna, isFallback: true, reason: 'fallback_spanish_anna', language: 'es' };

    const anyEs = profiles.find(p => (p.language || '').toLowerCase().startsWith('es'));
    if (anyEs) return { profile: anyEs, isFallback: true, reason: 'fallback_any_spanish', language: 'es' };
  }

  return { profile: profiles[0], isFallback: true, reason: 'fallback_first_available', language: lang };
}

async function gestionarModelos(args, deps) {
  const { config, vb, om, servidoresVoz, getVoiceboxProfiles, resolveVoiceboxUrl } = deps;
  const voiceboxUrl = resolveVoiceboxUrl(args, config);
  const responder = (texto, isError = false) => ({
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: texto }]
  });
  const action = args.action;

  if (action === 'status') return responder(await describirEstadoVoicebox(voiceboxUrl, config, { vb, om }));

  if (action === 'release') {
    const pin = vb.leerPin();
    vb.escribirPin(null);
    return responder(pin
      ? `Pin liberado (\`${pin.model}\`). Se descarga tras ${config.voiceboxIdleUnloadMinutes} min sin uso.`
      : 'No había ningún modelo fijado.');
  }

  if (!['start', 'activate', 'pin', 'unload'].includes(action)) {
    return responder(`Acción desconocida: \`${action}\`.`, true);
  }

  const esOmni = args.engine === vb.MODELO_OMNI;
  const urlO = om.urlOmni(config);

  if (action === 'unload') {
    // Primero OmniVoice (el server es nuestro, siempre se puede); después
    // Voicebox, solo si lo levantó el plugin o con force.
    const liberados = [];
    const pinPrevio = vb.leerPin();
    if (om.omniInstalado({ config })) {
      const eo = await vb.estadoOmniServidor(urlO);
      if (eo.models.some(m => m.loaded)) {
        try {
          await vb.descargarOmniServidor(urlO);
          liberados.push(`\`${vb.MODELO_OMNI}\` (${vb.SIZE_MB_OMNI} MB)`);
        } catch (err) {
          process.stderr.write(`[antigravity-mcp] unload de omnivoice falló: ${err.message}\n`);
        }
      }
    }
    if (esOmni) {
      if (pinPrevio && pinPrevio.model === vb.MODELO_OMNI) vb.escribirPin(null);
      return responder(liberados.length ? `🗑️ Descargado: ${liberados.join(', ')}.` : 'OmniVoice no tenía el modelo cargado.');
    }
    const vbArriba = (await vb.salud(voiceboxUrl)).ok;
    const k = vb.leerKeeper();
    if (vbArriba && !(k && k.vivo && k.ownsServer) && !args.force) {
      const aviso = 'Este Voicebox no lo levantó el plugin (probablemente la GUI): no descargo sus modelos. Pasá `force: true` para hacerlo igual.';
      return liberados.length ? responder(`🗑️ Descargado: ${liberados.join(', ')}.\n\n${aviso}`) : responder(aviso, true);
    }
    vb.escribirPin(null);
    const tts = vbArriba ? (await vb.estadoModelos(voiceboxUrl)).filter(m => m.loaded && vb.esModeloTts(m.model_name)) : [];
    for (const m of tts) {
      try {
        await vb.descargarModelo(voiceboxUrl, m.model_name);
        liberados.push(`\`${m.model_name}\`${m.size_mb ? ` (${Math.round(m.size_mb)} MB)` : ''}`);
      } catch (err) {
        process.stderr.write(`[antigravity-mcp] unload de ${m.model_name} falló: ${err.message}\n`);
      }
    }
    return responder(liberados.length ? `🗑️ Descargados: ${liberados.join(', ')}. Pin liberado.` : 'No había modelos TTS cargados. Pin liberado.');
  }

  // OmniVoice (segundo proveedor): start/activate/pin con engine "omnivoice".
  if (esOmni) {
    if (!om.omniInstalado({ config })) return responder('OmniVoice no está instalado: `npm run omnivoice:install`.', true);
    const s = await om.ensureOmniVoice(urlO, { config });
    if (!s.ok) return responder(`⚠️ ${s.error}`, true);
    if (action === 'start') return responder(s.started ? `✅ OmniVoice levantado en \`${urlO}\`.` : `✅ OmniVoice ya estaba corriendo en \`${urlO}\`.`);
    const vbArriba = (await vb.salud(voiceboxUrl)).ok;
    const r = await vb.aplicarModeloActivo(servidoresVoz(vbArriba ? voiceboxUrl : null, config), {
      proveedor: vb.MODELO_OMNI,
      engine: vb.MODELO_OMNI,
      voz: args.voice || null,
      fijar: action === 'pin'
    });
    if (!r.ok) return responder(`⚠️ ${r.error}`, true);
    return responder(formatearActivacion(r, action, args.voice ? ` (voz ${args.voice})` : ''));
  }

  const health = await vb.ensureVoicebox(voiceboxUrl, { config });
  if (!health.ok) return responder(`⚠️ **Voicebox no está disponible en \`${voiceboxUrl}\`**\n\n${health.error}`, true);

  if (action === 'start') {
    let out = health.started
      ? `✅ Voicebox levantado sin GUI (${health.variante}, \`${health.exe}\`).`
      : `✅ Voicebox ya estaba corriendo en \`${voiceboxUrl}\`.`;
    if (health.aviso) out += `\n\n⚠️ ${health.aviso}`;
    return responder(out);
  }

  // activate / pin
  let perfil = null;
  if (args.voice) {
    try {
      perfil = resolveVoiceProfile(await getVoiceboxProfiles(voiceboxUrl), args.voice, args.language).profile;
    } catch (err) {
      return responder(`⚠️ ${err.message}`, true);
    }
  }
  if (!perfil && !args.engine) return responder('Indicá `voice` o `engine` (y opcionalmente `model_size`).', true);

  const mapa = {};
  for (const m of await vb.estadoModelos(voiceboxUrl)) mapa[m.model_name] = m;
  const motor = vb.resolverMotor(perfil || {}, mapa, args.engine || null, args.model_size || null);
  if (motor.unavailable) return responder(`No se activó ningún modelo: ${motor.reason}. Indicá un motor/model_size descargado y compatible.`, true);
  const r = await vb.aplicarModeloActivo(servidoresVoz(voiceboxUrl, config), { ...motor, voz: perfil ? perfil.name : null, fijar: action === 'pin' });
  if (!r.ok) return responder(`⚠️ ${r.error}`, true);
  return responder(formatearActivacion(r, action, perfil ? ` (voz ${perfil.name})` : ''));
}

async function listarVoces(args, deps) {
  const { config, vr, buildVoiceSnapshot, resolveVoiceboxUrl } = deps;
  const voiceboxUrl = resolveVoiceboxUrl(args, config);
  // Discovery es estrictamente read-only: salud, caché y archivos locales;
  // jamás arranca proveedores, carga modelos, descarga pesos ni crea Souls.
  const built = await buildVoiceSnapshot(args, config, { allowStart: false });
  const health = built.health;
  const profiles = built.snapshot.profiles;

  // 3. Filter if requested
  const langFilter = (args.language || 'all').toLowerCase();
  const filtered = langFilter === 'all'
    ? profiles
    : profiles.filter(p => (p.language || '').toLowerCase().startsWith(langFilter));

  const setup = config.voiceSetup || config.voice_setup || null;
  function getRoleTag(profile) {
    const matchesProfile = (value) => [profile.id, profile.name].some(x => String(x || '').toLowerCase() === String(value || '').toLowerCase());
    if (setup && setup.status === 'configured') {
      for (const lang of setup.languages || []) {
        const primary = setup.defaults && setup.defaults[lang] && setup.defaults[lang].audio;
        if (primary && matchesProfile(primary.profile)) return `⭐ Default ${lang}`;
        const fallbacks = setup.fallbacks && setup.fallbacks[lang] || [];
        const pos = fallbacks.findIndex(x => matchesProfile(x.profile));
        if (pos >= 0) return `🔄 Fallback ${lang} (P${pos + 1})`;
      }
    }
    return `Disponible${profile.language ? ` (${profile.language})` : ''}`;
  }

  // 5. Build presentation
  const hInfo = health.info || {};
  let out = `### 🎙️ Perfiles de Voz en Voicebox\n\n`;
  out += `**Estado del servicio:**\n`;
  out += `- **Endpoint**: \`${voiceboxUrl}\`\n`;
  out += `- **Voicebox**: ${health.ok ? '✅ accesible' : '⚪ detenido/no accesible (no se inició durante discovery)'}\n`;
  out += `- **Fuente de perfiles**: ${built.desdeCache ? 'caché local' : (health.ok ? 'servicio activo' : 'sin datos')}\n`;
  out += `- **voice_setup**: \`${vr.setupState(config, args.language)}\`\n`;
  if (hInfo.gpu_type) out += `- **Aceleración**: \`${hInfo.gpu_type}\` (${hInfo.backend_variant || 'cuda'})\n`;
  if (hInfo.model_size) out += `- **Modelo TTS**: \`${hInfo.model_size}\` (${hInfo.model_loaded ? 'Cargado en memoria' : 'Descargado'})\n`;
  out += `- **Total de perfiles instalados**: ${profiles.length}${langFilter !== 'all' ? ` (${filtered.length} mostrando filtro: \`${langFilter}\`)` : ''}\n\n`;

  out += `| Perfil | Idioma | Tipo | Rol en Antigravity | Personalidad |\n`;
  out += `|---|---|---|---|---|\n`;

  for (const p of filtered) {
    const role = getRoleTag(p);
    const pers = p.personality ? '✅ Sí' : '—';
    out += `| **${p.name}** | \`${p.language || '?'}\` | ${p.voice_type || 'cloned'} | ${role} | ${pers} |\n`;
  }

  out += `\n> **Cómo usar una voz específica:**\n`;
  out += `> - Comando: \`/lagrange:narrate <nombre>\` (ej: \`/lagrange:narrate aria\` o \`/lagrange:narrate "Mi voz"\`)\n`;
  out += `> - Con Claude: *"Narra el último checkpoint con [nombre de voz]"*\n`;

  return {
    content: [{ type: 'text', text: out }]
  };
}

/**
 * Despacha solo las dos tools de gestion de voz. `null` para cualquier otro
 * nombre, para que el contrato sea explicito y testeable.
 */
async function manejarGestionVoz(name, args, deps) {
  if (name === 'voice_model') return gestionarModelos(args, deps);
  if (name === 'narrate_voices') return listarVoces(args, deps);
  return null;
}

module.exports = { manejarGestionVoz };
