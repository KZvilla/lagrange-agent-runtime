const { execFile } = require('node:child_process');

const MAX_DIFF = 200 * 1024;

function validarSha(sha) {
  const valor = String(sha || '');
  if (!/^[0-9a-f]{7,64}$/i.test(valor)) throw new Error('commit inválido');
  return valor;
}

function diffCommit({ repo, commit, ejecutar = execFile, maxBytes = MAX_DIFF } = {}) {
  const sha = validarSha(commit);
  return new Promise((resolve, reject) => {
    ejecutar('git', ['-C', repo, '-c', 'core.pager=cat', 'show', '--no-ext-diff', '--no-textconv', '--format=', '--no-color', sha, '--'], {
      encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: maxBytes + 1
    }, (err, stdout = '', stderr = '') => {
      if (err) {
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || err.code === 'ENOBUFS') {
          return reject(new Error(`el diff supera ${maxBytes} bytes`));
        }
        return reject(new Error(`no se pudo leer el diff: ${String(stderr || err.message).trim().slice(0, 300)}`));
      }
      if (Buffer.byteLength(stdout) > maxBytes) return reject(new Error(`el diff supera ${maxBytes} bytes`));
      resolve({ commit: sha, diff: stdout, truncado: false });
    });
  });
}

module.exports = { MAX_DIFF, validarSha, diffCommit };
