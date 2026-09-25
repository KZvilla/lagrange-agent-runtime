/**
 * BE-048 — `checkpoint.js` no toma como nota del turno la prosa que anuncia la
 * narración. Sin prefijo propio, la tool aparece como `mcp__…__narrate`,
 * `lagrange_narrate` o `` `narrate` ``; los transcripts viejos traen
 * `agy_narrate`. La palabra suelta en prosa no cuenta como anuncio.
 */
const { check, group, report } = require('./lib/assert');
const { checkpointFromLines } = require('../mcp-server/checkpoint.js');

function notas(...textos) {
  const lineas = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hacé la tarea' } }),
    ...textos.map((t) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }))
  ];
  return checkpointFromLines(lineas).assistantNotes;
}

async function main() {
  await group('el anuncio de la narración no pisa la nota del turno', () => {
    const base = 'Terminé: los tests pasan.';
    for (const anuncio of [
      'Ahora llamo a mcp__plugin_lagrange_lagrange__narrate.',
      'Uso lagrange_narrate para contarlo.',
      'Te lo cuento con `narrate`.',
      'Voy a usar agy_narrate.'
    ]) {
      check(`descarta: ${anuncio}`, notas(base, anuncio) === base, notas(base, anuncio));
    }
  });

  await group('la palabra en prosa o un identificador parecido no se descartan', () => {
    for (const texto of [
      'Te voy a narrate the result later.',
      'Arreglé test_narrate y pre_narrate.'
    ]) {
      check(`conserva: ${texto}`, notas('Nota vieja.', texto) === texto, notas('Nota vieja.', texto));
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
