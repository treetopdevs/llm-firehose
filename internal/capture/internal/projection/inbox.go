package projection

import (
	"sort"
	"time"

	"agentfirehose/internal/event"
)

// Evidence identifies a captured observation, never a synthetic state frame.
type Evidence struct {
	SourceTime *time.Time `json:"source_time,omitempty"`
	Source     string     `json:"source"`
	EventID    string     `json:"event_id"`
	Kind       string     `json:"kind"`
	Summary    string     `json:"summary"`
	Time       time.Time  `json:"time"`
	ObservedAt time.Time  `json:"observed_at"`
}

// InboxSession is scoped by both source and native session ID. The older
// session projection and its frozen attention semantics remain independent.
type InboxSession struct {
	stateTime   time.Time
	requestKey  string
	ID          string    `json:"id"`
	Source      string    `json:"source"`
	Agent       string    `json:"agent,omitempty"`
	Repo        string    `json:"repo,omitempty"`
	CWD         string    `json:"cwd,omitempty"`
	RepoID      string    `json:"repo_id,omitempty"`
	WorktreeID  string    `json:"worktree_id,omitempty"`
	Events      int       `json:"events"`
	State       string    `json:"state"`
	Last        Evidence  `json:"last"`
	Pending     *Evidence `json:"pending,omitempty"`
	Uncertainty string    `json:"uncertainty,omitempty"`
}

type InboxSnapshot struct {
	Sessions []InboxSession `json:"sessions"`
	Warnings []Evidence     `json:"warnings"`
}

type inboxKey struct{ source, session string }

func capturedEvidence(ev event.Event, kind string) Evidence {
	observed := ev.Time
	if ev.CaptureTime != nil {
		observed = *ev.CaptureTime
	}
	return copyEvidence(Evidence{SourceTime: ev.SourceTime, Source: ev.Source, EventID: ev.ID, Kind: kind, Summary: ev.Summary, Time: ev.Time, ObservedAt: observed})
}

// applyInbox runs under the Projection write lock after exact-ID deduplication.
func (ix *Projection) applyInbox(ev event.Event) {
	if ev.Category == event.CategoryMeta && ev.Severity == event.SeverityWarn && ev.Name != "parse-error" {
		key := inboxKey{ev.Source, ev.Name}
		if old, ok := ix.warnings[key]; !ok || !ev.Time.Before(old.Time) {
			ix.warnings[key] = capturedEvidence(ev, "capture_warning")
		}
	}
	if ev.SessionID == "" {
		return
	}
	key := inboxKey{ev.Source, ev.SessionID}
	s := ix.inbox[key]
	if s == nil {
		s = &InboxSession{ID: ev.SessionID, Source: ev.Source, State: "unknown"}
		ix.inbox[key] = s
	}
	s.Events++
	if !ev.Time.Before(s.Last.Time) {
		s.Last = capturedEvidence(ev, "activity")
		if ev.Agent != "" {
			s.Agent = ev.Agent
		}
		if ev.Repo != "" {
			s.Repo = ev.Repo
		}
		if ev.CWD != "" {
			s.CWD = ev.CWD
		}
		if ev.RepoID != "" {
			s.RepoID = ev.RepoID
		}
		if ev.WorktreeID != "" {
			s.WorktreeID = ev.WorktreeID
		}
	}
	if ev.Time.Before(s.stateTime) {
		return
	}
	kind := inboxSignal(ev)
	switch kind {
	case "request", "failure":
		requestKey := ev.RequestID
		if requestKey == "" {
			requestKey = ev.CallID
		}
		if kind != "request" || s.Pending == nil || s.Pending.Kind != kind || requestKey == "" || requestKey != s.requestKey {
			p := capturedEvidence(ev, kind)
			s.Pending = &p
		}
		s.requestKey = requestKey
		s.State = "needs_input"
		if kind == "failure" {
			s.State = "failed"
		}
		s.Uncertainty = ""
		s.stateTime = ev.Time
	case "done", "working":
		s.Pending = nil
		s.State = kind
		s.Uncertainty = ""
		s.stateTime = ev.Time
	case "uncertain":
		s.Uncertainty = "Notification captured; whether input is required is unknown."
	}

}

// Inbox returns detached snapshots so callers cannot mutate the Projection.
func (ix *Projection) Inbox() InboxSnapshot {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := InboxSnapshot{Sessions: make([]InboxSession, 0, len(ix.inbox)), Warnings: []Evidence{}}
	for _, w := range ix.warnings {
		out.Warnings = append(out.Warnings, copyEvidence(w))
	}
	sort.Slice(out.Warnings, func(i, j int) bool {
		a, b := out.Warnings[i], out.Warnings[j]
		if a.Time.Equal(b.Time) {
			return a.EventID < b.EventID
		}
		return a.Time.After(b.Time)
	})
	for _, s := range ix.inbox {
		copy := *s
		copy.Last = copyEvidence(s.Last)
		if s.Pending != nil {
			p := copyEvidence(*s.Pending)
			copy.Pending = &p
		}
		out.Sessions = append(out.Sessions, copy)
	}
	sort.Slice(out.Sessions, func(i, j int) bool {
		a, b := out.Sessions[i], out.Sessions[j]
		if a.Source != b.Source {
			return a.Source < b.Source
		}
		return a.ID < b.ID
	})
	return out
}

// Only verified native signal families earn an interruption. Privacy-redacted
// or unfamiliar notifications remain visible without asserting a blocking state.
func inboxSignal(ev event.Event) string {
	known := ev.Source == "codex" || ev.Source == "claude-code" || ev.Source == "opencode"
	if ev.Category == event.CategoryPermission {
		switch {
		case ev.Source == "codex" && ev.Name == "PermissionRequest", ev.Source == "opencode" && ev.Name == "permission.updated":
			return "request"
		case ev.Source == "opencode" && ev.Name == "permission.replied":
			return "working"
		case ev.Source == "claude-code" && ev.Name == "Notification":
			if ev.Payload["notification_type"] == "permission_prompt" {
				return "request"
			}
		}
		return "uncertain"
	}
	if ev.Category == event.CategoryError {
		if ev.Source == "claude-code" && ev.Name == "StopFailure" || ev.Source == "opencode" && ev.Name == "session.error" || ev.Source == "codex" && ev.Name == "error" {
			return "failure"
		}
	}
	if known && ev.Name != "SubagentStop" && isSessionEnd(ev) {
		return "done"
	}
	if isActivity(ev) && ev.Severity != event.SeverityError {
		return "working"
	}
	return ""
}

// EventDay locates the canonical day containing an already projected ID.
func (ix *Projection) EventDay(id string) string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.seen[id]
}

func copyEvidence(ev Evidence) Evidence {
	if ev.SourceTime != nil {
		t := *ev.SourceTime
		ev.SourceTime = &t
	}
	return ev
}
