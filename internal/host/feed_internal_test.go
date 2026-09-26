package host

import (
	"testing"
	"time"

	"agentfirehose/internal/capture"
)

// TestProjectedSessionTransitionsCarryHasErrorAndLastTime is the regression
// test for Codex review finding F3: the daemonless reconnect path's
// reconciliation snapshot must carry both HasError and LastTime, the same
// fields the daemon client's sessionTransitions carries (client package).
// Without has_error, a stream overflow on the daemonless path silently
// clears an unresolved error mark the next time a session reconciles.
// Without last_time, the TUI's freshness check (attentionFresh) has nothing
// but the bounded event-ring recovery window to go on, and can drop a
// genuinely active session from the header and workspace matrix once its
// activity falls outside that window.
func TestProjectedSessionTransitionsCarryHasErrorAndLastTime(t *testing.T) {
	last := time.Unix(2000, 0)
	sessions := []capture.Session{
		{ID: "s1", State: "working", StateSince: time.Unix(1000, 0), LastTime: last, HasError: true},
		{ID: "s2", State: "idle", StateSince: time.Unix(1000, 0), LastTime: last, HasError: false},
	}
	out := projectedSessionTransitions(sessions)
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}

	gotErr, ok := out[0].Payload["has_error"].(bool)
	if !ok || !gotErr {
		t.Errorf("s1 reconciled payload has_error = %v (ok=%v), want true", gotErr, ok)
	}
	gotErr, ok = out[1].Payload["has_error"].(bool)
	if !ok || gotErr {
		t.Errorf("s2 reconciled payload has_error = %v (ok=%v), want false", gotErr, ok)
	}

	gotLast, ok := out[0].Payload["last_time"].(time.Time)
	if !ok || !gotLast.Equal(last) {
		t.Errorf("s1 reconciled payload last_time = %v (ok=%v), want %v", gotLast, ok, last)
	}
}
