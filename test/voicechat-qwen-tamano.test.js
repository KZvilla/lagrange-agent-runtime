/**
 * BE-029 en el espejo de Python: con los dos tamaños de Qwen descargados, la
 * charla de voz se negaba a elegir (`compatibility_unknown`) aunque Node ya
 * desempataba por prioridad.
 *
 * Corre common.py de verdad con Python. Sin Python en el PATH, se omite y lo dice.
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');

const SCRIPT = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'voice-chat'))})
import common
def resolver(status, engine="qwen", size=None):
    try:
        return list(common.resolve_engine_and_model({"default_engine": engine}, status, model_size_override=size))
    except RuntimeError as e:
        return "error: " + str(e).split(":")[0]
d = {"downloaded": True}
casos = {
    "ambos": resolver({"qwen-tts-0.6B": d, "qwen-tts-1.7B": d}),
    "solo_chico": resolver({"qwen-tts-0.6B": d}),
    "desconocido_al_final": resolver({"qwen-tts-9B": d, "qwen-tts-0.6B": d}),
    "solo_desconocido": resolver({"qwen-tts-9B": d}),
    "a_mano": resolver({"qwen-tts-0.6B": d, "qwen-tts-1.7B": d}, size="0.6B"),
    "custom": resolver({"qwen-custom-voice-0.6B": d, "qwen-custom-voice-1.7B": d}, engine="qwen_custom_voice"),
    "ninguno": resolver({"kokoro": d}),
    "no_descargado": resolver({"qwen-tts-1.7B": {"downloaded": False}}),
}
print("RESULTADO " + json.dumps(casos))
`;

async function main() {
  const r = spawnSync('python', ['-c', SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 30000
  });

  await group('voice-chat elige el tamaño de Qwen', () => {
    if (r.error || (r.status !== 0 && /not found|no se encontr|was not found/i.test(r.stderr || ''))) {
      console.log('  (Python no disponible: se omite)');
      check('python no disponible — omitido', true);
      return;
    }
    const linea = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULTADO '));
    check('el script corrió', !!linea, r.stderr);
    const c = linea ? JSON.parse(linea.slice('RESULTADO '.length)) : {};
    const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check('con los dos descargados elige 1.7B', igual(c.ambos, ['qwen', '1.7B']), JSON.stringify(c.ambos));
    check('con uno solo, ese', igual(c.solo_chico, ['qwen', '0.6B']), JSON.stringify(c.solo_chico));
    check('un tamaño fuera de la lista va al final', igual(c.desconocido_al_final, ['qwen', '0.6B']), JSON.stringify(c.desconocido_al_final));
    check('pero sigue siendo usable', igual(c.solo_desconocido, ['qwen', '9B']), JSON.stringify(c.solo_desconocido));
    check('un tamaño pedido a mano sigue mandando', igual(c.a_mano, ['qwen', '0.6B']), JSON.stringify(c.a_mano));
    check('qwen_custom_voice desempata igual', igual(c.custom, ['qwen_custom_voice', '1.7B']), JSON.stringify(c.custom));
    check('sin ningún tamaño → model_not_downloaded', c.ninguno === 'error: model_not_downloaded', JSON.stringify(c.ninguno));
    check('uno no descargado no cuenta', c.no_descargado === 'error: model_not_downloaded', JSON.stringify(c.no_descargado));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
