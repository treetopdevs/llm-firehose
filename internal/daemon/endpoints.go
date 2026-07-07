package daemon

import (
	"fmt"
	"net/http"
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
	return spool.ReadLastN(s.cfg.SpoolDir, 1<<31-1)
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

func (s *Server) handleDoctor(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, cli.Doctor(s.cfg, s.home))
}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Firehose-Export-Version", fmt.Sprint(cli.ExportVersion))
	if _, err := cli.Export(s.cfg, w); err != nil {
		// Headers are already sent; the truncated body is the best signal left.
		return
	}
}
