// Package daemon exposes the capture engine over a local HTTP API so clients
// (TUI, desktop shell, CLI) read and write events through one boundary
// instead of touching spool files directly.
package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"agentfirehose/internal/adapters/generic"
	"agentfirehose/internal/adapters/push"
	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

const (
	defaultRecentLimit = 500
	maxRecentLimit     = 10000
)

// Server adapts an injected capture engine to the local API.
type Server struct {
	mu      sync.RWMutex // guards cfg
	cfg     cli.Config
	home    string
	version string
	engine  *capture.Engine

	// Environ is the process environment consulted by install handlers;
	// injectable for tests so host telemetry variables cannot leak in.
	Environ []string
}

func New(engine *capture.Engine, cfg cli.Config, home, version string) *Server {
	return &Server{
		cfg:     cfg,
		home:    home,
		version: version,
		engine:  engine,
		Environ: os.Environ(),
	}
}

// allowedOrigins are the browser origins that may read the local API: the
// Tauri desktop shell and its vite dev server. Arbitrary web origins are
// deliberately excluded — a random website must not read the event feed.
var allowedOrigins = map[string]bool{
	"tauri://localhost":       true, // tauri webview (macOS/Linux)
	"http://tauri.localhost":  true, // tauri webview (Windows)
	"https://tauri.localhost": true,
	"http://localhost:1420":   true, // vite dev server (tauri dev)
}

// cors echoes the Origin header for allowlisted origins and answers their
// preflights. Non-browser clients (no Origin header) are untouched.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && !allowedOrigins[origin] {
			http.Error(w, "browser origin is not allowed", http.StatusForbidden)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// Handler returns the daemon's HTTP API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /config", s.handleConfig)
	mux.HandleFunc("POST /config", s.handleConfigUpdate)
	mux.HandleFunc("GET /events", s.handleRecent)
	mux.HandleFunc("GET /events/stream", s.handleStream)
	mux.HandleFunc("POST /events", s.handleIngest)
	mux.HandleFunc("POST /emit", s.handleEmit)
	mux.HandleFunc("POST /v1/logs", s.handleOTLPLogs)
	mux.HandleFunc("POST /v1/metrics", s.handleOTLPMetrics)
	mux.HandleFunc("GET /sessions", s.handleSessions)
	mux.HandleFunc("GET /sessions/{id}", s.handleSessionByID)
	mux.HandleFunc("GET /traces/{id}", s.handleTraceByID)
	mux.HandleFunc("GET /artifacts/files", s.handleArtifactFiles)
	mux.HandleFunc("GET /doctor", s.handleDoctor)
	mux.HandleFunc("POST /install/{adapter}", s.handleInstall)
	mux.HandleFunc("POST /export", s.handleExport)
	return cors(mux)
}

// Serve listens on addr and serves the API until ctx is canceled. It returns
// the bound address (useful with ":0"), and a channel that yields the serve
// error (nil on clean shutdown). Open event streams are closed on shutdown so
// the daemon can always restart independently of its clients.
func (s *Server) Serve(ctx context.Context, addr string) (string, <-chan error, error) {
	if err := validateLoopbackAddr(addr); err != nil {
		return "", nil, err
	}
	l, err := (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
	if err != nil {
		return "", nil, err
	}
	tcpAddr, ok := l.Addr().(*net.TCPAddr)
	if !ok || tcpAddr.IP == nil || !tcpAddr.IP.IsLoopback() {
		_ = l.Close()
		return "", nil, fmt.Errorf("daemon address %q resolved outside loopback", addr)
	}
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       60 * time.Second,
		// WriteTimeout intentionally unset: SSE /events/stream is long-lived.
	}
	requestCtx, cancelRequests := context.WithCancel(context.Background())
	srv.BaseContext = func(net.Listener) context.Context { return requestCtx }
	go func() {
		<-ctx.Done()
		cancelRequests()
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()
	done := make(chan error, 1)
	go func() {
		defer cancelRequests()
		err := srv.Serve(l)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		done <- err
	}()
	return l.Addr().String(), done, nil
}

func validateLoopbackAddr(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("daemon address %q: %w", addr, err)
	}
	if host == "localhost" {
		// The actual listener address is checked again after bind, so a
		// nonstandard hosts-file mapping is still rejected without DNS here.
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("daemon address %q must use localhost or a loopback IP", addr)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"status":         "ok",
		"version":        s.version,
		"schema_version": event.CurrentSchemaVersion,
	})
}

// config returns a snapshot of the effective runtime configuration.
func (s *Server) config() cli.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.config())
}

// handleConfigUpdate persists a partial config update. Only privacy_mode is
// applied to the running engine; other fields take effect on restart.
func (s *Server) handleConfigUpdate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxOTLPBodyBytes)
	var patch cli.Config
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if patch.PrivacyMode != "" {
		if _, err := privacy.ParseMode(patch.PrivacyMode); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	s.mu.Lock()
	merged := s.cfg
	var restart []string
	if patch.PrivacyMode != "" {
		merged.PrivacyMode = patch.PrivacyMode
	}
	if patch.SpoolDir != "" && patch.SpoolDir != merged.SpoolDir {
		merged.SpoolDir = patch.SpoolDir
		restart = append(restart, "spool_dir")
	}
	if patch.CodexDir != "" && patch.CodexDir != merged.CodexDir {
		merged.CodexDir = patch.CodexDir
		restart = append(restart, "codex_sessions_dir")
	}
	if patch.DaemonAddr != "" && patch.DaemonAddr != merged.DaemonAddr {
		merged.DaemonAddr = patch.DaemonAddr
		restart = append(restart, "daemon_addr")
	}
	if err := cli.SaveConfig(s.home, merged); err != nil {
		s.mu.Unlock()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.cfg.PrivacyMode = merged.PrivacyMode
	s.mu.Unlock()
	if patch.PrivacyMode != "" {
		mode, _ := privacy.ParseMode(patch.PrivacyMode)
		s.engine.SetPolicy(mode)
	}

	if restart == nil {
		restart = []string{}
	}
	writeJSON(w, map[string]any{"config": merged, "restart_required": restart})
}

func (s *Server) handleRecent(w http.ResponseWriter, r *http.Request) {
	limit := defaultRecentLimit
	if q := r.URL.Query().Get("limit"); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n <= 0 {
			http.Error(w, "limit must be a positive integer", http.StatusBadRequest)
			return
		}
		limit = n
	}
	if limit > maxRecentLimit {
		limit = maxRecentLimit
	}
	evs, err := s.engine.Recent(limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if evs == nil {
		evs = []event.Event{}
	}
	writeJSON(w, evs)
}

func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxOTLPBodyBytes)
	scanner := bufio.NewScanner(r.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	n := 0
	for scanner.Scan() {
		if len(scanner.Bytes()) == 0 {
			continue
		}
		observation, err := generic.Parse(scanner.Bytes())
		if err != nil {
			continue
		}
		if _, err := s.engine.Admit(r.Context(), observation); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		n++
	}
	if err := scanner.Err(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]int{"ingested": n})
}

func (s *Server) handleEmit(w http.ResponseWriter, r *http.Request) {
	source := r.URL.Query().Get("source")
	if source == "" {
		source = "generic"
	}
	// `event` is an additive, optional parameter: sources whose payloads
	// carry no event-name field (antigravity) supply the native hook event
	// name here; every other source ignores it.
	eventName := r.URL.Query().Get("event")
	r.Body = http.MaxBytesReader(w, r.Body, maxOTLPBodyBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	observation, err := push.Parse(source, eventName, raw)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if observation != nil {
		if _, err := s.engine.Admit(r.Context(), *observation); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
