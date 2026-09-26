package projection

import (
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func TestTransitionPermissionNeedsInput(t *testing.T) {
	prev := Attention{State: StateWorking, Since: time.Now()}
	ev := event.Event{
		Category: event.CategoryPermission,
		Name:     "Notification",
		Summary:  "Claude needs your permission to use Bash",
		Severity: event.SeverityNotice,
		Time:     time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC),
	}
	next, changed := Transition(prev, ev)
	if !changed {
		t.Fatal("expected transition")
	}
	if next.State != StateNeedsInput {
		t.Errorf("state = %q, want needs_input", next.State)
	}
	if next.Reason != ev.Summary {
		t.Errorf("reason = %q, want %q", next.Reason, ev.Summary)
	}
	if !next.Since.Equal(ev.Time) {
		t.Errorf("since = %v, want event time", next.Since)
	}
}

func TestTransitionActivityClearsNeedsInput(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	prev := Attention{State: StateNeedsInput, Since: base, Reason: "waiting"}
	for _, cat := range []event.Category{
		event.CategoryTool, event.CategoryMessage, event.CategoryFile,
		event.CategoryShell, event.CategoryPrompt,
	} {
		ev := event.Event{Category: cat, Time: base.Add(time.Minute), Summary: "activity"}
		next, changed := Transition(prev, ev)
		if !changed || next.State != StateWorking {
			t.Errorf("%s: got %+v changed=%v, want working", cat, next, changed)
		}
		if next.HasError {
			t.Errorf("%s: HasError should clear on activity", cat)
		}
	}
}

func TestTransitionPermissionReplyClearsNeedsInput(t *testing.T) {
	// OpenCode maps both permission.updated and permission.replied to the
	// permission category; a reply means the human answered, so the session
	// goes back to working rather than staying needs_input.
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	prev := Attention{State: StateNeedsInput, Since: base, Reason: "permission requested: Edit main.go"}
	ev := event.Event{
		Category: event.CategoryPermission,
		Name:     "permission.replied",
		Summary:  "permission answered: once",
		Severity: event.SeverityNotice,
		Time:     base.Add(time.Minute),
	}
	next, changed := Transition(prev, ev)
	if !changed {
		t.Fatal("expected transition")
	}
	if next.State != StateWorking {
		t.Errorf("state = %q, want working", next.State)
	}
	if next.Reason != "" {
		t.Errorf("reason = %q, want cleared", next.Reason)
	}
}

func TestTransitionClaudeTerminalPermissionEventsClearNeedsInput(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	for _, name := range []string{"PermissionDenied", "ElicitationResult"} {
		t.Run(name, func(t *testing.T) {
			prev := Attention{State: StateNeedsInput, Since: base, Reason: "waiting"}
			ev := event.Event{
				Category: event.CategoryPermission,
				Name:     name,
				Summary:  "permission interaction completed",
				Time:     base.Add(time.Minute),
			}
			next, changed := Transition(prev, ev)
			if !changed || next.State != StateWorking || next.Reason != "" {
				t.Fatalf("%s => %+v changed=%v, want working with cleared reason", name, next, changed)
			}
		})
	}
}

func TestTransitionPermissionUpdatedStillNeedsInput(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	prev := Attention{State: StateWorking, Since: base}
	ev := event.Event{
		Category: event.CategoryPermission,
		Name:     "permission.updated",
		Summary:  "permission requested: Edit main.go",
		Time:     base.Add(time.Minute),
	}
	next, changed := Transition(prev, ev)
	if !changed || next.State != StateNeedsInput {
		t.Errorf("permission.updated => %+v changed=%v, want needs_input", next, changed)
	}
}

func TestTransitionSessionEndOtherAgents(t *testing.T) {
	// Codex ends turns with task_complete; OpenCode signals lifecycle with
	// session.idle / session.deleted. All must count as session completion.
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	for _, name := range []string{"task_complete", "session.idle", "session.deleted"} {
		prev := Attention{State: StateWorking, Since: base}
		ev := event.Event{
			Category: event.CategorySession,
			Name:     name,
			Time:     base.Add(time.Minute),
		}
		next, changed := Transition(prev, ev)
		if !changed || next.State != StateDone {
			t.Errorf("%s: got %+v changed=%v, want done", name, next, changed)
		}
	}
	// Session starts must not read as completion.
	for _, name := range []string{"task_started", "session.created", "session_meta", "SessionStart"} {
		prev := Attention{State: StateWorking, Since: base}
		ev := event.Event{
			Category: event.CategorySession,
			Name:     name,
			Time:     base.Add(time.Minute),
		}
		next, _ := Transition(prev, ev)
		if next.State == StateDone {
			t.Errorf("%s must not mark session done", name)
		}
	}
}

func TestTransitionStopDone(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	prev := Attention{State: StateWorking, Since: base}
	for _, name := range []string{"Stop", "SessionEnd", "SubagentStop"} {
		ev := event.Event{
			Category: event.CategorySession,
			Name:     name,
			Time:     base.Add(time.Minute),
			Summary:  "agent finished responding",
		}
		next, changed := Transition(prev, ev)
		if !changed || next.State != StateDone {
			t.Errorf("%s: got %+v changed=%v, want done", name, next, changed)
		}
	}
}

func TestTransitionDoneStaysUntilActivity(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	prev := Attention{State: StateDone, Since: base}
	meta := event.Event{Category: event.CategoryMeta, Name: "PreCompact", Time: base.Add(time.Second)}
	next, changed := Transition(prev, meta)
	if changed || next.State != StateDone {
		t.Errorf("done should stay on meta: %+v changed=%v", next, changed)
	}
	tool := event.Event{Category: event.CategoryTool, Time: base.Add(2 * time.Second)}
	next, changed = Transition(prev, tool)
	if !changed || next.State != StateWorking {
		t.Errorf("done→working on tool: %+v changed=%v", next, changed)
	}
}

func TestTransitionErrorOverlay(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	prev := Attention{State: StateWorking, Since: base}
	ev := event.Event{
		Category: event.CategoryError,
		Severity: event.SeverityError,
		Time:     base.Add(time.Second),
		Summary:  "boom",
	}
	next, changed := Transition(prev, ev)
	if !changed || !next.HasError {
		t.Fatalf("expected HasError overlay: %+v changed=%v", next, changed)
	}
	if next.State != StateWorking {
		t.Errorf("primary state should stay working, got %q", next.State)
	}
	// severity=error alone also sets overlay
	prev = Attention{State: StateWorking, Since: base}
	ev = event.Event{
		Category: event.CategoryTool,
		Severity: event.SeverityError,
		Time:     base.Add(time.Second),
	}
	next, changed = Transition(prev, ev)
	// tool activity → working (already) but HasError set; state may not change
	if !next.HasError {
		t.Error("severity=error should set HasError")
	}
	_ = changed
}

func TestTransitionIdleOnlyFromWorking(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	last := base
	now := base.Add(IdleAfter + time.Second)

	working := Attention{State: StateWorking, Since: base}
	next, changed := TickIdle(working, last, now, false)
	if !changed || next.State != StateIdle {
		t.Errorf("working→idle: %+v changed=%v", next, changed)
	}
	wantSince := last.Add(IdleAfter)
	if !next.Since.Equal(wantSince) {
		t.Errorf("idle Since should be the threshold crossing (lastActivity+IdleAfter = %v), got %v", wantSince, next.Since)
	}

	// A cold rebuild's first idle sweep can run hours after the session's
	// last real activity (e.g. a daemon restart long after the session went
	// quiet). Since must still reflect when the session actually crossed
	// into idle — lastActivity+IdleAfter — not the wall clock the sweep
	// happened to run at, and not lastActivity itself (which would still
	// misstate the crossing by a full IdleAfter and, live, make the reader
	// see a huge fake dwell the instant idle is first noticed).
	longDeadLast := base
	longDeadNow := base.Add(6 * time.Hour)
	longDeadWorking := Attention{State: StateWorking, Since: base}
	longDeadNext, longDeadChanged := TickIdle(longDeadWorking, longDeadLast, longDeadNow, false)
	if !longDeadChanged || longDeadNext.State != StateIdle {
		t.Errorf("long-dead working→idle: %+v changed=%v", longDeadNext, longDeadChanged)
	}
	wantLongDeadSince := longDeadLast.Add(IdleAfter)
	if !longDeadNext.Since.Equal(wantLongDeadSince) {
		t.Errorf("long-dead idle Since should be lastActivity+IdleAfter (%v), got %v (now was %v)", wantLongDeadSince, longDeadNext.Since, longDeadNow)
	}

	needs := Attention{State: StateNeedsInput, Since: base, Reason: "perm"}
	next, changed = TickIdle(needs, last, now, false)
	if changed || next.State != StateNeedsInput {
		t.Errorf("needs_input must not become idle: %+v changed=%v", next, changed)
	}

	done := Attention{State: StateDone, Since: base}
	next, changed = TickIdle(done, last, now, false)
	if changed || next.State != StateDone {
		t.Errorf("done must not become idle: %+v changed=%v", next, changed)
	}
}

// TestTickIdleDwellIsAccurateJustAfterCrossing is the regression test for the
// Codex finding that a normal idle sweep, discovering idleness moments after
// the threshold was crossed, must not report a dwell time inflated by the
// full IdleAfter window. A viewer computing dwell as now.Sub(Since) should
// see only the small margin between the threshold crossing and the sweep
// that noticed it, not IdleAfter plus that margin.
func TestTickIdleDwellIsAccurateJustAfterCrossing(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	lastActivity := base
	// The sweep runs one second after the idle threshold was crossed.
	now := lastActivity.Add(IdleAfter + time.Second)

	working := Attention{State: StateWorking, Since: base}
	next, changed := TickIdle(working, lastActivity, now, false)
	if !changed || next.State != StateIdle {
		t.Fatalf("working→idle: %+v changed=%v", next, changed)
	}

	dwell := now.Sub(next.Since)
	if dwell != time.Second {
		t.Errorf("dwell just after crossing = %v, want 1s (Since should be the crossing instant, not lastActivity or now)", dwell)
	}
}

func TestTickIdleSuppressedWhileToolOpen(t *testing.T) {
	// A long-running command (e.g. a build between PreToolUse and PostToolUse)
	// is not idleness — the agent is waiting on its own tool, not the human.
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	working := Attention{State: StateWorking, Since: base}
	now := base.Add(IdleAfter + time.Second)

	next, changed := TickIdle(working, base, now, true)
	if changed || next.State != StateWorking {
		t.Errorf("open tool call must suppress idle: %+v changed=%v", next, changed)
	}

	next, changed = TickIdle(working, base, now, false)
	if !changed || next.State != StateIdle {
		t.Errorf("closed tool call must allow idle: %+v changed=%v", next, changed)
	}
}

func TestTransitionPermissionSequence(t *testing.T) {
	base := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	att := Attention{State: StateWorking, Since: base}

	perm := event.Event{
		Category: event.CategoryPermission,
		Name:     "Notification",
		Summary:  "Claude needs your permission to use Bash",
		Time:     base.Add(time.Minute),
	}
	att, _ = Transition(att, perm)
	if att.State != StateNeedsInput {
		t.Fatalf("after perm: %q", att.State)
	}

	tool := event.Event{Category: event.CategoryTool, Time: base.Add(2 * time.Minute), Summary: "Bash"}
	att, _ = Transition(att, tool)
	if att.State != StateWorking {
		t.Fatalf("after tool: %q", att.State)
	}

	stop := event.Event{Category: event.CategorySession, Name: "Stop", Time: base.Add(3 * time.Minute)}
	att, _ = Transition(att, stop)
	if att.State != StateDone {
		t.Fatalf("after stop: %q", att.State)
	}
}
