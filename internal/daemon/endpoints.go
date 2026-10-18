package daemon

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

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
	// Validate the view before touching the spool so a typo never scans.
	view := r.URL.Query().Get("view")
	if view != "" && view != "full" && view != "timeline" {
		http.Error(w, fmt.Sprintf("unknown view %q (want full or timeline)", view), http.StatusBadRequest)
		return
	}
	evs, err := s.engine.SessionContext(r.Context(), id)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		if errors.Is(err, capture.ErrNotFound) {
			http.Error(w, fmt.Sprintf("no events for session %q", id), http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if view == "timeline" {
		for i := range evs {
			evs[i] = capture.TimelineView(evs[i])
		}
	}
	writeJSON(w, evs)
}

func (s *Server) handleTraceByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	evs, err := s.engine.TraceContext(r.Context(), id)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
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

func (s *Server) handleAttention(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, s.engine.Attention())
}

func (s *Server) handleEventByID(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ev, err := s.engine.Event(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		if r.Context().Err() != nil {
			return // client aborted; the scan stopped with it
		}
		if errors.Is(err, capture.ErrNotFound) {
			http.Error(w, "captured event unavailable", http.StatusNotFound)
		} else {
			http.Error(w, "could not read captured evidence", http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, ev)
}

func (s *Server) handleErrorSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		http.Error(w, "invalid query", http.StatusBadRequest)
		return
	}
	for _, name := range []string{"key", "offset", "limit"} {
		if len(q[name]) > 1 {
			http.Error(w, "duplicate "+name, http.StatusBadRequest)
			return
		}
	}
	offset, limit := 0, 50
	for _, param := range []struct {
		name string
		dst  *int
	}{{"offset", &offset}, {"limit", &limit}} {
		if q.Has(param.name) {
			raw := q.Get(param.name)
			if raw == "" || strings.IndexFunc(raw, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
				http.Error(w, "invalid "+param.name, http.StatusBadRequest)
				return
			}
			n, err := strconv.Atoi(raw)
			if err != nil {
				http.Error(w, "invalid "+param.name, http.StatusBadRequest)
				return
			}
			*param.dst = n
		}
	}
	page, err := s.engine.ErrorSessions(q.Get("key"), offset, limit)
	if err != nil {
		status, message := http.StatusInternalServerError, "could not read error sessions"
		if errors.Is(err, capture.ErrInvalidErrorSessionsQuery) {
			status, message = http.StatusBadRequest, "invalid error sessions query"
		} else if errors.Is(err, capture.ErrNotFound) {
			status, message = http.StatusNotFound, "error signature not found"
		}
		http.Error(w, message, status)
		return
	}
	writeJSON(w, page)
}
