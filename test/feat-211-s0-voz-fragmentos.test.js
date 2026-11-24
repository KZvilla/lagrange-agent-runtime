/**
 * FEAT-211 S0 — La voz por fragmentos: el fragmentador, la huella, la limpieza
 * sin tope, `sintetizar` con `sinTope`, el bot (lista, audio de un fragmento,
 * orden de validación, el cerrojo con dueño y la espera de Telegram), las rutas
 * v2 y el contrato.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, group, report } = require('./lib/assert');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-211-s0-'));
process.env.TELEGRAM_BRIDGE_ENV_FILE = path.join(raiz, '.env');
process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(raiz, 'datos');
process.env.TELEGRAM_BRIDGE_STATE_FILE = path.join(raiz, 'state.json');
process.env.LAGRANGE_ALMAS_DIR = path.join(raiz, 'almas');
process.env.LAGRANGE_VOICEBOX_DIR = path.join(raiz, 'voicebox'); // conModeloEnUso no toca el del usuario
fs.mkdirSync(process.env.TELEGRAM_BRIDGE_DATA_DIR, { recursive: true });

const RAIZ = path.join(__dirname, '..');
const importar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const { fragmentar, huella, VERSION_FRAGMENTOS, TOPE } = require('../mcp-server/voz-fragmentos.js');
const { normalizeSpokenText, redactSecrets } = require('../mcp-server/spoken-text.js');
const { esFinDeOracion, DEFAULT_ABBREVIATIONS } = require('../mcp-server/lib/sentence-chunker.js');
const { sintetizar } = require('../mcp-server/voz-sintesis.js');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const B = String.fromCharCode(92);

const PARRAFO = 'La luna sale tarde sobre el puerto. Dr. García mira el agua; nadie habla, y el viento sigue. ¿Qué queda? Queda el ruido de las cuerdas, el olor a sal y una lámpara que nadie apaga.';

/** Los rangos cubren el texto entero, sin huecos ni solapes, y `n` empieza en 0. */
function cubre(t, f) {
  return f.length > 0 && f[0].desde === 0 && f[f.length - 1].hasta === t.length
    && f.every((x, i) => x.n === i && x.hasta > x.desde && (i === 0 || x.desde === f[i - 1].hasta));
}
const hablados = (f) => f.map((x) => x.hablado).filter(Boolean).join(' ');
const sinBordes = (s) => s.replace(/\s+/g, ' ').trim();
const enSilencio = (f, i) => f.some((x) => x.silencios.some((s) => s.desde <= i && i < s.hasta));

async function main() {
  await group('FEAT-211 — la huella: FNV-1a sobre UTF-16, con los vectores fijos del plan', () => {
    check('""', huella('') === '811c9dc5');
    check('"hola"', huella('hola') === 'd35a0e2f');
    check('"á"', huella('á') === '29e79bc4');
    check('"😀"', huella('😀') === 'b34a1daa');
    check('"Día 😀."', huella('Día 😀.') === '5f593fb4');
  });

  await group('FEAT-211 — esFinDeOracion: solo los finales fuertes', () => {
    const t = 'Dr. García. Vale 3.14 euros... Sí. «Hola.» Fin! ¿Qué? Mirá: algo, y punto.com listo';
    check('«Dr.» no termina', !esFinDeOracion(t, t.indexOf('Dr.') + 2));
    check('«García.» termina', esFinDeOracion(t, t.indexOf('García.') + 6));
    check('«3.14» no termina', !esFinDeOracion(t, t.indexOf('3.14') + 1));
    check('«...» termina solo en el último punto', !esFinDeOracion(t, t.indexOf('...')) && esFinDeOracion(t, t.indexOf('...') + 2));
    check('«.»» termina con el cierre', esFinDeOracion(t, t.indexOf('Hola.') + 4));
    check('«!» y «?» terminan', esFinDeOracion(t, t.indexOf('!')) && esFinDeOracion(t, t.indexOf('?')));
    check('«:» y «,» no son finales fuertes', !esFinDeOracion(t, t.indexOf(':')) && !esFinDeOracion(t, t.indexOf(',')));
    check('un punto pegado a texto no termina', !esFinDeOracion(t, t.indexOf('.com')));
    check('acepta el array exportado como abreviaturas', !esFinDeOracion(t, t.indexOf('Dr.') + 2, DEFAULT_ABBREVIATIONS));
  });

  await group('FEAT-211 — normalizeSpokenText: sinTope, el corte de siempre y los secretos', () => {
    const largo = 'Una oración más. '.repeat(100);
    const conTope = normalizeSpokenText(largo);
    const sin = normalizeSpokenText(largo, { sinTope: true });
    check('sin la opción corta en 1200, como hoy', conTope.truncated && conTope.text.length <= 1200);
    check('con sinTope no corta y truncated es false', !sin.truncated && sin.text.length > 1200);
    const token = `bot123456789:${'A'.repeat(30)}`;
    const clave = `sk-${'b'.repeat(30)}`;
    const r = normalizeSpokenText(`token ${token} y clave ${clave}`).text;
    check('redacta el token de bot', !r.includes('A'.repeat(30)));
    check('redacta un sk-…, como policy.js', r.includes('sk-[REDACTED]') && !r.includes('b'.repeat(30)));
    check('redactSecrets también', redactSecrets(clave) === 'sk-[REDACTED]');
  });

  await group('FEAT-211 — fragmentar: rangos, niveles de corte y tope', () => {
    const parrafos = [PARRAFO, PARRAFO, `${PARRAFO} ${PARRAFO}`, PARRAFO].join('\n\n');
    const f = fragmentar(parrafos);
    check('cubre el texto y n empieza en 0', cubre(parrafos, f));
    check('ningún fragmento pasa del tope', f.every((x) => x.hasta - x.desde <= TOPE));
    check('corta en un párrafo cuando puede', /\n\n$/.test(parrafos.slice(f[0].desde, f[0].hasta)));
    const linea = `${PARRAFO} `.repeat(8);
    const g = fragmentar(linea);
    check('sin párrafos, corta al final de una oración', cubre(linea, g) && g.slice(0, -1).every((x) => /[.?!]\s+$/.test(linea.slice(x.desde, x.hasta))));
    check('«Dr. García» no se parte', g.every((x) => !/Dr\.\s+$/.test(linea.slice(x.desde, x.hasta))));
    // Un párrafo en 100 y una oración en 390: el párrafo queda por debajo del mínimo y gana la oración.
    const corto = `${'a'.repeat(98)}.\n\n${'palabra '.repeat(36)}fin. ${'b'.repeat(300)}`;
    const h = fragmentar(corto);
    check('la prioridad por nivel respeta el mínimo', h[0].hasta > 300 && /fin\.\s+$/.test(corto.slice(0, h[0].hasta)));
    const duro = 'x'.repeat(1000);
    const d = fragmentar(duro);
    check('un token sin espacios se parte con el corte duro', cubre(duro, d) && d.length === 3 && d[0].hasta === TOPE);
    check('es determinista (sin lastIndex colgado)', JSON.stringify(fragmentar(parrafos)) === JSON.stringify(f));
    const emojis = '😀'.repeat(300);
    const e = fragmentar(emojis);
    check('no parte un par sustituto', cubre(emojis, e) && e.every((x) => x.desde % 2 === 0));
    const corazon = `${'x'.repeat(399)}❤️${'y'.repeat(600)}`;
    check('el corte duro no separa un emoji de su selector', fragmentar(corazon)[0].hasta === 399);
    const crlf = `${'palabra '.repeat(37)}fin.\r\n\r\n${'otra '.repeat(10)}seguido. ${'b'.repeat(300)}`;
    check('un párrafo con CRLF también es nivel 1', /\r\n\r\n$/.test(crlf.slice(0, fragmentar(crlf)[0].hasta)));
    let tiro = false;
    try { fragmentar('hola', { tope: 0 }); } catch (err) { tiro = err instanceof RangeError; }
    check('un tope que no avanza se rechaza (no un bucle)', tiro);
  });

  await group('FEAT-211 — fragmentar: cortes descartados', () => {
    const lista = `${'palabra '.repeat(48)}- no es lista ${'otra '.repeat(80)}`;
    const f = fragmentar(lista);
    check('no deja un «- » al comienzo fuera de un comienzo de línea', f.every((x, i) => i === 0 || !/^[-+*]\s/.test(lista.slice(x.desde))));
    const pregunta = `${'palabra '.repeat(48)}¿ qué tal ${'otra '.repeat(80)}`;
    const g = fragmentar(pregunta);
    check('no corta después de «¿»', g.every((x) => !/¿\s+$/.test(pregunta.slice(x.desde, x.hasta))));
    const justo = `${'a'.repeat(390)} ¿ ${'b'.repeat(300)}`;
    check('un «¿ » justo antes del tope no queda al final del fragmento', !/¿\s+$/.test(justo.slice(0, fragmentar(justo)[0].hasta)));
    const puntuacion = `${'palabra '.repeat(48)}hola , sigue ${'otra '.repeat(80)}`;
    const h = fragmentar(puntuacion);
    check('no corta antes de la puntuación', h.every((x, i) => i === 0 || !/^[,.;:!?]/.test(puntuacion.slice(x.desde))));
  });

  await group('FEAT-211 — fragmentar: zonas protegidas, mudo y silencios', () => {
    const codigo = `${PARRAFO}\n\n\`\`\`js\n${'const x = 1;\n'.repeat(60)}\`\`\`\n\n${PARRAFO}`;
    const f = fragmentar(codigo);
    const bloque = f.find((x) => codigo.slice(x.desde, x.hasta).startsWith('```'));
    check('un bloque largo queda entero y es mudo', cubre(codigo, f) && bloque && bloque.mudo && codigo.slice(bloque.desde, bloque.hasta).trimEnd().endsWith('```'));
    check('el bloque es silencio', enSilencio(f, bloque.desde + 10));
    const url = `Mirá: https://${'a'.repeat(2000)}`;
    const u = fragmentar(url);
    check('una URL larga tras un prefijo corto da un borde forzado', cubre(url, u) && u.length === 2 && u[0].hasta === 6 && u[1].mudo);
    const pegada = `${'pal '.repeat(10)}${'y'.repeat(100)}(https://${'a'.repeat(2000)})`;
    const pg = fragmentar(pegada);
    check('sin cortes por encima del mínimo, el borde forzado cae en el comienzo de la zona', cubre(pegada, pg) && pg[0].hasta === pegada.indexOf('https'));
    const enLinea = `Corré \`${'npm run algo '.repeat(150)}\` y listo.`;
    const l = fragmentar(enLinea);
    check('un código en línea largo se corta por dentro', cubre(enLinea, l) && l.length > 1 && l.every((x) => x.hasta - x.desde <= TOPE));
    check('ningún fragmento hablado lleva un backtick suelto', l.every((x) => !x.hablado.includes('`')));
    check('los backticks sueltos son silencio', enSilencio(l, enLinea.indexOf('`')) && enSilencio(l, enLinea.lastIndexOf('`')));
    const ruta = `El archivo C:${B}${`Carpeta Con Nombre Largo${B}`.repeat(25)}informe.json quedó listo.`;
    const r = fragmentar(ruta);
    check('una ruta larga no es muda: se dice el nombre del archivo', cubre(ruta, r) && r.some((x) => x.hablado.includes('informe.json')) && r.every((x) => !x.mudo));
    check('la carpeta de la ruta no se dice', r.every((x) => !x.hablado.includes('Carpeta')));
    const link = `Leé [el informe](https://x.com/a) y ${'`npm`'} en ${'/usr/lib/'}libx.so ahora. **Ojo** 😀`;
    const k = fragmentar(link);
    check('en un link, «[» y «](…)» son silencio y el texto no', enSilencio(k, link.indexOf('[')) && enSilencio(k, link.indexOf('](')) && !enSilencio(k, link.indexOf('informe')));
    check('en el código en línea, solo los backticks', enSilencio(k, link.indexOf('`npm`')) && !enSilencio(k, link.indexOf('npm')));
    check('en una ruta, la carpeta sí y el nombre no', enSilencio(k, link.indexOf('/usr')) && !enSilencio(k, link.indexOf('libx')));
    check('las marcas y el emoji son silencio', enSilencio(k, link.indexOf('**')) && enSilencio(k, link.indexOf('😀')));
    const comillas = `«${PARRAFO}»`;
    const c = fragmentar(comillas);
    check('las comillas de los bordes son silencio', enSilencio(c, 0) && enSilencio(c, comillas.length - 1));
    const cerca = `${PARRAFO}\n\n\`\`\`\n${'a'.repeat(200)} \`${'b '.repeat(200)}`;
    const z = fragmentar(cerca);
    check('una cerca sin cerrar se corta como texto', cubre(cerca, z) && z.length > 1 && z.every((x) => !x.mudo));
    check('solo un bloque de código es mudo', fragmentar('```\nx\n```').every((x) => x.mudo));
    // Ronda 1: un backtick suelto antes de un bloque largo no le quita lo mudo (el código en línea se busca, como en
    // la limpieza, sobre el texto ya sin bloques).
    const suelto = `El carácter \` se usa así.\n\n\`\`\`js\n${'const secreto = 1;\n'.repeat(60)}\`\`\`\n\nCorré \`npm\` y listo.`;
    const sf = fragmentar(suelto);
    check('backtick suelto + bloque largo: el bloque no se dice', cubre(suelto, sf) && sf.every((x) => !x.hablado.includes('secreto')));
    check('y el bloque es silencio', enSilencio(sf, suelto.indexOf('secreto')));
    // Un link largo (URL de 500) con código en línea en su texto: la URL no se dice en ningún fragmento.
    const largoLink = `Mirá [el \`npm\` de hoy](https://${'a'.repeat(500)}) y seguí.`;
    const lf = fragmentar(largoLink);
    check('un link con URL larga: ningún fragmento dice la URL', cubre(largoLink, lf) && lf.every((x) => !x.hablado.includes('aaaa')));
    check('y su texto sí se dice', hablados(lf).includes('el npm de hoy'));
    check('la URL del link es un fragmento mudo propio', lf.some((x) => x.mudo && largoLink.slice(x.desde, x.hasta).startsWith('](https')));
    check('la URL del link es silencio', enSilencio(lf, largoLink.indexOf('aaaa')) && enSilencio(lf, largoLink.indexOf('](')));
    // Un «- » que queda al comienzo de un fragmento por un borde forzado: la limpieza lo borra, así que es silencio.
    const guion = `Mirá https://${'a'.repeat(2000)} - opción`;
    const gf = fragmentar(guion);
    check('un «- » al comienzo de un fragmento que la limpieza borra es silencio', enSilencio(gf, guion.indexOf(' - ') + 1));
    // Un link seguido de un punto: el punto se dice (la URL suelta se busca sobre el texto ya sin links).
    const punto = '[x](https://a.b). Y sigue.';
    check('el punto después de un link no es silencio', !enSilencio(fragmentar(punto), punto.indexOf(').') + 1));
    // Comillas de borde del tramo que se sintetiza (después de sacar el backtick suelto).
    const comillaTramo = `\`«${'palabra '.repeat(100)}\``;
    const ct = fragmentar(comillaTramo);
    check('una comilla que queda en el borde del tramo es silencio', ct.length > 1 && enSilencio(ct, 1) && !ct[0].hablado.startsWith('«'));
  });

  await group('FEAT-211 — la equivalencia con normalizar el texto entero', () => {
    const casos = {
      párrafos: [PARRAFO, PARRAFO, PARRAFO].join('\n\n'),
      'una línea': `${PARRAFO} `.repeat(9),
      'código en línea, rutas y listas': `${PARRAFO}\n- uno \`npm i\`\n- dos /usr/lib/libx.so\n\n${PARRAFO} [link](https://a.b) ${PARRAFO}`,
      'un párrafo antes de una coma': `${'palabra '.repeat(60)}\n\n, sigue ${'otra '.repeat(80)}`,
      'un bloque en el medio': `${PARRAFO}\n\n\`\`\`\n${'x = 1\n'.repeat(80)}\`\`\`\n\n${PARRAFO}`,
      'una cerca sin cerrar': `${PARRAFO}\n\n\`\`\`\n${PARRAFO} ${PARRAFO}\n\n${PARRAFO}`,
      'un backtick suelto antes de un bloque': `El carácter \` se usa así. ${PARRAFO}\n\n\`\`\`\n${'y = 2\n'.repeat(80)}\`\`\`\n\n${PARRAFO} \`npm\` fin.`,
      'un texto largo como el del usuario (1267)': LARGO_1267
    };
    for (const [nombre, t] of Object.entries(casos)) {
      const f = fragmentar(t);
      check(`${nombre}: los hablado unidos dan lo mismo`, sinBordes(hablados(f)) === sinBordes(normalizeSpokenText(t, { sinTope: true }).text));
    }
    check('el texto largo mide 1267', LARGO_1267.length === 1267);
    // Las dos excepciones escritas del plan. 1) El corte duro agrega un espacio dentro del token.
    const duro = 'x'.repeat(1000);
    check('excepción: el corte duro', hablados(fragmentar(duro)).replace(/ /g, '') === duro);
    // 2) Las comillas que quedan en el borde de un fragmento no se pronuncian (y son silencio).
    const citas = `${'palabra '.repeat(45)}«${'cita '.repeat(30)}» ${'otra '.repeat(60)}`;
    const cf = fragmentar(citas);
    const sinComillas = (x) => sinBordes(x.replace(/[«»]/g, ''));
    check('excepción: las comillas de borde', sinComillas(hablados(cf)) === sinComillas(normalizeSpokenText(citas, { sinTope: true }).text));
  });

  await group('FEAT-211 — la salida de referencia está atada a VERSION_FRAGMENTOS', () => {
    const referencia = [
      PARRAFO, `${PARRAFO} Dr. Pérez llegó a las 3.14 horas... y se fue.`, `- uno \`npm i\`\n- dos [link](https://a.b/c)`,
      `Ruta C:${B}Program Files${B}app${B}x.json, emoji 😀 y «cita».`, `\`\`\`\ncódigo\n\`\`\``, '```sin cerrar ' + 'z '.repeat(250),
      'y'.repeat(900)
    ].join('\n\n');
    const salida = fragmentar(referencia).map(({ n, desde, hasta, hablado, mudo, silencios }) => ({ n, desde, hasta, hablado, mudo, silencios }));
    // Si este test falla porque cambió fragmentar o normalizeSpokenText, subí VERSION_FRAGMENTOS y actualizá la huella.
    const esperado = { version: 1, huella: huella(JSON.stringify(salida)) };
    check(`versión ${VERSION_FRAGMENTOS} y su salida (${esperado.huella})`, VERSION_FRAGMENTOS === 1 && esperado.huella === REFERENCIA_V1);
  });

  await group('FEAT-211 — sintetizar con sinTope: un tramo de más de 1200 llega entero', async () => {
    const tramo = 'Una oración más que se dice. '.repeat(60);
    let dicho = null;
    const wav = path.join(raiz, 'tramo.wav');
    fs.writeFileSync(wav, Buffer.from('RIFF'));
    const opciones = (sinTope) => ({
      texto: tramo, sinTope, config: {},
      preparar: async () => ({ status: 'audio', motor: 'voicebox', proveedor: 'voicebox', profile: { name: 'Alya' }, language: 'es' }),
      generar: async ({ spokenText }) => { dicho = spokenText; return { ok: true, generatedWavPath: wav }; }
    });
    const r = await sintetizar(opciones(true));
    check('con sinTope, generar recibe el tramo entero', r.ok && dicho.length > 1200);
    check('y devuelve los tiempos de preparar y generar', r.tiempos && Number.isInteger(r.tiempos.preparar) && Number.isInteger(r.tiempos.generar));
    await sintetizar(opciones(false));
    check('sin la opción, el corte de 1200 de siempre', dicho.length <= 1200);
  });

  const bot = await importar('telegram-bridge/bot.js');
  const tareas = await importar('telegram-bridge/tareas.js');
  bot.resetRuntimeState();
  tareas.reiniciarParaTests();
  const logs = [];
  const logOriginal = console.log;
  const warnOriginal = console.warn;
  console.log = (...a) => { const l = a.join(' '); logs.push(l); if (!l.startsWith('[')) logOriginal(...a); };
  console.warn = () => {};
  const pedidos = [];
  let pendiente = null;
  let respuesta = null;
  const sintetizarDePrueba = async (op) => {
    pedidos.push(op);
    if (pendiente) await pendiente;
    if (respuesta) return respuesta;
    const ruta = path.join(raiz, `voz-${pedidos.length}.wav`);
    fs.writeFileSync(ruta, Buffer.from('RIFF....WAVE'));
    return { ok: true, wavPath: ruta, perfil: 'Alya', tiempos: { preparar: 5, generar: 7 } };
  };
  bot.usarEjecutoresDePrueba({ sintetizar: sintetizarDePrueba });
  const alma = { carril: 'alma', sujeto: { tipo: 'alma', clave: 'alya', voz: 'Alya' } };
  const cerrada = (resultado) => {
    const t = tareas.crear({ origen: 'web', pedido: 'p', ...alma });
    tareas.actualizar(t.id, { estado: 'ok', resultado });
    return t.id;
  };
  const texto = [PARRAFO, PARRAFO, `${PARRAFO} ${PARRAFO}`, '```\n' + 'x = 1\n'.repeat(80) + '```', PARRAFO].join('\n\n');
  const id = cerrada(texto);

  try {
    await group('FEAT-211 — bot.vozFragmentos: la lista del texto que pinta la terminal', () => {
      const v = bot.vozFragmentos(id);
      check('ok, con largo, huella y versión', v.ok && v.largo === texto.length && v.huella === huella(texto) && v.version === VERSION_FRAGMENTOS);
      check('los fragmentos públicos no llevan el tramo ni el hablado', v.fragmentos.every((f) => !('tramo' in f) && !('hablado' in f)));
      check('404 y 400 como escuchar', bot.vozFragmentos('t_noexiste').codigo === 404 && bot.vozFragmentos(tareas.crear({ origen: 'web', pedido: 'p', ...alma }).id).codigo === 400);
      const enorme = cerrada('Una oración. '.repeat(2000));
      const w = bot.vozFragmentos(enorme);
      check('un resultado de 26.000 queda recortado en el registro: largo === TOPE_TEXTO, sin el sufijo', w.ok && w.largo === tareas.TOPE_TEXTO);
    });

    await group('FEAT-211 — bot.escucharFragmento: orden de validación y síntesis sin tope', async () => {
      const v = bot.vozFragmentos(id);
      const mudo = v.fragmentos.findIndex((f) => f.mudo);
      const r0 = await bot.escucharFragmento(id, { n: 0, huella: v.huella, version: v.version });
      check('el fragmento 0 da audio', r0.ok && r0.audio.length > 0);
      const f0 = fragmentar(texto)[0];
      check('sintetiza el tramo, con sinTope y la voz del alma', pedidos[0].texto === f0.tramo && pedidos[0].sinTope === true && pedidos[0].voz === 'Alya');
      check('anota la línea de tiempos en daemon.log', logs.some((l) => l.includes(`[web] fragmento ${id}#0: preparar 5 ms, generar 7 ms,`)));
      const ultimo = v.fragmentos.length - 1;
      check('el último también', (await bot.escucharFragmento(id, { n: ultimo, huella: v.huella, version: v.version })).ok);
      const viejo = await bot.escucharFragmento(id, { n: 0, huella: '00000000', version: v.version });
      check('una huella vieja: 409 texto_cambio', viejo.codigo === 409 && viejo.motivo === 'texto_cambio');
      check('otra versión: 409 texto_cambio', (await bot.escucharFragmento(id, { n: 0, huella: v.huella, version: v.version + 1 })).motivo === 'texto_cambio');
      const fuera = await bot.escucharFragmento(id, { n: 999, huella: '00000000', version: v.version });
      check('huella vieja con n fuera de rango: 409 (antes que el rango)', fuera.codigo === 409 && fuera.motivo === 'texto_cambio');
      check('n fuera de rango con huella vigente: 400', (await bot.escucharFragmento(id, { n: 999, huella: v.huella, version: v.version })).codigo === 400);
      check('n no entero: 400', (await bot.escucharFragmento(id, { n: '1', huella: v.huella, version: v.version })).codigo === 400);
      check('un mudo vigente: 400', mudo >= 0 && (await bot.escucharFragmento(id, { n: mudo, huella: v.huella, version: v.version })).codigo === 400);
      respuesta = { ok: false, motivo: 'profile_missing' };
      const sinVoz = await bot.escucharFragmento(id, { n: 0, huella: v.huella, version: v.version });
      check('sinVoz llega con su motivo', sinVoz.sinVoz === true && sinVoz.motivo === 'profile_missing');
      respuesta = null;
    });

    await group('FEAT-211 — el cerrojo: dueños, el 504 y la espera de Telegram', async () => {
      const v = bot.vozFragmentos(id);
      const cuerpo = { n: 0, huella: v.huella, version: v.version };
      check('Probar con el cerrojo libre suena (no se da 409 a sí mismo)', (await bot.probarVoz({ voz: 'Alya' })).ok);
      const prestado = bot.escucharPrestado({ rpc: async () => ({ ok: true, tarea: { sujeto: { tipo: 'agente' }, estado: 'ok', resultado: 'hola' } }) });
      check('la voz prestada con el cerrojo libre suena', (await prestado('nodo', 't_x')).ok);

      // Un fragmento lento pasa el límite: 504, y el cerrojo sigue tomado hasta que termina de verdad.
      let soltar;
      pendiente = new Promise((r) => { soltar = r; });
      const lento = await bot.escucharFragmento(id, cuerpo, { limiteMs: 30 });
      check('504 al vencer', lento.codigo === 504);
      check('el cerrojo sigue tomado', (await bot.escucharTarea(id)).codigo === 409);
      const lineas = () => logs.filter((l) => l.includes(`[web] fragmento ${id}#0:`)).length;
      const antesDel504 = lineas();

      // Telegram, con el cerrojo de un fragmento, espera y después responde en voz.
      const enviados = [];
      const ctx = { chat: { id: 'web:prueba-1' }, replyWithVoice: async () => { enviados.push('voz'); return { message_id: 9 }; } };
      const task = { voz: 'Alya', clave: 'alya' };
      const respuestaTelegram = bot.responderConVoz(ctx, task, { respuesta: 'Te contesto.' }, {}, { limiteMs: 2000, cadaMs: 10 });
      await esperar(50);
      check('mientras el fragmento sigue, Telegram espera', enviados.length === 0);
      soltar();
      pendiente = null;
      const rt = await respuestaTelegram;
      check('al soltarse, Telegram toma el cerrojo y manda la voz', rt.ok && enviados.length === 1);
      check('el fragmento que dio 504 anota su línea de tiempos al terminar', lineas() === antesDel504 + 1);

      // Si el fragmento no termina dentro de la espera, Telegram descarta (queda en texto).
      pendiente = new Promise((r) => { soltar = r; });
      const eterno = bot.escucharFragmento(id, cuerpo);
      await new Promise((r) => setImmediate(r));
      const vencida = await bot.responderConVoz(ctx, task, { respuesta: 'z' }, {}, { limiteMs: 60, cadaMs: 10 });
      check('la espera de Telegram vence: ocupado, sin voz', vencida.motivo === 'ocupado' && enviados.length === 1);
      soltar();
      pendiente = null;
      await eterno;

      // Un fragmento cuya síntesis lanza suelta el cerrojo.
      bot.usarEjecutoresDePrueba({ sintetizar: async () => { throw new Error('explotó'); } });
      const lanza = await bot.escucharFragmento(id, cuerpo);
      check('una síntesis que lanza da 503', lanza.codigo === 503);
      bot.usarEjecutoresDePrueba({ sintetizar: sintetizarDePrueba });
      check('y el cerrojo queda libre', (await bot.escucharTarea(id)).ok);

      // Con el cerrojo de otro dueño (escuchar entero), Telegram descarta como hoy, sin esperar.
      pendiente = new Promise((r) => { soltar = r; });
      const entera = bot.escucharTarea(id);
      await new Promise((r) => setImmediate(r));
      const t0 = Date.now();
      const ocupado = await bot.responderConVoz(ctx, task, { respuesta: 'x' }, {}, { limiteMs: 2000, cadaMs: 10 });
      check('con otro dueño: ocupado en el acto', ocupado.motivo === 'ocupado' && Date.now() - t0 < 500);
      soltar();
      pendiente = null;
      await entera;

      // Dos respuestas de Telegram esperando el mismo fragmento: una entra, la otra queda en texto.
      pendiente = new Promise((r) => { soltar = r; });
      const frag = bot.escucharFragmento(id, cuerpo);
      await new Promise((r) => setImmediate(r));
      let soltarTelegram;
      const enviados2 = [];
      const ctxLento = { chat: { id: 'web:prueba-2' }, replyWithVoice: async () => { enviados2.push(1); await new Promise((r) => { soltarTelegram = r; }); return { message_id: 10 }; } };
      const a = bot.responderConVoz(ctxLento, task, { respuesta: 'a' }, {}, { limiteMs: 2000, cadaMs: 10 });
      const b = bot.responderConVoz(ctxLento, task, { respuesta: 'b' }, {}, { limiteMs: 2000, cadaMs: 10 });
      soltar();
      pendiente = null;
      await frag;
      for (let i = 0; i < 100 && !soltarTelegram; i++) await esperar(10);
      const segunda = await Promise.race([a, b]);
      check('dos esperando: la segunda queda en texto (el dueño ya es Telegram)', segunda.motivo === 'ocupado');
      soltarTelegram();
      await Promise.all([a, b]);
      check('y la primera manda su voz', enviados2.length === 1);

      // resetRuntimeState limpia el dueño: Telegram no espera a un fragmento que ya no existe.
      bot.resetRuntimeState();
      bot.usarEjecutoresDePrueba({ sintetizar: async () => { const ruta = path.join(raiz, 'r.wav'); fs.writeFileSync(ruta, 'x'); return { ok: true, wavPath: ruta }; } });
      check('después del reset, Telegram responde', (await bot.responderConVoz(ctx, task, { respuesta: 'y' }, {}, { limiteMs: 200, cadaMs: 10 })).ok);
    });

    await group('FEAT-211 — capacidades: vozFragmentos', () => {
      check('capacidadesV2 suma vozFragmentos', bot.capacidadesV2().capacidades.vozFragmentos === true);
    });
  } finally {
    bot.usarEjecutoresDePrueba({});
    console.log = logOriginal;
    console.warn = warnOriginal;
  }

  await group('FEAT-211 — rutas v2, núcleo y contrato', async () => {
    const { rutasLecturaV2 } = await importar('telegram-bridge/web/v2/lecturas.js');
    const { rutasMutacionV2 } = await importar('telegram-bridge/web/v2/mutaciones.js');
    const { crearNucleoWeb } = await importar('telegram-bridge/web/nucleo.js');
    const esq = await importar('telegram-bridge/web/v2/esquema.js');
    const contrato = esq.cargarContrato();
    const pedidosNucleo = [];
    const nucleo = {
      vozFragmentos: (i) => { pedidosNucleo.push(['lista', i]); return { ok: true, fragmentos: [{ n: 0, desde: 0, hasta: 4, mudo: false, silencios: [{ desde: 0, hasta: 1 }] }], largo: 4, huella: 'abcdef01', version: 1 }; },
      escucharFragmento: (i, c) => { pedidosNucleo.push(['fragmento', i, c]); return { binario: Buffer.from('RIFF'), tipo: 'audio/wav' }; },
      escucharTarea: (i) => { pedidosNucleo.push(['entero', i]); return { binario: Buffer.from('RIFF'), tipo: 'audio/wav' }; }
    };
    const idem = { porId: (x) => (x === 'tid-1' ? { tareaId: 't_abc' } : null) };
    const llamar = (rutas, metodo, ruta, cuerpo = {}) => {
      const r = rutas.find((x) => x.metodo === metodo && x.patron.test(ruta));
      if (!r) return { sinRuta: true };
      return r.fn({ p: r.patron.exec(ruta).slice(1).filter((x) => x !== undefined), cuerpo, url: new URL(`http://x${ruta}`) });
    };
    const lecturas = rutasLecturaV2({ nucleo, recorte: '', arranque: 'a', idem });
    const voz = await llamar(lecturas, 'GET', '/api/v2/turnos/tid-1/voz');
    check('GET …/voz con tid resuelve el tareaId', voz.ok && pedidosNucleo[0][1] === 't_abc');
    await llamar(lecturas, 'GET', '/api/v2/turnos/t_xyz/voz');
    check('y con tareaId, tal cual', pedidosNucleo[1][1] === 't_xyz');
    check('la respuesta valida contra vozTurno', esq.validar(contrato, 'vozTurno', voz).length === 0);
    const sinIdem = rutasLecturaV2({ nucleo, recorte: '', arranque: 'a' });
    await llamar(sinIdem, 'GET', '/api/v2/turnos/t_sin/voz');
    check('sin idem (opcional), resuelve solo por tareaId', pedidosNucleo[2][1] === 't_sin');

    const mutaciones = rutasMutacionV2({ nucleo, cola: {}, ctx: { chat: { id: 'web:terminal' } }, chatTerminal: 'web:terminal', registro: { obtener: () => null }, idem, almacen: { publicar: () => {} }, recorte: '' });
    await llamar(mutaciones, 'POST', '/api/v2/turnos/tid-1:escuchar', { fragmento: 0, huella: 'abcdef01', version: 1 });
    const ultimo = pedidosNucleo[pedidosNucleo.length - 1];
    check(':escuchar con fragmento 0 va a escucharFragmento con el cuerpo', ultimo[0] === 'fragmento' && ultimo[1] === 't_abc' && ultimo[2].fragmento === 0 && ultimo[2].huella === 'abcdef01' && ultimo[2].version === 1);
    await llamar(mutaciones, 'POST', '/api/v2/turnos/tid-1:escuchar', {});
    check('sin cuerpo, el audio entero como hoy', pedidosNucleo[pedidosNucleo.length - 1][0] === 'entero');

    const nucleoReal = crearNucleoWeb({
      bot: {
        almasDisponibles: () => [], agentesCasteables: () => [], estadoDeCarriles: () => [],
        vozFragmentos: () => ({ ok: true }),
        escucharFragmento: async () => ({ ok: false, codigo: 409, error: 'cambió', motivo: 'texto_cambio' }),
        escucharTarea: async () => ({ ok: false, codigo: 503, error: 'sin voz', sinVoz: true, motivo: 'profile_missing' })
      }
    });
    const cambio = await nucleoReal.escucharFragmento('t_abc', { fragmento: 0, huella: 'x', version: 1 });
    check('el núcleo deja pasar el motivo texto_cambio', cambio.codigo === 409 && cambio.motivo === 'texto_cambio');
    check('y el error valida contra el agregado error', esq.validar(contrato, 'error', { ok: false, error: cambio.error, codigo: 409, motivo: 'texto_cambio' }).length === 0);
    const sinVoz = await nucleoReal.escucharTarea('t_abc');
    check('escucharTarea suma el motivo a sinVoz', sinVoz.sinVoz === true && sinVoz.motivo === 'profile_missing');
    check('sinVoz y motivo validan contra el agregado error', esq.validar(contrato, 'error', { ok: false, error: 'x', codigo: 503, sinVoz: true, motivo: 'profile_missing' }).length === 0);
    check('un id inválido: 400', (await nucleoReal.escucharFragmento('nada', {})).codigo === 400 && nucleoReal.vozFragmentos('nada').codigo === 400);
    check('capacidades.vozFragmentos está en el contrato', esq.validar(contrato, 'capacidades', { ...(await importar('telegram-bridge/bot.js')).capacidadesV2() }).length === 0);
  });
}

/** Un texto largo con la forma de una respuesta de alma (prosa, énfasis, una lista, un link y código en línea). */
const LARGO_1267 = (() => {
  const base = [
    '**Sobre el puerto.** La luna sale tarde y el agua queda quieta un rato largo. Dr. García mira las cuerdas; nadie habla, y el viento sigue.',
    'Hay tres cosas que conviene recordar:\n- que el faro se apaga a las 3.14 de la mañana;\n- que la lámpara de la cocina nadie la apaga;\n- y que el `npm run puerto` ya no hace falta.',
    'Si querés leer más, está todo en [la bitácora](https://ejemplo.org/bitacora/puerto) y en C:\\Users\\Ana\\notas\\puerto.md, pero no hace falta abrirlo ahora.',
    '¿Qué queda? Queda el ruido de las cuerdas, el olor a sal, una canción vieja que alguien silba desde un barco y la sensación de que mañana va a ser igual. «Siempre es igual», dijo alguien, y nadie le contestó.'
  ].join('\n\n');
  let t = base;
  while (t.length < 1267) t += ' Y el agua sigue quieta.';
  return t.slice(0, 1266) + '.';
})();

// La huella de la salida de referencia de la versión 1 de fragmentar.
const REFERENCIA_V1 = '1300220b';

main().then(() => {
  fs.rmSync(raiz, { recursive: true, force: true });
  report();
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
