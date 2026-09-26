package projection

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
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

func foldProjection(evs []event.Event) *Projection {
	ix := New()
	for _, ev := range evs {
		ix.Apply(ev)
	}
	return ix
}

func TestSessionsAggregation(t *testing.T) {
	ix := foldProjection(seedEvents())
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
	ix := foldProjection(seedEvents())
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
	ix := foldProjection(seedEvents())
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
	ix := foldProjection(evs)
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
	folded := foldProjection(written)
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
	wantSince := base.Add(IdleAfter)
	if !trs[0].Time.Equal(wantSince) {
		t.Errorf("transition Time should be the threshold crossing (last activity + IdleAfter = %v), got %v", wantSince, trs[0].Time)
	}
	s1, _ := ix.Session("s1")
	if !s1.StateSince.Equal(wantSince) {
		t.Errorf("s1 StateSince should be last activity + IdleAfter (%v), got %v", wantSince, s1.StateSince)
	}
	s2, _ := ix.Session("s2")
	if s2.State != StateNeedsInput {
		t.Errorf("s2 must stay needs_input, got %q", s2.State)
	}
}

// TestAdvanceIdleAfterRebuildStampsOwnLastActivity is the regression test for
// the "473 live sessions" restart bug: a cold rebuild's first idle sweep
// must stamp state_since from the session's own last real activity (plus the
// idle threshold, i.e. the instant the session actually crossed into idle),
// not from the wall-clock instant the sweep happened to run, however long
// after that activity the restart occurred.
func TestAdvanceIdleAfterRebuildStampsOwnLastActivity(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	ix := New()
	ix.Apply(event.Event{
		ID: "1", Time: base, Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool,
	})

	// Simulate a daemon restart hours after the session's last activity —
	// far past IdleAfter, as happens on a cold rebuild of a long-quiet spool.
	restartNow := base.Add(6 * time.Hour)
	trs := ix.AdvanceIdle(restartNow)
	if len(trs) != 1 {
		t.Fatalf("want 1 idle transition, got %d: %+v", len(trs), trs)
	}
	if trs[0].SessionID != "s1" || trs[0].Payload["state"] != "idle" {
		t.Errorf("wrong transition: %+v", trs[0])
	}

	s1, ok := ix.Session("s1")
	if !ok {
		t.Fatalf("session s1 not found")
	}
	if s1.State != StateIdle {
		t.Errorf("state = %q, want idle", s1.State)
	}
	wantSince := base.Add(IdleAfter)
	if !s1.StateSince.Equal(wantSince) {
		t.Errorf("StateSince should be the session's own last activity + IdleAfter (%v), got %v (restart was at %v)", wantSince, s1.StateSince, restartNow)
	}
}

// TestApplyKeepsLastActivityMonotonic is the regression test for a session
// whose events are applied out of timestamp order — which append order does
// not rule out, since sources are not guaranteed to be applied in the order
// their own clocks would sort them. A late-arriving event carrying an older
// timestamp than one already applied must not move the session's tracked
// last-activity backwards: doing so would make a later idle sweep derive
// state_since from stale evidence, reporting idle before the session's own
// recorded last_time or misjudging whether IdleAfter has even elapsed.
func TestApplyKeepsLastActivityMonotonic(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	trueLastActivity := base.Add(100 * time.Second)
	ix := New()
	ix.Apply(event.Event{
		ID: "1", Time: trueLastActivity, Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool,
	})
	// Arrives second, but stamped with an older source time than the event
	// already applied above.
	ix.Apply(event.Event{
		ID: "2", Time: base, Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool,
	})

	s1, ok := ix.Session("s1")
	if !ok {
		t.Fatalf("session s1 not found")
	}
	if !s1.LastTime.Equal(trueLastActivity) {
		t.Fatalf("s1 LastTime = %v, want %v (max of the two applied events)", s1.LastTime, trueLastActivity)
	}

	// The idle sweep runs just past IdleAfter measured from the session's
	// true (later) last activity — it must not yet be idle, and once it is,
	// it must derive state_since from the true last activity, not the older
	// event that happened to be applied last.
	notYetIdle := trueLastActivity.Add(IdleAfter - time.Second)
	if trs := ix.AdvanceIdle(notYetIdle); len(trs) != 0 {
		t.Fatalf("want no idle transition before the true IdleAfter elapses, got %+v", trs)
	}

	pastIdle := trueLastActivity.Add(IdleAfter + time.Second)
	trs := ix.AdvanceIdle(pastIdle)
	if len(trs) != 1 || trs[0].SessionID != "s1" || trs[0].Payload["state"] != "idle" {
		t.Fatalf("want 1 idle transition for s1, got %+v", trs)
	}
	wantSince := trueLastActivity.Add(IdleAfter)
	s1, _ = ix.Session("s1")
	if !s1.StateSince.Equal(wantSince) {
		t.Errorf("StateSince = %v, want %v (derived from the true, monotonic last activity)", s1.StateSince, wantSince)
	}
	if s1.StateSince.Before(s1.LastTime) {
		t.Errorf("StateSince (%v) precedes the session's own LastTime (%v)", s1.StateSince, s1.LastTime)
	}
}

// TestInboxUnaffectedByIdleSweep documents that the attention inbox
// (inbox.go) has no analogous wall-clock restamp bug: InboxSession state and
// evidence are set exclusively from real captured events inside applyInbox,
// with no ticked idle sweep. An AdvanceIdle call, run well past IdleAfter,
// must leave a session's inbox evidence byte-for-byte unchanged.
func TestInboxUnaffectedByIdleSweep(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	ix := New()
	ix.Apply(event.Event{
		ID: "1", Time: base, Source: "claude-code", SessionID: "s1",
		Category: event.CategoryTool, Summary: "Bash",
	})

	before := ix.Inbox()
	var beforeSession InboxSession
	found := false
	for _, s := range before.Sessions {
		if s.Source == "claude-code" && s.ID == "s1" {
			beforeSession = s
			found = true
		}
	}
	if !found {
		t.Fatalf("s1 not found in inbox before sweep: %+v", before.Sessions)
	}

	ix.AdvanceIdle(base.Add(6 * time.Hour))

	after := ix.Inbox()
	var afterSession InboxSession
	found = false
	for _, s := range after.Sessions {
		if s.Source == "claude-code" && s.ID == "s1" {
			afterSession = s
			found = true
		}
	}
	if !found {
		t.Fatalf("s1 not found in inbox after sweep: %+v", after.Sessions)
	}

	if !reflect.DeepEqual(beforeSession.Last, afterSession.Last) {
		t.Errorf("inbox Last evidence changed across an idle sweep: before=%+v after=%+v", beforeSession.Last, afterSession.Last)
	}
	if !afterSession.LastObservedAt.Equal(beforeSession.LastObservedAt) {
		t.Errorf("inbox LastObservedAt changed across an idle sweep: before=%v after=%v", beforeSession.LastObservedAt, afterSession.LastObservedAt)
	}
	if afterSession.State != beforeSession.State {
		t.Errorf("inbox State changed across an idle sweep: before=%q after=%q", beforeSession.State, afterSession.State)
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
	folded := foldProjection(written)
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
		t.Errorf("missing dir must build an empty Projection")
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
