// Package store holds the viewer's in-memory event window: a bounded ring
// buffer with filtering and correlated-observation coalescing for display.
package store

import (
	"strings"
	"sync"
	"time"

	"agentfirehose/internal/event"
)

// Ring is a bounded, thread-safe event buffer ordered by arrival.
type Ring struct {
	mu   sync.RWMutex
	buf  []event.Event
	cap  int
	head int // index of oldest
	size int
}

func NewRing(capacity int) *Ring {
	return &Ring{buf: make([]event.Event, capacity), cap: capacity}
}

func (r *Ring) Add(ev event.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.size < r.cap {
		r.buf[(r.head+r.size)%r.cap] = ev
		r.size++
		return
	}
	r.buf[r.head] = ev
	r.head = (r.head + 1) % r.cap
}

// Snapshot returns the buffered events oldest-first.
func (r *Ring) Snapshot() []event.Event {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]event.Event, r.size)
	for i := range r.size {
		out[i] = r.buf[(r.head+i)%r.cap]
	}
	return out
}

// Filter selects events; zero values mean "any".
type Filter struct {
	Source      string
	Agent       string
	Repo        string
	CWD         string
	SessionID   string
	Category    event.Category
	Name        string
	MinSeverity event.Severity
	Text        string // case-insensitive substring of summary
}

var severityRank = map[event.Severity]int{
	event.SeverityInfo: 0, event.SeverityNotice: 1,
	event.SeverityWarn: 2, event.SeverityError: 3,
}

// Match reports whether ev passes the filter.
func (f Filter) Match(ev event.Event) bool {
	if f.Source != "" && ev.Source != f.Source {
		return false
	}
	if f.Agent != "" && ev.Agent != f.Agent {
		return false
	}
	if f.Repo != "" && ev.Repo != f.Repo {
		return false
	}
	if f.CWD != "" && ev.CWD != f.CWD {
		return false
	}
	if f.SessionID != "" && ev.SessionID != f.SessionID {
		return false
	}
	if f.Category != "" && ev.Category != f.Category {
		return false
	}
	if f.Name != "" && ev.Name != f.Name {
		return false
	}
	if f.MinSeverity != "" && severityRank[ev.Severity] < severityRank[f.MinSeverity] {
		return false
	}
	if f.Text != "" && !strings.Contains(strings.ToLower(ev.Summary), strings.ToLower(f.Text)) {
		return false
	}
	return true
}

// Filtered returns matching events oldest-first.
func (r *Ring) Filtered(f Filter) []event.Event {
	snap := r.Snapshot()
	out := snap[:0:0]
	for _, ev := range snap {
		if f.Match(ev) {
			out = append(out, ev)
		}
	}
	return out
}

// Row is one display row: an event plus how many identical-shaped events it
// represents when a burst was coalesced.
type Row struct {
	Event event.Event
	Count int
}

// Coalesce removes replayed ids and groups dual transport observations sharing
// session, turn, call, phase, and tool within window. Starts and completions
// have different phase keys and can never collapse.
func Coalesce(evs []event.Event, window time.Duration) []Row {
	var rows []Row
	seen := map[string]bool{}
	correlated := map[string]int{}
	for _, ev := range evs {
		if ev.ID != "" && seen[ev.ID] {
			continue
		}
		seen[ev.ID] = true
		key := correlationKey(ev)
		if key != "" {
			if index, ok := correlated[key]; ok {
				row := &rows[index]
				gap := ev.Time.Sub(row.Event.Time)
				if gap < 0 {
					gap = -gap
				}
				if gap <= window {
					row.Event = ev
					row.Count++
					continue
				}
			}
		}
		rows = append(rows, Row{Event: ev, Count: 1})
		if key != "" {
			correlated[key] = len(rows) - 1
		}
	}
	return rows
}

func correlationKey(ev event.Event) string {
	if ev.SessionID == "" || ev.TurnID == "" || ev.CallID == "" {
		return ""
	}
	phase := metadataKey(ev.Payload["phase"])
	tool := metadataKey(ev.Payload["tool_name"])
	if phase == "" || tool == "" {
		return ""
	}
	return ev.SessionID + "\x00" + ev.TurnID + "\x00" + ev.CallID + "\x00" + phase + "\x00" + tool
}

func metadataKey(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	if digest, ok := value.(map[string]any); ok {
		if sha, ok := digest["sha256"].(string); ok {
			return "sha256:" + sha
		}
	}
	return ""
}
