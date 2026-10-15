package main

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testHeaders = `/*
  Content-Security-Policy: default-src 'self'; connect-src 'none'
  X-Robots-Tag: noindex, nofollow
  X-Content-Type-Options: nosniff

/assets/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/pdf-editor/*
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'self'; connect-src 'self'
`

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const testHost = "127.0.0.1:4198"

func newTestSite(t *testing.T) *staticServer {
	t.Helper()
	dir := t.TempDir()
	site := filepath.Join(dir, "site")
	writeFile(t, filepath.Join(dir, "outside.txt"), "secret")
	writeFile(t, filepath.Join(site, "_headers"), testHeaders)
	writeFile(t, filepath.Join(site, "index.html"), "<html><head><title>x</title></head><body></body></html>")
	writeFile(t, filepath.Join(site, "pdf-editor", "index.html"), "<html><HEAD lang=en><title>x</title></HEAD></html>")
	writeFile(t, filepath.Join(site, "pdf-editor", "app.js"), "console.log(1)")
	writeFile(t, filepath.Join(site, "assets", "fonts", "a.woff2"), "font")
	writeFile(t, filepath.Join(site, "data.bin"), "bin")
	s, err := newStaticServer(site, "tok", func(r *http.Request) bool { return r.Host == testHost })
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// get parses the raw request line the way the HTTP server does, so paths are not cleaned.
func get(h http.Handler, target, host string) *httptest.ResponseRecorder {
	req, err := http.ReadRequest(bufio.NewReader(strings.NewReader("GET " + target + " HTTP/1.1\r\nHost: " + host + "\r\n\r\n")))
	if err != nil {
		panic(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestStaticRedirects(t *testing.T) {
	s := newTestSite(t)
	for _, p := range []string{"/tools"} {
		rec := get(s, p, testHost)
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/" {
			t.Errorf("%s: got %d %q", p, rec.Code, rec.Header().Get("Location"))
		}
	}
}

func TestStaticHeaders(t *testing.T) {
	s := newTestSite(t)

	rec := get(s, "/", testHost)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/html" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("index: %d %v", rec.Code, rec.Header())
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "default-src 'self'; connect-src 'none'" {
		t.Errorf("index CSP: %q", got)
	}
	if rec.Header().Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Errorf("missing X-Robots-Tag")
	}

	rec = get(s, "/pdf-editor/app.js", testHost)
	if csp := rec.Header().Values("Content-Security-Policy"); len(csp) != 1 || csp[0] != "default-src 'self'; connect-src 'self'" {
		t.Errorf("pdf-editor CSP after ! rule: %q", csp)
	}
	if rec.Header().Get("Content-Type") != "text/javascript" || rec.Header().Get("X-Robots-Tag") == "" {
		t.Errorf("pdf-editor headers: %v", rec.Header())
	}

	rec = get(s, "/assets/fonts/a.woff2", testHost)
	if rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || rec.Header().Get("Content-Type") != "font/woff2" {
		t.Errorf("font headers: %v", rec.Header())
	}

	rec = get(s, "/data.bin", testHost)
	if rec.Header().Get("Content-Type") != "application/octet-stream" {
		t.Errorf("unknown type: %q", rec.Header().Get("Content-Type"))
	}

	// Rules match the normalized pathname.
	rec = get(s, "/x/../pdf-editor/app.js", testHost)
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "connect-src 'self'") {
		t.Errorf("dot segments: %d %v", rec.Code, rec.Header())
	}
}

func TestStaticRefusals(t *testing.T) {
	s := newTestSite(t)
	for _, p := range []string{
		"/_headers",
		"/tools/_headers",
		"/tools/../_headers",
		"/tools/%5fheaders",
		"/tools/../../outside.txt",
		"/tools/%2e%2e/%2e%2e/outside.txt",
		"/tools/..%2f..%2foutside.txt",
		"/tools/a%2f..%2f..%2f..%2foutside.txt",
		`/tools\..\..\outside.txt`,
		"/tools/missing.html",
		"/tools/assets",
		"/tools/a%00.html",
	} {
		rec := get(s, p, testHost)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: got %d", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "secret") || strings.Contains(rec.Body.String(), "Content-Security") {
			t.Errorf("%s: leaked body", p)
		}
	}
}

func TestTokenInjection(t *testing.T) {
	s := newTestSite(t)
	meta := `<meta name="local-signer-token" content="tok">`

	if body := get(s, "/", testHost).Body.String(); body != "<html><head><title>x</title>"+meta+"</head><body></body></html>" {
		t.Errorf("index: %s", body)
	}
	if body := get(s, "/pdf-editor/", testHost).Body.String(); !strings.Contains(body, meta+"</HEAD>") {
		t.Errorf("upper-case head: %s", body)
	}
	if body := get(s, "/pdf-editor/app.js", testHost).Body.String(); strings.Contains(body, "local-signer-token") {
		t.Errorf("injected into JS")
	}
	for _, host := range []string{"localhost:4198", "attacker.example:4198", "127.0.0.1"} {
		if body := get(s, "/", host).Body.String(); strings.Contains(body, "local-signer-token") {
			t.Errorf("injected for Host %s", host)
		}
	}
}

func TestInjectToken(t *testing.T) {
	cases := map[string]string{
		"<head></head>":                   `<head><meta name="local-signer-token" content="T"></head>`,
		"<HEAD><title></title></HeAd>":    `<HEAD><title></title><meta name="local-signer-token" content="T"></HeAd>`,
		`<head lang="en"><title>x`:        `<head lang="en"><meta name="local-signer-token" content="T"><title>x`,
		"<header>no head element</p>":     "<header>no head element</p>",
		"<html><body>plain</body></html>": "<html><body>plain</body></html>",
	}
	for in, want := range cases {
		if got := string(injectToken([]byte(in), "T")); got != want {
			t.Errorf("%q: got %q", in, got)
		}
	}
}

func TestNormalizePathname(t *testing.T) {
	cases := map[string]string{
		"/":                    "/",
		"/tools":               "/tools",
		"/tools/":              "/tools/",
		"/tools/./a":           "/tools/a",
		"/tools/../a":          "/a",
		"/../../a":             "/a",
		"/tools/..":            "/",
		"/tools/x/..":          "/tools/",
		"/tools/.":             "/tools/",
		"/tools/%2E%2e/a":      "/a",
		"/tools/.%2E/a":        "/a",
		`/tools\a`:             "/tools/a",
		"/tools/a%2f..%2fb":    "/tools/a%2f..%2fb",
		"/tools/%20space.html": "/tools/%20space.html",
	}
	for in, want := range cases {
		if got := normalizePathname(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestParseHeaderRules(t *testing.T) {
	rules := parseHeaderRules(testHeaders)
	if len(rules) != 3 {
		t.Fatalf("got %d rules", len(rules))
	}
	if !rules[0].re.MatchString("/a/b") || !rules[1].re.MatchString("/assets/fonts/a") || rules[1].re.MatchString("/assets/fontsx") || rules[1].re.MatchString("/x/assets/fonts/a") {
		t.Errorf("wildcard match wrong")
	}
	if len(rules[2].unset) != 1 || rules[2].unset[0] != "content-security-policy" || len(rules[2].headers) != 1 {
		t.Errorf("unset rule: %+v", rules[2])
	}
	// Values keep everything after the first ": ".
	r := parseHeaderRules("/a.b\r\n  X-A: one: two\r\n  Broken\r\n")
	if len(r) != 1 || len(r[0].headers) != 1 || r[0].headers[0] != [2]string{"X-A", "one: two"} {
		t.Errorf("crlf/colon parse: %+v", r)
	}
	if r[0].re.MatchString("/aXb") {
		t.Errorf("dot not escaped")
	}
}
