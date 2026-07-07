package daemon

import (
	"fmt"
	"net/http"
	"os"
	"sort"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

// Session summarizes one agent session derived from the spool.
type Session struct {
	ID        string    `json:"id"`
	Source    string    `json:"source"`
	Agent     string    `json:"agent,omitempty"`
	Repo      string    `json:"repo,omitempty"`
	CWD       string    `json:"cwd,omitempty"`
	FirstTime time.Time `json:"first_time"`
	LastTime  time.Time `json:"last_time"`
	Events    int       `json:"events"`
}

func sessionsFromEvents(evs []event.Event) []Session {
	byID := map[string]*Session{}
	var order []string
	for _, ev := range evs {
		if ev.SessionID == "" {
			continue
		}
		s, ok := byID[ev.SessionID]
		if !ok {
			s = &Session{ID: ev.SessionID, FirstTime: ev.Time, LastTime: ev.Time}
			byID[ev.SessionID] = s
			order = append(order, ev.SessionID)
		}
		s.Events++
		if ev.Time.Before(s.FirstTime) {
			s.FirstTime = ev.Time
		}
		if !ev.Time.Before(s.LastTime) {
			s.LastTime = ev.Time
		}
		if s.Source == "" {
			s.Source = ev.Source
		}
		if s.Agent == "" {
			s.Agent = ev.Agent
		}
		if s.Repo == "" {
			s.Repo = ev.Repo
		}
		if s.CWD == "" {
			s.CWD = ev.CWD
		}
	}
	out := make([]Session, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastTime.After(out[j].LastTime) })
	return out
}

func (s *Server) readAll() ([]event.Event, error) {
	return spool.ReadLastN(s.config().SpoolDir, 1<<31-1)
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	evs, err := s.readAll()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, sessionsFromEvents(evs))
}

func (s *Server) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	evs, err := s.readAll()
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

// FileArtifact summarizes all touches of one file path across sources.
type FileArtifact struct {
	Path      string    `json:"path"`
	Events    int       `json:"events"`
	Sources   []string  `json:"sources"`
	FirstTime time.Time `json:"first_time"`
	LastTime  time.Time `json:"last_time"`
}

// eventFilePaths extracts the file paths a file-category event touched.
// Adapters store them differently: claude-code uses payload.file_path,
// opencode payload.file, codex a payload.changes map keyed by path.
func eventFilePaths(ev event.Event) []string {
	if ev.Category != event.CategoryFile {
		return nil
	}
	for _, key := range []string{"file_path", "path", "file"} {
		if p, ok := ev.Payload[key].(string); ok && p != "" {
			return []string{p}
		}
	}
	if changes, ok := ev.Payload["changes"].(map[string]any); ok {
		paths := make([]string, 0, len(changes))
		for p := range changes {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		return paths
	}
	return nil
}

func filesFromEvents(evs []event.Event) []FileArtifact {
	byPath := map[string]*FileArtifact{}
	sources := map[string]map[string]bool{}
	for _, ev := range evs {
		for _, p := range eventFilePaths(ev) {
			f, ok := byPath[p]
			if !ok {
				f = &FileArtifact{Path: p, FirstTime: ev.Time, LastTime: ev.Time}
				byPath[p] = f
				sources[p] = map[string]bool{}
			}
			f.Events++
			if ev.Time.Before(f.FirstTime) {
				f.FirstTime = ev.Time
			}
			if !ev.Time.Before(f.LastTime) {
				f.LastTime = ev.Time
			}
			if ev.Source != "" && !sources[p][ev.Source] {
				sources[p][ev.Source] = true
				f.Sources = append(f.Sources, ev.Source)
			}
		}
	}
	out := make([]FileArtifact, 0, len(byPath))
	for _, f := range byPath {
		out = append(out, *f)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].LastTime.Equal(out[j].LastTime) {
			return out[i].LastTime.After(out[j].LastTime)
		}
		return out[i].Path < out[j].Path
	})
	return out
}

func (s *Server) handleArtifactFiles(w http.ResponseWriter, r *http.Request) {
	evs, err := s.readAll()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, filesFromEvents(evs))
}

func (s *Server) handleTraceByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	evs, err := s.readAll()
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

func (s *Server) handleDoctor(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, cli.Doctor(s.config(), s.home))
}

// handleInstall wires an adapter the same way `firehose install` does, so
// desktop onboarding can drive installation through the API.
func (s *Server) handleInstall(w http.ResponseWriter, r *http.Request) {
	adapter := r.PathValue("adapter")
	var detail string
	switch adapter {
	case "claude-code":
		bin, err := os.Executable()
		if err != nil {
			bin = "firehose"
		}
		if err := cli.InstallClaudeCode(s.home, bin); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		detail = "hooks merged into ~/.claude/settings.json (backup: settings.json.bak); restart running Claude Code sessions"
	case "opencode":
		path, err := cli.InstallOpenCode(s.home)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		detail = "plugin written to " + path + "; restart OpenCode to load it"
	default:
		http.Error(w, fmt.Sprintf("unknown adapter %q (want claude-code or opencode)", adapter), http.StatusNotFound)
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
