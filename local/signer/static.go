package main

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// Same content types as server.js.
var contentTypes = map[string]string{
	".html":  "text/html",
	".css":   "text/css",
	".js":    "text/javascript",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".txt":   "text/plain",
	".woff2": "font/woff2",
	".wasm":  "application/wasm",
}

type headerRule struct {
	re      *regexp.Regexp
	unset   []string    // lower-case names removed before the rule's headers are set
	headers [][2]string // name, value in file order
}

var (
	blockSplit  = regexp.MustCompile(`\n(\S)`)
	headerSplit = regexp.MustCompile(`:\s(.+)`)
)

// parseHeaderRules parses site/_headers the way server.js does: blocks start on
// lines beginning with non-whitespace, the first line is a path pattern where
// "*" matches anything, "! Name" lines unset earlier headers and "Name: value"
// lines set headers.
func parseHeaderRules(text string) []headerRule {
	var blocks []string
	rest := text
	for {
		loc := blockSplit.FindStringIndex(rest)
		if loc == nil {
			blocks = append(blocks, rest)
			break
		}
		blocks = append(blocks, rest[:loc[0]])
		rest = rest[loc[0]+1:]
	}
	rules := make([]headerRule, 0, len(blocks))
	for _, block := range blocks {
		lines := strings.Split(jsTrim(block), "\n")
		parts := strings.Split(jsTrim(lines[0]), "*")
		for i, p := range parts {
			parts[i] = regexp.QuoteMeta(p)
		}
		rule := headerRule{re: regexp.MustCompile("^" + strings.Join(parts, ".*") + "$")}
		for _, l := range lines[1:] {
			l = jsTrim(l)
			if strings.HasPrefix(l, "!") {
				rule.unset = append(rule.unset, strings.ToLower(jsTrim(l[1:])))
			}
			if m := headerSplit.FindStringSubmatchIndex(l); m != nil {
				rule.headers = append(rule.headers, [2]string{l[:m[0]], l[m[2]:m[3]]})
			}
		}
		rules = append(rules, rule)
	}
	return rules
}

// jsTrim matches String.prototype.trim.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r == 0xFEFF || (unicode.IsSpace(r) && r != 0x85)
	})
}

// orderedHeaders keeps header names as written and in insertion order.
type orderedHeaders [][2]string

func (h *orderedHeaders) set(name, value string) {
	for i := range *h {
		if (*h)[i][0] == name {
			(*h)[i][1] = value
			return
		}
	}
	*h = append(*h, [2]string{name, value})
}

func (h *orderedHeaders) unset(lowerName string) {
	out := (*h)[:0]
	for _, kv := range *h {
		if strings.ToLower(kv[0]) != lowerName {
			out = append(out, kv)
		}
	}
	*h = out
}

func applyRules(rules []headerRule, pathname string, h *orderedHeaders) {
	for _, rule := range rules {
		if !rule.re.MatchString(pathname) {
			continue
		}
		for _, name := range rule.unset {
			h.unset(name)
		}
		for _, kv := range rule.headers {
			h.set(kv[0], kv[1])
		}
	}
}

// normalizePathname mirrors the WHATWG URL parser used by server.js: backslashes
// become slashes and "." / ".." segments (including %2e forms) are resolved.
// The result stays percent-encoded, like URL.pathname.
func normalizePathname(raw string) string {
	raw = strings.ReplaceAll(raw, `\`, "/")
	if !strings.HasPrefix(raw, "/") {
		raw = "/" + raw
	}
	segs := strings.Split(raw[1:], "/")
	out := make([]string, 0, len(segs))
	for i, seg := range segs {
		last := i == len(segs)-1
		switch strings.ToLower(seg) {
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, seg)
		}
	}
	return "/" + strings.Join(out, "/")
}

var (
	headClose = regexp.MustCompile(`(?i)</head>`)
	headOpen  = regexp.MustCompile(`(?i)<head(\s[^>]*)?>`)
)

// injectToken adds the signer token meta element before </head>, or after <head>.
func injectToken(body []byte, token string) []byte {
	meta := []byte(`<meta name="local-signer-token" content="` + token + `">`)
	at := -1
	if loc := headClose.FindIndex(body); loc != nil {
		at = loc[0]
	} else if loc := headOpen.FindIndex(body); loc != nil {
		at = loc[1]
	}
	if at < 0 {
		return body
	}
	out := make([]byte, 0, len(body)+len(meta))
	out = append(out, body[:at]...)
	out = append(out, meta...)
	return append(out, body[at:]...)
}

type staticServer struct {
	root  string // absolute, cleaned path of site/
	rules []headerRule
	// inject reports whether the token may be added to this request's pages.
	inject func(r *http.Request) bool
	token  string
}

func newStaticServer(root, token string, inject func(*http.Request) bool) (*staticServer, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	text, err := os.ReadFile(filepath.Join(abs, "_headers"))
	if err != nil {
		return nil, err
	}
	return &staticServer{root: abs, rules: parseHeaderRules(string(text)), inject: inject, token: token}, nil
}

func (s *staticServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	pathname := normalizePathname(r.URL.EscapedPath())
	if pathname == "/" || pathname == "/tools" {
		w.Header().Set("Location", "/tools/")
		w.WriteHeader(http.StatusFound)
		return
	}
	p := pathname
	if strings.HasSuffix(p, "/") {
		p += "index.html"
	}
	decoded, err := url.PathUnescape(p)
	if err != nil || strings.ContainsRune(decoded, 0) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	filename := filepath.Join(s.root, filepath.FromSlash("."+decoded))
	if !strings.HasPrefix(filename, s.root+string(filepath.Separator)) || strings.EqualFold(filepath.Base(filename), "_headers") {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	body, err := os.ReadFile(filename)
	if err != nil {
		w.Header()["Content-Type"] = nil
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("Not found"))
		return
	}
	ext := filepath.Ext(filename)
	ct, ok := contentTypes[ext]
	if !ok {
		ct = "application/octet-stream"
	}
	h := orderedHeaders{{"Content-Type", ct}, {"Cache-Control", "no-store"}}
	applyRules(s.rules, pathname, &h)
	if ext == ".html" && strings.HasPrefix(pathname, "/tools/") && s.inject != nil && s.inject(r) {
		body = injectToken(body, s.token)
	}
	w.Header()["Content-Type"] = nil // no sniffing if a rule removed it
	for _, kv := range h {
		w.Header()[http.CanonicalHeaderKey(kv[0])] = []string{kv[1]}
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
