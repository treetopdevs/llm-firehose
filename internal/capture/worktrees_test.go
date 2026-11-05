package capture_test

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func loadWorktreeFixture(t *testing.T) []event.Event {
	t.Helper()
	f, err := os.Open("testdata/worktrees_full.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		var ev event.Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatal(err)
		}
		out = append(out, ev)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func newWorktreeEngine(t *testing.T, dir string, mode privacy.Mode) *capture.Engine {
	t.Helper()
	engine, err := capture.New(capture.Options{SpoolDir: dir, Policy: mode})
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func admitAll(t *testing.T, engine *capture.Engine, events []event.Event) {
	t.Helper()
	for _, ev := range events {
		if _, err := engine.Admit(context.Background(), ev); err != nil {
			t.Fatalf("admit %s: %v", ev.ID, err)
		}
	}
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestEngineWorktreesFromAdmittedFixture(t *testing.T) {
	engine := newWorktreeEngine(t, t.TempDir(), privacy.ModeFull)
	admitAll(t, engine, loadWorktreeFixture(t))

	rows := engine.Worktrees()
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	want := map[string][3]int{
		"/work/alpha":      {19, 12, 3},
		"/work/alpha-feat": {12, 30, 4},
		"/work/beta-fix":   {10, 8, 3},
	}
	for _, r := range rows {
		w, ok := want[r.WorktreeID]
		if !ok {
			t.Fatalf("unexpected row %q", r.WorktreeID)
		}
		if got := [3]int{r.SignalEvents, r.MetaEvents, r.MarksTotal}; got != w {
			t.Errorf("%s signal/meta/marks = %v, want %v", r.WorktreeID, got, w)
		}
	}
	got, ok := engine.Worktree("/work/alpha-feat")
	if !ok || got.WorktreeID != "/work/alpha-feat" || got.RepoID != "/work/alpha/.git" {
		t.Fatalf("Worktree(alpha-feat) = %+v, %v", got, ok)
	}
	if _, ok := engine.Worktree("nope"); ok {
		t.Fatal("Worktree(nope) unexpectedly found")
	}
}

func TestEngineWorktreesLiveEqualsRebuildOutOfOrder(t *testing.T) {
	events := loadWorktreeFixture(t)
	rand.New(rand.NewSource(7)).Shuffle(len(events), func(i, j int) { events[i], events[j] = events[j], events[i] })
	for i := range events {
		if i%2 == 0 { // spread across two spool day files
			events[i].Time = events[i].Time.Add(-24 * time.Hour)
			ct := events[i].Time
			events[i].CaptureTime = &ct
		}
	}
	// 250 synthetic commits on one worktree, beyond the 200 mark cap.
	for i := 0; i < 250; i++ {
		raw, _ := json.Marshal(map[string]any{
			"session_id": "sess-fixture-1", "cwd": "/work/alpha-feat", "hook_event_name": "PostToolUse",
			"tool_name": "Bash", "tool_input": map[string]any{"command": fmt.Sprintf("git commit -m c%d", i)},
			"tool_use_id": fmt.Sprintf("toolu_syn_%d", i),
		})
		events = append(events, event.Event{
			SchemaVersion: event.CurrentSchemaVersion,
			ID:            fmt.Sprintf("syn-%04d", i),
			Time:          time.Date(2026, 10, 29, 6, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Minute),
			Source:        "claude-code", Agent: "claude", SessionID: "sess-fixture-1",
			Transport: "hook", Category: event.CategoryShell, Name: "PostToolUse:Bash",
			Severity: event.SeverityInfo, Summary: "ran shell tool", CWD: "/work/alpha-feat",
			RepoID: "/work/alpha/.git", WorktreeID: "/work/alpha-feat", Raw: string(raw),
		})
		ct := events[len(events)-1].Time
		events[len(events)-1].CaptureTime = &ct
	}
	dir := t.TempDir()
	live := newWorktreeEngine(t, dir, privacy.ModeFull)
	admitAll(t, live, events)
	admitAll(t, live, events[:30]) // duplicates

	rebuilt := newWorktreeEngine(t, dir, privacy.ModeFull)
	l, r := live.Worktrees(), rebuilt.Worktrees()
	if len(l) != 3 {
		t.Fatalf("live rows = %d", len(l))
	}
	if !reflect.DeepEqual(l, r) {
		t.Fatalf("live != rebuilt\nlive:    %+v\nrebuilt: %+v", l, r)
	}
	lw, _ := live.Worktree("/work/alpha-feat")
	rw, _ := rebuilt.Worktree("/work/alpha-feat")
	if len(lw.Marks) != 200 || lw.MarksTotal < 250 || lw.MarksTotal != rw.MarksTotal || len(rw.Marks) != 200 {
		t.Fatalf("marks live %d/%d rebuilt %d/%d", len(lw.Marks), lw.MarksTotal, len(rw.Marks), rw.MarksTotal)
	}
	days, _ := filepath.Glob(filepath.Join(dir, "*.ndjson"))
	if len(days) < 2 {
		t.Fatalf("spool day files = %d, want >= 2", len(days))
	}
}

func TestEngineWorktreesBalancedPolicy(t *testing.T) {
	engine := newWorktreeEngine(t, t.TempDir(), privacy.ModeBalanced)
	admitAll(t, engine, loadWorktreeFixture(t))

	rows := engine.Worktrees()
	if len(rows) != 3 {
		t.Fatalf("rows = %d", len(rows))
	}
	signal, meta := 0, 0
	keys := map[string]bool{}
	for _, r := range rows {
		keys[r.WorktreeID] = true
		signal += r.SignalEvents
		meta += r.MetaEvents
		// Summary verbs survive balanced redaction as display-only marks.
		wantMarks := map[string]int{sha("/work/alpha"): 3, sha("/work/alpha-feat"): 4, sha("/work/beta-fix"): 3}[r.WorktreeID]
		if r.MarksTotal != wantMarks || len(r.Marks) != wantMarks || r.Marks == nil {
			t.Errorf("%s balanced marks = %d/%d, want %d", r.WorktreeID, len(r.Marks), r.MarksTotal, wantMarks)
		}
		if !r.LastCommitMark.IsZero() || !r.LastMergeMark.IsZero() {
			t.Errorf("%s balanced marks must be display-only: %v %v", r.WorktreeID, r.LastCommitMark, r.LastMergeMark)
		}
		if r.Marks == nil || r.Sessions == nil || r.Paths == nil {
			t.Errorf("%s has nil slice", r.WorktreeID)
		}
		for _, p := range r.Paths {
			if n := len([]rune(p)); n > 245 {
				t.Errorf("path not truncated: %d runes", n)
			}
		}
	}
	for _, raw := range []string{"/work/alpha", "/work/alpha-feat", "/work/beta-fix"} {
		if !keys[sha(raw)] {
			t.Errorf("missing digest key for %s", raw)
		}
	}
	if signal != 41 || meta != 50 {
		t.Errorf("signal/meta = %d/%d, want 41/50", signal, meta)
	}
	if _, ok := engine.Worktree("/work/alpha-feat"); ok {
		t.Error("raw id found in balanced mode")
	}
	if _, ok := engine.Worktree(sha("/work/alpha-feat")); !ok {
		t.Error("digest id not found")
	}
}

func TestEngineWorktreesMixedModeSplitsRows(t *testing.T) {
	var w2 []event.Event
	for _, ev := range loadWorktreeFixture(t) {
		if ev.WorktreeID == "/work/alpha-feat" && ev.Category != event.CategoryMeta {
			w2 = append(w2, ev)
		}
	}
	if len(w2) < 4 {
		t.Fatalf("fixture W2 signal = %d", len(w2))
	}
	dir := t.TempDir()
	full := newWorktreeEngine(t, dir, privacy.ModeFull)
	admitAll(t, full, w2[:len(w2)/2])
	balanced := newWorktreeEngine(t, dir, privacy.ModeBalanced)
	admitAll(t, balanced, w2[len(w2)/2:])

	rows := balanced.Worktrees()
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2: %+v", len(rows), rows)
	}
	ids := []string{rows[0].WorktreeID, rows[1].WorktreeID}
	if !(contains(ids, "/work/alpha-feat") && contains(ids, sha("/work/alpha-feat"))) {
		t.Fatalf("ids = %v", ids)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
