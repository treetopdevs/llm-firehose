// Package index maintains derived, queryable state over the spool: session
// and trace summaries, touched-file artifacts, and the day files each id
// appears in. The spool stays the source of truth (migration plan, Phase 2);
// the index is rebuilt from it at startup and updated incrementally, so it
// can always be thrown away.
package index

import (
	"math"
	"sort"
	"sync"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

// Session summarizes one agent session.
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

// seenCap bounds the recent-event-id set used to make Apply idempotent.
// Startup overlaps (index build racing the spool tailer) span at most a few
// hundred events; the cap only guards memory, not correctness of old history.
const seenCap = 8192

// Index is a thread-safe derived view over spooled events.
type Index struct {
	mu        sync.RWMutex
	sessions  map[string]*sessionEntry
	traces    map[string]*traceEntry
	files     map[string]*fileEntry
	seen      map[string]bool
	seenOrder []string
}

type sessionEntry struct {
	Session
	days map[string]bool
}

type traceEntry struct {
	Trace
	days map[string]bool
}

type fileEntry struct {
	FileArtifact
	sources map[string]bool
}

func New() *Index {
	return &Index{
		sessions: map[string]*sessionEntry{},
		traces:   map[string]*traceEntry{},
		files:    map[string]*fileEntry{},
		seen:     map[string]bool{},
	}
}

// Build rebuilds the index from every event in the spool directory. A
// missing directory yields an empty index; unparseable lines are skipped by
// the spool reader.
func Build(dir string) (*Index, error) {
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

// Apply folds one event into the index. Events with an id already applied
// are ignored, so replays (e.g. the startup tail overlapping the build read)
// never double-count.
func (ix *Index) Apply(ev event.Event) {
	ix.mu.Lock()
	defer ix.mu.Unlock()

	if ev.ID != "" {
		if ix.seen[ev.ID] {
			return
		}
		ix.seen[ev.ID] = true
		ix.seenOrder = append(ix.seenOrder, ev.ID)
		if len(ix.seenOrder) > seenCap {
			delete(ix.seen, ix.seenOrder[0])
			ix.seenOrder = ix.seenOrder[1:]
		}
	}

	day := ev.Time.UTC().Format("2006-01-02")

	if ev.SessionID != "" {
		s, ok := ix.sessions[ev.SessionID]
		if !ok {
			s = &sessionEntry{
				Session: Session{ID: ev.SessionID, FirstTime: ev.Time, LastTime: ev.Time},
				days:    map[string]bool{},
			}
			ix.sessions[ev.SessionID] = s
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
		s.days[day] = true
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
func (ix *Index) Sessions() []Session {
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
func (ix *Index) Session(id string) (Session, bool) {
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
func (ix *Index) SessionDays(id string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	s, ok := ix.sessions[id]
	if !ok {
		return nil
	}
	return sortedDays(s.days)
}

// Traces returns trace summaries, most recently active first.
func (ix *Index) Traces() []Trace {
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
func (ix *Index) TraceDays(id string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	tr, ok := ix.traces[id]
	if !ok {
		return nil
	}
	return sortedDays(tr.days)
}

// Files returns touched-file artifacts, most recently touched first.
func (ix *Index) Files() []FileArtifact {
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
