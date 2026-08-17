package daemon

import (
	"errors"
	"fmt"
	"net/http"
	"os"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
)

// Session and FileArtifact are served straight from the derived index; the
// JSON shapes are part of the local API contract.
type (
	Session      = capture.Session
	FileArtifact = capture.FileArtifact
)

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.engine.Sessions())
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
		if err := cli.InstallClaudeOTel(s.home, addr, s.Environ); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, cli.ErrClaudeOTelConflict) {
				status = http.StatusConflict
			}
			http.Error(w, err.Error(), status)
			return
		}
		detail = "supplemental Claude OTLP/HTTP JSON enabled for the local daemon; restart running Claude Code sessions"
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
