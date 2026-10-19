package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
)

// Session, FileArtifact and ErrorSignature are served straight from the derived index; the
// JSON shapes are part of the local API contract.
type (
	Session        = capture.Session
	FileArtifact   = capture.FileArtifact
	ErrorSignature = capture.ErrorSignature
)

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.engine.Sessions())
}

// handleErrors serves derived Error Signature summaries, optionally limited to
// signatures that include one session (counts stay global).
func (s *Server) handleErrors(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.engine.ErrorSignatures(r.URL.Query().Get("session")))
}

func (s *Server) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	evs, err := s.engine.Session(id)
	if err != nil {
		if errors.Is(err, capture.ErrNotFound) {
			http.Error(w, fmt.Sprintf("no events for session %q", id), http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, evs)
}

func (s *Server) handleTraceByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	evs, err := s.engine.Trace(id)
	if err != nil {
		if errors.Is(err, capture.ErrNotFound) {
			http.Error(w, fmt.Sprintf("no events for trace %q", id), http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, evs)
}

func (s *Server) handleArtifactFiles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.engine.Files())
}

func (s *Server) handleDoctor(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, cli.Doctor(s.config(), s.home))
}

// handleInstall wires an adapter the same way `firehose install` does, so
// desktop onboarding can drive installation through the API.
func (s *Server) handleInstall(w http.ResponseWriter, r *http.Request) {
	adapter := r.PathValue("adapter")
	var detail string
	bin, err := os.Executable()
	if err != nil {
		bin = "firehosed"
	}
	switch adapter {
	case "claude-code":
		if err := cli.InstallClaudeCode(s.home, bin); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		detail = "hooks merged into ~/.claude/settings.json (backup: settings.json.bak); restart running Claude Code sessions"
	case "claude-otel":
		addr := s.config().DaemonAddr
		if addr == "" {
			addr = cli.DefaultDaemonAddr
		}
		var opts struct {
			Replace bool `json:"replace"`
			Forward bool `json:"forward"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&opts); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, "invalid install options: "+err.Error(), http.StatusBadRequest)
			return
		}
		if opts.Replace && opts.Forward {
			http.Error(w, "replace and forward are mutually exclusive", http.StatusBadRequest)
			return
		}
		backup, err := cli.InstallClaudeOTelWith(s.home, addr, s.Environ, cli.ClaudeOTelOptions{Replace: opts.Replace, Forward: opts.Forward})
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, cli.ErrClaudeOTelConflict) {
				status = http.StatusConflict
			}
			http.Error(w, err.Error(), status)
			return
		}
		detail = "supplemental Claude OTLP/HTTP JSON enabled for the local daemon; restart running Claude Code sessions"
		if kept, err := cli.LoadOTelForward(s.home); opts.Forward && err == nil && (kept.Logs != "" || kept.Metrics != "") {
			detail += "; your existing collector keeps receiving telemetry through Firehose"
		}
		if backup != "" {
			detail += " (backup: " + backup + ")"
		}
	case "opencode":
		path, err := cli.InstallOpenCode(s.home, bin)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		detail = "plugin written to " + path + "; restart OpenCode to load it"
	case "codex":
		if err := cli.InstallCodex(s.home, bin); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		detail = "Codex hooks configured in ~/.codex/hooks.json (backup: hooks.json.bak); review and trust them in Codex /hooks, then start a fresh task"
	case "antigravity":
		if err := cli.InstallAntigravity(s.home, bin); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		detail = "Antigravity hooks merged into ~/.gemini/config/hooks.json (backup: hooks.json.bak); start a fresh agy conversation to pick them up"
	default:
		http.Error(w, fmt.Sprintf("unknown adapter %q (want antigravity, claude-code, claude-otel, codex, or opencode)", adapter), http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "detail": detail})
}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Firehose-Export-Version", fmt.Sprint(cli.ExportVersion))
	if _, err := s.engine.Export(w); err != nil {
		// Headers are already sent; the truncated body is the best signal left.
		return
	}
}

func (s *Server) handleAttention(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, s.engine.Attention())
}

func (s *Server) handleEventByID(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ev, err := s.engine.Event(r.URL.Query().Get("id"))
	if err != nil {
		if errors.Is(err, capture.ErrNotFound) {
			http.Error(w, "captured event unavailable", http.StatusNotFound)
		} else {
			http.Error(w, "could not read captured evidence", http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, ev)
}
