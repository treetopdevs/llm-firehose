package procwatch

import (
	"context"
	"sync"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

// fakeLister is mutated by the test while the watcher polls it, so access is
// locked.
type fakeLister struct {
	mu    sync.Mutex
	procs []Process
}

func (f *fakeLister) List() ([]Process, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.procs, nil
}

func (f *fakeLister) set(procs []Process) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.procs = procs
}

func collect(ch <-chan event.Event, n int, t *testing.T) []event.Event {
	t.Helper()
	var got []event.Event
	deadline := time.After(2 * time.Second)
	for len(got) < n {
		select {
		case ev := <-ch:
			got = append(got, ev)
		case <-deadline:
			t.Fatalf("collected %d events, want %d", len(got), n)
		}
	}
	return got
}

func TestStartAndStopEvents(t *testing.T) {
	lister := &fakeLister{}
	w := NewWatcher(lister, 10*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := make(chan event.Event, 16)
	go w.Run(ctx, ch)

	time.Sleep(25 * time.Millisecond) // baseline poll with nothing running
	lister.set([]Process{{PID: 42, Command: "claude", Args: "claude --continue"}})

	got := collect(ch, 1, t)
	ev := got[0]
	if ev.Category != event.CategorySession || ev.Name != "agent-start" {
		t.Fatalf("start event wrong: %+v", ev)
	}
	if ev.Agent != "claude" || ev.Source != "procwatch" {
		t.Errorf("agent identity wrong: %+v", ev)
	}

	// still running: no duplicate
	select {
	case dup := <-ch:
		t.Fatalf("duplicate event while process still running: %+v", dup)
	case <-time.After(50 * time.Millisecond):
	}

	lister.set(nil)
	got = collect(ch, 1, t)
	if got[0].Name != "agent-stop" {
		t.Fatalf("stop event wrong: %+v", got[0])
	}
}

func TestUnknownBinariesIgnored(t *testing.T) {
	lister := &fakeLister{procs: []Process{{PID: 1, Command: "Safari", Args: "/Applications/Safari.app"}}}
	w := NewWatcher(lister, 10*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := make(chan event.Event, 16)
	go w.Run(ctx, ch)

	select {
	case ev := <-ch:
		t.Fatalf("unknown binary produced event: %+v", ev)
	case <-time.After(60 * time.Millisecond):
	}
}

func TestKnownAgentMatching(t *testing.T) {
	cases := []struct {
		comm string
		want string
	}{
		{"claude", "claude"},
		{"/opt/homebrew/bin/codex", "codex"},
		{"opencode", "opencode"},
		{"aider", "aider"},
		{"node", ""}, // bare runtime is not an agent
	}
	for _, tc := range cases {
		if got := matchAgent(tc.comm); got != tc.want {
			t.Errorf("matchAgent(%q) = %q, want %q", tc.comm, got, tc.want)
		}
	}
}
