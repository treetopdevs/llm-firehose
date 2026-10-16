package capture

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
)

// historyEvent builds a valid envelope for the Session/Trace fixtures.
func historyEvent(id, session, trace string, d, h int) event.Event {
	return event.Event{
		ID:        id,
		Source:    "codex",
		Category:  event.CategoryTool,
		Name:      "tool",
		Time:      dayOf(d, h, 0, 0),
		SessionID: session,
		TraceID:   trace,
	}
}

// appendRawRecord writes a record straight into a day file, bypassing the
// Writer's validation so a fixture can hold an invalid record.
func appendRawRecord(t *testing.T, dir string, ev event.Event) {
	t.Helper()
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ev.Time.UTC().Format("2006-01-02")+".ndjson")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		t.Fatal(err)
	}
}

// referenceHistory is the pre-prefilter implementation: decode every record
// of every named day file, keep the matching ones, and collapse stable-id
// replays onto their first occurrence. Unlike the engine it does not validate
// records, so callers subtract invalid ones explicitly.
func referenceHistory(t *testing.T, dir string, days []string, keep func(event.Event) bool) []event.Event {
	t.Helper()
	events, err := spool.ReadDays(dir, days)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	var out []event.Event
	for _, ev := range events {
		if !keep(ev) || ev.ID != "" && seen[ev.ID] {
			continue
		}
		if ev.ID != "" {
			seen[ev.ID] = true
		}
		out = append(out, ev)
	}
	return out
}

// historyFixture spreads the target session and trace across days 1, 3, and 4
// with other sessions on days 2 and 3, a stable-id replay of a target event
// into day 4, a foreign record whose payload quotes the target id (admitted
// by the prefilter, rejected by the exact check), and one invalid-category
// record of the target appended raw to day 3.
func historyFixture(t *testing.T, dir, session, trace string) (targetDays []string, invalidID string) {
	t.Helper()
	writeSpool(t, dir, []event.Event{
		historyEvent("t-1", session, trace, 1, 9),
		historyEvent("t-2", session, trace, 1, 10),
		historyEvent("o-1", "other-session", "other-trace", 2, 9),
		historyEvent("o-2", "other-session", "other-trace", 3, 8),
		historyEvent("t-3", session, trace, 3, 9),
		historyEvent("t-4", session, trace, 4, 9),
	})
	quoting := historyEvent("o-3", "other-session", "other-trace", 3, 10)
	quoting.Payload = map[string]any{"note": "mentions " + session + " and " + trace}
	writeSpool(t, dir, []event.Event{quoting})
	replay := historyEvent("t-2", session, trace, 4, 10) // same stable id as day 1
	writeSpool(t, dir, []event.Event{replay})
	invalid := historyEvent("t-bad", session, trace, 3, 11)
	invalid.Category = "bogus"
	appendRawRecord(t, dir, invalid)
	return []string{dayName(1), dayName(3), dayName(4)}, invalid.ID
}

func containsID(evs []event.Event, id string) bool {
	for _, ev := range evs {
		if ev.ID == id {
			return true
		}
	}
	return false
}

func withoutID(evs []event.Event, id string) []event.Event {
	var out []event.Event
	for _, ev := range evs {
		if ev.ID != id {
			out = append(out, ev)
		}
	}
	return out
}

func quotedNeedle(id string) spool.Prefilter {
	return spool.Prefilter{[][]byte{[]byte(`"` + id + `"`)}}
}

func TestSessionMatchesFullReadMinusInvalidRecords(t *testing.T) {
	dir := t.TempDir()
	days, invalidID := historyFixture(t, dir, "sess-target", "trace-target")
	e := newRecordingEngine(t, dir, &scanRecorder{})

	got, err := e.Session("sess-target")
	if err != nil {
		t.Fatal(err)
	}
	want := referenceHistory(t, dir, days, func(ev event.Event) bool { return ev.SessionID == "sess-target" })
	if !containsID(want, invalidID) {
		t.Fatalf("fixture lost the invalid record; reference = %v", ids(want))
	}
	// Invalid records are skipped on purpose: the projection never counted
	// them, so the old full-decode path returning them was the inconsistency.
	want = withoutID(want, invalidID)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Session = %+v, want %+v", got, want)
	}
	if want := []string{"t-1", "t-2", "t-3", "t-4"}; !reflect.DeepEqual(ids(got), want) {
		t.Fatalf("Session ids = %v, want %v", ids(got), want)
	}
	if !got[1].Time.Equal(dayOf(1, 10, 0, 0)) {
		t.Fatalf("t-2 replay won over its first record: time = %v", got[1].Time)
	}
}

func TestSessionScansOnlyItsDaysWithQuotedIDPrefilter(t *testing.T) {
	dir := t.TempDir()
	days, _ := historyFixture(t, dir, "sess-target", "trace-target")
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)

	if _, err := e.Session("sess-target"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rec.scanned(), days) {
		t.Fatalf("scanned days = %v, want %v", rec.scanned(), days)
	}
	for i, filter := range rec.prefilters() {
		if !reflect.DeepEqual(filter, quotedNeedle("sess-target")) {
			t.Fatalf("day %d prefilter = %q, want quoted session id", i, filter)
		}
	}
}

func TestSessionNonASCIIIDFallsBackToFullDecode(t *testing.T) {
	dir := t.TempDir()
	id := "sess-é<x>"
	days, _ := historyFixture(t, dir, id, "trace-target")
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)

	got, err := e.Session(id)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"t-1", "t-2", "t-3", "t-4"}; !reflect.DeepEqual(ids(got), want) {
		t.Fatalf("Session ids = %v, want %v", ids(got), want)
	}
	if !reflect.DeepEqual(rec.scanned(), days) {
		t.Fatalf("scanned days = %v, want %v", rec.scanned(), days)
	}
	for i, filter := range rec.prefilters() {
		if filter != nil {
			t.Fatalf("day %d prefilter = %q, want nil for an unneedleable id", i, filter)
		}
	}
}

func TestTraceMatchesFullReadMinusInvalidRecords(t *testing.T) {
	dir := t.TempDir()
	days, invalidID := historyFixture(t, dir, "sess-target", "trace-target")
	e := newRecordingEngine(t, dir, &scanRecorder{})

	got, err := e.Trace("trace-target")
	if err != nil {
		t.Fatal(err)
	}
	want := referenceHistory(t, dir, days, func(ev event.Event) bool { return ev.TraceID == "trace-target" })
	if !containsID(want, invalidID) {
		t.Fatalf("fixture lost the invalid record; reference = %v", ids(want))
	}
	want = withoutID(want, invalidID)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Trace = %+v, want %+v", got, want)
	}
	if !got[1].Time.Equal(dayOf(1, 10, 0, 0)) {
		t.Fatalf("t-2 replay won over its first record: time = %v", got[1].Time)
	}
}

func TestTraceScansOnlyItsDaysWithQuotedIDPrefilter(t *testing.T) {
	dir := t.TempDir()
	days, _ := historyFixture(t, dir, "sess-target", "trace-target")
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)

	if _, err := e.Trace("trace-target"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rec.scanned(), days) {
		t.Fatalf("scanned days = %v, want %v", rec.scanned(), days)
	}
	for i, filter := range rec.prefilters() {
		if !reflect.DeepEqual(filter, quotedNeedle("trace-target")) {
			t.Fatalf("day %d prefilter = %q, want quoted trace id", i, filter)
		}
	}
}

func TestTraceNonASCIIIDFallsBackToFullDecode(t *testing.T) {
	dir := t.TempDir()
	id := "trace-é"
	days, _ := historyFixture(t, dir, "sess-target", id)
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)

	got, err := e.Trace(id)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"t-1", "t-2", "t-3", "t-4"}; !reflect.DeepEqual(ids(got), want) {
		t.Fatalf("Trace ids = %v, want %v", ids(got), want)
	}
	if !reflect.DeepEqual(rec.scanned(), days) {
		t.Fatalf("scanned days = %v, want %v", rec.scanned(), days)
	}
	for i, filter := range rec.prefilters() {
		if filter != nil {
			t.Fatalf("day %d prefilter = %q, want nil for an unneedleable id", i, filter)
		}
	}
}

// The prefilter is a superset filter: the quoted id must survive a Writer
// round trip so the needle actually matches the bytes on disk.
func TestQuotedNeedleMatchesWriterBytes(t *testing.T) {
	dir := t.TempDir()
	writeSpool(t, dir, []event.Event{historyEvent("t-1", "sess-target", "trace-target", 1, 9)})
	data, err := os.ReadFile(filepath.Join(dir, dayName(1)+".ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte(`"sess-target"`)) {
		t.Fatalf("day file does not contain the quoted id: %s", data)
	}
}
