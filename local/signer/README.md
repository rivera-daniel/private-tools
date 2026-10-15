# Private Tools signer

`private-tools-signer` is a small local program that lets the PDF Editor sign documents with a smart card or USB token (CAC, PIV, national eID cards, YubiKey PIV and other PKCS#11 tokens).

## Why it exists

Web pages cannot use the keys on a smart card. Browsers only use card keys for TLS client-certificate authentication, and that signs the TLS handshake, not a document. To sign a PDF with a card, something outside the browser has to talk to the card.

This program does that. It serves the Private Tools site itself on `127.0.0.1` and adds two same-origin endpoints that list the certificates on your tokens and sign a document digest through a PKCS#11 module such as OpenSC. The PDF itself never leaves the page. Only the 32- or 48-byte digest to be signed is sent to the program.

It is not part of the hosted site. The hosted site is only `site/`. You build and run this program on your own computer when you want to sign with a card.

## Build

Requires Go 1.22 or later and cgo (a C compiler: gcc or clang. On Windows use a MinGW-w64 gcc).

```sh
cd local/signer
go build -trimpath -o private-tools-signer .
# or
./build.sh
```

## Run with a smart card (OpenSC)

1. Install [OpenSC](https://github.com/OpenSC/OpenSC). It supports CAC, PIV and many national eID cards. On Linux also make sure the `pcscd` service is running.
2. Insert the card and start the signer from the repository:

   ```sh
   ./local/signer/private-tools-signer
   ```

   It looks for OpenSC in the usual install locations. If it is not found, or you want a different PKCS#11 library (for example a vendor driver), pass it explicitly:

   ```sh
   ./local/signer/private-tools-signer -module /path/to/opensc-pkcs11.so
   ```

   `PKCS11_MODULE` in the environment works too.
3. Open the printed URL, `http://127.0.0.1:4198/pdf-editor/`.
4. In the PDF Editor's Sign tab, choose **Smart card or USB token**, pick the certificate, confirm the signature and enter the card PIN.

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `-module` | `$PKCS11_MODULE`, then OpenSC locations | PKCS#11 library |
| `-port` | `4198` | Port on 127.0.0.1. `0` picks a free port. |
| `-site` | found by walking up from the program and the working directory | The repository's `site/` directory |
| `-max-pin-failures` | `3` | Wrong PINs per token before PIN entry stops until restart |

## HTTP interface

All endpoints are on `http://127.0.0.1:<port>`. Every request must carry `X-Local-Signer-Token`, whose value the program puts into each page it serves as `<meta name="local-signer-token" content="...">`.

`GET /local-signer/status` lists tokens and their certificates. No PIN is needed.

```json
{ "version": 1, "module": "opensc-pkcs11.so",
  "tokens": [ { "slot": 0, "label": "...", "manufacturer": "...", "model": "...", "serial": "...",
    "loginRequired": true, "protectedAuthPath": false, "pinCountLow": false, "pinFinalTry": false, "pinLocked": false,
    "certificates": [ { "id": "<hex CKA_ID>", "label": "...", "der": "<base64>", "subject": "CN=...", "issuer": "CN=...",
      "notBefore": "<RFC 3339>", "notAfter": "<RFC 3339>", "keyType": "RSA", "keyBits": 2048, "curve": "",
      "algorithms": ["RSASSA-PKCS1-v1_5", "RSA-PSS"], "hasPrivateKey": true } ] } ] }
```

`error` is present when the module could not be found or loaded. Keys other than RSA, P-256 and P-384 are listed with `"algorithms": []`.

`POST /local-signer/sign` with `Content-Type: application/json`:

```json
{ "slot": 0, "id": "<hex CKA_ID>", "pin": "<PIN>", "algorithm": "RSASSA-PKCS1-v1_5", "hash": "SHA-256", "digest": "<base64>" }
```

`algorithm` is `RSASSA-PKCS1-v1_5`, `RSA-PSS` (salt length equals the hash length), `ECDSA-P256` or `ECDSA-P384`. `hash` is `SHA-256` or `SHA-384`. The response is `{ "signature": "<base64>" }`. ECDSA signatures are DER-encoded. Errors are `{ "error": "...", "code": "..." }` with code `bad_request`, `not_found`, `pin_incorrect`, `pin_locked`, `rate_limited`, `token_error` or `forbidden`. A wrong PIN also reports `pinCountLow` and `pinFinalTry`. A rate-limited request reports `retryAfter` in seconds.

## Security model

- **Loopback only.** The program listens on `127.0.0.1` and has no option to listen anywhere else.
- **DNS rebinding and cross-site requests.** Signer requests must have the exact `Host: 127.0.0.1:<port>`. `localhost` and other names are refused. If an `Origin` header is present it must be exactly `http://127.0.0.1:<port>`, and it is required for POST. A `Sec-Fetch-Site` header other than `same-origin` is refused.
- **Per-launch token.** A random 256-bit token is created at each start, put into the pages the program serves (only for requests with the exact Host above), and required on every signer request. It is compared in constant time. Other web sites cannot read it.
- **No CORS.** No `Access-Control-Allow-*` headers are ever sent, and preflight requests are refused.
- **Digest-only signing.** The program signs only a 32-byte SHA-256 or 48-byte SHA-384 digest, never arbitrary data, and only with an algorithm that matches the certificate's key. RSA PKCS#1 v1.5 signatures use a DigestInfo built by the program. Each signature is verified against the certificate before it is returned, so a misbehaving module cannot hand back a bad signature.
- **PIN protection.** After a wrong PIN, further attempts on that token are refused for 2, 4, 8 ... seconds (at most 60). After `-max-pin-failures` wrong PINs (default 3) the program refuses PIN entry for that token until it is restarted, so a page cannot use up the card's own retry counter. A correct PIN resets the count. Token operations are serialized.
- **User confirmation.** The PDF Editor asks you to confirm each signature before it sends the request.
- **No secrets in logs.** Only method, path, status and sizes are logged. PINs, digests, signatures and the token are never logged.
- **PIN transport.** The PIN travels only over the loopback interface to this program, which passes it to the PKCS#11 module.

Anything running on your computer as your user can also talk to the card through the same PKCS#11 module, so the program does not protect against local malware.

## Testing

Unit tests need no PKCS#11 module:

```sh
go test ./...
```

### SoftHSM

[SoftHSM v2](https://github.com/softhsm/SoftHSMv2) provides a software token for testing. Install it from your package manager, or build it into a prefix of your choice:

```sh
./configure --prefix="$PREFIX" --disable-gost --disable-p11-kit
make && make install
```

The integration test runs when both variables are set. It creates its own token in a temporary directory, so existing tokens are not changed:

```sh
SOFTHSM2_MODULE="$PREFIX/lib/softhsm/libsofthsm2.so" SOFTHSM2_CONF="$PREFIX/etc/softhsm2.conf" go test ./...
```

`e2e.sh` runs the whole program against a throwaway token. It generates a test CA with an RSA-2048 and a P-256 certificate, imports them with `cmd/p11import`, starts the signer, runs a curl smoke test (token injection, request checks, each signing algorithm verified with openssl, PIN backoff) and then `tests/browser-pdf-sign.mjs` if present.

```sh
SOFTHSM2_UTIL="$PREFIX/bin/softhsm2-util" ./local/signer/e2e.sh
```

| Variable | Default |
| --- | --- |
| `SOFTHSM2_UTIL` | `softhsm2-util` on `PATH` |
| `SOFTHSM2_MODULE` | `../lib/softhsm/libsofthsm2.so` next to `softhsm2-util`, then common system paths |
| `SIGNER_PORT` | `4198` |

It needs openssl, curl, node and Go.

`cmd/p11import` imports a PKCS#8 private key and its certificate into a token, since `softhsm2-util` cannot import certificates:

```sh
P11IMPORT_PIN=123456 go run ./cmd/p11import -module "$SOFTHSM2_MODULE" -token LABEL -key key.pem -cert cert.pem -id 01 -label "Signing key"
```

## Dependencies

| Module | License |
| --- | --- |
| [github.com/miekg/pkcs11](https://github.com/miekg/pkcs11) | BSD-3-Clause |

Everything else is the Go standard library (BSD-3-Clause). OpenSC (LGPL-2.1) and SoftHSM (BSD-2-Clause) are loaded or run at runtime and are not part of this program.

## Limits

- Signs with RSA (PKCS#1 v1.5, PSS), ECDSA P-256 and P-384 keys. Other curves and Ed25519 are listed but cannot sign.
- Loads one PKCS#11 module per run. Run several instances with different `-module` and `-port` for several drivers.
- Tokens on readers with a PIN pad (protected authentication path) are logged in with an empty PIN, and the PIN is entered on the reader.
- Certificates must be stored on the token as public X.509 certificate objects.
- The page has to be opened from this program (`http://127.0.0.1:<port>`), not from the hosted site.
