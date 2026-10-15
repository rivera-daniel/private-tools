// Command private-tools-signer serves the Private Tools site on 127.0.0.1 and
// lets the PDF Editor sign document digests with smart cards and USB tokens
// through a PKCS#11 module.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

var moduleCandidates = map[string][]string{
	"linux": {
		"/usr/lib/opensc-pkcs11.so",
		"/usr/lib64/opensc-pkcs11.so",
		"/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
		"/usr/lib/aarch64-linux-gnu/opensc-pkcs11.so",
		"/usr/lib/pkcs11/opensc-pkcs11.so",
		"/usr/local/lib/opensc-pkcs11.so",
	},
	"darwin": {
		"/Library/OpenSC/lib/opensc-pkcs11.so",
		"/opt/homebrew/lib/opensc-pkcs11.so",
		"/usr/local/lib/opensc-pkcs11.so",
	},
	"windows": {`C:\Windows\System32\opensc-pkcs11.dll`},
}

func findModule() string {
	for _, p := range moduleCandidates[runtime.GOOS] {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// findSite walks up from the executable's directory and from the working
// directory looking for site/_headers.
func findSite() string {
	var starts []string
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, dir := range starts {
		for {
			site := filepath.Join(dir, "site")
			if st, err := os.Stat(filepath.Join(site, "_headers")); err == nil && !st.IsDir() {
				return site
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

// noModule is used when no PKCS#11 module could be loaded.
type noModule struct{ msg string }

func (n noModule) Tokens() ([]RawToken, error)  { return nil, errors.New(n.msg) }
func (n noModule) Token(uint) (RawToken, error) { return RawToken{}, errors.New(n.msg) }
func (n noModule) Sign(uint, []byte, string, Mechanism, []byte) ([]byte, error) {
	return nil, errors.New(n.msg)
}

// statusRecorder captures the response status and size for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// newHandler routes /local-signer/* to the API and everything else to the site.
func newHandler(a *api, static http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w}
		if isSignerPath(r.URL.Path) {
			a.ServeHTTP(rec, r)
		} else {
			static.ServeHTTP(rec, r)
		}
		// Only method, path, status and sizes are logged.
		log.Printf("%s %s %d req=%d resp=%d", r.Method, r.URL.Path, rec.status, r.ContentLength, rec.bytes)
	})
}

func main() {
	siteFlag := flag.String("site", "", "path to the site/ directory (default: found by walking up from the executable and the working directory)")
	port := flag.Int("port", 4198, "port to listen on at 127.0.0.1 (0 picks a free port)")
	moduleFlag := flag.String("module", "", "path to the PKCS#11 module (default: $PKCS11_MODULE, then common OpenSC locations)")
	maxFailures := flag.Int("max-pin-failures", 3, "wrong PINs per slot before PIN attempts stop until restart")
	flag.Parse()
	if *maxFailures < 1 {
		log.Fatal("-max-pin-failures must be at least 1")
	}

	site := *siteFlag
	if site == "" {
		if site = findSite(); site == "" {
			log.Fatal("could not find site/_headers; pass -site")
		}
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		log.Fatal(err)
	}
	token := hex.EncodeToString(tokenBytes)

	module := *moduleFlag
	if module == "" {
		module = os.Getenv("PKCS11_MODULE")
	}
	if module == "" {
		module = findModule()
	}
	var backend Backend
	moduleName := ""
	if module == "" {
		backend = noModule{"No PKCS#11 module found. Install OpenSC, or start the signer with -module pointing at your token's PKCS#11 library."}
	} else {
		moduleName = filepath.Base(module)
		if b, err := loadModule(module); err != nil {
			log.Print(err)
			backend = noModule{err.Error()}
		} else {
			log.Printf("PKCS#11 module: %s", moduleName)
			backend = b
		}
	}

	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		log.Fatal(err)
	}
	actual := ln.Addr().(*net.TCPAddr).Port
	host := "127.0.0.1:" + strconv.Itoa(actual)

	a := &api{backend: backend, moduleName: moduleName, host: host, origin: "http://" + host, token: token, limiter: newPinLimiter(*maxFailures)}
	static, err := newStaticServer(site, token, func(r *http.Request) bool { return r.Host == host })
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Handler:           newHandler(a, static),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if moduleName == "" {
		log.Print("no PKCS#11 module found; install OpenSC or pass -module")
	}
	fmt.Printf("Private Tools signer: http://%s/tools/pdf-editor/\n", host)
	log.Fatal(srv.Serve(ln))
}
