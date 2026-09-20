/** FEAT-061 fase 2b — configuración TLS MITM y sustitución de secretos. */
const { check, group, report } = require('./lib/assert.js');
const fs = require('node:fs');
const path = require('node:path');
const d = require('../mcp-server/lotes/docker.js');

const dir = path.join(__dirname, '..', 'mcp-server', 'lotes', 'imagenes');
const leer = nombre => fs.readFileSync(path.join(dir, nombre), 'utf8');

group('supply chain e imagen', () => {
  const dockerfile = leer('Dockerfile.proxy');
  check('iron-proxy está fijado por digest', /ironsh\/iron-proxy@sha256:132ed363/.test(dockerfile));
  check('la base final también está fijada', /FROM alpine@sha256:d9e853e8/.test(dockerfile));
  check('el build exige 0.50.0', /--version.*0\.50\.0/s.test(dockerfile));
  check('Tinyproxy ya no forma parte de la imagen', !/tinyproxy/i.test(dockerfile));
});

group('perfil de tarea', () => {
  const yaml = leer('proxy-tarea.yaml');
  check('TLS queda en modo MITM', /mode: "mitm"/.test(yaml));
  check('DNS queda desactivado', /dns:\s+enabled: false/.test(yaml));
  check('métricas solo en loopback efímero', /metrics:\s+listen: "127\.0\.0\.1:0"/.test(yaml));
  check('la allowlist restringe userinfo por ruta', /www\.googleapis\.com[\s\S]*\/oauth2\/v2\/userinfo/.test(yaml));
  check('Cloud Storage no está permitido', !/storage\/v1|upload\/storage/.test(yaml));
  check('el secreto sale de archivo', /type: file\s+path: "\/secret\/access-token"/.test(yaml));
  check('solo busca el señuelo en Authorization', /match_headers: \["Authorization"\]/.test(yaml));
  check('la credencial es obligatoria', /require: true/.test(yaml));
  check('no captura cuerpos ni headers', !/body_capture|annotate/.test(yaml));
});

group('perfil refrescador', () => {
  const yaml = leer('proxy-refrescador.yaml');
  check('solo el refrescador admite el endpoint OAuth', /oauth2\.googleapis\.com[\s\S]*\/token/.test(yaml));
  check('no tiene transform de secretos', !/name: secrets/.test(yaml));
  check('el refrescador tampoco usa comodines de API interna', !/v1internal:\*/.test(yaml));
});

group('entrypoint y saneo', () => {
  const sh = leer('proxy-entrypoint.sh');
  check('la CA se genera sin entrar en la imagen', /openssl genrsa/.test(sh) && /\/ca-private/.test(sh));
  check('solo admite dos perfiles literales', /tarea.*refrescador/.test(sh));
  const salida = d.sanitizarSalida('Authorization: Bearer abc.DEF-123\nlagrange-falso-0123456789abcdef0123');
  check('los errores no devuelven bearer ni señuelo', !/abc\.DEF|0123456789abcdef/.test(salida), salida);
});

report();
