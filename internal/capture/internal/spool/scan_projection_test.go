package spool

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"agentfirehose/internal/event"
)

func scanForProjection(t *testing.T, dir string) ([]event.Event, bool, error) {
	t.Helper()
	var evs []event.Event
	gaps := false
	err := ScanForProjection(dir, func() { gaps = true }, func(ev event.Event) { evs = append(evs, ev) })
	return evs, gaps, err
}

func assertProjectionParity(t *testing.T, dir string) []event.Event {
	t.Helper()
	want, wantGaps, wantErr := ReadForProjection(dir)
	if wantErr != nil {
		t.Fatalf("ReadForProjection: %v", wantErr)
	}
	got, gotGaps, err := scanForProjection(t, dir)
	if err != nil {
		t.Fatalf("ScanForProjection: %v", err)
	}
	if len(got) == 0 {
		got = []event.Event{}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events differ:\n got=%+v\nwant=%+v", got, want)
	}
	if gotGaps != wantGaps {
		t.Fatalf("gaps=%v, ReadForProjection gaps=%v", gotGaps, wantGaps)
	}
	return got
}

func writeRawDayFile(t *testing.T, dir, day, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, day+".ndjson"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanForProjectionMatchesReadForProjectionAcrossDaysAndGaps(t *testing.T) {
	dir := t.TempDir()
	oversized := `{"id":"huge","time":"2026-07-01T10:00:00Z","source":"generic","category":"meta","summary":"` +
		strings.Repeat("x", maxRecordBytes) + `"}`
	writeRawDayFile(t, dir, "2026-07-01", strings.Join([]string{
		rec("a1", "r1"),
		"{corrupt",
		`{"id":"invalid","time":"2026-07-01T10:00:00Z","category":"meta"}`, // no source: fails Validate
		oversized,
		rec("a2", "r2"),
	}, "\n")+"\n")
	writeRawDayFile(t, dir, "2026-07-02", rec("b1", "r1")+"\r\n"+rec("b2", "r2")+"\r\n")
	writeRawDayFile(t, dir, "2026-07-03", rec("c1", "r1")+"\n"+rec("c2", "r3")) // final record, no newline
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(rec("ignored", "r1")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := assertProjectionParity(t, dir)
	var ids []string
	for _, ev := range got {
		ids = append(ids, ev.ID)
	}
	if want := []string{"a1", "a2", "b1", "b2", "c1", "c2"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids=%v want %v", ids, want)
	}
	if _, gaps, _ := scanForProjection(t, dir); !gaps {
		t.Fatal("expected gaps for undecodable, invalid, and oversized records")
	}
}

func TestScanForProjectionReportsNoGapsForCleanSpool(t *testing.T) {
	dir := t.TempDir()
	writeDayFile(t, dir, "2026-07-01", rec("a", "r1"), rec("b", "r2"))
	writeDayFile(t, dir, "2026-07-02", rec("c", "r1"))
	assertProjectionParity(t, dir)
	if _, gaps, _ := scanForProjection(t, dir); gaps {
		t.Fatal("clean spool reported gaps")
	}
}

func TestScanForProjectionMissingDirIsEmptyNotAnError(t *testing.T) {
	evs, gaps, err := scanForProjection(t, filepath.Join(t.TempDir(), "absent"))
	if err != nil || len(evs) != 0 || gaps {
		t.Fatalf("evs=%v gaps=%v err=%v", evs, gaps, err)
	}
}

func TestScanForProjectionReturnsOpenErrors(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores file permissions")
	}
	dir := t.TempDir()
	writeDayFile(t, dir, "2026-07-01", rec("a", "r1"))
	path := filepath.Join(dir, "2026-07-01.ndjson")
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(path, 0o644) })
	if _, _, err := ReadForProjection(dir); err == nil {
		t.Fatal("reference reader unexpectedly opened an unreadable file")
	}
	if _, _, err := scanForProjection(t, dir); err == nil {
		t.Fatal("ScanForProjection swallowed an open error")
	}
}

func TestScanForProjectionYieldedEventsDoNotAliasLineBuffer(t *testing.T) {
	dir := t.TempDir()
	for day := 1; day <= 3; day++ {
		var lines []string
		for i := 0; i < 200; i++ {
			// Lengths alternate long/short so a reused buffer would overwrite
			// earlier strings if decoded values aliased it.
			n := 4000 - (i%7)*500 + day
			summary := strings.Repeat(string(rune('a'+(i+day)%26)), n)
			lines = append(lines, fmt.Sprintf(
				`{"id":"d%d-%d","time":"2026-07-0%dT10:00:00Z","source":"generic","category":"meta","summary":%q,"raw":%q,"payload":{"k":%q,"n":[%q]}}`,
				day, i, day, summary, summary[:n/2], summary[:n/3], summary[:n/4]))
		}
		writeDayFile(t, dir, fmt.Sprintf("2026-07-0%d", day), lines...)
	}
	got := assertProjectionParity(t, dir)
	if len(got) != 600 {
		t.Fatalf("got %d events, want 600", len(got))
	}
}
