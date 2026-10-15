package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/miekg/pkcs11"
)

// p11Backend talks to a PKCS#11 module. All calls are serialized.
type p11Backend struct {
	mu  sync.Mutex
	ctx *pkcs11.Ctx
}

func loadModule(path string) (*p11Backend, error) {
	ctx := pkcs11.New(path)
	if ctx == nil {
		return nil, fmt.Errorf("could not load the PKCS#11 module %s", path)
	}
	if err := ctx.Initialize(); err != nil && !isCKR(err, pkcs11.CKR_CRYPTOKI_ALREADY_INITIALIZED) {
		ctx.Destroy()
		return nil, fmt.Errorf("could not initialize the PKCS#11 module: %v", err)
	}
	return &p11Backend{ctx: ctx}, nil
}

func isCKR(err error, code uint) bool {
	var e pkcs11.Error
	return errors.As(err, &e) && uint(e) == code
}

func (b *p11Backend) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	_ = b.ctx.Finalize()
	b.ctx.Destroy()
}

func (b *p11Backend) Tokens() ([]RawToken, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	slots, err := b.ctx.GetSlotList(true)
	if err != nil {
		return nil, fmt.Errorf("could not list slots: %v", err)
	}
	out := []RawToken{}
	for _, slot := range slots {
		if t, err := b.readToken(slot); err == nil {
			out = append(out, t)
		}
	}
	return out, nil
}

func (b *p11Backend) Token(slot uint) (RawToken, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.readToken(slot)
}

func (b *p11Backend) readToken(slot uint) (RawToken, error) {
	info, err := b.ctx.GetTokenInfo(slot)
	if err != nil {
		return RawToken{}, err
	}
	t := RawToken{
		Slot:              slot,
		Label:             strings.TrimRight(info.Label, " \x00"),
		Manufacturer:      strings.TrimRight(info.ManufacturerID, " \x00"),
		Model:             strings.TrimRight(info.Model, " \x00"),
		Serial:            strings.TrimRight(info.SerialNumber, " \x00"),
		LoginRequired:     info.Flags&pkcs11.CKF_LOGIN_REQUIRED != 0,
		ProtectedAuthPath: info.Flags&pkcs11.CKF_PROTECTED_AUTHENTICATION_PATH != 0,
		PinCountLow:       info.Flags&pkcs11.CKF_USER_PIN_COUNT_LOW != 0,
		PinFinalTry:       info.Flags&pkcs11.CKF_USER_PIN_FINAL_TRY != 0,
		PinLocked:         info.Flags&pkcs11.CKF_USER_PIN_LOCKED != 0,
		Certs:             []RawCert{},
	}
	sh, err := b.ctx.OpenSession(slot, pkcs11.CKF_SERIAL_SESSION)
	if err != nil {
		return t, nil
	}
	defer b.ctx.CloseSession(sh)
	objs, err := b.find(sh, []*pkcs11.Attribute{
		pkcs11.NewAttribute(pkcs11.CKA_CLASS, pkcs11.CKO_CERTIFICATE),
		pkcs11.NewAttribute(pkcs11.CKA_CERTIFICATE_TYPE, pkcs11.CKC_X_509),
	}, 64)
	if err != nil {
		return t, nil
	}
	for _, o := range objs {
		attrs, err := b.ctx.GetAttributeValue(sh, o, []*pkcs11.Attribute{
			pkcs11.NewAttribute(pkcs11.CKA_ID, nil),
			pkcs11.NewAttribute(pkcs11.CKA_LABEL, nil),
			pkcs11.NewAttribute(pkcs11.CKA_VALUE, nil),
		})
		if err != nil || len(attrs) != 3 || len(attrs[2].Value) == 0 {
			continue
		}
		c := RawCert{ID: attrs[0].Value, Label: string(attrs[1].Value), DER: attrs[2].Value}
		if len(c.ID) > 0 {
			keys, err := b.find(sh, keyTemplate(c.ID), 1)
			c.PrivateKeyVisible = err == nil && len(keys) > 0
		}
		t.Certs = append(t.Certs, c)
	}
	return t, nil
}

func keyTemplate(id []byte) []*pkcs11.Attribute {
	return []*pkcs11.Attribute{
		pkcs11.NewAttribute(pkcs11.CKA_CLASS, pkcs11.CKO_PRIVATE_KEY),
		pkcs11.NewAttribute(pkcs11.CKA_ID, id),
	}
}

func (b *p11Backend) find(sh pkcs11.SessionHandle, tmpl []*pkcs11.Attribute, max int) ([]pkcs11.ObjectHandle, error) {
	if err := b.ctx.FindObjectsInit(sh, tmpl); err != nil {
		return nil, err
	}
	defer b.ctx.FindObjectsFinal(sh)
	objs, _, err := b.ctx.FindObjects(sh, max)
	return objs, err
}

func mapPinError(err error) error {
	switch {
	case isCKR(err, pkcs11.CKR_PIN_INCORRECT):
		return ErrPinIncorrect
	case isCKR(err, pkcs11.CKR_PIN_LOCKED):
		return ErrPinLocked
	case isCKR(err, pkcs11.CKR_PIN_LEN_RANGE), isCKR(err, pkcs11.CKR_PIN_INVALID):
		return ErrPinRejected
	}
	return err
}

func (b *p11Backend) Sign(slot uint, id []byte, pin string, mech Mechanism, data []byte) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	var m *pkcs11.Mechanism
	switch mech.Algorithm {
	case algRSAPKCS1:
		m = pkcs11.NewMechanism(pkcs11.CKM_RSA_PKCS, nil)
	case algRSAPSS:
		hashMech, mgf, sLen := uint(pkcs11.CKM_SHA256), uint(pkcs11.CKG_MGF1_SHA256), uint(32)
		if mech.HashName == "SHA-384" {
			hashMech, mgf, sLen = pkcs11.CKM_SHA384, pkcs11.CKG_MGF1_SHA384, 48
		}
		m = pkcs11.NewMechanism(pkcs11.CKM_RSA_PKCS_PSS, pkcs11.NewPSSParams(hashMech, mgf, sLen))
	case algECDSA256, algECDSA384:
		m = pkcs11.NewMechanism(pkcs11.CKM_ECDSA, nil)
	default:
		return nil, errors.New("unsupported algorithm")
	}

	sh, err := b.ctx.OpenSession(slot, pkcs11.CKF_SERIAL_SESSION)
	if err != nil {
		return nil, fmt.Errorf("could not open a session: %v", err)
	}
	defer b.ctx.CloseSession(sh)

	err = b.ctx.Login(sh, pkcs11.CKU_USER, pin)
	if isCKR(err, pkcs11.CKR_USER_ALREADY_LOGGED_IN) {
		_ = b.ctx.Logout(sh)
		err = b.ctx.Login(sh, pkcs11.CKU_USER, pin)
	}
	if err != nil {
		return nil, mapPinError(err)
	}
	defer b.ctx.Logout(sh)

	keys, err := b.find(sh, keyTemplate(id), 1)
	if err != nil || len(keys) == 0 {
		return nil, ErrKeyNotFound
	}
	key := keys[0]

	alwaysAuth := false
	if attrs, err := b.ctx.GetAttributeValue(sh, key, []*pkcs11.Attribute{pkcs11.NewAttribute(pkcs11.CKA_ALWAYS_AUTHENTICATE, nil)}); err == nil && len(attrs) == 1 {
		v := attrs[0].Value
		alwaysAuth = len(v) == 1 && v[0] != 0
	}

	if err := b.ctx.SignInit(sh, []*pkcs11.Mechanism{m}, key); err != nil {
		return nil, fmt.Errorf("could not start signing: %v", err)
	}
	if alwaysAuth {
		// Closing the session ends the pending operation on failure.
		if err := b.ctx.Login(sh, pkcs11.CKU_CONTEXT_SPECIFIC, pin); err != nil {
			return nil, mapPinError(err)
		}
	}
	sig, err := b.ctx.Sign(sh, data)
	if err != nil {
		return nil, fmt.Errorf("signing failed: %v", err)
	}
	return sig, nil
}
