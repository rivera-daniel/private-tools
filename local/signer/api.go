package main

import (
	"bytes"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

const maxSignBody = 16 << 10

// Backend errors the API maps to specific responses.
var (
	ErrPinIncorrect = errors.New("PIN incorrect")
	ErrPinLocked    = errors.New("PIN locked")
	ErrPinRejected  = errors.New("PIN rejected by the token")
	ErrKeyNotFound  = errors.New("private key not found")
)

// Mechanism selects how the backend signs.
type Mechanism struct {
	Algorithm string // one of the alg* constants
	HashName  string // "SHA-256" or "SHA-384"
}

// Backend is the token access used by the API. The PKCS#11 implementation is in
// pkcs11backend.go; tests use a fake.
type Backend interface {
	// Tokens lists tokens and their public certificate objects.
	Tokens() ([]RawToken, error)
	// Token returns one token's information and flags.
	Token(slot uint) (RawToken, error)
	// Sign logs in with pin, signs data with the private key with CKA_ID id,
	// logs out and returns the raw module output.
	Sign(slot uint, id []byte, pin string, mech Mechanism, data []byte) ([]byte, error)
}

type api struct {
	backend    Backend
	moduleName string
	host       string // "127.0.0.1:<port>"
	origin     string // "http://127.0.0.1:<port>"
	token      string
	limiter    *pinLimiter
	// signMu makes the limiter check, the PIN attempt and the failure record
	// one step, so queued requests cannot spend several PIN tries at once.
	signMu sync.Mutex
}

type apiError struct {
	Error       string `json:"error"`
	Code        string `json:"code"`
	PinCountLow *bool  `json:"pinCountLow,omitempty"`
	PinFinalTry *bool  `json:"pinFinalTry,omitempty"`
	RetryAfter  *int   `json:"retryAfter,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, apiError{Error: msg, Code: code})
}

// checkRequest enforces Host, Origin, Sec-Fetch-Site and the token.
func (a *api) checkRequest(r *http.Request) string {
	if r.Host != a.host {
		return "unexpected Host header"
	}
	if origin, present := r.Header["Origin"]; present {
		if len(origin) != 1 || origin[0] != a.origin {
			return "cross-origin request refused"
		}
	} else if r.Method == http.MethodPost {
		return "missing Origin header"
	}
	if site, present := r.Header["Sec-Fetch-Site"]; present && (len(site) != 1 || site[0] != "same-origin") {
		return "cross-site request refused"
	}
	got := r.Header.Get("X-Local-Signer-Token")
	if subtle.ConstantTimeCompare([]byte(got), []byte(a.token)) != 1 {
		return "missing or wrong signer token; reload the page"
	}
	return ""
}

func (a *api) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		fail(w, http.StatusMethodNotAllowed, "forbidden", "method not allowed")
		return
	}
	if msg := a.checkRequest(r); msg != "" {
		fail(w, http.StatusForbidden, "forbidden", msg)
		return
	}
	switch r.URL.Path {
	case "/local-signer/status":
		if r.Method != http.MethodGet {
			fail(w, http.StatusMethodNotAllowed, "bad_request", "use GET")
			return
		}
		a.status(w)
	case "/local-signer/sign":
		if r.Method != http.MethodPost {
			fail(w, http.StatusMethodNotAllowed, "bad_request", "use POST")
			return
		}
		a.sign(w, r)
	default:
		fail(w, http.StatusNotFound, "not_found", "unknown endpoint")
	}
}

type statusJSON struct {
	Version int         `json:"version"`
	Module  string      `json:"module"`
	Error   string      `json:"error,omitempty"`
	Tokens  []tokenJSON `json:"tokens"`
}

func (a *api) status(w http.ResponseWriter) {
	out := statusJSON{Version: 1, Module: a.moduleName, Tokens: []tokenJSON{}}
	tokens, err := a.backend.Tokens()
	if err != nil {
		out.Error = err.Error()
	}
	for _, t := range tokens {
		out.Tokens = append(out.Tokens, describeToken(t))
	}
	writeJSON(w, http.StatusOK, out)
}

type signRequest struct {
	Slot      *uint  `json:"slot"`
	ID        string `json:"id"`
	PIN       string `json:"pin"`
	Algorithm string `json:"algorithm"`
	Hash      string `json:"hash"`
	Digest    string `json:"digest"`
}

type parsedSign struct {
	slot   uint
	id     []byte
	pin    string
	mech   Mechanism
	digest []byte
}

// parseSignRequest validates everything that does not need the token.
func parseSignRequest(r *http.Request) (*parsedSign, int, string) {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		return nil, http.StatusUnsupportedMediaType, "Content-Type must be application/json"
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxSignBody+1))
	if err != nil {
		return nil, http.StatusBadRequest, "could not read request body"
	}
	if len(body) > maxSignBody {
		return nil, http.StatusRequestEntityTooLarge, "request body too large"
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var req signRequest
	if err := dec.Decode(&req); err != nil {
		return nil, http.StatusBadRequest, "invalid JSON request"
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, http.StatusBadRequest, "unexpected data after JSON request"
	}
	if req.Slot == nil {
		return nil, http.StatusBadRequest, "slot is required"
	}
	h, ok := hashByName[req.Hash]
	if !ok {
		return nil, http.StatusBadRequest, "hash must be SHA-256 or SHA-384"
	}
	switch req.Algorithm {
	case algRSAPKCS1, algRSAPSS, algECDSA256, algECDSA384:
	default:
		return nil, http.StatusBadRequest, "unsupported algorithm"
	}
	digest, err := base64.StdEncoding.Strict().DecodeString(req.Digest)
	if err != nil {
		return nil, http.StatusBadRequest, "digest must be standard base64"
	}
	if len(digest) != h.Size() {
		return nil, http.StatusBadRequest, fmt.Sprintf("digest must be %d bytes for %s", h.Size(), req.Hash)
	}
	id, err := hex.DecodeString(req.ID)
	if err != nil || len(id) == 0 {
		return nil, http.StatusBadRequest, "id must be a non-empty hex string"
	}
	if len(req.PIN) > 64 {
		return nil, http.StatusBadRequest, "PIN is too long"
	}
	return &parsedSign{slot: *req.Slot, id: id, pin: req.PIN, mech: Mechanism{req.Algorithm, req.Hash}, digest: digest}, 0, ""
}

func findCert(t RawToken, id []byte) (RawCert, *x509.Certificate, bool) {
	for _, c := range t.Certs {
		if bytes.Equal(c.ID, id) {
			if cert, err := x509.ParseCertificate(c.DER); err == nil {
				return c, cert, true
			}
		}
	}
	return RawCert{}, nil, false
}

func boolPtr(b bool) *bool { return &b }

func (a *api) sign(w http.ResponseWriter, r *http.Request) {
	req, status, msg := parseSignRequest(r)
	if req == nil {
		fail(w, status, "bad_request", msg)
		return
	}

	a.signMu.Lock()
	defer a.signMu.Unlock()

	tok, err := a.backend.Token(req.slot)
	if err != nil {
		fail(w, http.StatusNotFound, "not_found", "no token in that slot")
		return
	}
	rc, cert, ok := findCert(tok, req.id)
	if !ok || !hasPrivateKey(tok, rc) {
		fail(w, http.StatusNotFound, "not_found", "no certificate with a private key under that id on this token")
		return
	}
	if !supportsAlgorithm(cert, req.mech.Algorithm) {
		fail(w, http.StatusBadRequest, "bad_request", "algorithm does not match the certificate's key")
		return
	}
	if req.pin == "" && !tok.ProtectedAuthPath {
		fail(w, http.StatusBadRequest, "bad_request", "Enter the card PIN.")
		return
	}
	if tok.PinLocked {
		fail(w, http.StatusLocked, "pin_locked", "The card PIN is locked. Unlock it with the card's unblocking code (PUK) or its administrator.")
		return
	}
	if ok, stopped, retry := a.limiter.check(req.slot); !ok {
		if stopped {
			fail(w, http.StatusTooManyRequests, "rate_limited", "Too many wrong PINs. Restart the signer to try again.")
			return
		}
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		writeJSON(w, http.StatusTooManyRequests, apiError{Error: fmt.Sprintf("A wrong PIN was entered. Wait %d seconds before trying again.", retry), Code: "rate_limited", RetryAfter: &retry})
		return
	}

	data := req.digest
	h := hashByName[req.mech.HashName]
	if req.mech.Algorithm == algRSAPKCS1 {
		if data, err = digestInfo(h, req.digest); err != nil {
			fail(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
	}
	raw, err := a.backend.Sign(req.slot, req.id, req.pin, req.mech, data)
	switch {
	case err == nil:
	case errors.Is(err, ErrPinIncorrect):
		stopped := a.limiter.fail(req.slot)
		resp := apiError{Error: "The PIN is incorrect.", Code: "pin_incorrect", PinCountLow: boolPtr(false), PinFinalTry: boolPtr(false)}
		if t, err := a.backend.Token(req.slot); err == nil {
			resp.PinCountLow, resp.PinFinalTry = boolPtr(t.PinCountLow), boolPtr(t.PinFinalTry)
			if t.PinLocked {
				resp.Error, resp.Code = "The PIN is incorrect, and the card PIN is now locked.", "pin_locked"
				writeJSON(w, http.StatusLocked, resp)
				return
			}
		}
		if stopped {
			resp.Error = "The PIN is incorrect. Too many wrong PINs: restart the signer to try again."
		}
		writeJSON(w, http.StatusUnauthorized, resp)
		return
	case errors.Is(err, ErrPinLocked):
		fail(w, http.StatusLocked, "pin_locked", "The card PIN is locked. Unlock it with the card's unblocking code (PUK) or its administrator.")
		return
	case errors.Is(err, ErrPinRejected):
		fail(w, http.StatusBadRequest, "bad_request", "The card rejected the PIN. Check its length and characters.")
		return
	case errors.Is(err, ErrKeyNotFound):
		a.limiter.reset(req.slot)
		fail(w, http.StatusNotFound, "not_found", "The private key for this certificate was not found on the card.")
		return
	default:
		fail(w, http.StatusBadGateway, "token_error", "The card could not sign: "+err.Error())
		return
	}
	a.limiter.reset(req.slot)

	sig, err := finishSignature(cert, req.mech.Algorithm, h, req.digest, raw)
	if err != nil {
		fail(w, http.StatusBadGateway, "token_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"signature": base64.StdEncoding.EncodeToString(sig)})
}

// isSignerPath reports whether a request belongs to the signer API.
func isSignerPath(p string) bool {
	return p == "/local-signer" || strings.HasPrefix(p, "/local-signer/")
}
