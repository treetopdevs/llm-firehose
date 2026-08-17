package spool

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/workspace"
)

func (t *Tailer) poll(ctx context.Context, ch chan<- event.Event) {
	t.pollAck(func(ev event.Event) error {
		select {
		case ch <- ev:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

func mkEvent(i int, ts time.Time) event.Event {
	return event.Event{
		ID:       fmt.Sprintf("ev-%d", i),
		Time:     ts,
		Source:   "generic",
		Category: event.CategoryMeta,
		Summary:  fmt.Sprintf("event %d", i),
	}
}

func TestAppendReadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	w := NewWriter(dir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	for i := range 3 {
		if _, err := w.Append(mkEvent(i, base.Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	evs, err := ReadLastN(dir, 10)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(evs) != 3 {
		t.Fatalf("got %d events, want 3", len(evs))
	}
	for i, ev := range evs {
		if ev.ID != fmt.Sprintf("ev-%d", i) {
			t.Errorf("event %d out of order: %s", i, ev.ID)
		}
	}
}

func TestAppendReturnsExactStoredEvent(t *testing.T) {
	dir := t.TempDir()
	observation := mkEvent(0, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	observation.ID = ""

	stored, err := NewWriter(dir).Append(observation)
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if stored.ID == "" || stored.SchemaVersion != event.CurrentSchemaVersion || stored.CaptureTime == nil {
		t.Fatalf("stored event was not completed at commit: %+v", stored)
	}
	if observation.ID != "" || observation.SchemaVersion != 0 || observation.CaptureTime != nil {
		t.Fatalf("append mutated caller observation: %+v", observation)
	}

	events, err := ReadLastN(dir, 1)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if got, want := events[0], stored; !reflect.DeepEqual(got, want) {
		t.Fatalf("read event differs from commit result:\n got: %+v\nwant: %+v", got, want)
	}
}

func TestConcurrentAppendReturnsWholeOrderedRecords(t *testing.T) {
	dir := t.TempDir()
	writer := NewWriter(dir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	const count = 64

	stored := make(chan event.Event, count)
	errs := make(chan error, count)
	var wg sync.WaitGroup
	for i := range count {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ev := mkEvent(i, base)
			ev.ID = ""
			got, err := writer.Append(ev)
			if err != nil {
				errs <- err
				return
			}
			stored <- got
		}(i)
	}
	wg.Wait()
	close(errs)
	close(stored)
	for err := range errs {
		t.Fatalf("concurrent append: %v", err)
	}

	byID := make(map[string]event.Event, count)
	for ev := range stored {
		if _, exists := byID[ev.ID]; exists {
			t.Fatalf("duplicate assigned id %q", ev.ID)
		}
		byID[ev.ID] = ev
	}
	events, err := ReadLastN(dir, count)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(events) != count {
		t.Fatalf("events = %d, want %d", len(events), count)
	}
	for _, ev := range events {
		if want, ok := byID[ev.ID]; !ok || !reflect.DeepEqual(ev, want) {
			t.Fatalf("record was interleaved or differed from append result: %+v", ev)
		}
	}
}

func TestAppendReadRoundTripLargerThanScannerLimit(t *testing.T) {
	dir := t.TempDir()
	ev := mkEvent(1, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	ev.Payload = map[string]any{"output": strings.Repeat("x", 5*1024*1024)}
	if _, err := NewWriter(dir).Append(ev); err != nil {
		t.Fatalf("append large event: %v", err)
	}
	after := mkEvent(2, ev.Time.Add(time.Second))
	if _, err := NewWriter(dir).Append(after); err != nil {
		t.Fatalf("append event after large record: %v", err)
	}

	evs, err := ReadLastN(dir, 2)
	if err != nil {
		t.Fatalf("read large event: %v", err)
	}
	if len(evs) != 2 || evs[0].ID != ev.ID || evs[1].ID != after.ID {
		t.Fatalf("large event did not round-trip: %+v", evs)
	}
	if got := evs[0].Payload["output"].(string); len(got) != 5*1024*1024 {
		t.Fatalf("large payload length = %d", len(got))
	}
}

func TestReadLastNAcrossFilesAndLimit(t *testing.T) {
	dir := t.TempDir()
	// two daily files written directly
	day1 := filepath.Join(dir, "2026-07-01.ndjson")
	day2 := filepath.Join(dir, "2026-07-02.ndjson")
	l1 := `{"id":"a","time":"2026-07-01T10:00:00Z","source":"generic","category":"meta"}` + "\n"
	l2 := `{"id":"b","time":"2026-07-02T10:00:00Z","source":"generic","category":"meta"}` + "\n" +
		`{"id":"c","time":"2026-07-02T11:00:00Z","source":"generic","category":"meta"}` + "\n"
	os.WriteFile(day1, []byte(l1), 0o644)
	os.WriteFile(day2, []byte(l2), 0o644)

	evs, err := ReadLastN(dir, 2)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(evs) != 2 || evs[0].ID != "b" || evs[1].ID != "c" {
		t.Fatalf("lastN wrong: %+v", evs)
	}
}

func TestReadLastDistinctNExpandsOnlyPastReplayDuplicates(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	writer := NewWriter(dir)
	for _, ev := range []event.Event{
		mkEvent(1, base), mkEvent(2, base.Add(time.Second)),
		mkEvent(2, base.Add(time.Second)), mkEvent(3, base.Add(2*time.Second)),
	} {
		if _, err := writer.Append(ev); err != nil {
			t.Fatal(err)
		}
	}

	events, err := ReadLastDistinctN(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].ID != "ev-1" || events[1].ID != "ev-2" || events[2].ID != "ev-3" {
		t.Fatalf("distinct recent events = %+v", events)
	}
}

func TestReadLastDistinctNDoesNotOpenOlderFilesWhenNewestWindowIsEnough(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink(filepath.Join(dir, "missing"), filepath.Join(dir, "2026-07-01.ndjson")); err != nil {
		t.Fatal(err)
	}
	day2 := filepath.Join(dir, "2026-07-02.ndjson")
	line := `{"id":"new","time":"2026-07-02T10:00:00Z","source":"generic","category":"meta"}` + "\n"
	if err := os.WriteFile(day2, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	events, err := ReadLastDistinctN(dir, 1)
	if err != nil {
		t.Fatalf("bounded read opened older broken file: %v", err)
	}
	if len(events) != 1 || events[0].ID != "new" {
		t.Fatalf("events = %+v", events)
	}
}

func TestAppendStampsSchemaVersion(t *testing.T) {
	dir := t.TempDir()
	w := NewWriter(dir)
	ev := mkEvent(0, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	if ev.SchemaVersion != 0 {
		t.Fatalf("precondition: fresh event should have zero version")
	}
	if _, err := w.Append(ev); err != nil {
		t.Fatalf("append: %v", err)
	}
	evs, err := ReadLastN(dir, 1)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(evs) != 1 || evs[0].SchemaVersion != event.CurrentSchemaVersion {
		t.Fatalf("spooled schema_version = %d, want %d", evs[0].SchemaVersion, event.CurrentSchemaVersion)
	}
}

func TestAppendStampsMissingCaptureTime(t *testing.T) {
	dir := t.TempDir()
	ev := mkEvent(0, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	before := time.Now().UTC()
	if _, err := NewWriter(dir).Append(ev); err != nil {
		t.Fatalf("append: %v", err)
	}
	after := time.Now().UTC()

	evs, err := ReadLastN(dir, 1)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(evs) != 1 || evs[0].CaptureTime == nil {
		t.Fatalf("spooled capture_time = %v, want a timestamp", evs)
	}
	if evs[0].CaptureTime.Before(before) || evs[0].CaptureTime.After(after) {
		t.Errorf("capture_time = %v, want append observation between %v and %v", evs[0].CaptureTime, before, after)
	}
	if evs[0].SourceTime != nil {
		t.Errorf("source_time = %v, want absent when the producer did not identify one", evs[0].SourceTime)
	}
}

func TestAppendObservesRepositoryAndWorktreeIdentity(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "project")
	cwd := filepath.Join(repo, "nested", "package")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	ev := mkEvent(0, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	ev.CWD = cwd
	ev.RepoID = "unverified-source-repo"
	ev.WorktreeID = "unverified-source-worktree"
	dir := filepath.Join(root, "spool")
	if _, err := NewWriter(dir).Append(workspace.Enrich(ev)); err != nil {
		t.Fatalf("append: %v", err)
	}
	evs, err := ReadLastN(dir, 1)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(evs) != 1 {
		t.Fatalf("spooled events = %d, want 1", len(evs))
	}
	wantRepo, err := filepath.EvalSymlinks(filepath.Join(repo, ".git"))
	if err != nil {
		t.Fatal(err)
	}
	wantWorktree, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	if evs[0].RepoID != wantRepo {
		t.Errorf("repo_id = %q, want %q", evs[0].RepoID, wantRepo)
	}
	if evs[0].WorktreeID != wantWorktree {
		t.Errorf("worktree_id = %q, want %q", evs[0].WorktreeID, wantWorktree)
	}
}

func TestAppendDistinguishesLinkedWorktreesInOneRepository(t *testing.T) {
	root := t.TempDir()
	commonDir := filepath.Join(root, "main", ".git")
	gitDir := filepath.Join(commonDir, "worktrees", "feature")
	worktree := filepath.Join(root, "feature")
	cwd := filepath.Join(worktree, "internal", "thing")
	for _, dir := range []string{commonDir, gitDir, cwd} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: "+gitDir+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "commondir"), []byte("../..\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ev := mkEvent(0, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	ev.CWD = cwd
	dir := filepath.Join(root, "spool")
	if _, err := NewWriter(dir).Append(workspace.Enrich(ev)); err != nil {
		t.Fatalf("append: %v", err)
	}
	evs, err := ReadLastN(dir, 1)
	if err != nil || len(evs) != 1 {
		t.Fatalf("read = %+v, %v", evs, err)
	}
	wantRepo, _ := filepath.EvalSymlinks(commonDir)
	wantWorktree, _ := filepath.EvalSymlinks(worktree)
	if evs[0].RepoID != wantRepo || evs[0].WorktreeID != wantWorktree {
		t.Errorf("identity = repo %q worktree %q, want repo %q worktree %q",
			evs[0].RepoID, evs[0].WorktreeID, wantRepo, wantWorktree)
	}
}

func TestReadPreVersioningLines(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"id":"old","time":"2026-07-01T10:00:00Z","source":"generic","category":"meta"}` + "\n"
	os.WriteFile(filepath.Join(dir, "2026-07-01.ndjson"), []byte(legacy), 0o644)
	evs, err := ReadLastN(dir, 10)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(evs) != 1 || evs[0].ID != "old" || evs[0].SchemaVersion != 0 {
		t.Fatalf("legacy line misread: %+v", evs)
	}
}

func TestReadLegacyFinalRecordWithoutNewline(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"id":"old","time":"2026-07-01T10:00:00Z","source":"generic","category":"meta"}`
	if err := os.WriteFile(filepath.Join(dir, "2026-07-01.ndjson"), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	evs, err := ReadLastN(dir, 10)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(evs) != 1 || evs[0].ID != "old" {
		t.Fatalf("legacy final record was not read: %+v", evs)
	}
}

func TestReadDaysLimitsToNamedFiles(t *testing.T) {
	dir := t.TempDir()
	w := NewWriter(dir)
	day1 := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 7, 3, 10, 0, 0, 0, time.UTC)
	for i, ts := range []time.Time{day1, day1.Add(time.Minute), day2} {
		if _, err := w.Append(mkEvent(i, ts)); err != nil {
			t.Fatalf("append: %v", err)
		}
	}

	evs, err := ReadDays(dir, []string{"2026-07-02"})
	if err != nil {
		t.Fatalf("ReadDays: %v", err)
	}
	if len(evs) != 2 || evs[0].ID != "ev-0" || evs[1].ID != "ev-1" {
		t.Fatalf("day-1 events wrong: %+v", evs)
	}

	// Both days, oldest first regardless of input order.
	evs, err = ReadDays(dir, []string{"2026-07-03", "2026-07-02"})
	if err != nil {
		t.Fatalf("ReadDays both: %v", err)
	}
	if len(evs) != 3 || evs[0].ID != "ev-0" || evs[2].ID != "ev-2" {
		t.Fatalf("two-day events wrong: %+v", evs)
	}

	// Missing day files are skipped, not errors.
	evs, err = ReadDays(dir, []string{"1999-01-01"})
	if err != nil || len(evs) != 0 {
		t.Fatalf("missing day: evs=%v err=%v", evs, err)
	}
}

func TestTailerPrimeFixesSnapshotBoundary(t *testing.T) {
	dir := t.TempDir()
	w := NewWriter(dir)
	if _, err := w.Append(mkEvent(0, time.Now().UTC())); err != nil {
		t.Fatalf("append existing: %v", err)
	}

	tail := NewTailer(dir, 10*time.Millisecond)
	tail.Prime() // snapshot boundary: everything before this is "existing"

	// Appended after Prime but before Run: must still be delivered.
	if _, err := w.Append(mkEvent(1, time.Now().UTC())); err != nil {
		t.Fatalf("append post-prime: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := make(chan event.Event, 16)
	go tail.Run(ctx, ch)

	select {
	case ev := <-ch:
		if ev.ID != "ev-1" {
			t.Errorf("got %q, want ev-1 (pre-prime content must be skipped)", ev.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tailer never delivered post-prime event")
	}
}

func TestTailerSeesNewLines(t *testing.T) {
	dir := t.TempDir()
	w := NewWriter(dir)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := make(chan event.Event, 16)
	tail := NewTailer(dir, 10*time.Millisecond)
	go tail.Run(ctx, ch)

	time.Sleep(30 * time.Millisecond) // let tailer record initial offsets
	if _, err := w.Append(mkEvent(42, time.Now().UTC())); err != nil {
		t.Fatalf("append: %v", err)
	}

	select {
	case ev := <-ch:
		if ev.ID != "ev-42" {
			t.Errorf("got %q, want ev-42", ev.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tailer never delivered appended event")
	}
}

func TestTailerEmitsParseErrorEvent(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := make(chan event.Event, 16)
	tail := NewTailer(dir, 10*time.Millisecond)
	go tail.Run(ctx, ch)
	time.Sleep(30 * time.Millisecond)

	f, _ := os.OpenFile(filepath.Join(dir, "2026-07-02.ndjson"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	f.WriteString("this is not json\n")
	f.Close()

	select {
	case ev := <-ch:
		if ev.Category != event.CategoryMeta || ev.Severity != event.SeverityWarn {
			t.Errorf("want meta/warn parse-error event, got %+v", ev)
		}
		if ev.CaptureTime == nil || !ev.Time.Equal(*ev.CaptureTime) {
			t.Errorf("capture_time = %v, want parse observation time %v", ev.CaptureTime, ev.Time)
		}
		if ev.SourceTime != nil {
			t.Errorf("source_time = %v, want absent for an unparseable source line", ev.SourceTime)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tailer never surfaced parse failure")
	}
}

func TestTailerProjectionFailureDoesNotStarveNewerFiles(t *testing.T) {
	dir := t.TempDir()
	tail := NewTailer(dir, time.Second)
	tail.Prime()
	writer := NewWriter(dir)
	older := mkEvent(1, time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC))
	newer := mkEvent(2, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	if _, err := writer.Append(older); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Append(newer); err != nil {
		t.Fatal(err)
	}
	var delivered []string
	tail.pollAck(func(ev event.Event) error {
		if ev.ID == older.ID {
			return fmt.Errorf("projection unavailable")
		}
		delivered = append(delivered, ev.ID)
		return nil
	})
	if len(delivered) != 1 || delivered[0] != newer.ID {
		t.Fatalf("newer file was starved: %v", delivered)
	}
	if tail.offsets[fileFor(dir, older.Time)] != 0 {
		t.Fatal("failed record offset advanced")
	}
}

func TestTailerWaitsForIncompleteFinalLine(t *testing.T) {
	dir := t.TempDir()
	tail := NewTailer(dir, time.Second)
	tail.Prime()
	ch := make(chan event.Event, 2)
	ctx := context.Background()

	ev := mkEvent(7, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	line, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "2026-07-02.ndjson")
	cut := len(line) / 2
	if err := os.WriteFile(path, line[:cut], 0o644); err != nil {
		t.Fatal(err)
	}

	tail.poll(ctx, ch)
	select {
	case got := <-ch:
		t.Fatalf("incomplete line produced an event: %+v", got)
	default:
	}
	if got := tail.offsets[path]; got != 0 {
		t.Fatalf("incomplete line advanced offset to %d", got)
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(append(line[cut:], '\n')); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	tail.poll(ctx, ch)
	select {
	case got := <-ch:
		if got.ID != ev.ID {
			t.Fatalf("completed line produced %+v", got)
		}
	default:
		t.Fatal("completed line was not delivered")
	}
}

func TestTailerAdvancesPastLargeRecord(t *testing.T) {
	dir := t.TempDir()
	tail := NewTailer(dir, time.Second)
	tail.Prime()
	ch := make(chan event.Event, 2)

	large := mkEvent(8, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	large.Payload = map[string]any{"output": strings.Repeat("x", 5*1024*1024)}
	after := mkEvent(9, large.Time.Add(time.Second))
	writer := NewWriter(dir)
	if _, err := writer.Append(large); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Append(after); err != nil {
		t.Fatal(err)
	}

	tail.poll(context.Background(), ch)
	first := <-ch
	second := <-ch
	if first.ID != large.ID || second.ID != after.ID {
		t.Fatalf("tailer stopped at large record: first=%s second=%s", first.ID, second.ID)
	}
}

func TestAppendAssignsMissingEventID(t *testing.T) {
	dir := t.TempDir()
	ev := mkEvent(0, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	ev.ID = ""
	if _, err := NewWriter(dir).Append(ev); err != nil {
		t.Fatalf("append: %v", err)
	}
	evs, err := ReadLastN(dir, 1)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	if evs[0].ID == "" {
		t.Fatal("appended event missing id")
	}
	if len(evs[0].ID) != 32 {
		t.Fatalf("id = %q, want NewID hex length", evs[0].ID)
	}
}

func TestAppendPreservesProducerEventID(t *testing.T) {
	dir := t.TempDir()
	ev := mkEvent(0, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	ev.ID = "producer-supplied-id"
	if _, err := NewWriter(dir).Append(ev); err != nil {
		t.Fatalf("append: %v", err)
	}
	evs, err := ReadLastN(dir, 1)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if evs[0].ID != "producer-supplied-id" {
		t.Fatalf("id = %q, want producer-supplied-id", evs[0].ID)
	}
}

func TestTailerQuarantinesOversizedRecord(t *testing.T) {
	dir := t.TempDir()
	tail := NewTailer(dir, time.Second)
	tail.Prime()
	ch := make(chan event.Event, 4)

	path := filepath.Join(dir, "2026-07-02.ndjson")
	// Oversized unfinished-then-completed record exceeding the live-tail bound,
	// followed by a valid event the tailer must still deliver.
	oversized := strings.Repeat("x", maxRecordBytes+1024) + "\n"
	after := mkEvent(99, time.Date(2026, 7, 2, 10, 0, 1, 0, time.UTC))
	afterLine, err := json.Marshal(after)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append([]byte(oversized), append(afterLine, '\n')...), 0o644); err != nil {
		t.Fatal(err)
	}

	tail.poll(context.Background(), ch)
	warn := <-ch
	if warn.Category != event.CategoryMeta || warn.Severity != event.SeverityWarn {
		t.Fatalf("want meta/warn quarantine event, got %+v", warn)
	}
	if !strings.Contains(warn.Summary, "oversized") {
		t.Fatalf("warn summary = %q", warn.Summary)
	}
	got := <-ch
	if got.ID != after.ID {
		t.Fatalf("tailer did not advance past oversized record: got %s", got.ID)
	}

	// A second poll must not re-emit the oversized record.
	tail.poll(context.Background(), ch)
	select {
	case ev := <-ch:
		t.Fatalf("unexpected re-read event: %+v", ev)
	default:
	}
}
