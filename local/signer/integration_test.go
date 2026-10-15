package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/miekg/pkcs11"

	"privatetools/signer/internal/p11import"
)

// TestSoftHSM signs through a real PKCS#11 module. It runs only when
// SOFTHSM2_MODULE and SOFTHSM2_CONF are set. It points SoftHSM at a fresh
// token directory of its own, so existing tokens are never touched.
func TestSoftHSM(t *testing.T) {
	module := os.Getenv("SOFTHSM2_MODULE")
	if module == "" || os.Getenv("SOFTHSM2_CONF") == "" {
		t.Skip("set SOFTHSM2_MODULE and SOFTHSM2_CONF to run")
	}
	dir := t.TempDir()
	tokens := filepath.Join(dir, "tokens")
	if err := os.Mkdir(tokens, 0o700); err != nil {
		t.Fatal(err)
	}
	conf := filepath.Join(dir, "softhsm2.conf")
	if err := os.WriteFile(conf, []byte("directories.tokendir = "+tokens+"\nobjectstore.backend = file\nlog.level = ERROR\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SOFTHSM2_CONF", conf)

	b, err := loadModule(module)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	ctx := b.ctx

	const soPIN, userPIN, label = "87654321", "123456", "integration"
	slots, err := ctx.GetSlotList(false)
	if err != nil || len(slots) == 0 {
		t.Fatalf("slots: %v %v", slots, err)
	}
	if err := ctx.InitToken(slots[0], soPIN, label); err != nil {
		t.Fatalf("init token: %v", err)
	}
	slot, err := p11import.FindSlot(ctx, label)
	if err != nil {
		t.Fatal(err)
	}
	sh, err := ctx.OpenSession(slot, pkcs11.CKF_SERIAL_SESSION|pkcs11.CKF_RW_SESSION)
	if err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(ctx.Login(sh, pkcs11.CKU_SO, soPIN))
	must(ctx.InitPIN(sh, userPIN))
	must(ctx.Logout(sh))
	must(ctx.Login(sh, pkcs11.CKU_USER, userPIN))
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	must(err)
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(err)
	rsaCert, ecCert := makeCert(t, rsaKey, "RSA Integration"), makeCert(t, ecKey, "EC Integration")
	must(p11import.Import(ctx, sh, rsaKey, rsaCert, p11import.Options{ID: []byte{0x01}, Label: "rsa"}))
	must(p11import.Import(ctx, sh, ecKey, ecCert, p11import.Options{ID: []byte{0x02}, Label: "ec", AlwaysAuthenticate: true}))
	// The EC key must require context-specific login, so that path is exercised.
	keys, err := b.find(sh, keyTemplate([]byte{0x02}), 1)
	must(err)
	attrs, err := ctx.GetAttributeValue(sh, keys[0], []*pkcs11.Attribute{pkcs11.NewAttribute(pkcs11.CKA_ALWAYS_AUTHENTICATE, nil)})
	if err != nil || len(attrs[0].Value) != 1 || attrs[0].Value[0] != 1 {
		t.Fatalf("CKA_ALWAYS_AUTHENTICATE not set: %v", err)
	}
	must(ctx.Logout(sh))
	must(ctx.CloseSession(sh))

	lim := newPinLimiter(3)
	a := &api{backend: b, moduleName: filepath.Base(module), host: testHost, origin: testOrigin, token: testToken, limiter: lim}

	rec := apiRequest(a, http.MethodGet, "/local-signer/status", "", nil)
	var st statusJSON
	must(json.Unmarshal(rec.Body.Bytes(), &st))
	var tok *tokenJSON
	for i := range st.Tokens {
		if st.Tokens[i].Slot == slot {
			tok = &st.Tokens[i]
		}
	}
	if tok == nil || tok.Label != label || len(tok.Certificates) != 2 {
		t.Fatalf("status: %s", rec.Body.String())
	}
	for _, c := range tok.Certificates {
		if !c.HasPrivateKey {
			t.Errorf("certificate %s has no private key", c.ID)
		}
	}

	digest := sha256.Sum256([]byte("integration document"))
	body := func(alg, id, pin string) string {
		m, _ := json.Marshal(map[string]any{"slot": slot, "id": id, "pin": pin, "algorithm": alg, "hash": "SHA-256", "digest": base64.StdEncoding.EncodeToString(digest[:])})
		return string(m)
	}
	for _, c := range [][2]string{{algRSAPKCS1, "01"}, {algRSAPSS, "01"}, {algECDSA256, "02"}} {
		rec := apiRequest(a, http.MethodPost, "/local-signer/sign", body(c[0], c[1], userPIN), nil)
		if rec.Code != 200 {
			t.Errorf("%s: %d %s", c[0], rec.Code, rec.Body.String())
			continue
		}
		sig, _ := base64.StdEncoding.DecodeString(decode(t, rec)["signature"].(string))
		var verr error
		switch c[0] {
		case algRSAPKCS1:
			verr = rsa.VerifyPKCS1v15(&rsaKey.PublicKey, crypto.SHA256, digest[:], sig)
		case algRSAPSS:
			verr = rsa.VerifyPSS(&rsaKey.PublicKey, crypto.SHA256, digest[:], sig, &rsa.PSSOptions{SaltLength: 32})
		case algECDSA256:
			if !ecdsa.VerifyASN1(&ecKey.PublicKey, digest[:], sig) {
				verr = rsa.ErrVerification
			}
		}
		if verr != nil {
			t.Errorf("%s: signature does not verify", c[0])
		}
	}

	rec = apiRequest(a, http.MethodPost, "/local-signer/sign", body(algRSAPKCS1, "01", "000000"), nil)
	if rec.Code != 401 || decode(t, rec)["code"] != "pin_incorrect" {
		t.Errorf("wrong PIN: %d %s", rec.Code, rec.Body.String())
	}
	rec = apiRequest(a, http.MethodPost, "/local-signer/sign", body(algRSAPKCS1, "01", userPIN), nil)
	if rec.Code != 429 {
		t.Errorf("after wrong PIN: %d %s", rec.Code, rec.Body.String())
	}
}
