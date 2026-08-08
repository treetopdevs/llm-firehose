package store

import (
	"fmt"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func ev(id, source, sess string, cat event.Category, name, summary string, ts time.Time) event.Event {
	return event.Event{
		ID: id, Time: ts, Source: source, SessionID: sess,
		Category: cat, Name: name, Severity: event.SeverityInfo, Summary: summary,
	}
}

var t0 = time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)

func TestRingEvictsOldest(t *testing.T) {
	r := NewRing(3)
	for i := range 5 {
		r.Add(ev(fmt.Sprintf("e%d", i), "generic", "s", event.CategoryMeta, "n", "x", t0.Add(time.Duration(i)*time.Second)))
	}
	snap := r.Snapshot()
	if len(snap) != 3 {
		t.Fatalf("len = %d, want 3", len(snap))
	}
	if snap[0].ID != "e2" || snap[2].ID != "e4" {
		t.Errorf("wrong window: %s..%s", snap[0].ID, snap[2].ID)
	}
}

func TestFilterDimensions(t *testing.T) {
	r := NewRing(100)
	r.Add(ev("e1", "claude-code", "s1", event.CategoryShell, "PostToolUse:Bash", "ran: go test", t0))
	r.Add(ev("e2", "codex", "s2", event.CategoryPrompt, "user_message", `prompt: "hello"`, t0.Add(time.Second)))
	e3 := ev("e3", "claude-code", "s1", event.CategoryError, "err", "boom", t0.Add(2*time.Second))
	e3.Severity = event.SeverityError
	e3.CWD = "/repo/a"
	r.Add(e3)

	cases := []struct {
		name string
		f    Filter
		want []string
	}{
		{"none", Filter{}, []string{"e1", "e2", "e3"}},
		{"source", Filter{Source: "codex"}, []string{"e2"}},
		{"session", Filter{SessionID: "s1"}, []string{"e1", "e3"}},
		{"category", Filter{Category: event.CategoryShell}, []string{"e1"}},
		{"severity min", Filter{MinSeverity: event.SeverityError}, []string{"e3"}},
		{"cwd", Filter{CWD: "/repo/a"}, []string{"e3"}},
		{"text", Filter{Text: "go test"}, []string{"e1"}},
		{"text case-insensitive", Filter{Text: "HELLO"}, []string{"e2"}},
		{"combined", Filter{Source: "claude-code", Category: event.CategoryError}, []string{"e3"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := r.Filtered(tc.f)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d events, want %d: %+v", len(got), len(tc.want), got)
			}
			for i, id := range tc.want {
				if got[i].ID != id {
					t.Errorf("[%d] = %s, want %s", i, got[i].ID, id)
				}
			}
		})
	}
}

func TestCoalesceKeepsDistinctBursts(t *testing.T) {
	r := NewRing(100)
	// five identical shell events within 2s, then a different one
	for i := range 5 {
		r.Add(ev(fmt.Sprintf("b%d", i), "codex", "s1", event.CategoryShell, "exec_command_end", "ran: ls", t0.Add(time.Duration(i)*200*time.Millisecond)))
	}
	r.Add(ev("other", "codex", "s1", event.CategoryPrompt, "user_message", "hi", t0.Add(5*time.Second)))

	rows := Coalesce(r.Snapshot(), 2*time.Second)
	if len(rows) != 6 {
		t.Fatalf("got %d rows, want all distinct observations: %+v", len(rows), rows)
	}
}

func TestCoalesceCorrelatedObservationsButNotPhases(t *testing.T) {
	start := ev("start", "codex", "s1", event.CategoryShell, "PreToolUse", "start", t0)
	start.TurnID, start.CallID = "t1", "c1"
	start.Payload = map[string]any{"phase": "start", "tool_name": "exec_command"}
	rolloutEnd := ev("rollout", "codex", "s1", event.CategoryShell, "function_call_output", "end", t0.Add(time.Second))
	rolloutEnd.TurnID, rolloutEnd.CallID = "t1", "c1"
	rolloutEnd.Payload = map[string]any{"phase": "end", "tool_name": "exec_command"}
	hookEnd := ev("hook", "codex", "s1", event.CategoryShell, "PostToolUse", "end", t0.Add(2*time.Second))
	hookEnd.TurnID, hookEnd.CallID = "t1", "c1"
	hookEnd.Payload = map[string]any{"phase": "end", "tool_name": "exec_command"}
	rows := Coalesce([]event.Event{start, rolloutEnd, hookEnd}, 5*time.Second)
	if len(rows) != 2 || rows[0].Event.ID != "start" || rows[1].Count != 2 {
		t.Fatalf("correlated rows = %+v", rows)
	}
}

func TestCoalesceRespectsGap(t *testing.T) {
	r := NewRing(100)
	r.Add(ev("a", "codex", "s1", event.CategoryShell, "exec_command_end", "ran: ls", t0))
	r.Add(ev("b", "codex", "s1", event.CategoryShell, "exec_command_end", "ran: ls", t0.Add(10*time.Second)))
	rows := Coalesce(r.Snapshot(), 2*time.Second)
	if len(rows) != 2 {
		t.Fatalf("events beyond window must not merge, got %d rows", len(rows))
	}
}
