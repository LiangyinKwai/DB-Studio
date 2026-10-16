#!/bin/sh
set -eu
export LC_ALL=C

# Start an isolated Redis TLS server and run the real Rust adapter against it.
# The server listens only on loopback and is removed on exit. No user Redis
# endpoint or credentials are read by this script.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REDIS_SERVER=$(command -v redis-server || true)
REDIS_CLI=$(command -v redis-cli || true)
OPENSSL=$(command -v openssl || true)
PYTHON=$(command -v python3 || true)
if [ -z "$REDIS_SERVER" ] || [ -z "$REDIS_CLI" ] || [ -z "$OPENSSL" ] || [ -z "$PYTHON" ]; then
  echo "verify-redis requires redis-server, redis-cli, openssl, and python3" >&2
  exit 2
fi

TMPBASE=$(printenv TMPDIR || true)
if [ -z "$TMPBASE" ]; then TMPBASE=/tmp; fi
TMP=$(mktemp -d "$TMPBASE/db-studio-redis.XXXXXX")
TLS_PORT=$("$PYTHON" - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)
PIDFILE="$TMP/redis.pid"
LOGFILE="$TMP/redis.log"
CA_KEY="$TMP/ca.key"
CA_CERT="$TMP/ca.crt"
BAD_CA_KEY="$TMP/bad-ca.key"
BAD_CA_CERT="$TMP/bad-ca.crt"
SERVER_KEY="$TMP/server.key"
SERVER_CSR="$TMP/server.csr"
SERVER_CERT="$TMP/server.crt"
SERVER_EXT="$TMP/server.ext"

cleanup() {
  "$REDIS_CLI" --tls --cacert "$CA_CERT" -h localhost -p "$TLS_PORT" shutdown nosave >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

umask 077
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -keyout "$CA_KEY" -out "$CA_CERT" -subj "/CN=DB Studio Redis test CA" >/dev/null 2>&1
"$OPENSSL" req -newkey rsa:2048 -nodes -sha256 -keyout "$SERVER_KEY" -out "$SERVER_CSR" -subj "/CN=localhost" >/dev/null 2>&1
cat >"$SERVER_EXT" <<'EOF'
subjectAltName = DNS:localhost
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF
"$OPENSSL" x509 -req -sha256 -days 1 -in "$SERVER_CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial -out "$SERVER_CERT" -extfile "$SERVER_EXT" >/dev/null 2>&1
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -keyout "$BAD_CA_KEY" -out "$BAD_CA_CERT" -subj "/CN=DB Studio unrelated CA" >/dev/null 2>&1

"$REDIS_SERVER" --bind 127.0.0.1 --port 0 --tls-port "$TLS_PORT" --tls-cert-file "$SERVER_CERT" --tls-key-file "$SERVER_KEY" --tls-ca-cert-file "$CA_CERT" --tls-auth-clients no --save "" --appendonly no --dir "$TMP" --dbfilename dump.rdb --pidfile "$PIDFILE" --logfile "$LOGFILE" --daemonize yes

ready=false
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if SSL_CERT_FILE="$CA_CERT" "$REDIS_CLI" --tls --cacert "$CA_CERT"   -h localhost -p "$TLS_PORT" ping 2>/dev/null | grep -q '^PONG$'; then
    ready=true
    break
  fi
  sleep 0.1
done
if [ "$ready" != true ]; then
  echo "Redis TLS server did not become ready" >&2
  cat "$LOGFILE" >&2 || true
  exit 1
fi

echo "Redis TLS server ready on localhost:$TLS_PORT"
echo "Running Rust adapter contract (trusted TLS, hostname/CA rejection, SCAN/string/hash/edit/rename/delete)…"
set +e
LC_ALL=C DB_STUDIO_REDIS_TLS_PORT="$TLS_PORT" DB_STUDIO_REDIS_CA_FILE="$CA_CERT" DB_STUDIO_REDIS_BAD_CA_FILE="$BAD_CA_CERT" SSL_CERT_FILE="$CA_CERT" cargo test --locked --manifest-path "$ROOT/src-tauri/Cargo.toml" --test redis_runtime redis_runtime_contract -- --ignored --nocapture
STATUS=$?
set -e
if [ "$STATUS" -eq 0 ]; then
  echo "Redis runtime verification passed"
else
  echo "Redis runtime verification failed (status $STATUS)" >&2
  cat "$LOGFILE" >&2 || true
fi
exit "$STATUS"
