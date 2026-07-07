package spool

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

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
		if err := w.Append(mkEvent(i, base.Add(time.Duration(i)*time.Second))); err != nil {
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

func TestAppendStampsSchemaVersion(t *testing.T) {
	dir := t.TempDir()
	w := NewWriter(dir)
	ev := mkEvent(0, time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC))
	if ev.SchemaVersion != 0 {
		t.Fatalf("precondition: fresh event should have zero version")
	}
	if err := w.Append(ev); err != nil {
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

func TestReadDaysLimitsToNamedFiles(t *testing.T) {
	dir := t.TempDir()
	w := NewWriter(dir)
	day1 := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 7, 3, 10, 0, 0, 0, time.UTC)
	for i, ts := range []time.Time{day1, day1.Add(time.Minute), day2} {
		if err := w.Append(mkEvent(i, ts)); err != nil {
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
	if err := w.Append(mkEvent(0, time.Now().UTC())); err != nil {
		t.Fatalf("append existing: %v", err)
	}

	tail := NewTailer(dir, 10*time.Millisecond)
	tail.Prime() // snapshot boundary: everything before this is "existing"

	// Appended after Prime but before Run: must still be delivered.
	if err := w.Append(mkEvent(1, time.Now().UTC())); err != nil {
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
	if err := w.Append(mkEvent(42, time.Now().UTC())); err != nil {
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
	case <-time.After(2 * time.Second):
		t.Fatal("tailer never surfaced parse failure")
	}
}
