package projection

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"

	"agentfirehose/internal/event"
)

// Evidence identifies a captured observation, never a synthetic state frame.
type Evidence struct {
	EpisodeID  string     `json:"episode_id,omitempty"`
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
	signal         Evidence
	uncertain      Evidence
	identity       [5]Evidence
	LastObservedAt time.Time `json:"last_observed_at"`
	ID             string    `json:"id"`
	Source         string    `json:"source"`
	Agent          string    `json:"agent,omitempty"`
	Repo           string    `json:"repo,omitempty"`
	CWD            string    `json:"cwd,omitempty"`
	RepoID         string    `json:"repo_id,omitempty"`
	WorktreeID     string    `json:"worktree_id,omitempty"`
	Events         int       `json:"events"`
	State          string    `json:"state"`
	Last           Evidence  `json:"last"`
	Pending        *Evidence `json:"pending,omitempty"`
	Uncertainty    string    `json:"uncertainty,omitempty"`
}

// CaptureGap describes an unreadable record, with no invented captured ID.
type CaptureGap struct {
	Source  string    `json:"source"`
	Time    time.Time `json:"time"`
	Summary string    `json:"summary"`
}

type InboxSnapshot struct {
	Gaps     []CaptureGap   `json:"gaps"`
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
	// Legacy history may lack IDs. Keep existing history/export semantics, but
	// never turn unaddressable observations into attention or resolution evidence.
	if ev.ID == "" {
		ix.gap = &CaptureGap{Source: ev.Source, Time: time.Now().UTC(), Summary: "Some legacy spool records lack stable event IDs and cannot support attention evidence."}
		return
	}
	if ev.Source == "firehose" && ev.Name == "parse-error" && ev.Category == event.CategoryMeta {
		ix.gap = &CaptureGap{Source: ev.Source, Time: ev.Time, Summary: ev.Summary}
	} else if ev.Category == event.CategoryMeta && ev.Severity == event.SeverityWarn {
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
	observed := capturedEvidence(ev, "activity")
	if observed.ObservedAt.After(s.LastObservedAt) {
		s.LastObservedAt = observed.ObservedAt
	}
	if newerEvidence(observed, s.Last) {
		s.Last = observed
	}
	fields := []struct {
		value  string
		target *string
	}{
		{ev.Agent, &s.Agent}, {ev.Repo, &s.Repo}, {ev.CWD, &s.CWD}, {ev.RepoID, &s.RepoID}, {ev.WorktreeID, &s.WorktreeID},
	}
	for i, f := range fields {
		if f.value != "" && newerEvidence(observed, s.identity[i]) {
			*f.target = f.value
			s.identity[i] = observed
		}
	}
	kind := inboxSignal(ev)
	if kind == "uncertain" {
		if newerEvidence(observed, s.uncertain) {
			s.uncertain = observed
		}
	} else if kind != "" && newerEvidence(observed, s.signal) {
		s.signal = observed
		s.Pending = nil
		s.State = kind
		if kind == "request" || kind == "failure" {
			pending := capturedEvidence(ev, kind)
			pending.EpisodeID = episodeID(ev, kind)
			s.Pending = &pending
			s.State = "needs_input"
			if kind == "failure" {
				s.State = "failed"
			}
		}
	}
	s.Uncertainty = ""
	if s.uncertain.EventID != "" && newerEvidence(s.uncertain, s.signal) {
		s.Uncertainty = "Notification captured; whether input is required is unknown."
	}
}

// Use native chronology when supplied. Observation time and stable ID break
// ties deterministically, so live application and day-sorted rebuild converge.
func newerEvidence(a, b Evidence) bool {
	at, bt := a.Time, b.Time
	if a.SourceTime != nil {
		at = *a.SourceTime
	}
	if b.SourceTime != nil {
		bt = *b.SourceTime
	}
	if !at.Equal(bt) {
		return at.After(bt)
	}
	if !a.ObservedAt.Equal(b.ObservedAt) {
		return a.ObservedAt.After(b.ObservedAt)
	}
	return a.EventID > b.EventID
}

func episodeID(ev event.Event, kind string) string {
	scope, key := "event", ev.ID
	if kind == "request" {
		if ev.RequestID != "" {
			scope, key = "request", ev.RequestID
		} else if ev.CallID != "" {
			scope, key = "call", ev.CallID
		}
	}
	encoded, _ := json.Marshal([]string{ev.Source, ev.SessionID, kind, scope, key})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

// Inbox returns detached snapshots so callers cannot mutate the Projection.
func (ix *Projection) Inbox() InboxSnapshot {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := InboxSnapshot{Gaps: []CaptureGap{}, Sessions: make([]InboxSession, 0, len(ix.inbox)), Warnings: []Evidence{}}
	if ix.gap != nil {
		out.Gaps = append(out.Gaps, *ix.gap)
	}
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

// Only explicitly mapped native signal families earn an interruption. Privacy-redacted
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
