// Package p11import writes a private key and its certificate into a PKCS#11
// token. It is used to prepare SoftHSM test tokens.
package p11import

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/miekg/pkcs11"
)

var curveOIDs = map[elliptic.Curve]asn1.ObjectIdentifier{
	elliptic.P256(): {1, 2, 840, 10045, 3, 1, 7},
	elliptic.P384(): {1, 3, 132, 0, 34},
	elliptic.P521(): {1, 3, 132, 0, 35},
}

// Options controls how the key object is created.
type Options struct {
	ID    []byte
	Label string
	// AlwaysAuthenticate sets CKA_ALWAYS_AUTHENTICATE on the private key.
	AlwaysAuthenticate bool
}

// ParseKey accepts a PKCS#8 private key in PEM or DER form.
func ParseKey(data []byte) (any, error) {
	if b, _ := pem.Decode(data); b != nil {
		data = b.Bytes
	}
	return x509.ParsePKCS8PrivateKey(data)
}

// ParseCert accepts an X.509 certificate in PEM or DER form.
func ParseCert(data []byte) (*x509.Certificate, error) {
	if b, _ := pem.Decode(data); b != nil {
		data = b.Bytes
	}
	return x509.ParseCertificate(data)
}

// FindSlot returns the slot holding the token with the given label.
func FindSlot(ctx *pkcs11.Ctx, label string) (uint, error) {
	slots, err := ctx.GetSlotList(true)
	if err != nil {
		return 0, err
	}
	for _, s := range slots {
		info, err := ctx.GetTokenInfo(s)
		if err == nil && strings.TrimRight(info.Label, " \x00") == label {
			return s, nil
		}
	}
	return 0, fmt.Errorf("no token labelled %q", label)
}

// Import creates the private key and certificate objects in a logged-in
// read-write session.
func Import(ctx *pkcs11.Ctx, sh pkcs11.SessionHandle, key any, cert *x509.Certificate, opt Options) error {
	common := []*pkcs11.Attribute{
		pkcs11.NewAttribute(pkcs11.CKA_CLASS, pkcs11.CKO_PRIVATE_KEY),
		pkcs11.NewAttribute(pkcs11.CKA_TOKEN, true),
		pkcs11.NewAttribute(pkcs11.CKA_PRIVATE, true),
		pkcs11.NewAttribute(pkcs11.CKA_SENSITIVE, true),
		pkcs11.NewAttribute(pkcs11.CKA_EXTRACTABLE, false),
		pkcs11.NewAttribute(pkcs11.CKA_SIGN, true),
		pkcs11.NewAttribute(pkcs11.CKA_ID, opt.ID),
		pkcs11.NewAttribute(pkcs11.CKA_LABEL, opt.Label),
	}
	if opt.AlwaysAuthenticate {
		common = append(common, pkcs11.NewAttribute(pkcs11.CKA_ALWAYS_AUTHENTICATE, true))
	}
	var tmpl []*pkcs11.Attribute
	switch k := key.(type) {
	case *rsa.PrivateKey:
		if len(k.Primes) != 2 {
			return errors.New("multi-prime RSA keys are not supported")
		}
		k.Precompute()
		tmpl = append(common,
			pkcs11.NewAttribute(pkcs11.CKA_KEY_TYPE, pkcs11.CKK_RSA),
			pkcs11.NewAttribute(pkcs11.CKA_MODULUS, k.N.Bytes()),
			pkcs11.NewAttribute(pkcs11.CKA_PUBLIC_EXPONENT, big.NewInt(int64(k.E)).Bytes()),
			pkcs11.NewAttribute(pkcs11.CKA_PRIVATE_EXPONENT, k.D.Bytes()),
			pkcs11.NewAttribute(pkcs11.CKA_PRIME_1, k.Primes[0].Bytes()),
			pkcs11.NewAttribute(pkcs11.CKA_PRIME_2, k.Primes[1].Bytes()),
			pkcs11.NewAttribute(pkcs11.CKA_EXPONENT_1, k.Precomputed.Dp.Bytes()),
			pkcs11.NewAttribute(pkcs11.CKA_EXPONENT_2, k.Precomputed.Dq.Bytes()),
			pkcs11.NewAttribute(pkcs11.CKA_COEFFICIENT, k.Precomputed.Qinv.Bytes()),
		)
	case *ecdsa.PrivateKey:
		oid, ok := curveOIDs[k.Curve]
		if !ok {
			return errors.New("unsupported curve")
		}
		params, err := asn1.Marshal(oid)
		if err != nil {
			return err
		}
		size := (k.Curve.Params().BitSize + 7) / 8
		tmpl = append(common,
			pkcs11.NewAttribute(pkcs11.CKA_KEY_TYPE, pkcs11.CKK_EC),
			pkcs11.NewAttribute(pkcs11.CKA_EC_PARAMS, params),
			pkcs11.NewAttribute(pkcs11.CKA_VALUE, k.D.FillBytes(make([]byte, size))),
		)
	default:
		return errors.New("unsupported key type")
	}
	if _, err := ctx.CreateObject(sh, tmpl); err != nil {
		return fmt.Errorf("creating private key: %w", err)
	}
	serial, err := asn1.Marshal(cert.SerialNumber)
	if err != nil {
		return err
	}
	_, err = ctx.CreateObject(sh, []*pkcs11.Attribute{
		pkcs11.NewAttribute(pkcs11.CKA_CLASS, pkcs11.CKO_CERTIFICATE),
		pkcs11.NewAttribute(pkcs11.CKA_CERTIFICATE_TYPE, pkcs11.CKC_X_509),
		pkcs11.NewAttribute(pkcs11.CKA_TOKEN, true),
		pkcs11.NewAttribute(pkcs11.CKA_PRIVATE, false),
		pkcs11.NewAttribute(pkcs11.CKA_ID, opt.ID),
		pkcs11.NewAttribute(pkcs11.CKA_LABEL, opt.Label),
		pkcs11.NewAttribute(pkcs11.CKA_SUBJECT, cert.RawSubject),
		pkcs11.NewAttribute(pkcs11.CKA_ISSUER, cert.RawIssuer),
		pkcs11.NewAttribute(pkcs11.CKA_SERIAL_NUMBER, serial),
		pkcs11.NewAttribute(pkcs11.CKA_VALUE, cert.Raw),
	})
	if err != nil {
		return fmt.Errorf("creating certificate: %w", err)
	}
	return nil
}
