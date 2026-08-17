// Package projection maintains derived, queryable state over the spool: session
// and trace summaries, touched-file artifacts, and the day files each id
// appears in. The spool stays the source of truth (migration plan, Phase 2);
// the Projection is rebuilt from it at startup and updated incrementally, so it
// can always be thrown away.
package projection

import (
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
)

// Session summarizes one agent session.
type Session struct {
	ID           string       `json:"id"`
	Source       string       `json:"source"`
	Agent        string       `json:"agent,omitempty"`
	Repo         string       `json:"repo,omitempty"`
	CWD          string       `json:"cwd,omitempty"`
	FirstTime    time.Time    `json:"first_time"`
	LastTime     time.Time    `json:"last_time"`
	Events       int          `json:"events"`
	State        SessionState `json:"state"`
	StateSince   time.Time    `json:"state_since"`
	StateReason  string       `json:"state_reason,omitempty"`
	HasError     bool         `json:"has_error,omitempty"`
	LastSummary  string       `json:"last_summary,omitempty"`
	LastCategory string       `json:"last_category,omitempty"`
}

// Trace summarizes causally related events sharing one trace_id.
type Trace struct {
	ID        string    `json:"id"`
	FirstTime time.Time `json:"first_time"`
	LastTime  time.Time `json:"last_time"`
	Events    int       `json:"events"`
}

// FileArtifact summarizes all touches of one file path across sources.
type FileArtifact struct {
	Path      string    `json:"path"`
	Events    int       `json:"events"`
	Sources   []string  `json:"sources"`
	FirstTime time.Time `json:"first_time"`
	LastTime  time.Time `json:"last_time"`
}

// Projection is a thread-safe disposable view over Captured Events.
type Projection struct {
	mu       sync.RWMutex
	sessions map[string]*sessionEntry
	traces   map[string]*traceEntry
	files    map[string]*fileEntry
	seen     map[string]bool
}

type sessionEntry struct {
	Session
	days         map[string]bool
	lastActivity time.Time
	openTools    int // tool calls begun (PreToolUse) but not yet finished
}

type traceEntry struct {
	Trace
	days map[string]bool
}

type fileEntry struct {
	FileArtifact
	sources map[string]bool
}

func New() *Projection {
	return &Projection{
		sessions: map[string]*sessionEntry{},
		traces:   map[string]*traceEntry{},
		files:    map[string]*fileEntry{},
		seen:     map[string]bool{},
	}
}

// Build rebuilds the Projection from every event in the spool directory. A
// missing directory yields an empty Projection; unparseable lines are skipped by
// the spool reader.
func Build(dir string) (*Projection, error) {
	evs, err := spool.ReadLastN(dir, math.MaxInt)
	if err != nil {
		return nil, err
	}
	ix := New()
	for _, ev := range evs {
		ix.Apply(ev)
	}
	return ix, nil
}

// SourceFirehose is the synthetic source for stream-only derived frames.
const SourceFirehose = "firehose"

// NameStateTransition is the event name for attention-state SSE frames.
const NameStateTransition = "state.transition"

// Apply folds one event into the Projection. Events with an id already applied
// are ignored, so replays (e.g. the startup tail overlapping the build read)
// never double-count. When a session's attention state changes, Apply returns
// a stream-only synthetic event (never spooled).
func (ix *Projection) Apply(ev event.Event) *event.Event {
	transition, _ := ix.ApplyResult(ev)
	return transition
}

// ApplyResult folds one event into the Projection and reports whether its stable id
// was new. The seen set spans the lifetime of the Projection so an old replay
// can never be counted twice.
func (ix *Projection) ApplyResult(ev event.Event) (*event.Event, bool) {
	ix.mu.Lock()
	defer ix.mu.Unlock()

	if ev.Source == SourceFirehose && ev.Name == NameStateTransition {
		return nil, false
	}

	if ev.ID != "" {
		if ix.seen[ev.ID] {
			return nil, false
		}
		ix.seen[ev.ID] = true
	}

	day := ev.Time.UTC().Format("2006-01-02")
	var transition *event.Event

	if ev.SessionID != "" {
		s, ok := ix.sessions[ev.SessionID]
		if !ok {
			s = &sessionEntry{
				Session: Session{
					ID:         ev.SessionID,
					FirstTime:  ev.Time,
					LastTime:   ev.Time,
					State:      StateWorking,
					StateSince: ev.Time,
				},
				days:         map[string]bool{},
				lastActivity: ev.Time,
			}
			ix.sessions[ev.SessionID] = s
		}
		s.Events++
		if ev.Time.Before(s.FirstTime) {
			s.FirstTime = ev.Time
		}
		if !ev.Time.Before(s.LastTime) {
			s.LastTime = ev.Time
			s.LastSummary = ev.Summary
			s.LastCategory = string(ev.Category)
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
		s.days[day] = true
		s.lastActivity = ev.Time

		switch {
		case strings.HasPrefix(ev.Name, "PreToolUse"):
			s.openTools++
		case strings.HasPrefix(ev.Name, "PostToolUse"):
			if s.openTools > 0 {
				s.openTools--
			}
		case isSessionEnd(ev):
			// A lost PostToolUse must not pin the session out of idle forever.
			s.openTools = 0
		}

		prev := Attention{
			State:    s.State,
			Since:    s.StateSince,
			Reason:   s.StateReason,
			HasError: s.HasError,
		}
		next, changed := Transition(prev, ev)
		if changed {
			s.State = next.State
			s.StateSince = next.Since
			s.StateReason = next.Reason
			s.HasError = next.HasError
			transition = newStateTransition(ev.SessionID, prev.State, next, ev.Time)
		}
	}

	if ev.TraceID != "" {
		tr, ok := ix.traces[ev.TraceID]
		if !ok {
			tr = &traceEntry{
				Trace: Trace{ID: ev.TraceID, FirstTime: ev.Time, LastTime: ev.Time},
				days:  map[string]bool{},
			}
			ix.traces[ev.TraceID] = tr
		}
		tr.Events++
		if ev.Time.Before(tr.FirstTime) {
			tr.FirstTime = ev.Time
		}
		if !ev.Time.Before(tr.LastTime) {
			tr.LastTime = ev.Time
		}
		tr.days[day] = true
	}

	for _, p := range EventFilePaths(ev) {
		f, ok := ix.files[p]
		if !ok {
			f = &fileEntry{
				FileArtifact: FileArtifact{Path: p, FirstTime: ev.Time, LastTime: ev.Time},
				sources:      map[string]bool{},
			}
			ix.files[p] = f
		}
		f.Events++
		if ev.Time.Before(f.FirstTime) {
			f.FirstTime = ev.Time
		}
		if !ev.Time.Before(f.LastTime) {
			f.LastTime = ev.Time
		}
		if ev.Source != "" && !f.sources[ev.Source] {
			f.sources[ev.Source] = true
			f.Sources = append(f.Sources, ev.Source)
		}
	}
	return transition, true
}

// AdvanceIdle moves quiet working sessions to idle and returns one synthetic
// transition event per session that changed.
func (ix *Projection) AdvanceIdle(now time.Time) []*event.Event {
	ix.mu.Lock()
	defer ix.mu.Unlock()

	var out []*event.Event
	for id, s := range ix.sessions {
		prev := Attention{
			State:    s.State,
			Since:    s.StateSince,
			Reason:   s.StateReason,
			HasError: s.HasError,
		}
		next, changed := TickIdle(prev, s.lastActivity, now, s.openTools > 0)
		if !changed {
			continue
		}
		s.State = next.State
		s.StateSince = next.Since
		s.StateReason = next.Reason
		out = append(out, newStateTransition(id, prev.State, next, now))
	}
	return out
}

func newStateTransition(sessionID string, prev SessionState, next Attention, t time.Time) *event.Event {
	summary := string(next.State)
	if next.Reason != "" {
		summary = string(next.State) + ": " + next.Reason
	}
	return &event.Event{
		SchemaVersion: event.CurrentSchemaVersion,
		ID:            event.NewID(),
		Time:          t,
		Source:        SourceFirehose,
		SessionID:     sessionID,
		Category:      event.CategoryMeta,
		Name:          NameStateTransition,
		Severity:      event.SeverityInfo,
		Summary:       summary,
		Payload: map[string]any{
			"state":     string(next.State),
			"prev":      string(prev),
			"reason":    next.Reason,
			"has_error": next.HasError,
		},
	}
}

// EventFilePaths extracts the file paths a file-category event touched.
// Adapters store them differently: claude-code uses payload.file_path,
// opencode payload.file, codex a payload.changes map keyed by path.
func EventFilePaths(ev event.Event) []string {
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

// Sessions returns session summaries, most recently active first.
func (ix *Projection) Sessions() []Session {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]Session, 0, len(ix.sessions))
	for _, s := range ix.sessions {
		out = append(out, s.Session)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].LastTime.Equal(out[j].LastTime) {
			return out[i].LastTime.After(out[j].LastTime)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Session returns one session summary by id.
func (ix *Projection) Session(id string) (Session, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	s, ok := ix.sessions[id]
	if !ok {
		return Session{}, false
	}
	return s.Session, true
}

// SessionDays returns the UTC day files (YYYY-MM-DD) containing the session,
// oldest first, so readers can limit spool reads to the relevant files.
func (ix *Projection) SessionDays(id string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	s, ok := ix.sessions[id]
	if !ok {
		return nil
	}
	return sortedDays(s.days)
}

// Traces returns trace summaries, most recently active first.
func (ix *Projection) Traces() []Trace {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]Trace, 0, len(ix.traces))
	for _, tr := range ix.traces {
		out = append(out, tr.Trace)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].LastTime.Equal(out[j].LastTime) {
			return out[i].LastTime.After(out[j].LastTime)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// TraceDays returns the UTC day files containing the trace, oldest first.
func (ix *Projection) TraceDays(id string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	tr, ok := ix.traces[id]
	if !ok {
		return nil
	}
	return sortedDays(tr.days)
}

// Files returns touched-file artifacts, most recently touched first.
func (ix *Projection) Files() []FileArtifact {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]FileArtifact, 0, len(ix.files))
	for _, f := range ix.files {
		out = append(out, f.FileArtifact)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].LastTime.Equal(out[j].LastTime) {
			return out[i].LastTime.After(out[j].LastTime)
		}
		return out[i].Path < out[j].Path
	})
	return out
}

func sortedDays(days map[string]bool) []string {
	out := make([]string, 0, len(days))
	for d := range days {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}
