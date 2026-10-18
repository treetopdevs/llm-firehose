package projection

import (
	"encoding/json"
	"fmt"
	"reflect"
	"runtime"
	"testing"
	"time"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func TestFileSessionsKeepRecordedScopesAndSourcesSeparate(t *testing.T) {
	// Normalized contract mutations of a real captured Codex patch event.
	real := realPatchApplyEnd(t)
	rows := []event.Event{}
	for i, scope := range []struct{ source, session, workspace string }{
		{"codex", "same", "/work/a"}, {"claude-code", "same", "/work/a"},
		{"codex", "same", "/work/b"}, {"codex", "other", "/work/a"},
	} {
		ev := real
		ev.ID = string(rune('a' + i))
		ev.Source = scope.source
		ev.SessionID = scope.session
		ev.WorktreeID = scope.workspace
		rows = append(rows, ev)
	}
	ix := foldProjection(rows)
	got := ix.FileSessions()
	if len(got) != 4 {
		t.Fatalf("scopes collapsed: %+v", got)
	}
	if len(ix.Files()) != 1 || ix.Files()[0].Events != 4 {
		t.Fatalf("legacy aggregation changed: %+v", ix.Files())
	}
	ix.Apply(rows[0])
	if !reflect.DeepEqual(got, ix.FileSessions()) {
		t.Fatal("duplicate admission changed scoped summaries")
	}
	got[0].Path = "mutated"
	if ix.FileSessions()[0].Path == "mutated" {
		t.Fatal("caller mutated projection")
	}
}

func TestFileSessionsChronologyAndOpaquePaths(t *testing.T) {
	real := realPatchApplyEnd(t)
	real.WorktreeID = "/work/proj"
	late := real
	late.ID = "z"
	late.Time = real.Time.Add(time.Hour)
	tie := late
	tie.ID = "a"
	minimal := privacy.Redact(real, privacy.ModeMinimal)
	minimal.ID = "minimal"
	ix := foldProjection([]event.Event{late, tie, real, minimal})
	got := ix.FileSessions()
	if len(got) != 1 {
		t.Fatalf("opaque path or scope admitted: %+v", got)
	}
	row := got[0]
	if row.Events != 3 || row.LastEventID != "z" || !row.FirstTime.Equal(real.Time) || !row.LastTime.Equal(late.Time) {
		t.Fatalf("wrong chronology: %+v", row)
	}
}

func TestFileSessionsUnknownScopeAndKindSeparation(t *testing.T) {
	real := realPatchApplyEnd(t)
	real.WorktreeID = ""
	real.JJWorkspaceID = ""
	real.CWD = ""
	real.Repo = ""
	real.SessionID = ""
	cwd := real
	cwd.ID = "cwd"
	cwd.CWD = "/same"
	worktree := real
	worktree.ID = "worktree"
	worktree.WorktreeID = "/same"
	rows := foldProjection([]event.Event{real, cwd, worktree}).FileSessions()
	if len(rows) != 3 {
		t.Fatalf("scope kinds collapsed: %+v", rows)
	}
	unknown := false
	for _, row := range rows {
		if row.Workspace == "" {
			unknown = true
			if row.WorkspaceKind != "unknown" || row.SessionID != "" {
				t.Fatalf("invented identity: %+v", row)
			}
		}
	}
	if !unknown {
		t.Fatal("unknown scope omitted")
	}
}

func TestFileSessionsRebuildMatchesIncremental(t *testing.T) {
	real := realPatchApplyEnd(t)
	dir := t.TempDir()
	w := spool.NewWriter(dir)
	if _, err := w.Append(real); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rebuilt.FileSessions(), foldProjection([]event.Event{real}).FileSessions()) {
		t.Fatal("spool rebuild differs from incremental aggregation")
	}
}

func TestFileSessionsIDLessAndMultiplePaths(t *testing.T) {
	real := realPatchApplyEnd(t)
	// Normalized changes-map and identity mutations of the captured patch.
	real.ID = ""
	real.Payload = map[string]any{"changes": map[string]any{"a": map[string]any{}, "b": map[string]any{}}}
	ix := foldProjection([]event.Event{real, real})
	rows := ix.FileSessions()
	if len(rows) != 2 {
		t.Fatalf("multiple paths lost: %+v", rows)
	}
	for _, row := range rows {
		if row.Events != 2 || row.LastEventID != "" {
			t.Fatalf("ID-less admission semantics changed: %+v", row)
		}
	}
}

func TestFileSessionsScale(t *testing.T) {
	real := realPatchApplyEnd(t)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	ix := New()
	for i := 0; i < 10000; i++ {
		ev := real
		ev.ID = fmt.Sprint(i)
		ev.SessionID = fmt.Sprint(i)
		ev.WorktreeID = "/work/proj"
		ix.Apply(ev)
	}
	rows := ix.FileSessions()
	encoded, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	if len(rows) != 10000 {
		t.Fatalf("rows %d", len(rows))
	}
	allocated := after.TotalAlloc - before.TotalAlloc
	t.Logf("10000 rows: %d allocated bytes, %d JSON bytes", allocated, len(encoded))
	if allocated > 64<<20 || len(encoded) > 16<<20 {
		t.Fatalf("scale ceiling exceeded: allocation=%d JSON=%d", allocated, len(encoded))
	}
	runtime.KeepAlive(ix)
}
