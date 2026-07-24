package daemon

import (
	"fmt"
	"net/http"
	"os"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/index"
	"agentfirehose/internal/spool"
)

// Session and FileArtifact are served straight from the derived index; the
// JSON shapes are part of the local API contract.
type (
	Session      = index.Session
	FileArtifact = index.FileArtifact
)

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.ensureIndex().Sessions())
}

func (s *Server) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	days := s.ensureIndex().SessionDays(id)
	if len(days) == 0 {
		http.Error(w, fmt.Sprintf("no events for session %q", id), http.StatusNotFound)
		return
	}
	// The index narrows the read to the day files the session appears in;
	// the spool stays the source of truth for the events themselves.
	evs, err := spool.ReadDays(s.config().SpoolDir, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var out []event.Event
	for _, ev := range evs {
		if ev.SessionID == id {
			out = append(out, ev)
		}
	}
	if len(out) == 0 {
		http.Error(w, fmt.Sprintf("no events for session %q", id), http.StatusNotFound)
		return
	}
	writeJSON(w, out)
}

func (s *Server) handleTraceByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	days := s.ensureIndex().TraceDays(id)
	if len(days) == 0 {
		http.Error(w, fmt.Sprintf("no events for trace %q", id), http.StatusNotFound)
		return
	}
	evs, err := spool.ReadDays(s.config().SpoolDir, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var out []event.Event
	for _, ev := range evs {
		if ev.TraceID == id {
			out = append(out, ev)
		}
	}
	if len(out) == 0 {
		http.Error(w, fmt.Sprintf("no events for trace %q", id), http.StatusNotFound)
		return
	}
	writeJSON(w, out)
}

func (s *Server) handleArtifactFiles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.ensureIndex().Files())
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
	default:
		http.Error(w, fmt.Sprintf("unknown adapter %q (want claude-code, codex, or opencode)", adapter), http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "detail": detail})
}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Firehose-Export-Version", fmt.Sprint(cli.ExportVersion))
	if _, err := cli.Export(s.config(), w); err != nil {
		// Headers are already sent; the truncated body is the best signal left.
		return
	}
}
