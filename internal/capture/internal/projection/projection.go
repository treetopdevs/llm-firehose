// Package projection maintains derived, queryable state over the spool: session
// and trace summaries, touched-file artifacts, and the day files each id
// appears in. The spool stays the source of truth (migration plan, Phase 2);
// the Projection is rebuilt from it at startup and updated incrementally, so it
// can always be thrown away.
package projection

import (
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
	seen     map[string]string
	inbox    map[inboxKey]*InboxSession
	warnings map[inboxKey]Evidence
	gap      *CaptureGap

	// identityDays maps each Git/JJ repository or workspace identity value seen
	// on a Captured Event to the UTC day files that contain it. allDays is every
	// day with at least one projected event. readGap records that some spool
	// record could not be read. Like the session and trace day sets they are
	// derived solely from applied events, so Build and incremental Apply agree.
	identityDays map[string]map[string]bool
	allDays      map[string]bool
	readGap      bool
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
		seen:     map[string]string{},
		inbox:    map[inboxKey]*InboxSession{},
		warnings: map[inboxKey]Evidence{},

		identityDays: map[string]map[string]bool{},
		allDays:      map[string]bool{},
	}
}

// Build rebuilds the Projection from every event in the spool directory. A
// missing directory yields an empty Projection; unparseable lines are skipped by
// the spool reader.
func Build(dir string) (*Projection, error) {
	evs, gaps, err := spool.ReadForProjection(dir)
	if err != nil {
		return nil, err
	}
	ix := New()
	if gaps {
		ix.gap = &CaptureGap{Source: "firehose", Time: time.Now().UTC(), Summary: "Some spool records could not be read while rebuilding history."}
		ix.readGap = true
	}
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
// a stream-only synthetic event (never spooled). When the event reveals an idle
// crossing and also changes state, Apply returns the final transition;
// ApplyResult returns both.
func (ix *Projection) Apply(ev event.Event) *event.Event {
	transitions, _ := ix.ApplyResult(ev)
	if len(transitions) == 0 {
		return nil
	}
	return transitions[len(transitions)-1]
}

// ApplyResult folds one event into the Projection and reports whether its stable id
// was new, along with the attention transitions it caused, in order: an idle
// crossing revealed by the event's arrival, then the event's own change. The
// seen set spans the lifetime of the Projection so an old replay can never be
// counted twice.
func (ix *Projection) ApplyResult(ev event.Event) ([]*event.Event, bool) {
	ix.mu.Lock()
	defer ix.mu.Unlock()

	if ev.Source == SourceFirehose && ev.Name == NameStateTransition {
		return nil, false
	}

	if ev.ID != "" {
		if ix.seen[ev.ID] != "" {
			return nil, false
		}
		ix.seen[ev.ID] = ev.Time.UTC().Format("2006-01-02")
	}

	ix.applyInbox(ev)
	day := ev.Time.UTC().Format("2006-01-02")
	ix.indexDay(ev, day)
	var transitions []*event.Event

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
		// Snapshot the session's evidence of life and attention state as they
		// stood immediately before this event, so an idle crossing that
		// happened *between* the previous event and this one can be applied
		// below using the same rule AdvanceIdle uses live.
		priorLastActivity := s.lastActivity
		priorOpenTools := s.openTools
		priorAttention := Attention{
			State:    s.State,
			Since:    s.StateSince,
			Reason:   s.StateReason,
			HasError: s.HasError,
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
		// lastActivity must be monotonic per session, mirroring LastTime above:
		// append order does not establish timestamp order (a source can be
		// applied out of order relative to another, or relative to itself), so
		// a late-arriving event carrying an older source time must not drag
		// the session's evidence of life backwards — that would make the idle
		// sweep derive state_since from stale evidence.
		if !ev.Time.Before(s.lastActivity) {
			s.lastActivity = ev.Time
		}

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

		// Codex review finding F1 (round 3): AdvanceIdle's periodic sweep is
		// what normally carries a working session into idle, but that
		// transition is never spooled. Live, the sweep ticks every 5s, so it
		// always gets a chance to run between two real events and the
		// session is already idle by the time a later event (e.g. an error,
		// which does not itself restart the idle clock — see isActivity)
		// arrives. A spool rebuild applies events back-to-back with no sweep
		// interleaved, so without this, the same two events would leave the
		// session "working" until some later sweep derives state_since from
		// whatever event happened to update lastActivity next, rather than
		// from the original threshold crossing — a restart-dependent answer
		// for the same spool. Applying the same crossing TickIdle would
		// apply, using the state exactly as it stood before this event,
		// keeps replay and incremental projection identical regardless of
		// ordering. Errors and other non-activity events do not restart the
		// idle clock: they only ever land here if a crossing already
		// occurred, and the subsequent Transition call decides on top of
		// that honestly-idled state.
		originalState := priorAttention.State
		prev := priorAttention
		crossed, crossedChanged := TickIdle(prev, priorLastActivity, ev.Time, priorOpenTools > 0)
		if crossedChanged {
			prev = crossed
			s.State = crossed.State
			s.StateSince = crossed.Since
			s.StateReason = crossed.Reason
			// The crossing is a real state change in its own right, whether
			// or not this event changes state on top of it. Publish it first
			// so a live subscriber sees the idle interval: without it, a
			// meta event would publish nothing and an activity event would
			// publish working → working, and no later sweep can recover the
			// crossing because the projection has already moved past it.
			transitions = append(transitions, newStateTransition(ev.SessionID, originalState, crossed, ev.Time))
		}
		next, changed := Transition(prev, ev)
		if changed {
			s.State = next.State
			s.StateSince = next.Since
			s.StateReason = next.Reason
			s.HasError = next.HasError
			transitions = append(transitions, newStateTransition(ev.SessionID, prev.State, next, ev.Time))
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
	return transitions, true
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
		// The transition publishes now, at the sweep's own tick — never at
		// next.Since, which on a cold rebuild can be hours or days in the
		// past (the session's own threshold crossing). A live timeline
		// appends events in arrival order and never sorts, so a historical
		// Time here would render this row — which just arrived — as if it
		// happened long before rows already on screen. next.Since (the
		// honest "when this state began") still travels in the payload for
		// viewers that need it (see newStateTransition).
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
			// since is next.Since (the state's own honest start time), kept
			// separate from the event's own Time (the publication instant)
			// so a viewer can distinguish "when this transition was
			// observed" from "when the state actually began" — collapsing
			// them made an error-only transition (state and Since unchanged,
			// only has_error flips) look like it reset the dwell clock, and
			// made a restart's historical idle transitions carry a stale
			// Time into the live timeline. Formatted as a string (rather
			// than left as time.Time) so it survives the daemon's SSE JSON
			// transport unchanged; the daemonless in-process path parses the
			// same format.
			"since": next.Since.UTC().Format(time.RFC3339Nano),
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

// indexDay records which day file holds the event under each identity value it
// carries. Runs under the write lock, after exact-ID deduplication.
func (ix *Projection) indexDay(ev event.Event, day string) {
	ix.allDays[day] = true
	for _, id := range [...]string{ev.RepoID, ev.JJRepoID, ev.WorktreeID, ev.JJWorkspaceID} {
		if id == "" {
			continue
		}
		days := ix.identityDays[id]
		if days == nil {
			days = map[string]bool{}
			ix.identityDays[id] = days
		}
		days[day] = true
	}
	if ev.Source == SourceFirehose && ev.Name == "parse-error" && ev.Category == event.CategoryMeta {
		// The live tailer reports an unreadable appended record this way.
		ix.readGap = true
	}
}

// IdentityDays returns the UTC day files (YYYY-MM-DD), oldest first, holding
// an event that carries any of the identity values (repository or workspace,
// Git or JJ). Empty values never match.
func (ix *Projection) IdentityDays(values []string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return sortedDays(ix.unionDays(values))
}

func (ix *Projection) unionDays(values []string) map[string]bool {
	out := map[string]bool{}
	for _, v := range values {
		for day := range ix.identityDays[v] {
			out[day] = true
		}
	}
	return out
}

// TimelineDays returns the candidate day files, newest first, for a historical
// query. Each group is a set of alternative identity values (an identity plus
// its aliases); a day qualifies only if it holds an event for every group, and
// for sessionID when set. No group and no session means every projected day.
// The result is a superset of the days that can hold a matching event; callers
// still apply the exact event filters.
func (ix *Projection) TimelineDays(groups [][]string, sessionID string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	var days map[string]bool
	narrow := func(next map[string]bool) {
		if days == nil {
			days = next
			return
		}
		for day := range days {
			if !next[day] {
				delete(days, day)
			}
		}
	}
	for _, group := range groups {
		narrow(ix.unionDays(group))
	}
	if sessionID != "" {
		s, ok := ix.sessions[sessionID]
		if !ok {
			return nil
		}
		next := make(map[string]bool, len(s.days))
		for day := range s.days {
			next[day] = true
		}
		narrow(next)
	}
	if days == nil {
		days = make(map[string]bool, len(ix.allDays))
		for day := range ix.allDays {
			days[day] = true
		}
	}
	out := sortedDays(days)
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// ReadGap reports that some spool record could not be read, either while the
// Projection was rebuilt or later by the live tailer. It describes missing
// evidence, not a captured event.
func (ix *Projection) ReadGap() bool {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.readGap
}
