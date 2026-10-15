#!/usr/bin/env bash
# End-to-end test of private-tools-signer against a throwaway SoftHSM token.
#
# Needs softhsm2-util and the SoftHSM PKCS#11 module, openssl, curl, node and Go
# (or mise). Environment:
#   SOFTHSM2_UTIL    softhsm2-util binary (default: from PATH)
#   SOFTHSM2_MODULE  libsofthsm2 module (default: next to softhsm2-util, then common system paths)
#   SIGNER_PORT      port for the signer (default 4198)
#
# Steps: create a token in a temporary directory, generate a test CA with an
# RSA-2048 and a P-256 signing certificate, import them, start the signer, run
# a curl smoke test, then tests/browser-pdf-sign.mjs if it exists.
set -euo pipefail

SIGNER_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SIGNER_DIR/../.." && pwd)"

SOFTHSM2_UTIL="${SOFTHSM2_UTIL:-$(command -v softhsm2-util || true)}"
if [ -z "$SOFTHSM2_UTIL" ] || [ ! -x "$SOFTHSM2_UTIL" ]; then
  echo "softhsm2-util not found; set SOFTHSM2_UTIL" >&2
  exit 1
fi
if [ -z "${SOFTHSM2_MODULE:-}" ]; then
  for candidate in \
    "$(dirname "$SOFTHSM2_UTIL")/../lib/softhsm/libsofthsm2.so" \
    /usr/lib/softhsm/libsofthsm2.so \
    /usr/lib64/softhsm/libsofthsm2.so \
    /usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so \
    /usr/lib/aarch64-linux-gnu/softhsm/libsofthsm2.so \
    /usr/local/lib/softhsm/libsofthsm2.so \
    /opt/homebrew/lib/softhsm/libsofthsm2.so; do
    if [ -f "$candidate" ]; then
      SOFTHSM2_MODULE="$candidate"
      break
    fi
  done
fi
if [ -z "${SOFTHSM2_MODULE:-}" ] || [ ! -f "$SOFTHSM2_MODULE" ]; then
  echo "SoftHSM module not found; set SOFTHSM2_MODULE" >&2
  exit 1
fi
if command -v go >/dev/null 2>&1; then
  GO=(go)
elif command -v mise >/dev/null 2>&1; then
  GO=(mise exec go@latest -- go)
else
  echo "Go is required" >&2
  exit 1
fi
for tool in openssl curl node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

PORT="${SIGNER_PORT:-4198}"
BASE="http://127.0.0.1:$PORT"
SO_PIN=12345678
USER_PIN=123456
TOKEN_LABEL=private-tools-test

WORK="$(mktemp -d)"
SIGNER_PID=""
cleanup() {
  status=$?
  if [ -n "$SIGNER_PID" ]; then
    kill "$SIGNER_PID" 2>/dev/null || true
    wait "$SIGNER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$WORK/signer.log" ]; then
    echo "--- signer log ---" >&2
    tail -n 30 "$WORK/signer.log" >&2
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== SoftHSM token"
mkdir "$WORK/tokens"
cat >"$WORK/softhsm2.conf" <<EOF
directories.tokendir = $WORK/tokens
objectstore.backend = file
log.level = ERROR
EOF
export SOFTHSM2_CONF="$WORK/softhsm2.conf"
"$SOFTHSM2_UTIL" --init-token --free --label "$TOKEN_LABEL" --so-pin "$SO_PIN" --pin "$USER_PIN" >/dev/null

echo "== Test certificates"
cd "$WORK"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key 2>/dev/null
openssl req -x509 -new -key ca.key -subj "/CN=Private Tools Test CA" -days 2 -out ca.pem \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n' >leaf.ext
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out rsa.key 2>/dev/null
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ec.key 2>/dev/null
for name in rsa ec; do
  openssl req -new -key "$name.key" -subj "/CN=Private Tools Test Signer $name" -out "$name.csr"
  openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca.key -set_serial "0x$(openssl rand -hex 8)" \
    -days 2 -extfile leaf.ext -out "$name.pem" 2>/dev/null
  openssl x509 -in "$name.pem" -pubkey -noout >"$name.pub"
done

echo "== Build"
(cd "$SIGNER_DIR" && "${GO[@]}" build -trimpath -o "$WORK/private-tools-signer" . && "${GO[@]}" build -trimpath -o "$WORK/p11import" ./cmd/p11import)

echo "== Import"
P11IMPORT_PIN="$USER_PIN" "$WORK/p11import" -module "$SOFTHSM2_MODULE" -token "$TOKEN_LABEL" -key rsa.key -cert rsa.pem -id 01 -label "Test RSA"
# The EC key requires login for every signature, like PIV signing keys.
P11IMPORT_PIN="$USER_PIN" "$WORK/p11import" -module "$SOFTHSM2_MODULE" -token "$TOKEN_LABEL" -key ec.key -cert ec.pem -id 02 -label "Test EC" -always-authenticate

echo "== Start signer on port $PORT"
"$WORK/private-tools-signer" -port "$PORT" -module "$SOFTHSM2_MODULE" -site "$REPO_ROOT/site" >"$WORK/signer.log" 2>&1 &
SIGNER_PID=$!
for _ in $(seq 1 50); do
  kill -0 "$SIGNER_PID" 2>/dev/null || fail "signer exited"
  if curl -sf -o /dev/null "$BASE/tools/"; then break; fi
  sleep 0.2
done
curl -sf -o /dev/null "$BASE/tools/" || fail "signer did not start"

echo "== Curl smoke test"
page="$BASE/tools/pdf-editor/"
curl -sf -o /dev/null "$page" || page="$BASE/tools/"
TOKEN="$(curl -sf "$page" | grep -o 'name="local-signer-token" content="[0-9a-f]*"' | sed 's/.*content="//; s/"$//')"
[ "${#TOKEN}" -eq 64 ] || fail "no signer token in $page"
echo "ok   token injected into $page"

json() { node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8')); $1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

curl -sf -H "X-Local-Signer-Token: $TOKEN" "$BASE/local-signer/status" >status.json
SLOT="$(json "
  const t = r.tokens.find((t) => t.label === '$TOKEN_LABEL');
  if (!t) throw new Error('token missing from status');
  const rsa = t.certificates.find((c) => c.id === '01'), ec = t.certificates.find((c) => c.id === '02');
  if (!rsa || rsa.keyType !== 'RSA' || rsa.keyBits !== 2048 || rsa.algorithms.join() !== 'RSASSA-PKCS1-v1_5,RSA-PSS' || !rsa.hasPrivateKey) throw new Error('bad RSA entry');
  if (!ec || ec.curve !== 'P-256' || ec.algorithms.join() !== 'ECDSA-P256' || !ec.hasPrivateKey) throw new Error('bad EC entry');
  process.stdout.write(String(t.slot));
" <status.json)"
echo "ok   status lists both certificates (slot $SLOT)"

[ "$(code "$BASE/local-signer/status")" = 403 ] || fail "status without token not refused"
[ "$(code -H "X-Local-Signer-Token: $TOKEN" -H "Host: localhost:$PORT" "$BASE/local-signer/status")" = 403 ] || fail "wrong Host not refused"
[ "$(code -H "X-Local-Signer-Token: $TOKEN" -H "Origin: https://attacker.example" "$BASE/local-signer/status")" = 403 ] || fail "cross origin not refused"
[ "$(code -X OPTIONS "$BASE/local-signer/sign")" = 405 ] || fail "OPTIONS not refused"
echo "ok   token, Host, Origin and OPTIONS checks"

printf 'Private Tools end-to-end test document\n' >data.txt
DIGEST="$(openssl dgst -sha256 -binary data.txt | openssl base64 -A)"

sign() { # algorithm id pin [digest]
  curl -s -o response.json -w '%{http_code}' -X POST "$BASE/local-signer/sign" \
    -H "X-Local-Signer-Token: $TOKEN" -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" \
    -H "Content-Type: application/json" \
    --data "{\"slot\":$SLOT,\"id\":\"$2\",\"pin\":\"$3\",\"algorithm\":\"$1\",\"hash\":\"SHA-256\",\"digest\":\"${4:-$DIGEST}\"}"
}

[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/local-signer/sign" -H "X-Local-Signer-Token: $TOKEN" -H "Content-Type: application/json" --data '{}')" = 403 ] || fail "POST without Origin not refused"
[ "$(sign RSASSA-PKCS1-v1_5 01 "$USER_PIN" "$(head -c 31 /dev/zero | openssl base64 -A)")" = 400 ] || fail "short digest not refused"
[ "$(sign ECDSA-P256 01 "$USER_PIN")" = 400 ] || fail "ECDSA with an RSA key not refused"
echo "ok   request validation"

for spec in "RSASSA-PKCS1-v1_5 01 rsa" "RSA-PSS 01 rsa" "ECDSA-P256 02 ec"; do
  set -- $spec
  status="$(sign "$1" "$2" "$USER_PIN")"
  [ "$status" = 200 ] || fail "$1 returned $status: $(cat response.json)"
  json "process.stdout.write(r.signature)" <response.json | openssl base64 -d -A >sig.bin
  opts=()
  [ "$1" = RSA-PSS ] && opts=(-sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:32)
  openssl dgst -sha256 -verify "$3.pub" ${opts[@]+"${opts[@]}"} -signature sig.bin data.txt >/dev/null || fail "$1 signature does not verify"
  echo "ok   $1 signature verified with openssl"
done

status="$(sign RSASSA-PKCS1-v1_5 01 000000)"
[ "$status" = 401 ] && [ "$(json "process.stdout.write(r.code)" <response.json)" = pin_incorrect ] || fail "wrong PIN returned $status"
status="$(sign RSASSA-PKCS1-v1_5 01 "$USER_PIN")"
[ "$status" = 429 ] || fail "no rate limit after a wrong PIN ($status)"
sleep 2.2
[ "$(sign RSASSA-PKCS1-v1_5 01 "$USER_PIN")" = 200 ] || fail "correct PIN after backoff failed"
echo "ok   wrong PIN, backoff and reset"

if [ -f "$REPO_ROOT/tests/browser-pdf-sign.mjs" ]; then
  echo "== Browser test"
  (cd "$REPO_ROOT" && BASE="$BASE" SIGNER_PIN="$USER_PIN" node tests/browser-pdf-sign.mjs)
else
  echo "== tests/browser-pdf-sign.mjs not found; curl smoke test only"
fi
echo "PASS"
