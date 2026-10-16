package capture

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"

	"agentfirehose/internal/capture/internal/projection"
	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
)

// ErrNotFound reports an absent projected session or trace.
var ErrNotFound = errors.New("capture: not found")

// Capture-owned query shapes retain the frozen local HTTP JSON representation.
type (
	InboxSnapshot = projection.InboxSnapshot
	Session       = projection.Session
	TraceSummary  = projection.Trace
	FileArtifact  = projection.FileArtifact
)

func (e *Engine) applyProjection(ev event.Event) error {
	transitions, applied := e.projection.ApplyResult(ev)
	if !applied {
		return nil
	}
	// Preserve the frozen stream behavior: derived attention transitions are
	// announced before the Captured Event that caused them.
	for _, transition := range transitions {
		e.publish(*transition)
	}
	e.publish(ev)
	return nil
}

// Sessions returns projected session summaries, most recently active first.
func (e *Engine) Sessions() []Session { return e.projection.Sessions() }

// Files returns projected file summaries, most recently touched first.
func (e *Engine) Files() []FileArtifact { return e.projection.Files() }

// Session returns presentation-deduplicated events for one session.
func (e *Engine) Session(id string) ([]event.Event, error) {
	days := e.projection.SessionDays(id)
	if len(days) == 0 {
		return nil, fmt.Errorf("%w: session %q", ErrNotFound, id)
	}
	return e.history(days, id, func(ev event.Event) bool { return ev.SessionID == id }, "session")
}

// Trace returns presentation-deduplicated events sharing one trace id.
func (e *Engine) Trace(id string) ([]event.Event, error) {
	days := e.projection.TraceDays(id)
	if len(days) == 0 {
		return nil, fmt.Errorf("%w: trace %q", ErrNotFound, id)
	}
	return e.history(days, id, func(ev event.Event) bool { return ev.TraceID == id }, "trace")
}

// history streams the named day files (oldest first, as the projection
// returns them) through the day scanner, decoding only records whose raw
// bytes carry the quoted id, and keeps the events the exact predicate accepts
// with stable-id replays collapsed onto their first occurrence. An id that
// cannot be located reliably in raw bytes (non-ASCII, escapable) is scanned
// without a prefilter. Invalid records are skipped, matching the projection
// that produced the day list: it never counted them, so they are not part of
// the session or trace the caller was shown.
func (e *Engine) history(days []string, id string, keep func(event.Event) bool, kind string) ([]event.Event, error) {
	var filter spool.Prefilter
	if needles, ok := spool.IdentityNeedles([]string{id}); ok {
		filter = spool.Prefilter{needles}
	}
	seen := make(map[string]bool)
	var out []event.Event
	for _, day := range days {
		err := e.scanDay(context.Background(), e.spoolDir, day, filter, func() {}, func(ev event.Event) {
			if !keep(ev) || ev.ID != "" && seen[ev.ID] {
				return
			}
			if ev.ID != "" {
				seen[ev.ID] = true
			}
			out = append(out, ev)
		})
		if err != nil {
			return nil, err
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: %s %q", ErrNotFound, kind, id)
	}
	return out, nil
}

// Export writes every physical spool observation oldest first. Unlike
// presentation queries, it intentionally retains stable-ID duplicates.
func (e *Engine) Export(w io.Writer) (int, error) {
	return exportSpool(e.spoolDir, w)
}

// ExportOnce writes physical spool records without constructing a Projection
// or starting Source Adapters.
func ExportOnce(spoolDir string, w io.Writer) (int, error) {
	if spoolDir == "" {
		return 0, fmt.Errorf("capture: spool directory is required")
	}
	return exportSpool(spoolDir, w)
}

func exportSpool(spoolDir string, w io.Writer) (int, error) {
	events, err := spool.ReadLastN(spoolDir, math.MaxInt)
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

// Attention returns source-scoped, evidence-backed supervision state.
func (e *Engine) Attention() InboxSnapshot { return e.projection.Inbox() }

// Event retrieves an exact captured event for an evidence link.
func (e *Engine) Event(id string) (event.Event, error) {
	day := e.projection.EventDay(id)
	if day != "" {
		evs, err := spool.ReadDays(e.spoolDir, []string{day})
		if err != nil {
			return event.Event{}, err
		}
		for _, ev := range evs {
			if ev.ID == id {
				return ev, nil
			}
		}
	}
	return event.Event{}, fmt.Errorf("%w: event %q", ErrNotFound, id)
}
