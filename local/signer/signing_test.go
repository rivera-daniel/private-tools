package main

import (
	"bytes"
	"crypto"
	"encoding/asn1"
	"encoding/hex"
	"math/big"
	"testing"
	"time"
)

func TestDigestInfo(t *testing.T) {
	prefixes := map[crypto.Hash]string{
		crypto.SHA256: "3031300d060960864801650304020105000420",
		crypto.SHA384: "3041300d060960864801650304020205000430",
	}
	for h, prefix := range prefixes {
		digest := bytes.Repeat([]byte{0xab}, h.Size())
		got, err := digestInfo(h, digest)
		if err != nil {
			t.Fatal(err)
		}
		want, _ := hex.DecodeString(prefix)
		want = append(want, digest...)
		if !bytes.Equal(got, want) {
			t.Errorf("%v: got %x", h, got)
		}
	}
	if _, err := digestInfo(crypto.SHA256, make([]byte, 48)); err == nil {
		t.Error("accepted a digest of the wrong length")
	}
	if _, err := digestInfo(crypto.SHA512, make([]byte, 64)); err == nil {
		t.Error("accepted SHA-512")
	}
}

func TestECDSARawToDER(t *testing.T) {
	r := bytes.Repeat([]byte{0xff}, 32) // high bit set: needs a leading zero in DER
	s := append(make([]byte, 31), 0x05) // leading zeros: must be stripped
	der, err := ecdsaRawToDER(append(r, s...), 256)
	if err != nil {
		t.Fatal(err)
	}
	var sig struct{ R, S *big.Int }
	if rest, err := asn1.Unmarshal(der, &sig); err != nil || len(rest) != 0 {
		t.Fatalf("not DER: %v", err)
	}
	if !bytes.Equal(sig.R.Bytes(), r) || sig.S.Int64() != 5 {
		t.Errorf("values changed: %v %v", sig.R, sig.S)
	}
	wantPrefix, _ := hex.DecodeString("3026022100ff")
	if !bytes.HasPrefix(der, wantPrefix) || !bytes.HasSuffix(der, []byte{0x02, 0x01, 0x05}) {
		t.Errorf("encoding: %x", der)
	}
	for _, bad := range [][]byte{nil, make([]byte, 63), make([]byte, 96), make([]byte, 64)} {
		if _, err := ecdsaRawToDER(bad, 256); err == nil {
			t.Errorf("accepted %d bytes", len(bad))
		}
	}
	if _, err := ecdsaRawToDER(make([]byte, 96), 384); err == nil {
		t.Error("accepted zero r and s")
	}
	if _, err := ecdsaRawToDER(append(bytes.Repeat([]byte{1}, 66), bytes.Repeat([]byte{2}, 66)...), 521); err != nil {
		t.Errorf("P-521 size: %v", err)
	}
}

func TestPinLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := newPinLimiter(3)
	l.now = func() time.Time { return now }
	if ok, _, _ := l.check(1); !ok {
		t.Fatal("fresh slot refused")
	}
	if l.fail(1) {
		t.Fatal("stopped after one failure")
	}
	if ok, stopped, retry := l.check(1); ok || stopped || retry != 2 {
		t.Fatalf("after one failure: %v %v %d", ok, stopped, retry)
	}
	if ok, _, _ := l.check(2); !ok {
		t.Fatal("other slot affected")
	}
	now = now.Add(1500 * time.Millisecond)
	if _, _, retry := l.check(1); retry != 1 {
		t.Fatalf("retry rounds up: %d", retry)
	}
	now = now.Add(time.Second)
	if ok, _, _ := l.check(1); !ok {
		t.Fatal("still refused after backoff")
	}
	l.fail(1)
	if _, _, retry := l.check(1); retry != 4 {
		t.Fatalf("second backoff: %d", retry)
	}
	if !l.fail(1) {
		t.Fatal("not stopped after max failures")
	}
	now = now.Add(24 * time.Hour)
	if ok, stopped, _ := l.check(1); ok || !stopped {
		t.Fatal("stop did not persist")
	}
	l.reset(1)
	if ok, _, _ := l.check(1); !ok {
		t.Fatal("reset failed")
	}

	// The backoff is capped at 60 seconds.
	big := newPinLimiter(100)
	big.now = func() time.Time { return now }
	for i := 0; i < 10; i++ {
		big.fail(3)
	}
	if _, _, retry := big.check(3); retry != 60 {
		t.Errorf("cap: %d", retry)
	}
}
