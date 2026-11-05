package capture

import (
	"agentfirehose/internal/capture/internal/projection"
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
)

// referenceActivity reads every day file in order, keeps each stable ID's first
// record, and counts Heat with no index. The indexed engine must agree.
func referenceActivity(t *testing.T, dir string, q ActivityQuery) map[string][][2]int {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(dir, "*.ndjson"))
	sort.Strings(files)
	from, _ := ActivityWindow(q.From, q.To, q.Bucket)
	seen := map[string]bool{}
	counts := map[string]map[int]int{}
	for _, f := range files {
		day := strings.TrimSuffix(filepath.Base(f), ".ndjson")
		if err := spool.ScanDay(context.Background(), dir, day, nil, func() {}, func(ev event.Event) {
			if seen[ev.ID] {
				return
			}
			seen[ev.ID] = true
			if ev.Category != event.CategoryFile || ev.RepoID != q.RepoID || ev.Time.Before(from) || !ev.Time.Before(q.To) {
				return
			}
			for _, p := range projection.EventActivityPaths(ev) {
				g, rel := q.Resolve(ev, p)
				if counts[g+"|"+rel] == nil {
					counts[g+"|"+rel] = map[int]int{}
				}
				counts[g+"|"+rel][int(ev.Time.Sub(from)/q.Bucket)]++
			}
		}); err != nil {
			t.Fatal(err)
		}
	}
	out := map[string][][2]int{}
	for k, m := range counts {
		for i, n := range m {
			out[k] = append(out[k], [2]int{i, n})
		}
		sort.Slice(out[k], func(i, j int) bool { return out[k][i][0] < out[k][j][0] })
	}
	return out
}

// Cost is bounded by the window's days, not by spool size: a one-day window over
// a 40-day spool opens at most the two UTC days it overlaps, and agrees with a
// full read of the spool.
func TestActivityCostIsBoundedByWindowDays(t *testing.T) {
	s := realShapes(t)
	rng := rand.New(rand.NewSource(11))
	keys := []string{editPre, editPost, "codex patch_apply_end", "codex custom_tool_call:apply_patch", "antigravity PostToolUse:view_file"}
	var evs []event.Event
	start := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	for d := 0; d < 40; d++ {
		for k := 0; k < 80; k++ {
			ev := shapeAt(t, s, keys[rng.Intn(len(keys))], fmt.Sprintf("d%02d-%03d", d, k), start.Add(time.Duration(d)*24*time.Hour+time.Duration(rng.Intn(86400))*time.Second))
			if rng.Intn(3) == 0 {
				ev.RepoID = "other-repo"
			}
			if p, ok := ev.Payload["file_path"].(string); ok {
				ev.Payload["file_path"] = strings.Replace(p, "plans/", fmt.Sprintf("pkg%d/", rng.Intn(6)), 1)
			}
			if ev.Name == "PostToolUse:view_file" {
				ev.RepoID = shapeRepo // full-mode raw identity, made to match directly
			}
			evs = append(evs, ev)
		}
	}
	evs = append(evs, evs[100], evs[len(evs)/2]) // replayed stable IDs
	dir := t.TempDir()
	writeSpool(t, dir, evs)
	rec := &scanRecorder{}
	e := newRecordingEngine(t, dir, rec)

	from := time.Date(2026, 9, 20, 18, 0, 0, 0, time.UTC)
	q := ActivityQuery{RepoID: shapeRepo, From: from, To: from.Add(24 * time.Hour), Bucket: 15 * time.Minute, Resolve: stripRoot}
	r, err := e.Activity(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	if got := rec.scanned(); !reflect.DeepEqual(got, []string{"2026-09-21", "2026-09-20"}) {
		t.Fatalf("a window over two UTC days opens two of 40 day files; read %v", got)
	}
	want := referenceActivity(t, dir, q)
	if got := heatOf(r); len(got) == 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("indexed activity disagrees with a full read:\n got %v\nwant %v", got, want)
	}
	if entries, _ := os.ReadDir(dir); len(entries) < 40 {
		t.Fatalf("spool days: %d", len(entries))
	}
}
