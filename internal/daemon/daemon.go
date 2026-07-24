// Package daemon exposes the capture engine over a local HTTP API so clients
// (TUI, desktop shell, CLI) read and write events through one boundary
// instead of touching spool files directly.
package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"agentfirehose/internal/adapters/procwatch"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/index"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
)

const defaultRecentLimit = 500

// Server owns the capture engine behind the local API.
type Server struct {
	mu      sync.RWMutex // guards cfg
	wg      sync.WaitGroup
	cfg     cli.Config
	home    string
	version string
	hub     *hub

	ixOnce sync.Once
	ix     *index.Index

	// TailInterval is the spool poll cadence; WatchInterval the codex one;
	// ProcInterval the process-table one.
	TailInterval  time.Duration
	WatchInterval time.Duration
	ProcInterval  time.Duration

	// ProcLister supplies the process table for the agent process watcher;
	// injectable for tests.
	ProcLister procwatch.Lister
}

func (s *Server) launch(run func()) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		run()
	}()
}

// Wait blocks until capture workers launched by Start have observed
// cancellation and stopped.
func (s *Server) Wait() {
	s.wg.Wait()
}

// ensureIndex builds the derived index from the spool exactly once (at Start
// in production, or lazily at the first query) and returns it. A failed
// build degrades to an empty index rather than taking the API down; the
// spool remains authoritative either way.
func (s *Server) ensureIndex() *index.Index {
	s.ixOnce.Do(func() {
		ix, err := index.Build(s.config().SpoolDir)
		if err != nil {
			ix = index.New()
		}
		s.ix = ix
	})
	return s.ix
}

func New(cfg cli.Config, home, version string) *Server {
	return &Server{
		cfg:           cfg,
		home:          home,
		version:       version,
		hub:           newHub(),
		TailInterval:  100 * time.Millisecond,
		WatchInterval: 250 * time.Millisecond,
		ProcInterval:  2 * time.Second,
		ProcLister:    procwatch.PSLister{},
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
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return "", nil, err
	}
	tcpAddr, ok := l.Addr().(*net.TCPAddr)
	if !ok || tcpAddr.IP == nil || !tcpAddr.IP.IsLoopback() {
		_ = l.Close()
		return "", nil, fmt.Errorf("daemon address %q resolved outside loopback", addr)
	}
	srv := &http.Server{Handler: s.Handler()}
	srv.RegisterOnShutdown(s.hub.closeAll)
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(shutCtx)
	}()
	done := make(chan error, 1)
	go func() {
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

// Run starts the capture engine and serves the local API on addr until ctx
// is canceled. onReady, when non-nil, receives the bound address once the
// listener is up. Both firehosed and `firehose daemon` are thin wrappers
// around this.
func Run(ctx context.Context, cfg cli.Config, home, version, addr string, onReady func(bound string)) error {
	s := New(cfg, home, version)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.Start(runCtx)
	bound, done, err := s.Serve(runCtx, addr)
	if err != nil {
		cancel()
		s.Wait()
		return err
	}
	if onReady != nil {
		onReady(bound)
	}
	err = <-done
	cancel()
	s.Wait()
	return err
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
	evs, err := spool.ReadLastN(s.config().SpoolDir, limit)
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
	n, err := cli.Ingest(s.config(), r.Body)
	if err != nil {
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
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// EmitLocal, never Emit: the daemon is the engine and must not proxy
	// emits back to its own address.
	if err := cli.EmitLocal(s.config(), source, raw); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
