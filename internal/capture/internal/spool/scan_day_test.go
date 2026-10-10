package spool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func writeDayFile(t *testing.T, dir, day string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, day+".ndjson"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func rec(id, repo string) string {
	return fmt.Sprintf(`{"id":%q,"time":"2026-07-02T10:00:00Z","source":"generic","category":"meta","repo_id":%q}`, id, repo)
}

func scanIDs(t *testing.T, dir, day string, filter Prefilter) ([]string, bool, error) {
	t.Helper()
	var ids []string
	gap := false
	err := ScanDay(context.Background(), dir, day, filter, func() { gap = true }, func(ev event.Event) { ids = append(ids, ev.ID) })
	return ids, gap, err
}

func TestScanDayYieldsValidRecordsInFileOrderAndReportsGaps(t *testing.T) {
	dir := t.TempDir()
	writeDayFile(t, dir, "2026-07-02",
		rec("a", "r1"),
		"{corrupt",
		`{"id":"invalid","time":"2026-07-02T10:00:00Z","category":"meta"}`, // no source: fails Validate
		rec("b", "r2"),
	)
	ids, gap, err := scanIDs(t, dir, "2026-07-02", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"a", "b"}) || !gap {
		t.Fatalf("ids=%v gap=%v", ids, gap)
	}
}

func TestScanDayMissingDayIsEmptyNotAnError(t *testing.T) {
	ids, gap, err := scanIDs(t, t.TempDir(), "2026-07-02", nil)
	if err != nil || len(ids) != 0 || gap {
		t.Fatalf("ids=%v gap=%v err=%v", ids, gap, err)
	}
}

func TestScanDayPrefilterDecodesOnlyRecordsContainingARequiredIdentity(t *testing.T) {
	dir := t.TempDir()
	writeDayFile(t, dir, "2026-07-02",
		rec("keep-1", "/work/alpha"),
		rec("skip", "/work/beta"),
		"{corrupt but unrelated",
		rec("keep-2", "/work/alpha-alias"),
	)
	needles, ok := IdentityNeedles([]string{"/work/alpha", "/work/alpha-alias"})
	if !ok {
		t.Fatal("plain path identities must be usable as needles")
	}
	ids, gap, err := scanIDs(t, dir, "2026-07-02", Prefilter{needles})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"keep-1", "keep-2"}) {
		t.Fatalf("ids = %v", ids)
	}
	if gap {
		t.Fatal("a record that cannot match is never decoded, so it is not a gap")
	}
	// Corruption on a record that contains the identity is still a gap.
	writeDayFile(t, dir, "2026-07-03", `{"repo_id":"/work/alpha", broken`)
	if _, gap, _ = scanIDs(t, dir, "2026-07-03", Prefilter{needles}); !gap {
		t.Fatal("a corrupt record containing the identity must be reported as a gap")
	}
}

func TestIdentityNeedlesRefuseValuesWhoseJSONEncodingIsWriterDependent(t *testing.T) {
	for _, value := range []string{"/path/with<angle", "has&amp", `quote"d`, `back\slash`, "unicodé", "tab\tchar", ""} {
		if _, ok := IdentityNeedles([]string{"/plain", value}); ok {
			t.Errorf("IdentityNeedles must refuse %q (prefiltering on it could miss records)", value)
		}
	}
	needles, ok := IdentityNeedles([]string{"jj:/Users/me/repo", "0123abcd"})
	if !ok || len(needles) != 2 || string(needles[0]) != `"jj:/Users/me/repo"` {
		t.Fatalf("needles = %q ok=%v", needles, ok)
	}
}

func TestScanDayPrefilterGroupsAreAnded(t *testing.T) {
	dir := t.TempDir()
	writeDayFile(t, dir, "2026-07-02",
		`{"id":"both","time":"2026-07-02T10:00:00Z","source":"g","category":"meta","repo_id":"R","worktree_id":"W"}`,
		`{"id":"repo-only","time":"2026-07-02T10:00:00Z","source":"g","category":"meta","repo_id":"R"}`,
		`{"id":"ws-only","time":"2026-07-02T10:00:00Z","source":"g","category":"meta","worktree_id":"W"}`,
	)
	repo, _ := IdentityNeedles([]string{"R"})
	ws, _ := IdentityNeedles([]string{"W"})
	ids, _, err := scanIDs(t, dir, "2026-07-02", Prefilter{repo, ws})
	if err != nil || !reflect.DeepEqual(ids, []string{"both"}) {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
}

func TestScanDayObservesCancellationInsideALargeFile(t *testing.T) {
	dir := t.TempDir()
	lines := make([]string, 5000)
	for i := range lines {
		lines[i] = rec(fmt.Sprintf("e%d", i), "r")
	}
	writeDayFile(t, dir, "2026-07-02", lines...)
	ctx, cancel := context.WithCancel(context.Background())
	yielded := 0
	err := ScanDay(ctx, dir, "2026-07-02", nil, func() {}, func(event.Event) {
		yielded++
		if yielded == 10 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if yielded >= len(lines)/2 {
		t.Fatalf("scan kept reading after cancellation: %d of %d records", yielded, len(lines))
	}
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	start := time.Now()
	if err := ScanDay(cancelled, dir, "2026-07-02", nil, func() {}, func(event.Event) { t.Fatal("yielded after cancel") }); !errors.Is(err, context.Canceled) || time.Since(start) > time.Second {
		t.Fatalf("pre-cancelled scan: %v after %v", err, time.Since(start))
	}
}

func TestScanDaySkipsOversizedRecordsAsGaps(t *testing.T) {
	dir := t.TempDir()
	huge := `{"id":"huge","time":"2026-07-02T10:00:00Z","source":"g","category":"meta","raw":"` + strings.Repeat("x", maxRecordBytes+10) + `"}`
	writeDayFile(t, dir, "2026-07-02", rec("a", "r"), huge, rec("b", "r"))
	ids, gap, err := scanIDs(t, dir, "2026-07-02", nil)
	if err != nil || !gap || !reflect.DeepEqual(ids, []string{"a", "b"}) {
		t.Fatalf("ids=%v gap=%v err=%v", ids, gap, err)
	}
}
