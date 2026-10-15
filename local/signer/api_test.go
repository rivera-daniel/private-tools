package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testToken  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testOrigin = "http://" + testHost
	testPIN    = "123456"
)

type fakeKey struct {
	id   []byte
	key  crypto.Signer
	cert *x509.Certificate
}

// fakeBackend behaves like a PKCS#11 token: RSA signs the given data with raw
// PKCS#1 padding, ECDSA returns r||s.
type fakeBackend struct {
	mu        sync.Mutex
	keys      []fakeKey
	protected bool
	finalTry  bool
	locked    bool
	corrupt   bool
	signCalls int
	delay     time.Duration
}

func makeCert(t *testing.T, key crypto.Signer, cn string) *x509.Certificate {
	t.Helper()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert
}

var (
	keysOnce sync.Once
	rsaKey   *rsa.PrivateKey
	p256Key  *ecdsa.PrivateKey
	p384Key  *ecdsa.PrivateKey
	p521Key  *ecdsa.PrivateKey
	edKey    ed25519.PrivateKey
)

func newFake(t *testing.T) *fakeBackend {
	t.Helper()
	keysOnce.Do(func() {
		rsaKey, _ = rsa.GenerateKey(rand.Reader, 2048)
		p256Key, _ = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		p384Key, _ = ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
		p521Key, _ = ecdsa.GenerateKey(elliptic.P521(), rand.Reader)
		_, edKey, _ = ed25519.GenerateKey(rand.Reader)
	})
	return &fakeBackend{keys: []fakeKey{
		{[]byte{0x01}, rsaKey, makeCert(t, rsaKey, "RSA Test")},
		{[]byte{0x02}, p256Key, makeCert(t, p256Key, "P256 Test")},
		{[]byte{0x03}, p384Key, makeCert(t, p384Key, "P384 Test")},
		{[]byte{0x04}, p521Key, makeCert(t, p521Key, "P521 Test")},
		{[]byte{0x05}, edKey, makeCert(t, edKey, "Ed25519 Test")},
	}}
}

func (f *fakeBackend) token() RawToken {
	t := RawToken{Slot: 7, Label: "Test Token", Manufacturer: "Example", Model: "Fake", Serial: "42",
		LoginRequired: true, ProtectedAuthPath: f.protected, PinFinalTry: f.finalTry, PinLocked: f.locked}
	for _, k := range f.keys {
		t.Certs = append(t.Certs, RawCert{ID: k.id, Label: k.cert.Subject.CommonName, DER: k.cert.Raw})
	}
	return t
}

func (f *fakeBackend) Tokens() ([]RawToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return []RawToken{f.token()}, nil
}

func (f *fakeBackend) Token(slot uint) (RawToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if slot != 7 {
		return RawToken{}, ErrKeyNotFound
	}
	return f.token(), nil
}

func (f *fakeBackend) Sign(slot uint, id []byte, pin string, mech Mechanism, data []byte) ([]byte, error) {
	time.Sleep(f.delay)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.signCalls++
	if pin != testPIN && !(f.protected && pin == "") {
		f.finalTry = true
		return nil, ErrPinIncorrect
	}
	for _, k := range f.keys {
		if string(k.id) != string(id) {
			continue
		}
		var sig []byte
		var err error
		switch key := k.key.(type) {
		case *rsa.PrivateKey:
			if mech.Algorithm == algRSAPSS {
				h := hashByName[mech.HashName]
				sig, err = rsa.SignPSS(rand.Reader, key, h, data, &rsa.PSSOptions{SaltLength: h.Size()})
			} else {
				sig, err = rsa.SignPKCS1v15(rand.Reader, key, 0, data)
			}
		case *ecdsa.PrivateKey:
			r, s, e := ecdsa.Sign(rand.Reader, key, data)
			size := (key.Curve.Params().BitSize + 7) / 8
			sig, err = append(r.FillBytes(make([]byte, size)), s.FillBytes(make([]byte, size))...), e
		}
		if f.corrupt && err == nil {
			sig[len(sig)/2] ^= 0xff
		}
		return sig, err
	}
	return nil, ErrKeyNotFound
}

func newTestAPI(t *testing.T) (*api, *fakeBackend, *time.Time) {
	f := newFake(t)
	now := time.Unix(1_000_000, 0)
	lim := newPinLimiter(3)
	lim.now = func() time.Time { return now }
	a := &api{backend: f, moduleName: "fake.so", host: testHost, origin: testOrigin, token: testToken, limiter: lim}
	return a, f, &now
}

func apiRequest(h http.Handler, method, path, body string, mod func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://"+testHost+path, strings.NewReader(body))
	req.Host = testHost
	req.Header.Set("X-Local-Signer-Token", testToken)
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	if mod != nil {
		mod(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("bad JSON %q: %v", rec.Body.String(), err)
	}
	return m
}

func TestRequestChecks(t *testing.T) {
	a, _, _ := newTestAPI(t)
	cases := map[string]func(*http.Request){
		"localhost host":    func(r *http.Request) { r.Host = "localhost:4198" },
		"other host":        func(r *http.Request) { r.Host = "attacker.example:4198" },
		"host without port": func(r *http.Request) { r.Host = "127.0.0.1" },
		"wrong port":        func(r *http.Request) { r.Host = "127.0.0.1:4199" },
		"cross origin":      func(r *http.Request) { r.Header.Set("Origin", "https://attacker.example") },
		"null origin":       func(r *http.Request) { r.Header.Set("Origin", "null") },
		"localhost origin":  func(r *http.Request) { r.Header.Set("Origin", "http://localhost:4198") },
		"cross site":        func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		"same site":         func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") },
		"missing token":     func(r *http.Request) { r.Header.Del("X-Local-Signer-Token") },
		"wrong token":       func(r *http.Request) { r.Header.Set("X-Local-Signer-Token", strings.Repeat("0", 64)) },
		"token prefix":      func(r *http.Request) { r.Header.Set("X-Local-Signer-Token", testToken[:32]) },
		"duplicated origin": func(r *http.Request) { r.Header.Add("Origin", testOrigin) },
	}
	for name, mod := range cases {
		rec := apiRequest(a, http.MethodGet, "/local-signer/status", "", mod)
		if rec.Code != http.StatusForbidden || decode(t, rec)["code"] != "forbidden" {
			t.Errorf("%s: got %d %s", name, rec.Code, rec.Body.String())
		}
	}
	// GET without Origin or Sec-Fetch-Site is allowed; POST without Origin is not.
	rec := apiRequest(a, http.MethodGet, "/local-signer/status", "", func(r *http.Request) {
		r.Header.Del("Origin")
		r.Header.Del("Sec-Fetch-Site")
	})
	if rec.Code != 200 {
		t.Errorf("plain GET: %d", rec.Code)
	}
	rec = apiRequest(a, http.MethodPost, "/local-signer/sign", "{}", func(r *http.Request) { r.Header.Del("Origin") })
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST without Origin: %d", rec.Code)
	}
	rec = apiRequest(a, http.MethodOptions, "/local-signer/sign", "", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("OPTIONS: %d", rec.Code)
	}
	rec = apiRequest(a, http.MethodGet, "/local-signer/sign", "", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET sign: %d", rec.Code)
	}
	rec = apiRequest(a, http.MethodGet, "/local-signer/other", "", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown endpoint: %d", rec.Code)
	}
	for k := range rec.Header() {
		if strings.HasPrefix(strings.ToLower(k), "access-control-") {
			t.Errorf("CORS header %s", k)
		}
	}
	if rec.Header().Get("Content-Type") != "application/json" || rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("response headers: %v", rec.Header())
	}
}

func TestStatus(t *testing.T) {
	a, _, _ := newTestAPI(t)
	rec := apiRequest(a, http.MethodGet, "/local-signer/status", "", nil)
	if rec.Code != 200 {
		t.Fatalf("status: %d", rec.Code)
	}
	var st statusJSON
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st.Version != 1 || st.Module != "fake.so" || len(st.Tokens) != 1 || strings.Contains(rec.Body.String(), `"error"`) {
		t.Fatalf("status: %s", rec.Body.String())
	}
	tok := st.Tokens[0]
	if tok.Slot != 7 || !tok.LoginRequired || len(tok.Certificates) != 5 {
		t.Fatalf("token: %+v", tok)
	}
	want := []struct {
		keyType, curve, algs string
		bits                 int
	}{
		{"RSA", "", "RSASSA-PKCS1-v1_5,RSA-PSS", 2048},
		{"EC", "P-256", "ECDSA-P256", 256},
		{"EC", "P-384", "ECDSA-P384", 384},
		{"EC", "", "", 521},
		{"", "", "", 0},
	}
	for i, c := range tok.Certificates {
		w := want[i]
		if c.KeyType != w.keyType || c.Curve != w.curve || strings.Join(c.Algorithms, ",") != w.algs || c.KeyBits != w.bits || !c.HasPrivateKey {
			t.Errorf("cert %d: %+v", i, c)
		}
		if c.Algorithms == nil || c.ID == "" || c.DER == "" || !strings.HasPrefix(c.Subject, "CN=") {
			t.Errorf("cert %d fields: %+v", i, c)
		}
	}
	if !strings.Contains(rec.Body.String(), `"algorithms":[]`) || !strings.Contains(rec.Body.String(), `"curve":""`) {
		t.Errorf("empty fields must be present: %s", rec.Body.String())
	}
}

func TestStatusNoModule(t *testing.T) {
	a := &api{backend: noModule{"install OpenSC"}, host: testHost, origin: testOrigin, token: testToken, limiter: newPinLimiter(3)}
	rec := apiRequest(a, http.MethodGet, "/local-signer/status", "", nil)
	if rec.Body.String() != `{"version":1,"module":"","error":"install OpenSC","tokens":[]}`+"\n" {
		t.Errorf("got %s", rec.Body.String())
	}
}

func TestHasPrivateKey(t *testing.T) {
	if hasPrivateKey(RawToken{}, RawCert{ID: []byte{1}}) {
		t.Error("no login, not visible")
	}
	if !hasPrivateKey(RawToken{}, RawCert{ID: []byte{1}, PrivateKeyVisible: true}) {
		t.Error("visible")
	}
	if !hasPrivateKey(RawToken{LoginRequired: true}, RawCert{ID: []byte{1}}) {
		t.Error("hidden behind login")
	}
	if hasPrivateKey(RawToken{LoginRequired: true}, RawCert{}) {
		t.Error("empty id")
	}
}

func signBody(alg, hash string, digest []byte, id, pin string) string {
	b, _ := json.Marshal(map[string]any{"slot": 7, "id": id, "pin": pin, "algorithm": alg, "hash": hash, "digest": base64.StdEncoding.EncodeToString(digest)})
	return string(b)
}

func TestSignSuccess(t *testing.T) {
	a, f, _ := newTestAPI(t)
	d256 := sha256.Sum256([]byte("document"))
	d384 := sha512.Sum384([]byte("document"))
	cases := []struct {
		alg, hash, id string
		digest        []byte
		key           int
	}{
		{algRSAPKCS1, "SHA-256", "01", d256[:], 0},
		{algRSAPKCS1, "SHA-384", "01", d384[:], 0},
		{algRSAPSS, "SHA-256", "01", d256[:], 0},
		{algRSAPSS, "SHA-384", "01", d384[:], 0},
		{algECDSA256, "SHA-256", "02", d256[:], 1},
		{algECDSA384, "SHA-384", "03", d384[:], 2},
		{algECDSA384, "SHA-256", "03", d256[:], 2},
	}
	for _, c := range cases {
		rec := apiRequest(a, http.MethodPost, "/local-signer/sign", signBody(c.alg, c.hash, c.digest, c.id, testPIN), nil)
		if rec.Code != 200 {
			t.Errorf("%s %s: %d %s", c.alg, c.hash, rec.Code, rec.Body.String())
			continue
		}
		sig, err := base64.StdEncoding.DecodeString(decode(t, rec)["signature"].(string))
		if err != nil {
			t.Fatal(err)
		}
		h := hashByName[c.hash]
		switch pub := f.keys[c.key].cert.PublicKey.(type) {
		case *rsa.PublicKey:
			if c.alg == algRSAPSS {
				err = rsa.VerifyPSS(pub, h, c.digest, sig, &rsa.PSSOptions{SaltLength: h.Size()})
			} else {
				err = rsa.VerifyPKCS1v15(pub, h, c.digest, sig)
			}
		case *ecdsa.PublicKey:
			if !ecdsa.VerifyASN1(pub, c.digest, sig) {
				err = rsa.ErrVerification
			}
		}
		if err != nil {
			t.Errorf("%s %s: signature does not verify", c.alg, c.hash)
		}
	}
}

func TestSignValidation(t *testing.T) {
	a, f, _ := newTestAPI(t)
	d := make([]byte, 32)
	d48 := make([]byte, 48)
	cases := []struct {
		name, body string
		mod        func(*http.Request)
		status     int
		code       string
	}{
		{"short digest", signBody(algRSAPKCS1, "SHA-256", d[:31], "01", testPIN), nil, 400, "bad_request"},
		{"long digest", signBody(algRSAPKCS1, "SHA-256", d48, "01", testPIN), nil, 400, "bad_request"},
		{"sha384 with 32 bytes", signBody(algRSAPKCS1, "SHA-384", d, "01", testPIN), nil, 400, "bad_request"},
		{"sha512", signBody(algRSAPKCS1, "SHA-512", make([]byte, 64), "01", testPIN), nil, 400, "bad_request"},
		{"unknown algorithm", signBody("RSA-RAW", "SHA-256", d, "01", testPIN), nil, 400, "bad_request"},
		{"ecdsa on rsa", signBody(algECDSA256, "SHA-256", d, "01", testPIN), nil, 400, "bad_request"},
		{"rsa on ec", signBody(algRSAPKCS1, "SHA-256", d, "02", testPIN), nil, 400, "bad_request"},
		{"p384 alg on p256", signBody(algECDSA384, "SHA-256", d, "02", testPIN), nil, 400, "bad_request"},
		{"p256 alg on p384", signBody(algECDSA256, "SHA-256", d, "03", testPIN), nil, 400, "bad_request"},
		{"p521 key", signBody(algECDSA256, "SHA-256", d, "04", testPIN), nil, 400, "bad_request"},
		{"ed25519 key", signBody(algECDSA256, "SHA-256", d, "05", testPIN), nil, 400, "bad_request"},
		{"unknown id", signBody(algRSAPKCS1, "SHA-256", d, "09", testPIN), nil, 404, "not_found"},
		{"unknown slot", strings.Replace(signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), `"slot":7`, `"slot":8`, 1), nil, 404, "not_found"},
		{"bad id hex", signBody(algRSAPKCS1, "SHA-256", d, "zz", testPIN), nil, 400, "bad_request"},
		{"empty id", signBody(algRSAPKCS1, "SHA-256", d, "", testPIN), nil, 400, "bad_request"},
		{"empty pin", signBody(algRSAPKCS1, "SHA-256", d, "01", ""), nil, 400, "bad_request"},
		{"long pin", signBody(algRSAPKCS1, "SHA-256", d, "01", strings.Repeat("1", 65)), nil, 400, "bad_request"},
		{"bad base64", strings.Replace(signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), `"digest":"`, `"digest":"*`, 1), nil, 400, "bad_request"},
		{"unknown field", strings.Replace(signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), `{`, `{"data":"AA==",`, 1), nil, 400, "bad_request"},
		{"missing slot", strings.Replace(signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), `,"slot":7`, ``, 1), nil, 400, "bad_request"},
		{"negative slot", strings.Replace(signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), `"slot":7`, `"slot":-1`, 1), nil, 400, "bad_request"},
		{"trailing data", signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN) + "{}", nil, 400, "bad_request"},
		{"not json", "slot=7", nil, 400, "bad_request"},
		{"text/plain", signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415, "bad_request"},
		{"no content type", signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), func(r *http.Request) { r.Header.Del("Content-Type") }, 415, "bad_request"},
		{"too large", strings.Replace(signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), `"pin"`, strings.Repeat(" ", maxSignBody)+`"pin"`, 1), nil, 413, "bad_request"},
	}
	for _, c := range cases {
		rec := apiRequest(a, http.MethodPost, "/local-signer/sign", c.body, c.mod)
		if rec.Code != c.status || decode(t, rec)["code"] != c.code {
			t.Errorf("%s: got %d %s", c.name, rec.Code, rec.Body.String())
		}
	}
	if f.signCalls != 0 {
		t.Errorf("token used %d times for invalid requests", f.signCalls)
	}
	// JSON with a charset parameter is accepted.
	rec := apiRequest(a, http.MethodPost, "/local-signer/sign", signBody(algRSAPKCS1, "SHA-256", d, "01", testPIN), func(r *http.Request) {
		r.Header.Set("Content-Type", "application/json; charset=utf-8")
	})
	if rec.Code != 200 {
		t.Errorf("charset: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSignProtectedAuthPath(t *testing.T) {
	a, f, _ := newTestAPI(t)
	f.protected = true
	rec := apiRequest(a, http.MethodPost, "/local-signer/sign", signBody(algECDSA256, "SHA-256", make([]byte, 32), "02", ""), nil)
	if rec.Code != 200 {
		t.Errorf("protected path with empty PIN: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSignMisbehavingModule(t *testing.T) {
	a, f, _ := newTestAPI(t)
	f.corrupt = true
	for _, c := range [][2]string{{algRSAPKCS1, "01"}, {algRSAPSS, "01"}, {algECDSA256, "02"}} {
		rec := apiRequest(a, http.MethodPost, "/local-signer/sign", signBody(c[0], "SHA-256", make([]byte, 32), c[1], testPIN), nil)
		if rec.Code != http.StatusBadGateway || decode(t, rec)["code"] != "token_error" {
			t.Errorf("%s: %d %s", c[0], rec.Code, rec.Body.String())
		}
	}
}

func TestSignPinLocked(t *testing.T) {
	a, f, _ := newTestAPI(t)
	f.locked = true
	rec := apiRequest(a, http.MethodPost, "/local-signer/sign", signBody(algRSAPKCS1, "SHA-256", make([]byte, 32), "01", testPIN), nil)
	if rec.Code != http.StatusLocked || decode(t, rec)["code"] != "pin_locked" || f.signCalls != 0 {
		t.Errorf("locked: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSignPinRateLimit(t *testing.T) {
	a, f, now := newTestAPI(t)
	body := func(pin string) string { return signBody(algRSAPKCS1, "SHA-256", make([]byte, 32), "01", pin) }
	post := func(pin string) (int, map[string]any) {
		rec := apiRequest(a, http.MethodPost, "/local-signer/sign", body(pin), nil)
		return rec.Code, decode(t, rec)
	}

	code, m := post("000000")
	if code != 401 || m["code"] != "pin_incorrect" || m["pinFinalTry"] != true || m["pinCountLow"] != false {
		t.Fatalf("first wrong PIN: %d %v", code, m)
	}
	code, m = post(testPIN)
	if code != 429 || m["code"] != "rate_limited" || m["retryAfter"] != float64(2) {
		t.Fatalf("during backoff: %d %v", code, m)
	}
	*now = now.Add(2 * time.Second)
	if code, m = post("000000"); code != 401 {
		t.Fatalf("second wrong PIN: %d %v", code, m)
	}
	if code, m = post(testPIN); m["retryAfter"] != float64(4) {
		t.Fatalf("second backoff: %d %v", code, m)
	}
	*now = now.Add(4 * time.Second)
	if code, m = post(testPIN); code != 200 {
		t.Fatalf("correct PIN: %d %v", code, m)
	}
	// The counter was reset: three more wrong PINs stop the slot.
	for i := 0; i < 3; i++ {
		*now = now.Add(time.Minute)
		code, m = post("000000")
		if code != 401 {
			t.Fatalf("wrong PIN %d: %d %v", i, code, m)
		}
	}
	if !strings.Contains(strings.ToLower(m["error"].(string)), "restart") {
		t.Errorf("final failure message: %v", m)
	}
	calls := f.signCalls
	*now = now.Add(time.Hour)
	code, m = post(testPIN)
	if code != 429 || m["retryAfter"] != nil || !strings.Contains(strings.ToLower(m["error"].(string)), "restart") || f.signCalls != calls {
		t.Errorf("after max failures: %d %v", code, m)
	}
}

func TestSignConcurrentWrongPins(t *testing.T) {
	a, f, _ := newTestAPI(t)
	f.delay = 50 * time.Millisecond
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = apiRequest(a, http.MethodPost, "/local-signer/sign", signBody(algRSAPKCS1, "SHA-256", make([]byte, 32), "01", "000000"), nil).Code
		}(i)
	}
	wg.Wait()
	if !(codes[0] == 401 && codes[1] == 429) && !(codes[0] == 429 && codes[1] == 401) {
		t.Errorf("codes %v", codes)
	}
	if f.signCalls != 1 {
		t.Errorf("PIN tried %d times", f.signCalls)
	}
}

func TestHandlerRouting(t *testing.T) {
	a, _, _ := newTestAPI(t)
	h := newHandler(a, newTestSite(t))
	if rec := apiRequest(h, http.MethodGet, "/local-signer/status", "", nil); rec.Code != 200 {
		t.Errorf("api: %d", rec.Code)
	}
	if rec := apiRequest(h, http.MethodGet, "/", "", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "local-signer-token") {
		t.Errorf("static: %d", rec.Code)
	}
}
