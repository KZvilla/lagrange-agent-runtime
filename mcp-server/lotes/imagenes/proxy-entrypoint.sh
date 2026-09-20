#!/bin/sh
set -eu

if [ "${1:-}" = "init-ca" ]; then
  mkdir -p /ca-private /ca-public
  if [ ! -s /ca-private/ca.key ] || [ ! -s /ca-private/ca.crt ]; then
    umask 077
    openssl genrsa -out /ca-private/.ca.key.tmp 4096
    openssl req -x509 -new -sha256 -days 3650 \
      -key /ca-private/.ca.key.tmp -subj '/CN=Lagrange lotes CA' \
      -addext 'basicConstraints=critical,CA:TRUE' \
      -addext 'keyUsage=critical,keyCertSign,cRLSign' \
      -out /ca-private/.ca.crt.tmp
    mv /ca-private/.ca.key.tmp /ca-private/ca.key
    mv /ca-private/.ca.crt.tmp /ca-private/ca.crt
  fi
  openssl x509 -in /ca-private/ca.crt -noout -checkend 86400 >/dev/null
  openssl pkey -in /ca-private/ca.key -pubout -out /tmp/key.pub
  openssl x509 -in /ca-private/ca.crt -pubkey -noout > /tmp/cert.pub
  cmp -s /tmp/key.pub /tmp/cert.pub
  cp /ca-private/ca.crt /ca-public/.ca.crt.tmp
  chmod 600 /ca-private/ca.key /ca-private/ca.crt
  chmod 644 /ca-public/.ca.crt.tmp
  chown 1001:1001 /ca-private/ca.key /ca-private/ca.crt
  mv /ca-public/.ca.crt.tmp /ca-public/ca.crt
  exit 0
fi

if [ "${1:-}" = "check-ca" ]; then
  [ -s /ca-private/ca.key ] && [ -s /ca-private/ca.crt ] && [ -s /ca-public/ca.crt ]
  openssl x509 -in /ca-private/ca.crt -noout -checkend 86400 >/dev/null
  openssl pkey -in /ca-private/ca.key -pubout -out /tmp/key.pub
  openssl x509 -in /ca-private/ca.crt -pubkey -noout > /tmp/cert.pub
  cmp -s /tmp/key.pub /tmp/cert.pub
  cmp -s /ca-private/ca.crt /ca-public/ca.crt
  exit 0
fi

[ "${1:-}" = "serve" ] || { echo 'uso: proxy-entrypoint serve <tarea|refrescador>' >&2; exit 2; }
profile="${2:-}"
[ "$profile" = "tarea" ] || [ "$profile" = "refrescador" ] || { echo 'perfil inválido' >&2; exit 2; }
[ -r /ca/ca.crt ] && [ -r /ca/ca.key ] || { echo 'CA ausente' >&2; exit 3; }

if [ "$profile" = "tarea" ]; then
  [ -s /secret/access-token ] && [ -s /secret/proxy-token ] || { echo 'secreto del proxy ausente' >&2; exit 4; }
  proxy_token="$(cat /secret/proxy-token)"
  printf %s "$proxy_token" | grep -Eq '^lagrange-falso-[0-9a-f]{48}$' || { echo 'token señuelo inválido' >&2; exit 5; }
  sed "s/__PROXY_TOKEN__/$proxy_token/g" /etc/iron-proxy/proxy-tarea.yaml > /tmp/proxy.yaml
else
  cp /etc/iron-proxy/proxy-refrescador.yaml /tmp/proxy.yaml
fi
chmod 600 /tmp/proxy.yaml
exec iron-proxy -config /tmp/proxy.yaml
