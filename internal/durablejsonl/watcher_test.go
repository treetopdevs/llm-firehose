package durablejsonl

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

type testParser struct {
	Session string `json:"session,omitempty"`
	Lines   int    `json:"lines"`
}

func newTestParser(snapshot json.RawMessage) (Parser, error) {
	parser := &testParser{}
	if len(snapshot) > 0 {
		if err := json.Unmarshal(snapshot, parser); err != nil {
			return nil, err
		}
	}
	return parser, nil
}

func (p *testParser) ParseLine(line []byte) (*event.Event, error) {
	var raw struct {
		Type    string `json:"type"`
		Session string `json:"session"`
		Text    string `json:"text"`
	}
	if err := json.Unmarshal(line, &raw); err != nil {
		return nil, err
	}
	p.Lines++
	if raw.Session != "" {
		p.Session = raw.Session
	}
	if raw.Type == "skip" {
		return nil, nil
	}
	return &event.Event{
		ID:        event.NewID(),
		Time:      time.Date(2026, 7, 25, 12, 0, p.Lines, 0, time.UTC),
		Source:    "test",
		SessionID: p.Session,
		Category:  event.CategoryMessage,
		Summary:   raw.Text,
	}, nil
}

func (p *testParser) Snapshot() (json.RawMessage, error) {
	return json.Marshal(p)
}

func testOptions(t *testing.T, root, state string, sink func(event.Event) error) Options {
	t.Helper()
	return Options{
		Root:      root,
		StatePath: state,
		Interval:  time.Millisecond,
		Match: func(path string, entry os.DirEntry) bool {
			return !entry.IsDir() && strings.HasSuffix(path, ".jsonl")
		},
		NewParser: newTestParser,
		Sink:      sink,
		ParseWarning: func(snapshot json.RawMessage, err error) event.Event {
			return event.Event{
				ID:       event.NewID(),
				Time:     time.Now().UTC(),
				Source:   "test",
				Category: event.CategoryMeta,
				Name:     "parse-warning",
				Severity: event.SeverityWarn,
			}
		},
		CaptureWarning: func(err error) event.Event {
			return event.Event{
				ID:       event.NewID(),
				Time:     time.Now().UTC(),
				Source:   "test",
				Category: event.CategoryMeta,
				Name:     "capture-warning",
				Severity: event.SeverityWarn,
				Summary:  err.Error(),
			}
		},
	}
}

func TestWatcherBaselinesExistingFilesAndReadsNewFilesFromStart(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "a-active.jsonl")
	if err := os.WriteFile(old, []byte(`{"session":"old","text":"history"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(t.TempDir(), "state.json")
	var got []event.Event
	w := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("baseline imported history: %+v", got)
	}
	if err := appendLine(old, `{"text":"after baseline"}`); err != nil {
		t.Fatal(err)
	}
	fresh := filepath.Join(root, "z-new.jsonl")
	if err := os.WriteFile(fresh, []byte(`{"session":"fresh","text":"first"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	bySession := map[string]event.Event{}
	for _, captured := range got {
		bySession[captured.SessionID] = captured
	}
	if len(got) != 2 || bySession["old"].Summary != "after baseline" || bySession["fresh"].Summary != "first" {
		t.Fatalf("captured events = %+v", got)
	}
}

func TestWatcherUnreadableFileDoesNotStarveLaterFiles(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("chmod 0 does not block reads for root")
	}
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	var got []event.Event
	w := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}

	unreadable := filepath.Join(root, "a-unreadable.jsonl")
	if err := os.WriteFile(unreadable, []byte(`{"session":"blocked","text":"first"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	later := filepath.Join(root, "z-readable.jsonl")
	if err := os.WriteFile(later, []byte(`{"session":"live","text":"first"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	got = nil

	if err := appendLine(unreadable, `{"text":"unreadable append"}`); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unreadable, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(unreadable, 0o600) })
	if err := appendLine(later, `{"text":"must not starve"}`); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatalf("unreadable file aborted poll: %v", err)
	}
	if len(got) != 2 || got[0].Name != "capture-warning" ||
		got[1].SessionID != "live" || got[1].Summary != "must not starve" {
		t.Fatalf("later capture = %+v", got)
	}
}

func TestWatcherFingerprintsOnlyWhenObservedFileStampChanges(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "active.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"s1","text":"history"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	w := New(testOptions(t, root, filepath.Join(t.TempDir(), "state.json"), func(event.Event) error {
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	firstReads := 0
	lastReads := 0
	w.firstLineFingerprint = func(path string) (string, error) {
		firstReads++
		return firstLineHash(path)
	}
	w.lastLineFingerprint = func(path string, offset int64) (string, error) {
		lastReads++
		return lastLineHashBefore(path, offset)
	}

	for range 3 {
		if err := w.Poll(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if firstReads != 0 || lastReads != 0 {
		t.Fatalf("unchanged file fingerprinted %d/%d times", firstReads, lastReads)
	}
	if err := appendLine(path, `{"text":"new"}`); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if firstReads != 1 || lastReads != 1 {
		t.Fatalf("changed file fingerprint reads = %d/%d, want 1/1", firstReads, lastReads)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if firstReads != 1 || lastReads != 1 {
		t.Fatalf("unchanged post-append file fingerprinted again: %d/%d", firstReads, lastReads)
	}
}

// On Linux, file mtimes come from the kernel's coarse clock and can lag
// time.Now() by a jiffy (~1-4ms), so a file created immediately after
// Initialize can stamp BEFORE the discovery watermark and be wrongly
// baselined at EOF — losing its committed lines. Chtimes simulates that lag
// deterministically on every OS.
func TestWatcherReadsFileCreatedJustAfterStartDespiteCoarseClockLag(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	var got []event.Event
	w := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "fresh.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"s1","text":"first"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lagged := time.Now().Add(-500 * time.Millisecond)
	if err := os.Chtimes(path, lagged, lagged); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Summary != "first" {
		t.Fatalf("coarse-clock-lagged new file was baselined instead of read: %+v", got)
	}
}

func TestWatcherAppendsBeforeCheckpointAndReplaysStablePendingID(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	var attempted string
	first := New(testOptions(t, root, state, func(ev event.Event) error {
		attempted = ev.ID
		return errors.New("spool unavailable")
	}))
	if err := first.Initialize(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "fresh.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"s1","text":"retry me"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := first.Poll(context.Background()); err == nil {
		t.Fatal("expected sink failure")
	}

	var replayed []event.Event
	second := New(testOptions(t, root, state, func(ev event.Event) error {
		replayed = append(replayed, ev)
		return nil
	}))
	if err := second.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := second.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 1 || replayed[0].ID != attempted {
		t.Fatalf("replay = %+v, want pending id %q", replayed, attempted)
	}
}

func TestWatcherLeavesPartialLineAndPersistsParseWarningBeforeAdvancing(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	var got []event.Event
	w := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "fresh.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"s1","text":"partial`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("partial line captured: %+v", got)
	}
	if err := appendRaw(path, `"}`+"\nnot-json\n"); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Summary != "partial" || got[1].Name != "parse-warning" {
		t.Fatalf("completed/invalid capture = %+v", got)
	}

	var afterRestart []event.Event
	restarted := New(testOptions(t, root, state, func(ev event.Event) error {
		afterRestart = append(afterRestart, ev)
		return nil
	}))
	if err := restarted.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(afterRestart) != 0 {
		t.Fatalf("parse warning cursor did not advance: %+v", afterRestart)
	}
}

func TestWatcherRecoversFromTruncateAndReplacement(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	var got []event.Event
	w := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "fresh.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"one","text":"first"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"session":"two","text":"replacement"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].SessionID != "two" || got[1].Summary != "replacement" {
		t.Fatalf("replacement capture = %+v", got)
	}
}

func TestWatcherRecoversWhenFileShrinksBelowCheckpoint(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	var got []event.Event
	w := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "fresh.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"long-session","text":"a deliberately long first event"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"session":"new","text":"short"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].SessionID != "new" || got[1].Summary != "short" {
		t.Fatalf("truncate recovery = %+v", got)
	}
}

func TestWatcherUsesExplicitMatcher(t *testing.T) {
	root := t.TempDir()
	var got []event.Event
	w := New(testOptions(t, root, filepath.Join(t.TempDir(), "state.json"), func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ignored.log"), []byte(`{"text":"ignored"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "accepted.jsonl"), []byte(`{"text":"accepted"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Summary != "accepted" {
		t.Fatalf("matcher capture = %+v", got)
	}
}

func TestWatcherQuarantinesSemanticallyCorruptParserCheckpoint(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "existing.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"s1","text":"history"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(t.TempDir(), "state.json")
	first := New(testOptions(t, root, state, func(event.Event) error { return nil }))
	if err := first.Initialize(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(state)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	files := document["files"].(map[string]any)
	cursor := files[path].(map[string]any)
	cursor["parser"] = "not-a-parser-snapshot"
	corrupt, _ := json.Marshal(document)
	if err := os.WriteFile(state, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}

	var got []event.Event
	restarted := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := restarted.Initialize(); err != nil {
		t.Fatalf("semantic cursor corruption disabled capture: %v", err)
	}
	if len(got) != 1 || got[0].Name != "capture-warning" {
		t.Fatalf("cursor warning = %+v", got)
	}
	backups, err := filepath.Glob(state + ".corrupt-*")
	if err != nil || len(backups) != 1 {
		t.Fatalf("corrupt cursor was not quarantined: backups=%v err=%v", backups, err)
	}
	if err := appendLine(path, `{"text":"after recovery"}`); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].SessionID != "s1" || got[1].Summary != "after recovery" {
		t.Fatalf("capture did not recover parser context: %+v", got)
	}
}

func TestWatcherQuarantinesMalformedJSONCheckpoint(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "existing.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"s1","text":"history"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(state, []byte(`{"saved_at":`), 0o600); err != nil {
		t.Fatal(err)
	}

	var got []event.Event
	w := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatalf("malformed cursor disabled capture: %v", err)
	}
	if len(got) != 1 || got[0].Name != "capture-warning" {
		t.Fatalf("cursor warning = %+v", got)
	}
	backups, err := filepath.Glob(state + ".corrupt-*")
	if err != nil || len(backups) != 1 {
		t.Fatalf("malformed cursor was not quarantined: backups=%v err=%v", backups, err)
	}
	if err := appendLine(path, `{"text":"after recovery"}`); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].SessionID != "s1" || got[1].Summary != "after recovery" {
		t.Fatalf("capture did not resume after quarantine: %+v", got)
	}
}

func appendLine(path, line string) error {
	return appendRaw(path, line+"\n")
}

func appendRaw(path, value string) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(value)
	return err
}

// A single bad file discovered mid-run (here: an old unreadable file whose
// baseline fingerprint read fails) must not abort the poll for files sorted
// after it.
func TestWatcherDiscoveryFailureDoesNotStarveLaterFiles(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("chmod 0 does not block reads for root")
	}
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	var got []event.Event
	w := New(testOptions(t, root, state, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}

	bad := filepath.Join(root, "a-bad.jsonl")
	if err := os.WriteFile(bad, []byte(`{"session":"bad","text":"old"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(bad, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(bad, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(bad, 0o600) })

	good := filepath.Join(root, "z-good.jsonl")
	if err := os.WriteFile(good, []byte(`{"session":"live","text":"works"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatalf("bad discovered file aborted poll: %v", err)
	}
	var live *event.Event
	for i := range got {
		if got[i].SessionID == "live" {
			live = &got[i]
		}
	}
	if live == nil || live.Summary != "works" {
		t.Fatalf("later file starved by discovery failure: %+v", got)
	}
}

// If NewParser fails while rolling back after a sink failure, the watcher
// must not be left with a nil parser that panics the next poll; the pending
// line must still be re-deliverable.
func TestWatcherSurvivesParserRollbackFailure(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	sinkFails := true
	var delivered []event.Event
	opts := testOptions(t, root, state, func(ev event.Event) error {
		if sinkFails {
			return errors.New("spool unavailable")
		}
		delivered = append(delivered, ev)
		return nil
	})
	calls := 0
	opts.NewParser = func(snapshot json.RawMessage) (Parser, error) {
		calls++
		if calls == 2 { // the rollback rehydration after the first sink failure
			return nil, errors.New("snapshot rehydration failed")
		}
		return newTestParser(snapshot)
	}
	w := New(opts)
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "fresh.jsonl")
	if err := os.WriteFile(path, []byte(`{"session":"s1","text":"retry me"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err == nil {
		t.Fatal("expected sink failure")
	}

	sinkFails = false
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("second poll panicked on nil parser: %v", r)
		}
	}()
	if err := w.Poll(context.Background()); err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if len(delivered) != 1 || delivered[0].Summary != "retry me" {
		t.Fatalf("pending line lost after rollback failure: %+v", delivered)
	}
}

func TestReportDedupsByStableErrorClassification(t *testing.T) {
	var got []event.Event
	w := New(testOptions(t, t.TempDir(), filepath.Join(t.TempDir(), "state.json"), func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}))

	first := &os.PathError{Op: "rename", Path: "/tmp/a", Err: errors.New("cross-device")}
	second := &os.PathError{Op: "rename", Path: "/tmp/b", Err: errors.New("cross-device")}
	openErr := &os.PathError{Op: "open", Path: "/tmp/c", Err: errors.New("permission denied")}

	w.Report(first)
	w.Report(second)
	w.Report(openErr)
	if len(got) != 2 {
		t.Fatalf("warnings = %d (%+v), want 2 distinct categories (rename once, open once)", len(got), got)
	}

	got = nil
	sinkFail := New(testOptions(t, t.TempDir(), filepath.Join(t.TempDir(), "state.json"), func(ev event.Event) error {
		return errors.New("sink down")
	}))
	sinkFail.Report(first)
	sinkFail.options.Sink = func(ev event.Event) error {
		got = append(got, ev)
		return nil
	}
	sinkFail.Report(first)
	if len(got) != 1 {
		t.Fatalf("failed sink should not mark warned; retry delivered %d, want 1", len(got))
	}
}
