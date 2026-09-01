package tui

import (
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"agentfirehose/internal/event"
)

func stateTransitionAt(at time.Time, sessionID, state, reason string) event.Event {
	ev := stateTransition(0, sessionID, state, reason)
	ev.ID = fmt.Sprintf("transition-%s-%d", sessionID, at.UnixNano())
	ev.Time = at
	return ev
}

func TestSparklineSharesScaleAndBlanksZero(t *testing.T) {
	if got := sparkline([]int{0, 1, 2, 4}, 4); got != " ▂▄█" {
		t.Fatalf("sparkline = %q", got)
	}
	if got := sparkline([]int{3}, 3); got != "█" {
		t.Fatalf("max bucket should fill: %q", got)
	}
	if got := sparkline([]int{0, 0}, 0); got != "  " {
		t.Fatalf("all-zero = %q", got)
	}
}

func TestFormatAgeUsesOneUnit(t *testing.T) {
	cases := map[time.Duration]string{
		-time.Second:     "0s",
		12 * time.Second: "12s",
		3 * time.Minute:  "3m",
		2 * time.Hour:    "2h",
		49 * time.Hour:   "2d",
	}
	for d, want := range cases {
		if got := formatAge(d); got != want {
			t.Errorf("formatAge(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestLiveSessionsBucketsOrdersAndDropsQuiet(t *testing.T) {
	now := t0.Add(10 * time.Minute)
	m := newTestModel()
	m.now = func() time.Time { return now }
	// s1: two events 40s ago and one 10s ago → buckets[8]=2, buckets[9]=1.
	for i, age := range []time.Duration{40 * time.Second, 40 * time.Second, 10 * time.Second} {
		ev := mkEv(i, event.CategoryTool, "s1 work")
		ev.Time = now.Add(-age)
		m = push(m, ev)
	}
	// s2: one event 2m ago, and the engine says it needs input.
	asked := mkEv(10, event.CategoryPermission, "s2 asked")
	asked.SessionID, asked.Source, asked.Agent = "s2", "codex", "codex"
	asked.Time = now.Add(-2 * time.Minute)
	m = push(m, asked)
	m = push(m, stateTransitionAt(now.Add(-90*time.Second), "s2", stateNeedsInput, "approve Bash"))
	// s3: last seen 20m ago → not live.
	old := mkEv(20, event.CategoryTool, "s3 old")
	old.SessionID = "s3"
	old.Time = now.Add(-20 * time.Minute)
	m = push(m, old)
	// s4: nothing in the ring, but preloaded engine attention says working.
	// s5 and s6 carry engine states too old to believe: a permission prompt
	// from two days ago and a tool call open for 40 minutes.
	m = m.PreloadSessions([]SessionAttention{
		{ID: "s4", Source: "opencode", State: stateWorking, Since: now.Add(-time.Minute)},
		{ID: "s5", Source: "codex", State: stateNeedsInput, Since: now.Add(-48 * time.Hour), Reason: "stale"},
		{ID: "s6", Source: "codex", State: stateWorking, Since: now.Add(-40 * time.Minute)},
	})
	ghost := mkEv(30, event.CategoryTool, "s6 old tool")
	ghost.SessionID = "s6"
	ghost.Time = now.Add(-40 * time.Minute)
	m = push(m, ghost)

	got := m.liveSessions(now)
	ids := make([]string, len(got))
	for i, s := range got {
		ids[i] = s.ID
	}
	if strings.Join(ids, ",") != "s2,s1,s4" {
		t.Fatalf("order = %v", ids)
	}
	s2, s1, s4 := got[0], got[1], got[2]
	if s2.State != stateNeedsInput || s2.Reason != "approve Bash" || s2.Label != "codex" {
		t.Errorf("s2 = %+v", s2)
	}
	if s1.Buckets[8] != 2 || s1.Buckets[9] != 1 || s1.Summary != "s1 work" || s1.Label != "claude" {
		t.Errorf("s1 = %+v", s1)
	}
	if s4.Label != "opencode" || s4.State != stateWorking {
		t.Errorf("s4 = %+v", s4)
	}
}

func laneEvent(now time.Time, age time.Duration, call, phase string) event.Event {
	ev := mkEv(int(age/time.Millisecond), event.CategoryShell, "x")
	ev.Time = now.Add(-age)
	ev.CallID = call
	if phase != "" {
		ev.Payload = map[string]any{"phase": phase, "tool_name": "Bash"}
	}
	return ev
}

func TestBuildLanesMarksEventsSpansAndFlags(t *testing.T) {
	now := t0.Add(time.Hour)
	window, width := time.Minute, 60 // one second per cell
	evs := []event.Event{
		laneEvent(now, 30*time.Second, "c1", "start"),
		laneEvent(now, 20*time.Second, "c1", "end"),
		laneEvent(now, 10*time.Second, "c2", "start"), // never ends → runs to now
	}
	failed := laneEvent(now, 5*time.Second, "", "")
	failed.Severity = event.SeverityError
	evs = append(evs, failed, stateTransitionAt(now.Add(-2*time.Second), "s1", stateNeedsInput, "approve"))

	lanes := buildLanes(evs, []sessionInfo{{ID: "s1"}}, now, window, width)
	if len(lanes) != 1 || len(lanes[0].Cells) != width {
		t.Fatalf("lanes = %+v", lanes)
	}
	c := lanes[0].Cells
	if c[29].Events != 1 || c[39].Events != 1 {
		t.Errorf("start/end ticks missing: %+v %+v", c[29], c[39])
	}
	for i := 29; i <= 39; i++ {
		if !c[i].Span {
			t.Errorf("cell %d should be inside the c1 span", i)
		}
	}
	if c[28].Span || c[40].Span {
		t.Errorf("span leaked outside c1: %+v %+v", c[28], c[40])
	}
	for i := 49; i < width; i++ {
		if !c[i].Span {
			t.Errorf("unfinished c2 should run to now at cell %d", i)
		}
	}
	if !c[54].Error {
		t.Errorf("error flag missing: %+v", c[54])
	}
	if !c[57].Needs || c[57].Events != 0 {
		t.Errorf("needs flag missing or transition counted as activity: %+v", c[57])
	}
}

func TestBuildLanesClipsSpansToWindow(t *testing.T) {
	now := t0.Add(time.Hour)
	evs := []event.Event{
		laneEvent(now, 90*time.Second, "c9", "start"), // before the window
		laneEvent(now, 50*time.Second, "c9", "end"),
		laneEvent(now, 2*time.Minute, "", ""), // before the window, no span
	}
	lanes := buildLanes(evs, []sessionInfo{{ID: "s1"}}, now, time.Minute, 60)
	c := lanes[0].Cells
	for i := 0; i <= 9; i++ {
		if !c[i].Span {
			t.Errorf("clipped span should start at the window edge, cell %d", i)
		}
	}
	if c[10].Span {
		t.Errorf("span ran past its end: %+v", c[10])
	}
	total := 0
	for _, cell := range c {
		total += cell.Events
	}
	if total != 1 || c[9].Events != 1 {
		t.Errorf("only the end event is inside the window: total=%d c[9]=%+v", total, c[9])
	}
}

func runeIndex(s, sub string) int {
	i := strings.Index(s, sub)
	if i < 0 {
		return -1
	}
	return utf8.RuneCountInString(s[:i])
}

func TestLaneAxisLabelsRoundTimes(t *testing.T) {
	now := time.Date(2026, 7, 2, 10, 5, 0, 0, time.UTC)
	axis := laneAxis(now, 5*time.Minute, 75) // 4s per cell → whole-minute labels every 15 cells
	if n := utf8.RuneCountInString(axis); n != 75 {
		t.Fatalf("axis width = %d: %q", n, axis)
	}
	want := "╷" + now.Add(-3*time.Minute).Local().Format("15:04")
	if at := runeIndex(axis, want); at != 30 {
		t.Errorf("%q at cell %d, want 30:\n%q", want, at, axis)
	}
	if strings.Contains(axis, now.Local().Format("15:04")) {
		t.Errorf("now sits past the right edge and must not be labelled:\n%q", axis)
	}

	fine := laneAxis(now, time.Minute, 60) // 1s per cell → 10s labels with seconds
	want = "╷" + now.Add(-30*time.Second).Local().Format("15:04:05")
	if at := runeIndex(fine, want); at != 30 {
		t.Errorf("%q at cell %d, want 30:\n%q", want, at, fine)
	}
}

func TestAttentionKeepsLiveStatesDropsDoneAndStaysBounded(t *testing.T) {
	m := newTestModel()
	m = push(m, stateTransition(1, "s1", stateWorking, ""))
	if m.attention["s1"].State != stateWorking {
		t.Fatalf("working state not retained: %+v", m.attention)
	}
	m = push(m, stateTransition(2, "s1", stateDone, ""))
	if _, ok := m.attention["s1"]; ok {
		t.Fatal("done session should leave the attention map")
	}
	m = push(m, stateTransition(3, "urgent", stateNeedsInput, "approve"))
	for i := range 3 * attentionCap {
		m = push(m, stateTransition(10+i, fmt.Sprintf("w%d", i), stateWorking, ""))
	}
	if len(m.attention) > attentionCap {
		t.Fatalf("attention map grew to %d", len(m.attention))
	}
	if m.attention["urgent"].State != stateNeedsInput {
		t.Fatal("needs-input attention must survive eviction")
	}
}
