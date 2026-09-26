package client

import (
	"testing"
	"time"
)

// sessionTransitions synthesizes reconciliation events for a snapshot of
// sessions on stream reconnect. The TUI's noteAttention reads has_error
// straight off these payloads (the same field live engine transitions
// carry), so a session whose Session.HasError is true must not lose its
// workspace matrix error mark just because the client reconnected.
func TestSessionTransitionsCarryHasError(t *testing.T) {
	sessions := []Session{
		{ID: "s1", State: "working", StateSince: time.Unix(1000, 0), HasError: true},
		{ID: "s2", State: "idle", StateSince: time.Unix(1000, 0), HasError: false},
	}
	out := sessionTransitions(sessions)
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}
	got, ok := out[0].Payload["has_error"].(bool)
	if !ok || !got {
		t.Fatalf("s1 reconciled payload has_error = %v (ok=%v), want true", got, ok)
	}
	got, ok = out[1].Payload["has_error"].(bool)
	if !ok || got {
		t.Fatalf("s2 reconciled payload has_error = %v (ok=%v), want false", got, ok)
	}
}
