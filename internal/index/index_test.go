package index

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

func seedEvents() []event.Event {
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	return []event.Event{
		{ID: "a1", Time: base, Source: "claude-code", Agent: "claude", SessionID: "s1",
			Category: event.CategorySession, Summary: "session started", Repo: "myrepo"},
		{ID: "a2", Time: base.Add(time.Minute), Source: "claude-code", SessionID: "s1", TraceID: "tr1",
			Category: event.CategoryFile, Payload: map[string]any{"file_path": "/repo/auth.go"}},
		// next UTC day: session s1 spans two day files
		{ID: "a3", Time: base.Add(15 * time.Hour), Source: "claude-code", SessionID: "s1",
			Category: event.CategoryTool, Summary: "ran a tool"},
		{ID: "b1", Time: base.Add(2 * time.Minute), Source: "codex", SessionID: "s2", TraceID: "tr1",
			Category: event.CategoryPrompt, Summary: "hello"},
		{ID: "c1", Time: base.Add(3 * time.Minute), Source: "procwatch",
			Category: event.CategoryMeta, Summary: "no session id"},
	}
}

func foldIndex(evs []event.Event) *Index {
	ix := New()
	for _, ev := range evs {
		ix.Apply(ev)
	}
	return ix
}

func TestSessionsAggregation(t *testing.T) {
	ix := foldIndex(seedEvents())
	sessions := ix.Sessions()
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2: %+v", len(sessions), sessions)
	}
	// s1's last event (a3) is later than s2's; most recent first.
	if sessions[0].ID != "s1" || sessions[1].ID != "s2" {
		t.Errorf("session order wrong: %+v", sessions)
	}
	s1 := sessions[0]
	if s1.Events != 3 || s1.Source != "claude-code" || s1.Agent != "claude" || s1.Repo != "myrepo" {
		t.Errorf("s1 summary wrong: %+v", s1)
	}
	if !s1.LastTime.After(s1.FirstTime) {
		t.Errorf("s1 time range wrong: %+v", s1)
	}
	if s1.LastSummary != "ran a tool" || s1.LastCategory != "tool" {
		t.Errorf("s1 latest activity wrong: %+v", s1)
	}
	if _, ok := ix.Session("s2"); !ok {
		t.Error("Session(s2) not found")
	}
	if _, ok := ix.Session("nope"); ok {
		t.Error("Session(nope) should not exist")
	}
}

func TestSessionDaysSpanFiles(t *testing.T) {
	ix := foldIndex(seedEvents())
	days := ix.SessionDays("s1")
	want := []string{"2026-07-02", "2026-07-03"}
	if !reflect.DeepEqual(days, want) {
		t.Errorf("SessionDays(s1) = %v, want %v", days, want)
	}
	if days := ix.SessionDays("s2"); !reflect.DeepEqual(days, []string{"2026-07-02"}) {
		t.Errorf("SessionDays(s2) = %v", days)
	}
	if days := ix.SessionDays("nope"); len(days) != 0 {
		t.Errorf("SessionDays(nope) = %v, want empty", days)
	}
}

func TestTracesAggregation(t *testing.T) {
	ix := foldIndex(seedEvents())
	traces := ix.Traces()
	if len(traces) != 1 || traces[0].ID != "tr1" || traces[0].Events != 2 {
		t.Fatalf("traces = %+v, want one tr1 with 2 events", traces)
	}
	if days := ix.TraceDays("tr1"); !reflect.DeepEqual(days, []string{"2026-07-02"}) {
		t.Errorf("TraceDays(tr1) = %v", days)
	}
}

func TestFilesAggregation(t *testing.T) {
	evs := seedEvents()
	evs = append(evs, event.Event{
		ID: "f9", Time: time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC), Source: "codex",
		SessionID: "s2", Category: event.CategoryFile,
		Payload: map[string]any{"changes": map[string]any{"/repo/auth.go": map[string]any{}}},
	})
	ix := foldIndex(evs)
	files := ix.Files()
	if len(files) != 1 {
		t.Fatalf("files = %+v, want 1 artifact", files)
	}
	f := files[0]
	if f.Path != "/repo/auth.go" || f.Events != 2 || len(f.Sources) != 2 {
		t.Errorf("artifact wrong: %+v", f)
	}
}

func TestApplyIsIdempotentPerEventID(t *testing.T) {
	evs := seedEvents()
	ix := New()
	for _, ev := range evs {
		ix.Apply(ev)
		ix.Apply(ev) // replays must not double-count (startup tail overlap)
	}
	sessions := ix.Sessions()
	if len(sessions) != 2 || sessions[0].Events != 3 {
		t.Errorf("duplicate Apply double-counted: %+v", sessions)
	}
}

func TestBuildEqualsFold(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "spool")
	w := spool.NewWriter(dir)
	evs := seedEvents()
	for _, ev := range evs {
		if _, err := w.Append(ev); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	built, err := Build(dir)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	// The spool stamps schema_version at append time; fold over what was
	// actually written so both sides see identical events.
	written, err := spool.ReadLastN(dir, 100)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	folded := foldIndex(written)
	if !reflect.DeepEqual(built.Sessions(), folded.Sessions()) {
		t.Errorf("Build sessions != fold sessions:\n%+v\n%+v", built.Sessions(), folded.Sessions())
	}
	if !reflect.DeepEqual(built.Traces(), folded.Traces()) {
		t.Errorf("Build traces != fold traces")
	}
	if !reflect.DeepEqual(built.Files(), folded.Files()) {
		t.Errorf("Build files != fold files")
	}
	if !reflect.DeepEqual(built.SessionDays("s1"), folded.SessionDays("s1")) {
		t.Errorf("Build days != fold days")
	}
}

func TestSessionAttentionSequence(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	ix := New()

	tr := ix.Apply(event.Event{
		ID: "1", Time: base, Source: "claude-code", SessionID: "s1",
		Category: event.CategorySession, Name: "SessionStart", Summary: "session started",
	})
	if tr != nil {
		t.Fatalf("SessionStart on new session should not transition: %+v", tr)
	}
	s, _ := ix.Session("s1")
	if s.State != StateWorking {
		t.Fatalf("initial state = %q", s.State)
	}

	tr = ix.Apply(event.Event{
		ID: "2", Time: base.Add(time.Minute), Source: "claude-code", SessionID: "s1",
		Category: event.CategoryPermission, Name: "Notification",
		Summary: "Claude needs your permission to use Bash", Severity: event.SeverityNotice,
	})
	if tr == nil || tr.Name != NameStateTransition {
		t.Fatalf("want state.transition, got %+v", tr)
	}
	if tr.Source != SourceFirehose || tr.Payload["state"] != "needs_input" {
		t.Errorf("transition payload wrong: %+v", tr)
	}
	s, _ = ix.Session("s1")
	if s.State != StateNeedsInput || s.StateReason != "Claude needs your permission to use Bash" {
		t.Errorf("after perm: %+v", s)
	}

	tr = ix.Apply(event.Event{
		ID: "3", Time: base.Add(2 * time.Minute), Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool, Summary: "Bash",
	})
	if tr == nil || tr.Payload["state"] != "working" {
		t.Fatalf("tool should resume working: %+v", tr)
	}

	tr = ix.Apply(event.Event{
		ID: "4", Time: base.Add(3 * time.Minute), Source: "claude-code", SessionID: "s1",
		Category: event.CategorySession, Name: "Stop", Summary: "agent finished responding",
	})
	if tr == nil || tr.Payload["state"] != "done" {
		t.Fatalf("Stop → done: %+v", tr)
	}
	s, _ = ix.Session("s1")
	if s.State != StateDone {
		t.Errorf("final state = %q", s.State)
	}
}

func TestApplyIgnoresSyntheticTransition(t *testing.T) {
	ix := New()
	ix.Apply(event.Event{
		ID: "1", Time: time.Now(), Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool,
	})
	tr := ix.Apply(event.Event{
		ID: "synth", Time: time.Now(), Source: SourceFirehose, SessionID: "s1",
		Category: event.CategoryMeta, Name: NameStateTransition,
		Payload: map[string]any{"state": "needs_input"},
	})
	if tr != nil {
		t.Fatalf("synthetic must not re-enter: %+v", tr)
	}
	s, _ := ix.Session("s1")
	if s.State != StateWorking || s.Events != 1 {
		t.Errorf("synthetic altered session: %+v", s)
	}
}

func TestAdvanceIdle(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	ix := New()
	ix.Apply(event.Event{
		ID: "1", Time: base, Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool,
	})
	ix.Apply(event.Event{
		ID: "2", Time: base, Source: "claude-code", SessionID: "s2",
		Category: event.CategoryPermission, Summary: "need you",
	})

	trs := ix.AdvanceIdle(base.Add(IdleAfter + time.Second))
	if len(trs) != 1 {
		t.Fatalf("want 1 idle transition (s1 only), got %d: %+v", len(trs), trs)
	}
	if trs[0].SessionID != "s1" || trs[0].Payload["state"] != "idle" {
		t.Errorf("wrong transition: %+v", trs[0])
	}
	s2, _ := ix.Session("s2")
	if s2.State != StateNeedsInput {
		t.Errorf("s2 must stay needs_input, got %q", s2.State)
	}
}

func TestAdvanceIdleSuppressedWhileToolOpen(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	ix := New()
	ix.Apply(event.Event{
		ID: "1", Time: base, Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool, Name: "PreToolUse:Bash", Summary: "Bash",
	})

	// The build runs long past the idle threshold — still working.
	if trs := ix.AdvanceIdle(base.Add(IdleAfter + time.Second)); len(trs) != 0 {
		t.Fatalf("open tool call must suppress idle, got %+v", trs)
	}
	s, _ := ix.Session("s1")
	if s.State != StateWorking {
		t.Fatalf("state = %q, want working", s.State)
	}

	ix.Apply(event.Event{
		ID: "2", Time: base.Add(2 * time.Minute), Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool, Name: "PostToolUse:Bash", Summary: "Bash",
	})
	trs := ix.AdvanceIdle(base.Add(2*time.Minute + IdleAfter + time.Second))
	if len(trs) != 1 || trs[0].Payload["state"] != "idle" {
		t.Fatalf("tool closed → idle after quiet period, got %+v", trs)
	}
}

func TestSessionEndClearsOpenTools(t *testing.T) {
	// A missing PostToolUse must not pin a finished session out of idle
	// forever: session end resets the open-tool bookkeeping.
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	ix := New()
	ix.Apply(event.Event{
		ID: "1", Time: base, Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool, Name: "PreToolUse:Bash",
	})
	ix.Apply(event.Event{
		ID: "2", Time: base.Add(time.Minute), Source: "claude-code", SessionID: "s1",
		Category: event.CategorySession, Name: "Stop",
	})
	ix.Apply(event.Event{
		ID: "3", Time: base.Add(2 * time.Minute), Source: "claude-code", SessionID: "s1",
		Category: event.CategoryPrompt, Summary: "next prompt",
	})
	trs := ix.AdvanceIdle(base.Add(2*time.Minute + IdleAfter + time.Second))
	if len(trs) != 1 || trs[0].Payload["state"] != "idle" {
		t.Fatalf("session end should clear open tools, got %+v", trs)
	}
}

func TestBuildAttentionDeterminism(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "spool")
	w := spool.NewWriter(dir)
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	evs := []event.Event{
		{ID: "a", Time: base, Source: "claude-code", SessionID: "s1",
			Category: event.CategoryPermission, Name: "Notification",
			Summary: "Claude needs your permission to use Bash"},
		{ID: "b", Time: base.Add(time.Minute), Source: "claude-code", SessionID: "s1",
			Category: event.CategoryTool, Summary: "Bash"},
		{ID: "c", Time: base.Add(2 * time.Minute), Source: "claude-code", SessionID: "s1",
			Category: event.CategorySession, Name: "Stop"},
	}
	for _, ev := range evs {
		if _, err := w.Append(ev); err != nil {
			t.Fatal(err)
		}
	}
	built, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	written, err := spool.ReadLastN(dir, 100)
	if err != nil {
		t.Fatal(err)
	}
	folded := foldIndex(written)
	if !reflect.DeepEqual(built.Sessions(), folded.Sessions()) {
		t.Errorf("attention rebuild mismatch:\n%+v\n%+v", built.Sessions(), folded.Sessions())
	}
	s, _ := built.Session("s1")
	if s.State != StateDone {
		t.Errorf("built state = %q, want done", s.State)
	}
}

func TestBuildMissingDirIsEmpty(t *testing.T) {
	ix, err := Build(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("Build on missing dir: %v", err)
	}
	if len(ix.Sessions()) != 0 || len(ix.Files()) != 0 {
		t.Errorf("missing dir must build an empty index")
	}
}

func TestBuildSkipsCorruptLines(t *testing.T) {
	dir := t.TempDir()
	line1 := `{"id":"ok1","time":"2026-07-02T10:00:00Z","source":"generic","category":"meta","session_id":"s1"}`
	line2 := `{"id":"ok2","time":"2026-07-02T10:00:01Z","source":"generic","category":"meta","session_id":"s1"}`
	data := line1 + "\n" + "{corrupt not json\n" + line2 + "\n"
	if err := os.WriteFile(filepath.Join(dir, "2026-07-02.ndjson"), []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	ix, err := Build(dir)
	if err != nil {
		t.Fatalf("Build with corrupt line: %v", err)
	}
	sessions := ix.Sessions()
	if len(sessions) != 1 || sessions[0].Events != 2 {
		t.Errorf("corrupt-line handling wrong (want 2 distinct events): %+v", sessions)
	}
}
