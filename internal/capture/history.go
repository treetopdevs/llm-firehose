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
	InboxSnapshot     = projection.InboxSnapshot
	Session           = projection.Session
	TraceSummary      = projection.Trace
	FileArtifact      = projection.FileArtifact
	FileSession       = projection.FileSession
	ErrorSignature    = projection.ErrorSignature
	ErrorSession      = projection.ErrorSession
	ErrorSessionsPage = projection.ErrorSessionsPage
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

// ErrorSignatures returns derived Error Signature summaries, most recently
// seen first. A non-empty sessionID selects only signatures that include that
// session, each carrying that session's member event ids; Count and Sessions
// remain global, not re-scoped to it. Never nil.
func (e *Engine) ErrorSignatures(sessionID string) []ErrorSignature {
	return e.projection.ErrorSignatures(sessionID)
}

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

// Event retrieves an exact captured event for an evidence link. It scans only
// the event's day, prefiltered on the quoted id like history(), so it decodes
// the matching record and the rare foreign record that quotes the id, not the
// whole day. An id that cannot be needled reliably is scanned without one.
// A cancelled ctx (the HTTP client went away) aborts the day scan.
func (e *Engine) Event(ctx context.Context, id string) (event.Event, error) {
	day := e.projection.EventDay(id)
	if day == "" {
		return event.Event{}, fmt.Errorf("%w: event %q", ErrNotFound, id)
	}
	var filter spool.Prefilter
	if needles, ok := spool.IdentityNeedles([]string{id}); ok {
		filter = spool.Prefilter{needles}
	}
	var found event.Event
	var have bool
	err := e.scanDay(ctx, e.spoolDir, day, filter, func() {}, func(ev event.Event) {
		if !have && ev.ID == id {
			found, have = ev, true
		}
	})
	if err != nil {
		return event.Event{}, err
	}
	if !have {
		return event.Event{}, fmt.Errorf("%w: event %q", ErrNotFound, id)
	}
	return found, nil
}

// timelinePayloadKeys are the payload keys the timeline view keeps.
var timelinePayloadKeys = [...]string{"phase", "state", "tool_name", "error_class", "duration_ms", "status", "item_type"}

// TimelineView projects an admitted event onto the timeline allowlist: the
// envelope fields a session replay reads, and only the allowlisted payload
// keys, values copied as-is (privacy digests intact). Everything else is
// zeroed so omitempty drops it; an empty payload is omitted. The result is a
// strict subset of the input, never a substitute envelope, and the input's
// payload map is not mutated.
func TimelineView(ev event.Event) event.Event {
	out := event.Event{
		SchemaVersion: ev.SchemaVersion,
		ID:            ev.ID,
		Time:          ev.Time,
		Source:        ev.Source,
		Agent:         ev.Agent,
		SessionID:     ev.SessionID,
		TurnID:        ev.TurnID,
		CallID:        ev.CallID,
		Category:      ev.Category,
		Name:          ev.Name,
		Severity:      ev.Severity,
		Summary:       ev.Summary,
	}
	for _, k := range timelinePayloadKeys {
		if v, ok := ev.Payload[k]; ok {
			if out.Payload == nil {
				out.Payload = make(map[string]any, len(timelinePayloadKeys))
			}
			out.Payload[k] = v
		}
	}
	return out
}

// ErrInvalidErrorSessionsQuery reports invalid signature or pagination input.
var ErrInvalidErrorSessionsQuery = errors.New("capture: invalid error sessions query")

// ErrorSessions returns exact per-session aggregates without reading the spool.
// Pagination is a fresh snapshot for each query, not a stable history cursor.
func (e *Engine) ErrorSessions(key string, offset, limit int) (ErrorSessionsPage, error) {
	if key == "" || offset < 0 || limit < 1 || limit > 100 {
		return ErrorSessionsPage{}, ErrInvalidErrorSessionsQuery
	}
	page, ok := e.projection.ErrorSessions(key, offset, limit)
	if !ok {
		return ErrorSessionsPage{}, fmt.Errorf("%w: error signature %q", ErrNotFound, key)
	}
	return page, nil
}

// FileSessions returns exact recorded workspace/path/source/session summaries.
func (e *Engine) FileSessions() []FileSession { return e.projection.FileSessions() }
