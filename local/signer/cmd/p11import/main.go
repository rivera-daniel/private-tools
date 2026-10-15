// Command p11import imports a PKCS#8 private key and its X.509 certificate into
// a PKCS#11 token under a given CKA_ID and label. It is a test helper for
// SoftHSM tokens.
//
// The user PIN is read from the P11IMPORT_PIN environment variable.
package main

import (
	"encoding/hex"
	"flag"
	"log"
	"os"

	"github.com/miekg/pkcs11"

	"privatetools/signer/internal/p11import"
)

func main() {
	module := flag.String("module", "", "path to the PKCS#11 module")
	tokenLabel := flag.String("token", "", "label of the token to import into")
	keyPath := flag.String("key", "", "PKCS#8 private key (PEM or DER)")
	certPath := flag.String("cert", "", "X.509 certificate (PEM or DER)")
	idHex := flag.String("id", "", "CKA_ID as hex")
	label := flag.String("label", "", "CKA_LABEL for both objects")
	alwaysAuth := flag.Bool("always-authenticate", false, "set CKA_ALWAYS_AUTHENTICATE on the private key")
	flag.Parse()

	pin := os.Getenv("P11IMPORT_PIN")
	if *module == "" || *tokenLabel == "" || *keyPath == "" || *certPath == "" || *idHex == "" || pin == "" {
		log.Fatal("usage: P11IMPORT_PIN=... p11import -module lib.so -token LABEL -key key.pem -cert cert.pem -id HEX [-label NAME] [-always-authenticate]")
	}
	id, err := hex.DecodeString(*idHex)
	if err != nil || len(id) == 0 {
		log.Fatal("-id must be non-empty hex")
	}
	keyData, err := os.ReadFile(*keyPath)
	if err != nil {
		log.Fatal(err)
	}
	key, err := p11import.ParseKey(keyData)
	if err != nil {
		log.Fatalf("parsing key: %v", err)
	}
	certData, err := os.ReadFile(*certPath)
	if err != nil {
		log.Fatal(err)
	}
	cert, err := p11import.ParseCert(certData)
	if err != nil {
		log.Fatalf("parsing certificate: %v", err)
	}

	ctx := pkcs11.New(*module)
	if ctx == nil {
		log.Fatalf("could not load %s", *module)
	}
	if err := ctx.Initialize(); err != nil {
		log.Fatalf("initialize: %v", err)
	}
	defer ctx.Destroy()
	defer ctx.Finalize()

	slot, err := p11import.FindSlot(ctx, *tokenLabel)
	if err != nil {
		log.Fatal(err)
	}
	sh, err := ctx.OpenSession(slot, pkcs11.CKF_SERIAL_SESSION|pkcs11.CKF_RW_SESSION)
	if err != nil {
		log.Fatalf("open session: %v", err)
	}
	defer ctx.CloseSession(sh)
	if err := ctx.Login(sh, pkcs11.CKU_USER, pin); err != nil {
		log.Fatalf("login: %v", err)
	}
	defer ctx.Logout(sh)
	if err := p11import.Import(ctx, sh, key, cert, p11import.Options{ID: id, Label: *label, AlwaysAuthenticate: *alwaysAuth}); err != nil {
		log.Fatal(err)
	}
}
