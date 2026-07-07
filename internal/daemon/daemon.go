// Package daemon exposes the capture engine over a local HTTP API so clients
// (TUI, desktop shell, CLI) read and write events through one boundary
// instead of touching spool files directly.
package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
)

const defaultRecentLimit = 500

// Server owns the capture engine behind the local API.
type Server struct {
	mu      sync.RWMutex // guards cfg
	cfg     cli.Config
	home    string
	version string
	hub     *hub

	// TailInterval is the spool poll cadence; WatchInterval the codex one.
	TailInterval  time.Duration
	WatchInterval time.Duration
}

func New(cfg cli.Config, home, version string) *Server {
	return &Server{
		cfg:           cfg,
		home:          home,
		version:       version,
		hub:           newHub(),
		TailInterval:  100 * time.Millisecond,
		WatchInterval: 250 * time.Millisecond,
	}
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
	mux.HandleFunc("POST /export", s.handleExport)
	return mux
}

// Serve listens on addr and serves the API until ctx is canceled. It returns
// the bound address (useful with ":0"), and a channel that yields the serve
// error (nil on clean shutdown). Open event streams are closed on shutdown so
// the daemon can always restart independently of its clients.
func (s *Server) Serve(ctx context.Context, addr string) (string, <-chan error, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return "", nil, err
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
