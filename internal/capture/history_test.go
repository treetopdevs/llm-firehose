package capture

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
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

var (
	wantEnvelopeKeys = []string{"schema_version", "id", "time", "source", "agent", "session_id", "turn_id", "call_id", "category", "name", "severity", "summary", "payload"}
	wantPayloadKeys  = []string{"phase", "state", "tool_name", "error_class", "duration_ms", "status", "item_type"}
)

func keySet(keys []string) map[string]bool {
	m := map[string]bool{}
	for _, k := range keys {
		m[k] = true
	}
	return m
}

func TestTimelineViewKeepsExactlyTheAllowlist(t *testing.T) {
	envAllowed, payAllowed := keySet(wantEnvelopeKeys), keySet(wantPayloadKeys)
	for _, name := range []string{"fixture.session.json", "fixture.errsig.json"} {
		data, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		var originals []map[string]json.RawMessage
		if err := json.Unmarshal(data, &originals); err != nil {
			t.Fatal(err)
		}
		var evs []event.Event
		if err := json.Unmarshal(data, &evs); err != nil {
			t.Fatal(err)
		}
		if len(evs) != len(originals) || len(evs) == 0 {
			t.Fatalf("%s: decoded %d of %d", name, len(evs), len(originals))
		}
		for i, ev := range evs {
			enc, err := json.Marshal(TimelineView(ev))
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]json.RawMessage
			if err := json.Unmarshal(enc, &got); err != nil {
				t.Fatal(err)
			}
			full, err := json.Marshal(ev) // same encoder as the original, so values are comparable
			if err != nil {
				t.Fatal(err)
			}
			var want map[string]json.RawMessage
			_ = json.Unmarshal(full, &want)
			for k, v := range got {
				if !envAllowed[k] {
					t.Fatalf("%s[%d]: envelope key %q outside allowlist", name, i, k)
				}
				if k == "payload" {
					continue
				}
				if !bytes.Equal(v, want[k]) {
					t.Fatalf("%s[%d]: %s = %s, want %s", name, i, k, v, want[k])
				}
			}
			for k := range want {
				if envAllowed[k] && k != "payload" {
					if _, ok := got[k]; !ok {
						t.Fatalf("%s[%d]: allowlisted %q dropped", name, i, k)
					}
				}
			}
			var gp, wp map[string]json.RawMessage
			_ = json.Unmarshal(got["payload"], &gp)
			_ = json.Unmarshal(want["payload"], &wp)
			for k, v := range gp {
				if !payAllowed[k] {
					t.Fatalf("%s[%d]: payload key %q outside allowlist", name, i, k)
				}
				if !bytes.Equal(v, wp[k]) {
					t.Fatalf("%s[%d]: payload.%s = %s, want %s", name, i, k, v, wp[k])
				}
			}
			for k := range wp {
				if payAllowed[k] {
					if _, ok := gp[k]; !ok {
						t.Fatalf("%s[%d]: allowlisted payload.%s dropped", name, i, k)
					}
				}
			}
			if _, ok := originals[i]["id"]; !ok || ev.ID == "" {
				t.Fatalf("%s[%d]: fixture event lost its id", name, i)
			}
		}

	}
}

// The errsig fixture holds balanced-mode records, so the minimal-mode digest
// shape is produced by the production redactor over the same real events.
func TestTimelineViewPassesMinimalModeDigestsThrough(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "fixture.errsig.json"))
	if err != nil {
		t.Fatal(err)
	}
	var evs []event.Event
	if err := json.Unmarshal(data, &evs); err != nil {
		t.Fatal(err)
	}
	digests := 0
	for _, ev := range evs {
		red := privacy.Redact(ev, privacy.ModeMinimal)
		want, ok := red.Payload["error_class"]
		if !ok {
			continue
		}
		m, isMap := want.(map[string]any)
		if !isMap || m["sha256"] == nil {
			t.Fatalf("minimal redaction did not digest error_class: %v", want)
		}
		got := TimelineView(red).Payload["error_class"]
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("error_class = %v, want %v", got, want)
		}
		digests++
	}
	if digests == 0 {
		t.Fatal("fixture has no error_class to digest")
	}
}

func TestTimelineViewDropsEmptyPayload(t *testing.T) {
	ev := historyEvent("e1", "s", "t", 1, 9)
	ev.Payload = map[string]any{"command": "ls", "usage": map[string]any{"n": 1}}
	if got := TimelineView(ev); got.Payload != nil {
		t.Fatalf("payload = %v, want nil when no key is allowlisted", got.Payload)
	}
	enc, _ := json.Marshal(TimelineView(ev))
	if bytes.Contains(enc, []byte("payload")) {
		t.Fatalf("encoded view carries payload: %s", enc)
	}
	ev.Payload = nil
	if TimelineView(ev).Payload != nil {
		t.Fatal("nil payload became non-nil")
	}
	ev.Payload = map[string]any{"phase": "end", "command": "ls"}
	if got := TimelineView(ev).Payload; !reflect.DeepEqual(got, map[string]any{"phase": "end"}) {
		t.Fatalf("payload = %v", got)
	}
	if ev.Payload["command"] != "ls" {
		t.Fatal("TimelineView mutated its input payload")
	}
}

// countingScanner counts the records the day scanner hands to the engine, that
// is the ones that survive the raw-byte prefilter and are decoded.
func countingScanner(decoded *int, filters *[]spool.Prefilter) dayScanner {
	return func(ctx context.Context, dir, day string, filter spool.Prefilter, onGap func(), yield func(event.Event)) error {
		*filters = append(*filters, filter)
		return spool.ScanDay(ctx, dir, day, filter, onGap, func(ev event.Event) {
			*decoded++
			yield(ev)
		})
	}
}

func eventScanFixture(t *testing.T, dir string, targetID string) {
	t.Helper()
	writeSpool(t, dir, []event.Event{
		historyEvent("x-1", "s", "t", 1, 9),
		historyEvent("x-2", "s", "t", 1, 10),
		historyEvent(targetID, "s", "t", 1, 11),
		historyEvent("x-3", "s", "t", 1, 12),
	})
	quoting := historyEvent("x-4", "s", "t", 1, 13)
	quoting.Payload = map[string]any{"note": targetID}
	writeSpool(t, dir, []event.Event{quoting})
}

func TestEventByIDUsesPrefilteredScan(t *testing.T) {
	dir := t.TempDir()
	eventScanFixture(t, dir, "want-1")
	var decoded int
	var filters []spool.Prefilter
	e, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: countingScanner(&decoded, &filters)})
	if err != nil {
		t.Fatal(err)
	}
	decoded, filters = 0, nil // ignore any startup scans

	got, err := e.Event(context.Background(), "want-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "want-1" {
		t.Fatalf("Event = %+v", got)
	}
	// The matching record and the foreign record quoting its id pass the
	// prefilter; the three other records are never decoded.
	if decoded != 2 {
		t.Fatalf("decoded %d records, want 2 (match + quoting record)", decoded)
	}
	if len(filters) != 1 || !reflect.DeepEqual(filters[0], quotedNeedle("want-1")) {
		t.Fatalf("prefilters = %q, want one quoted-id needle", filters)
	}

	decoded = 0
	if _, err := e.Event(context.Background(), "absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("absent event err = %v, want ErrNotFound", err)
	}
	if decoded != 0 {
		t.Fatalf("absent id decoded %d records", decoded)
	}
}

func TestEventByIDNonASCIIFallsBackToFullScan(t *testing.T) {
	dir := t.TempDir()
	eventScanFixture(t, dir, "want-é")
	var decoded int
	var filters []spool.Prefilter
	e, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: countingScanner(&decoded, &filters)})
	if err != nil {
		t.Fatal(err)
	}
	decoded, filters = 0, nil
	got, err := e.Event(context.Background(), "want-é")
	if err != nil || got.ID != "want-é" {
		t.Fatalf("Event = %+v, %v", got, err)
	}
	if len(filters) != 1 || filters[0] != nil {
		t.Fatalf("prefilters = %q, want a single nil prefilter", filters)
	}
	if decoded != 5 {
		t.Fatalf("decoded %d records, want all 5", decoded)
	}
}

func TestEventByIDHonorsCancelledContext(t *testing.T) {
	dir := t.TempDir()
	eventScanFixture(t, dir, "want-1")
	var seen context.Context
	scan := func(ctx context.Context, d, day string, f spool.Prefilter, onGap func(), yield func(event.Event)) error {
		seen = ctx
		return spool.ScanDay(ctx, d, day, f, onGap, yield)
	}
	e, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: scan})
	if err != nil {
		t.Fatal(err)
	}
	seen = nil
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := e.Event(ctx, "want-1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled Event err = %v, want context.Canceled", err)
	}
	if seen != ctx {
		t.Fatal("Event did not pass the caller's context to the day scan")
	}
}
