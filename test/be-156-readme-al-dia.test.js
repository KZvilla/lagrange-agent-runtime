/**
 * BE-156 — El README contra el código.
 *
 * Una auditoría del README (2026-10-21) encontró dos tools sin documentar
 * (`consola`, `conocimiento`), conteos viejos, un comando ausente
 * (`/lagrange:integrar-lote`), tablas de parámetros incompletas, anclas del
 * índice rotas y enlaces a `docs/`, que está en .gitignore y no existe para
 * quien lee el repo público. Nada lo vigilaba: cada rename lo volvía a romper.
 *
 * Este gate compara lo que se puede derivar del código:
 *   - la tabla de tools contra `tools/list` del servidor real;
 *   - las tablas de parámetros (`### \`tool\` — … Parameter…`) contra los esquemas;
 *   - los comandos contra `commands/`, las skills contra `skills/`;
 *   - el índice contra los encabezados (slug de GitHub);
 *   - ningún enlace a `docs/`.
 * Los defaults y la prosa no se derivan: siguen a cargo de quien edita.
 */
const fs = require('fs');
const path = require('path');
const { startServer, REPO_ROOT } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const LINEAS = README.split('\n');

// Las líneas de una sección: desde el encabezado que cumple `inicio` hasta el
// próximo encabezado de nivel igual o mayor.
function seccion(inicio) {
  const i = LINEAS.findIndex((l) => /^#{2,4} /.test(l) && inicio.test(l));
  if (i < 0) return null;
  const nivel = LINEAS[i].match(/^#+/)[0].length;
  const fin = LINEAS.findIndex((l, j) => j > i && new RegExp(`^#{1,${nivel}} `).test(l));
  return LINEAS.slice(i + 1, fin < 0 ? undefined : fin);
}

// Primera celda de cada fila de tabla con nombres en `código`: "`a` / `b`" da a y b.
function primeraColumna(lineas) {
  const nombres = [];
  for (const l of lineas) {
    const m = l.match(/^\|\s*([^|]+?)\s*\|/);
    if (!m || /^-+$/.test(m[1].replace(/[:\s]/g, ''))) continue;
    for (const c of m[1].matchAll(/`([^`]+)`/g)) nombres.push(c[1]);
  }
  return nombres;
}

const diferencia = (a, b) => [...a].filter((x) => !b.has(x));

// El slug de GitHub: minúsculas, fuera todo lo que no sea letra, marca, número,
// guion bajo, espacio o guion; espacios a guiones. Las marcas incluyen el
// selector de variación U+FE0F de emojis como 🛡️, que por eso queda en el ancla.
function slug(titulo) {
  return titulo.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

async function main() {
  const server = startServer({});
  let tools;
  try {
    await server.initialize();
    tools = (((await server.listTools()).result || {}).tools) || [];
  } finally {
    await server.stop();
  }
  const porNombre = new Map(tools.map((t) => [t.name, t]));

  await group('BE-156: la tabla de tools es la del servidor', () => {
    check('tools/list respondió', tools.length > 0);
    const filas = seccion(/MCP Tools Reference/);
    check('existe la sección MCP Tools Reference', !!filas);
    // Solo la tabla general: las subsecciones ### son tablas de parámetros.
    const hastaSub = (filas || []).findIndex((l) => /^#/.test(l));
    const documentadas = new Set(primeraColumna((filas || []).slice(0, hastaSub < 0 ? undefined : hastaSub)));
    const servidas = new Set(porNombre.keys());
    const faltan = diferencia(servidas, documentadas);
    const sobran = diferencia(documentadas, servidas);
    check('toda tool servida tiene su fila', faltan.length === 0, JSON.stringify(faltan));
    check('ninguna fila nombra una tool que ya no existe', sobran.length === 0, JSON.stringify(sobran));
    const conteos = README.match(/\(\d+ tools\)|\b(?:\d+|eleven|twelve|\w+teen|(?:twenty|thirty|forty)(?:-[a-z]+)?) tools\b/gi) || [];
    check('ningún conteo de tools escrito a mano', conteos.length === 0, JSON.stringify(conteos));
  });

  await group('BE-156: las tablas de parámetros son las de los esquemas', () => {
    const tablas = LINEAS
      .map((l) => l.match(/^### `(\w+)` — .*Param/))
      .filter(Boolean)
      .map((m) => m[1]);
    check('hay tablas de parámetros que comparar', tablas.length >= 3, JSON.stringify(tablas));
    for (const tool of tablas) {
      const esquema = (porNombre.get(tool) || {}).inputSchema;
      check(`${tool}: la tool existe`, !!esquema);
      if (!esquema) continue;
      const props = esquema.properties || {};
      const esperados = new Set();
      for (const [k, v] of Object.entries(props)) {
        esperados.add(k);
        const items = v.items && v.items.properties;
        if (items) for (const sub of Object.keys(items)) esperados.add(`${k}[].${sub}`);
      }
      const documentados = new Set(primeraColumna(seccion(new RegExp(`^### \`${tool}\` — `))));
      const faltan = diferencia(esperados, documentados);
      const sobran = diferencia(documentados, esperados);
      check(`${tool}: todo parámetro del esquema está en la tabla`, faltan.length === 0, JSON.stringify(faltan));
      check(`${tool}: la tabla no tiene parámetros inventados`, sobran.length === 0, JSON.stringify(sobran));
    }
  });

  await group('BE-156: comandos y skills', () => {
    const comandos = fs.readdirSync(path.join(REPO_ROOT, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    const tabla = new Set(primeraColumna(seccion(/Slash Commands/) || []).map((c) => (c.match(/^\/lagrange:([\w-]+)/) || [])[1]).filter(Boolean));
    const componentes = (seccion(/📦 Components/) || []).join('\n');
    const faltanTabla = comandos.filter((c) => !tabla.has(c));
    check('todo comando de commands/ está en Slash Commands', faltanTabla.length === 0, JSON.stringify(faltanTabla));
    const inventados = diferencia(tabla, new Set(comandos));
    check('Slash Commands no nombra comandos que no existen', inventados.length === 0, JSON.stringify(inventados));
    const faltanComp = comandos.filter((c) => !componentes.includes(`commands/${c}.md`));
    check('todo comando está en Components', faltanComp.length === 0, JSON.stringify(faltanComp));
    const skills = fs.readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const faltanSkills = skills.filter((s) => !componentes.includes(`skills/${s}/SKILL.md`));
    check('toda skill está en Components', faltanSkills.length === 0, JSON.stringify(faltanSkills));
  });

  await group('BE-156: índice y enlaces', () => {
    let enBloque = false;
    const anclas = new Set();
    const h2 = [];
    for (const l of LINEAS) {
      if (/^```/.test(l)) { enBloque = !enBloque; continue; }
      if (enBloque) continue;
      const m = l.match(/^(#{1,6}) (.+)$/);
      if (!m) continue;
      // Repetidos: GitHub agrega -1, -2…; acá alcanza con el primero.
      anclas.add(slug(m[2].replace(/`/g, '')));
      if (m[1] === '##' && !/Table of Contents/.test(m[2])) h2.push(m[2]);
    }
    const indice = seccion(/Table of Contents/) || [];
    const enlaces = indice.map((l) => l.match(/\]\(#([^)]+)\)/)).filter(Boolean).map((m) => m[1]);
    const rotas = enlaces.filter((a) => !anclas.has(a));
    check('toda entrada del índice apunta a un encabezado', rotas.length === 0, JSON.stringify(rotas));
    const indexadas = new Set(enlaces);
    const fuera = h2.filter((t) => !indexadas.has(slug(t.replace(/`/g, ''))));
    check('toda sección ## está en el índice', fuera.length === 0, JSON.stringify(fuera));
    const internos = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !anclas.has(a));
    check('todo enlace interno apunta a un encabezado', internos.length === 0, JSON.stringify(internos));
    const aDocs = LINEAS.map((l, i) => [i + 1, l]).filter(([, l]) => /(^|[\s`(])docs\//.test(l)).map(([n]) => n);
    check('ningún enlace a docs/ (está en .gitignore)', aDocs.length === 0, `líneas ${aDocs.join(', ')}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
