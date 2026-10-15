package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"time"
)

const (
	algRSAPKCS1 = "RSASSA-PKCS1-v1_5"
	algRSAPSS   = "RSA-PSS"
	algECDSA256 = "ECDSA-P256"
	algECDSA384 = "ECDSA-P384"
)

var hashByName = map[string]crypto.Hash{
	"SHA-256": crypto.SHA256,
	"SHA-384": crypto.SHA384,
}

var (
	oidSHA256 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}
	oidSHA384 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 2}
)

// digestInfo encodes the PKCS#1 v1.5 DigestInfo structure for a digest.
func digestInfo(h crypto.Hash, digest []byte) ([]byte, error) {
	var oid asn1.ObjectIdentifier
	switch h {
	case crypto.SHA256:
		oid = oidSHA256
	case crypto.SHA384:
		oid = oidSHA384
	default:
		return nil, errors.New("unsupported hash")
	}
	if len(digest) != h.Size() {
		return nil, errors.New("digest length does not match hash")
	}
	return asn1.Marshal(struct {
		Algorithm pkix.AlgorithmIdentifier
		Digest    []byte
	}{pkix.AlgorithmIdentifier{Algorithm: oid, Parameters: asn1.NullRawValue}, digest})
}

// ecdsaRawToDER converts a PKCS#11 r||s signature into an ECDSA-Sig-Value.
func ecdsaRawToDER(raw []byte, curveBits int) ([]byte, error) {
	size := (curveBits + 7) / 8
	if len(raw) != 2*size {
		return nil, fmt.Errorf("ECDSA signature has %d bytes, expected %d", len(raw), 2*size)
	}
	r := new(big.Int).SetBytes(raw[:size])
	s := new(big.Int).SetBytes(raw[size:])
	if r.Sign() == 0 || s.Sign() == 0 {
		return nil, errors.New("ECDSA signature has a zero component")
	}
	return asn1.Marshal(struct{ R, S *big.Int }{r, s})
}

// keyAlgorithms describes a certificate's public key and the algorithms it supports.
func keyAlgorithms(cert *x509.Certificate) (keyType string, bits int, curve string, algs []string) {
	algs = []string{}
	switch pub := cert.PublicKey.(type) {
	case *rsa.PublicKey:
		return "RSA", pub.N.BitLen(), "", []string{algRSAPKCS1, algRSAPSS}
	case *ecdsa.PublicKey:
		bits = pub.Curve.Params().BitSize
		switch pub.Curve {
		case elliptic.P256():
			return "EC", bits, "P-256", []string{algECDSA256}
		case elliptic.P384():
			return "EC", bits, "P-384", []string{algECDSA384}
		}
		return "EC", bits, "", algs
	}
	return "", 0, "", algs
}

func supportsAlgorithm(cert *x509.Certificate, alg string) bool {
	_, _, _, algs := keyAlgorithms(cert)
	for _, a := range algs {
		if a == alg {
			return true
		}
	}
	return false
}

// finishSignature turns the module output into the returned signature and
// verifies it against the certificate's public key.
func finishSignature(cert *x509.Certificate, alg string, h crypto.Hash, digest, raw []byte) ([]byte, error) {
	switch pub := cert.PublicKey.(type) {
	case *rsa.PublicKey:
		sig := raw
		if len(sig) < pub.Size() {
			sig = append(make([]byte, pub.Size()-len(sig)), sig...)
		}
		var err error
		if alg == algRSAPSS {
			err = rsa.VerifyPSS(pub, h, digest, sig, &rsa.PSSOptions{SaltLength: h.Size(), Hash: h})
		} else {
			err = rsa.VerifyPKCS1v15(pub, h, digest, sig)
		}
		if err != nil {
			return nil, errors.New("the token returned a signature that does not verify")
		}
		return sig, nil
	case *ecdsa.PublicKey:
		sig, err := ecdsaRawToDER(raw, pub.Curve.Params().BitSize)
		if err != nil {
			return nil, err
		}
		if !ecdsa.VerifyASN1(pub, digest, sig) {
			return nil, errors.New("the token returned a signature that does not verify")
		}
		return sig, nil
	}
	return nil, errors.New("unsupported key type")
}

// RawCert is a certificate object as read from a token.
type RawCert struct {
	ID                []byte
	Label             string
	DER               []byte
	PrivateKeyVisible bool
}

// RawToken is a token and its public certificate objects.
type RawToken struct {
	Slot              uint
	Label             string
	Manufacturer      string
	Model             string
	Serial            string
	LoginRequired     bool
	ProtectedAuthPath bool
	PinCountLow       bool
	PinFinalTry       bool
	PinLocked         bool
	Certs             []RawCert
}

type certJSON struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	DER           string   `json:"der"`
	Subject       string   `json:"subject"`
	Issuer        string   `json:"issuer"`
	NotBefore     string   `json:"notBefore"`
	NotAfter      string   `json:"notAfter"`
	KeyType       string   `json:"keyType"`
	KeyBits       int      `json:"keyBits"`
	Curve         string   `json:"curve"`
	Algorithms    []string `json:"algorithms"`
	HasPrivateKey bool     `json:"hasPrivateKey"`
}

type tokenJSON struct {
	Slot              uint       `json:"slot"`
	Label             string     `json:"label"`
	Manufacturer      string     `json:"manufacturer"`
	Model             string     `json:"model"`
	Serial            string     `json:"serial"`
	LoginRequired     bool       `json:"loginRequired"`
	ProtectedAuthPath bool       `json:"protectedAuthPath"`
	PinCountLow       bool       `json:"pinCountLow"`
	PinFinalTry       bool       `json:"pinFinalTry"`
	PinLocked         bool       `json:"pinLocked"`
	Certificates      []certJSON `json:"certificates"`
}

func hasPrivateKey(t RawToken, c RawCert) bool {
	return c.PrivateKeyVisible || (t.LoginRequired && len(c.ID) > 0)
}

func describeToken(t RawToken) tokenJSON {
	out := tokenJSON{
		Slot: t.Slot, Label: t.Label, Manufacturer: t.Manufacturer, Model: t.Model, Serial: t.Serial,
		LoginRequired: t.LoginRequired, ProtectedAuthPath: t.ProtectedAuthPath,
		PinCountLow: t.PinCountLow, PinFinalTry: t.PinFinalTry, PinLocked: t.PinLocked,
		Certificates: []certJSON{},
	}
	for _, c := range t.Certs {
		cert, err := x509.ParseCertificate(c.DER)
		if err != nil {
			continue
		}
		keyType, bits, curve, algs := keyAlgorithms(cert)
		out.Certificates = append(out.Certificates, certJSON{
			ID: hex.EncodeToString(c.ID), Label: c.Label, DER: base64.StdEncoding.EncodeToString(c.DER),
			Subject: cert.Subject.String(), Issuer: cert.Issuer.String(),
			NotBefore: cert.NotBefore.UTC().Format(time.RFC3339), NotAfter: cert.NotAfter.UTC().Format(time.RFC3339),
			KeyType: keyType, KeyBits: bits, Curve: curve, Algorithms: algs,
			HasPrivateKey: hasPrivateKey(t, c),
		})
	}
	return out
}
