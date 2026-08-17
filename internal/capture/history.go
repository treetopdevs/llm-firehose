package capture

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"

	"agentfirehose/internal/event"
	"agentfirehose/internal/index"
	"agentfirehose/internal/spool"
)

// ErrNotFound reports an absent projected session or trace.
var ErrNotFound = errors.New("capture: not found")

// Capture-owned query shapes retain the frozen local HTTP JSON representation.
type (
	Session      = index.Session
	TraceSummary = index.Trace
	FileArtifact = index.FileArtifact
)

func (e *Engine) applyProjection(ev event.Event) error {
	e.index.ApplyResult(ev)
	return nil
}

// Sessions returns projected session summaries, most recently active first.
func (e *Engine) Sessions() []Session { return e.index.Sessions() }

// Files returns projected file summaries, most recently touched first.
func (e *Engine) Files() []FileArtifact { return e.index.Files() }

// Session returns presentation-deduplicated events for one session.
func (e *Engine) Session(id string) ([]event.Event, error) {
	days := e.index.SessionDays(id)
	if len(days) == 0 {
		return nil, fmt.Errorf("%w: session %q", ErrNotFound, id)
	}
	events, err := spool.ReadDays(e.spoolDir, days)
	if err != nil {
		return nil, err
	}
	return filterDeduplicate(events, func(ev event.Event) bool { return ev.SessionID == id }, ErrNotFound, "session", id)
}

// Trace returns presentation-deduplicated events sharing one trace id.
func (e *Engine) Trace(id string) ([]event.Event, error) {
	days := e.index.TraceDays(id)
	if len(days) == 0 {
		return nil, fmt.Errorf("%w: trace %q", ErrNotFound, id)
	}
	events, err := spool.ReadDays(e.spoolDir, days)
	if err != nil {
		return nil, err
	}
	return filterDeduplicate(events, func(ev event.Event) bool { return ev.TraceID == id }, ErrNotFound, "trace", id)
}

func filterDeduplicate(events []event.Event, keep func(event.Event) bool, notFound error, kind, id string) ([]event.Event, error) {
	seen := make(map[string]bool)
	out := make([]event.Event, 0, len(events))
	for _, ev := range events {
		if !keep(ev) || ev.ID != "" && seen[ev.ID] {
			continue
		}
		if ev.ID != "" {
			seen[ev.ID] = true
		}
		out = append(out, ev)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: %s %q", notFound, kind, id)
	}
	return out, nil
}

// Export writes every physical spool observation oldest first. Unlike
// presentation queries, it intentionally retains stable-ID duplicates.
func (e *Engine) Export(w io.Writer) (int, error) {
	events, err := spool.ReadLastN(e.spoolDir, math.MaxInt)
	if err != nil {
		return 0, err
	}
	enc := json.NewEncoder(w)
	for i, ev := range events {
		if err := enc.Encode(ev); err != nil {
			return i, err
		}
	}
	return len(events), nil
}
