package tui

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"agentfirehose/internal/event"
)

var t0 = time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)

func mkEv(i int, cat event.Category, summary string) event.Event {
	return event.Event{
		ID: fmt.Sprintf("e%d", i), Time: t0.Add(time.Duration(i) * time.Second),
		Source: "claude-code", Agent: "claude", SessionID: "s1",
		Category: cat, Name: "n", Severity: event.SeverityInfo, Summary: summary,
		Payload: map[string]any{"k": "v"},
	}
}

func newTestModel() Model {
	m := NewModel(nil)
	mm, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	return mm.(Model)
}

func push(m Model, ev event.Event) Model {
	mm, _ := m.Update(EventMsg{Event: ev})
	return mm.(Model)
}

func stateTransition(i int, sessionID, state, reason string) event.Event {
	return event.Event{
		ID: fmt.Sprintf("transition-%d", i), Time: t0.Add(time.Duration(i) * time.Second),
		Source: "firehose", SessionID: sessionID, Category: event.CategoryMeta,
		Name: "state.transition", Summary: state,
		Payload: map[string]any{"state": state, "reason": reason},
	}
}

func key(m Model, k string) Model {
	var msg tea.KeyMsg
	switch k {
	case "space":
		msg = tea.KeyMsg{Type: tea.KeySpace}
	case "enter":
		msg = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		msg = tea.KeyMsg{Type: tea.KeyEsc}
	default:
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
	}
	mm, _ := m.Update(msg)
	return mm.(Model)
}

func TestNewEventAppearsInView(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryShell, "ran: go test ./..."))
	view := m.View()
	if !strings.Contains(view, "ran: go test ./...") {
		t.Errorf("view missing event summary:\n%s", view)
	}
	if !strings.Contains(view, "claude") {
		t.Errorf("view missing agent badge:\n%s", view)
	}
}

func TestReconciledAttentionTransitionDoesNotEnterTimeline(t *testing.T) {
	m := newTestModel()
	transition := stateTransition(1, "recovered", stateNeedsInput, "approve Bash")
	transition.ID = ""
	transition.Summary = ""
	transition.Payload["reconciled"] = true
	m = push(m, transition)
	if len(m.events) != 0 || m.total != 0 {
		t.Fatalf("reconciled transition entered timeline: %+v", m.events)
	}
	if got := m.attention["recovered"]; got.State != stateNeedsInput || got.Reason != "approve Bash" {
		t.Fatalf("reconciled attention = %+v", got)
	}
}

// TestReconciledTransitionRestoresLastForFreshness is the regression test for
// Codex review finding F3: a reconciliation snapshot's payload carries
// last_time (the session's real last activity), and noteAttention must
// consume it into the attention entry's Last. A session recovered purely
// from a reconciliation snapshot — its own activity long since scrolled out
// of the bounded event-ring recovery window — has no other way to look
// fresh: without last_time, Last stays at its zero value (there is no prior
// attention entry to carry it forward from), and attentionFresh falls back
// to the transition's own (here: stale) Since, wrongly judging a genuinely
// active session dead the instant it reconciles.
func TestReconciledTransitionRestoresLastForFreshness(t *testing.T) {
	now := t0.Add(30 * 24 * time.Hour)
	m := newTestModel()
	m.now = func() time.Time { return now }

	// The transition's own Since (ev.Time, from stateTransition's helper) is
	// deliberately ancient — far past workingStaleAfter — while last_time
	// carries the session's real, recent activity.
	recentLast := now.Add(-time.Minute)
	transition := stateTransition(1, "recovered", stateWorking, "")
	transition.ID = ""
	transition.Summary = ""
	transition.Payload["reconciled"] = true
	transition.Payload["has_error"] = false
	transition.Payload["last_time"] = recentLast
	m = push(m, transition)

	sessions := m.liveSessions(now)
	for _, s := range sessions {
		if s.ID == "recovered" {
			return
		}
	}
	t.Fatalf("reconciled working session with recent last_time should be live, got %+v (attention=%+v)", sessions, m.attention["recovered"])
}

// TestIdleTransitionKeepsPublicationTimeSeparateFromStateSince is the
// regression test for Codex review finding F1: the transition's event.Time
// is when it was published (arrival order, what the timeline appends by),
// while its payload's "since" carries the honest, possibly much older,
// state_since. Collapsing the two made a restart's historical idle
// transitions show a stale timestamp on what is, positionally, the newest
// row in the timeline.
func TestIdleTransitionKeepsPublicationTimeSeparateFromStateSince(t *testing.T) {
	m := newTestModel()
	now := t0.Add(10 * time.Minute)
	historicalSince := t0.Add(2 * time.Minute)
	transition := event.Event{
		ID: "idle-1", Time: now, Source: "firehose", SessionID: "s1",
		Category: event.CategoryMeta, Name: "state.transition", Summary: "idle",
		Payload: map[string]any{
			"state": "idle", "reason": "", "has_error": false,
			"since": historicalSince.UTC().Format(time.RFC3339Nano),
		},
	}
	m = push(m, transition)
	if len(m.events) != 1 || !m.events[0].Time.Equal(now) {
		t.Fatalf("timeline event should carry the publication time %v, got %+v", now, m.events)
	}
	got := m.attention["s1"]
	if !got.Since.Equal(historicalSince) {
		t.Errorf("attention Since should be the honest state_since %v, got %v", historicalSince, got.Since)
	}
}

// TestErrorOnlyTransitionDoesNotResetDwellSince is the regression test for
// Codex review finding F2: a transition that only flips has_error (the
// engine leaves state_since untouched, per Transition in attention.go) must
// not restart the viewer's dwell clock. Before the fix, noteAttention
// assigned every transition's own ev.Time to Since, so an error arriving ten
// minutes into an unanswered needs_input made the header look like the
// session had just started waiting.
func TestErrorOnlyTransitionDoesNotResetDwellSince(t *testing.T) {
	m := newTestModel()
	firstSince := t0.Add(time.Second)
	first := event.Event{
		ID: "transition-1", Time: firstSince, Source: "firehose", SessionID: "s1",
		Category: event.CategoryMeta, Name: "state.transition", Summary: stateNeedsInput,
		Payload: map[string]any{
			"state": stateNeedsInput, "reason": "approve Bash", "has_error": false,
			"since": firstSince.UTC().Format(time.RFC3339Nano),
		},
	}
	m = push(m, first)
	if got := m.attention["s1"].Since; !got.Equal(firstSince) {
		t.Fatalf("setup: want Since %v, got %v", firstSince, got)
	}

	errAt := firstSince.Add(10 * time.Minute)
	errOnly := event.Event{
		ID: "transition-2", Time: errAt, Source: "firehose", SessionID: "s1",
		Category: event.CategoryMeta, Name: "state.transition", Summary: stateNeedsInput,
		Payload: map[string]any{
			"state": stateNeedsInput, "reason": "approve Bash", "has_error": true,
			"since": firstSince.UTC().Format(time.RFC3339Nano),
		},
	}
	m = push(m, errOnly)
	got := m.attention["s1"]
	if !got.Since.Equal(firstSince) {
		t.Errorf("error-only transition reset Since: want %v, got %v", firstSince, got.Since)
	}
	if !got.HasError {
		t.Errorf("has_error should now be true, got %+v", got)
	}
}

// TestErrorOnlyTransitionFromOlderDaemonDoesNotResetDwellSince is the
// regression test for Codex review finding F3: a transition from a daemon
// old enough to predate the "since" payload key (wave 3) carries no since at
// all, so noteAttention falls back to the event's own Time. That fallback is
// correct for a genuine state change (the existing fallback coverage, via
// stateTransition() in other tests, only ever exercises that case) but wrong
// for an error-only transition — same state, same reason, only has_error
// flips — where ev.Time is the error's own arrival, not the state's start.
// When since is absent and state and reason are unchanged from the prior
// entry, the prior state_since must be kept.
func TestErrorOnlyTransitionFromOlderDaemonDoesNotResetDwellSince(t *testing.T) {
	m := newTestModel()
	firstSince := t0.Add(time.Second)
	first := event.Event{
		ID: "transition-1", Time: firstSince, Source: "firehose", SessionID: "s1",
		Category: event.CategoryMeta, Name: "state.transition", Summary: stateNeedsInput,
		Payload: map[string]any{
			"state": stateNeedsInput, "reason": "approve Bash", "has_error": false,
			// No "since" key at all: an older daemon that predates it.
		},
	}
	m = push(m, first)
	if got := m.attention["s1"].Since; !got.Equal(firstSince) {
		t.Fatalf("setup: want Since %v, got %v", firstSince, got)
	}

	errAt := firstSince.Add(10 * time.Minute)
	errOnly := event.Event{
		ID: "transition-2", Time: errAt, Source: "firehose", SessionID: "s1",
		Category: event.CategoryMeta, Name: "state.transition", Summary: stateNeedsInput,
		Payload: map[string]any{
			"state": stateNeedsInput, "reason": "approve Bash", "has_error": true,
			// Still no "since" key.
		},
	}
	m = push(m, errOnly)
	got := m.attention["s1"]
	if !got.Since.Equal(firstSince) {
		t.Errorf("error-only transition from an older daemon reset Since: want %v, got %v", firstSince, got.Since)
	}
	if !got.HasError {
		t.Errorf("has_error should now be true, got %+v", got)
	}
}

// TestErrorRecoveryFromOlderDaemonResetsDwellSince is the regression test for
// Codex review round-4 finding F2: the round-3 fix (above) preserves Since
// whenever state and reason are unchanged from the prior entry, with no
// payload "since" at all. That is right for an error being newly raised, but
// wrong for error *recovery* — working, then an error, then activity resumes
// — which has the exact same state ("working") and reason ("") on the way in
// and the way out, per Transition in attention.go: an activity event with
// prev.HasError true resets Since to the recovery time even though the
// primary state does not change. An older daemon with no "since" key must
// not make that recovery look like it kept dwelling in the pre-error wait;
// only a rising has_error edge (false -> true) may keep the prior Since.
func TestErrorRecoveryFromOlderDaemonResetsDwellSince(t *testing.T) {
	m := newTestModel()
	workingSince := t0
	working := event.Event{
		ID: "transition-1", Time: workingSince, Source: "firehose", SessionID: "s1",
		Category: event.CategoryMeta, Name: "state.transition", Summary: stateWorking,
		Payload: map[string]any{
			"state": stateWorking, "reason": "", "has_error": false,
			// No "since" key at all: an older daemon that predates it.
		},
	}
	m = push(m, working)
	if got := m.attention["s1"].Since; !got.Equal(workingSince) {
		t.Fatalf("setup: want Since %v, got %v", workingSince, got)
	}

	errAt := workingSince.Add(time.Minute)
	errOnly := event.Event{
		ID: "transition-2", Time: errAt, Source: "firehose", SessionID: "s1",
		Category: event.CategoryMeta, Name: "state.transition", Summary: stateWorking,
		Payload: map[string]any{
			"state": stateWorking, "reason": "", "has_error": true,
		},
	}
	m = push(m, errOnly)
	if got := m.attention["s1"]; !got.Since.Equal(workingSince) || !got.HasError {
		t.Fatalf("setup: want error raised with Since preserved at %v, got %+v", workingSince, got)
	}

	recoverAt := errAt.Add(2 * time.Minute)
	recovered := event.Event{
		ID: "transition-3", Time: recoverAt, Source: "firehose", SessionID: "s1",
		Category: event.CategoryMeta, Name: "state.transition", Summary: stateWorking,
		Payload: map[string]any{
			"state": stateWorking, "reason": "", "has_error": false,
			// Still no "since" key.
		},
	}
	m = push(m, recovered)
	got := m.attention["s1"]
	if got.HasError {
		t.Errorf("has_error should be cleared on recovery, got %+v", got)
	}
	if !got.Since.Equal(recoverAt) {
		t.Errorf("recovery should reset Since to the recovery time (%v), not keep the stale pre-error dwell: got %v", recoverAt, got.Since)
	}
}

// TestReconciledTransitionRestoresIdentityForWorkspaceCell is the regression
// test for Codex review finding F3: a session recovered purely from a
// reconciliation snapshot (its own events long scrolled out of the bounded
// recovery ring, and no prior attention entry to carry identity forward
// from) must still land in its real workspace cell, not an unknown one.
// noteAttention must consume the event's own Agent/Repo/CWD and the
// payload's source, not only carry forward whatever the (here: nonexistent)
// previous attention entry had.
func TestReconciledTransitionRestoresIdentityForWorkspaceCell(t *testing.T) {
	now := t0.Add(30 * 24 * time.Hour)
	m := newTestModel()
	m.now = func() time.Time { return now }

	recentLast := now.Add(-time.Minute)
	transition := event.Event{
		ID: "", Time: now.Add(-48 * time.Hour), Source: "firehose", SessionID: "recovered",
		Agent: "claude", Repo: "org/repo", CWD: "/home/me/dev/repo",
		Category: event.CategoryMeta, Name: "state.transition", Summary: "",
		Payload: map[string]any{
			"state": stateWorking, "reason": "", "reconciled": true,
			"has_error": false, "last_time": recentLast, "source": "claude-code",
		},
	}
	m = push(m, transition)

	sessions := m.liveSessions(now)
	for _, s := range sessions {
		if s.ID == "recovered" {
			if s.Where != "org/repo" {
				t.Errorf("workspace cell = %q, want %q", s.Where, "org/repo")
			}
			if s.Label != "claude" {
				t.Errorf("agent label = %q, want %q", s.Label, "claude")
			}
			return
		}
	}
	t.Fatalf("reconciled session should be live and placed in its own workspace cell, got %+v (attention=%+v)", sessions, m.attention["recovered"])
}

func TestPauseHoldsStreamAndCountsUnread(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryShell, "first event"))
	m = key(m, "space") // pause
	if !m.Paused() {
		t.Fatal("space should pause")
	}
	m = push(m, mkEv(2, event.CategoryShell, "arrived while paused"))
	view := m.View()
	if strings.Contains(view, "arrived while paused") {
		t.Error("paused view should not show new events")
	}
	if !strings.Contains(view, "1 new") {
		t.Errorf("paused view should show unread count:\n%s", view)
	}
	m = key(m, "space") // resume
	view = m.View()
	if !strings.Contains(view, "arrived while paused") {
		t.Error("resume should reveal held events")
	}
}

func TestCategoryFilterCyclesAndNarrows(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryShell, "shell event here"))
	m = push(m, mkEv(2, event.CategoryPrompt, "prompt event here"))
	// cycle category filter until it lands on shell
	found := false
	for range 12 {
		m = key(m, "f")
		if m.Filter().Category == event.CategoryShell {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("could not cycle to shell filter")
	}
	view := m.View()
	if strings.Contains(view, "prompt event here") {
		t.Error("filtered view should hide other categories")
	}
	if !strings.Contains(view, "shell event here") {
		t.Error("filtered view should keep matching category")
	}
}

func TestDetailPaneShowsPayload(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryTool, "tool call"))
	m = key(m, "enter")
	view := m.View()
	if !strings.Contains(view, "k  v") {
		t.Errorf("detail should tabulate the payload:\n%s", view)
	}
	m = key(m, "esc")
	if strings.Contains(m.View(), "k  v") {
		t.Error("esc should close detail")
	}
}

func TestSearchFiltersBySummary(t *testing.T) {
	m := newTestModel()
	m = push(m, mkEv(1, event.CategoryShell, "ran: make build"))
	m = push(m, mkEv(2, event.CategoryShell, "ran: go vet"))
	m = key(m, "/")
	for _, r := range "vet" {
		m = key(m, string(r))
	}
	m = key(m, "enter")
	view := m.View()
	if strings.Contains(view, "make build") || !strings.Contains(view, "go vet") {
		t.Errorf("search filter wrong:\n%s", view)
	}
}

func TestDistinctBurstRemainsVisibleInView(t *testing.T) {
	m := newTestModel()
	for i := range 4 {
		ev := mkEv(0, event.CategoryShell, "ran: ls")
		ev.ID = fmt.Sprintf("b%d", i)
		ev.Time = t0.Add(time.Duration(i) * 100 * time.Millisecond)
		m = push(m, ev)
	}
	view := m.View()
	if strings.Contains(view, "×4") {
		t.Errorf("distinct activity must not collapse:\n%s", view)
	}
}

func TestPreloadShowsHistory(t *testing.T) {
	m := newTestModel()
	m = m.Preload([]event.Event{mkEv(1, event.CategoryShell, "historic event")})
	if !strings.Contains(m.View(), "historic event") {
		t.Error("preloaded history should render")
	}
}

func TestPreloadSessionsShowsProjectedAttention(t *testing.T) {
	m := newTestModel()
	m.now = func() time.Time { return t0.Add(time.Minute) }
	m = m.PreloadSessions([]SessionAttention{{
		ID: "waiting", State: "needs_input", Since: t0, Reason: "approve Bash",
	}})
	view := m.View()
	if !strings.Contains(view, "NEEDS YOU · 1") || !strings.Contains(view, "approve Bash") {
		t.Fatalf("projected attention missing:\n%s", view)
	}
}

func TestNeedsYouCountIgnoresStaleSession(t *testing.T) {
	now := t0.Add(30 * 24 * time.Hour)
	m := newTestModel()
	m.now = func() time.Time { return now }
	stale := now.Add(-25 * time.Hour)
	m = m.PreloadSessions([]SessionAttention{{
		ID: "ghost", State: stateNeedsInput, Since: stale, Reason: "approve Bash",
	}})
	if got := m.needsYouCount(); got != 0 {
		t.Fatalf("needsYouCount = %d, want 0 for a needs_input session dead for 25h", got)
	}
	if view := m.View(); strings.Contains(view, "NEEDS YOU") {
		t.Fatalf("header should not show a stale needs_input session:\n%s", view)
	}

	fresh := now.Add(-time.Minute)
	m = m.PreloadSessions([]SessionAttention{{
		ID: "waiting", State: stateNeedsInput, Since: fresh, Reason: "approve Bash",
	}})
	if got := m.needsYouCount(); got != 1 {
		t.Fatalf("needsYouCount = %d, want 1 for a fresh needs_input session", got)
	}
	if view := m.View(); !strings.Contains(view, "NEEDS YOU · 1") {
		t.Fatalf("header should show a fresh needs_input session:\n%s", view)
	}
}

// TestNeedsYouCountRefreshesOnOrdinaryActivity guards against attention.Last
// only ever being set at preload/transition time. A session can sit in
// needs_input for a long time while still emitting ordinary events (a Codex
// token_count meta event, a shell event) that never change its state; those
// events are real evidence the session is alive and must refresh Last the
// same way liveSessions already does by scanning m.events, so the header
// count does not disagree with the band/workspace views about what is live.
func TestNeedsYouCountRefreshesOnOrdinaryActivity(t *testing.T) {
	now := t0.Add(30 * 24 * time.Hour)
	m := newTestModel()
	m.now = func() time.Time { return now }
	stale := now.Add(-25 * time.Hour)
	m = m.PreloadSessions([]SessionAttention{{
		ID: "s1", State: stateNeedsInput, Since: stale, Last: stale, Reason: "approve Bash",
	}})
	if got := m.needsYouCount(); got != 0 {
		t.Fatalf("needsYouCount = %d, want 0 before fresh activity", got)
	}

	recent := mkEv(1, event.CategoryMeta, "token_count")
	recent.Time = now.Add(-time.Minute)
	m = push(m, recent)

	if got := m.needsYouCount(); got != 1 {
		t.Fatalf("needsYouCount = %d, want 1 after a recent non-transition event", got)
	}
	if view := m.View(); !strings.Contains(view, "NEEDS YOU · 1") {
		t.Fatalf("header should reflect fresh activity on a needs_input session:\n%s", view)
	}
}

// TestAttentionIdentitySurvivesRingEviction is the regression test for Codex
// review finding F2: normal state.transition frames carry no agent/workspace
// identity (only a reconciliation snapshot stamps that), and noteAttention's
// ordinary-event branch used to update only Last, never Source/Agent/Where.
// A live session's identity therefore lived only in its own events in the
// 20,000-event ring; once every one of those events aged out (pushed out by
// unrelated traffic), the session fell back to whatever identity its
// attention entry carried -- which was empty -- landing it in an unknown
// workspace cell even though it never stopped being tracked.
func TestAttentionIdentitySurvivesRingEviction(t *testing.T) {
	now := t0.Add(time.Hour)
	m := newTestModel()
	m.now = func() time.Time { return now }

	// The attention entry is created by a transition first, exactly as it
	// would be live (an ordinary event never creates one) -- and, like every
	// normal transition, it carries no identity.
	m = push(m, stateTransition(1, "s1", stateNeedsInput, "approve Bash"))

	// An ordinary session event now carries the session's real identity.
	identified := mkEv(2, event.CategoryTool, "ran a tool")
	identified.SessionID = "s1"
	identified.Repo = "org/repo"
	identified.CWD = "/home/me/dev/repo"
	m = push(m, identified)

	// Evict every one of s1's own events from the ring with unrelated
	// traffic from another session.
	for i := 0; i < maxEvents+10; i++ {
		filler := mkEv(3, event.CategoryShell, "noise")
		filler.ID = fmt.Sprintf("filler-%d", i)
		filler.SessionID = "other"
		m = push(m, filler)
	}
	for _, ev := range m.events {
		if ev.SessionID == "s1" {
			t.Fatalf("test setup: s1's own events should all have left the ring")
		}
	}

	sessions := m.liveSessions(now)
	for _, s := range sessions {
		if s.ID == "s1" {
			if s.Where != "org/repo" {
				t.Errorf("workspace = %q, want %q (identity should survive ring eviction)", s.Where, "org/repo")
			}
			return
		}
	}
	t.Fatalf("s1 should still be live after its own events left the ring, got %+v", sessions)
}

func TestQuitKey(t *testing.T) {
	m := newTestModel()
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	if cmd == nil {
		t.Fatal("q should quit")
	}
	if msg := cmd(); msg != tea.Quit() {
		t.Errorf("expected quit msg, got %#v", msg)
	}
}

func TestNeedsYouInHeader(t *testing.T) {
	m := newTestModel()
	m.now = func() time.Time { return t0.Add(time.Minute) }
	m = push(m, mkEv(1, event.CategoryTool, "working"))
	if strings.Contains(m.View(), "NEEDS YOU") {
		t.Fatal("working session should not show NEEDS YOU")
	}
	m = push(m, stateTransition(2, "s1", "needs_input", "Claude needs your permission to use Bash"))
	view := m.View()
	if !strings.Contains(view, "NEEDS YOU · 1") {
		t.Errorf("expected NEEDS YOU indicator:\n%s", view)
	}
	if !strings.Contains(view, "Claude needs your permission to use Bash") {
		t.Errorf("expected reason in header:\n%s", view)
	}
	m = push(m, stateTransition(3, "s1", "working", ""))
	if strings.Contains(m.View(), "NEEDS YOU") {
		t.Error("activity should clear NEEDS YOU")
	}
}

func TestAttentionMapStaysBounded(t *testing.T) {
	m := newTestModel()
	const n = 500
	for i := range n {
		working := mkEv(i*2, event.CategoryTool, "working")
		working.SessionID = fmt.Sprintf("session-%d", i)
		m = push(m, working)
		done := mkEv(i*2+1, event.CategorySession, "ended")
		done.SessionID = working.SessionID
		done.Name = "Stop"
		m = push(m, done)
	}
	if len(m.attention) > 32 {
		t.Fatalf("attention map grew unbounded: %d entries", len(m.attention))
	}
	// Active needs-input attention must still be retained.
	m = push(m, stateTransition(n*2, "active-needs-you", "needs_input", "needs approval"))
	if got := m.attention["active-needs-you"]; got.State == "" {
		t.Fatal("active needs-input attention was not retained")
	}
}

func TestNeedsYouReasonStripsControlSequences(t *testing.T) {
	m := newTestModel()
	m.now = func() time.Time { return t0.Add(time.Minute) }
	m = push(m, stateTransition(1, "s1", "needs_input", "ok\x1b[31mALERT\x1b[0m\x07"+strings.Repeat("x", 200)))
	header := m.viewHeader()
	if strings.Contains(header, "\x1b") || strings.Contains(header, "\x07") {
		t.Fatalf("header leaked control sequences:\n%q", header)
	}
	if !strings.Contains(header, "NEEDS YOU · 1") {
		t.Fatalf("expected NEEDS YOU indicator:\n%s", header)
	}
	if !strings.Contains(header, "okALERT") {
		t.Fatalf("expected sanitized reason in header:\n%s", header)
	}
}
