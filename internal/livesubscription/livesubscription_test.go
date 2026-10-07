package livesubscription

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func TestOpenReturnsCatchupHistoryAndSessionSnapshot(t *testing.T) {
	gap := event.Event{ID: "between-history-and-stream", Time: time.Unix(10, 0).UTC(), Source: "generic"}
	src := &script{recent: func(call int) []event.Event {
		if call == 1 {
			return nil
		}
		return []event.Event{gap}
	}}
	src.sessions = []Session{{ID: "s1", State: "needs_input", StateSince: time.Unix(10, 0).UTC()}}

	sub, err := Open(context.Background(), src, 500, 10000)
	if err != nil {
		t.Fatal(err)
	}
	if len(sub.History) != 1 || sub.History[0].ID != gap.ID {
		t.Fatalf("history = %+v", sub.History)
	}
	if len(sub.Sessions) != 1 || sub.Sessions[0].ID != "s1" || sub.Sessions[0].State != "needs_input" {
		t.Fatalf("sessions = %+v", sub.Sessions)
	}
}

func TestOpenSuppressesLiveDuplicatesOfHistory(t *testing.T) {
	seen := event.Event{ID: "already", Time: time.Unix(1, 0).UTC()}
	fresh := event.Event{ID: "fresh", Time: time.Unix(2, 0).UTC()}
	src := &script{recent: func(int) []event.Event { return []event.Event{seen} }}

	sub, err := Open(context.Background(), src, 500, 10000)
	if err != nil {
		t.Fatal(err)
	}
	src.emit(seen)
	src.emit(fresh)

	got := recv(t, sub.Events)
	if got.ID != fresh.ID {
		t.Fatalf("live event = %+v, want %s", got, fresh.ID)
	}
}

func TestOpenFailsAndCancelsWhenSessionSnapshotFails(t *testing.T) {
	src := &script{sessionFails: 1}
	_, err := Open(context.Background(), src, 500, 10000)
	if err == nil {
		t.Fatal("expected session snapshot failure")
	}
	waitUntil(t, func() bool { return src.cancelled() >= 1 })
}

func TestReconnectWaitsForSessionSnapshot(t *testing.T) {
	recovered := event.Event{ID: "recovered", Time: time.Unix(3, 0).UTC(), Source: "generic"}
	last := time.Unix(4, 0).UTC()
	since := time.Unix(5, 0).UTC()
	src := &script{recent: func(int) []event.Event { return nil }}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub, err := Open(ctx, src, 500, 10000)
	if err != nil {
		t.Fatal(err)
	}

	src.mu.Lock()
	src.sessionFails = 1
	src.recent = func(int) []event.Event { return []event.Event{recovered} }
	src.sessions = []Session{{
		ID: "attention", State: "working", StateSince: since, LastTime: last, HasError: true,
		Source: "claude-code", Agent: "claude", Repo: "org/repo", CWD: "/home/me/dev/repo",
		StateReason: "tool running",
	}}
	src.mu.Unlock()
	src.drop()

	waitUntil(t, func() bool { return src.failures.Load() >= 1 })
	select {
	case ev := <-sub.Events:
		t.Fatalf("emitted before session snapshot succeeded: %+v", ev)
	case <-time.After(40 * time.Millisecond):
	}

	got := recv(t, sub.Events)
	if got.ID != recovered.ID {
		t.Fatalf("recovered event = %+v", got)
	}
	transition := recv(t, sub.Events)
	if transition.Source != "firehose" || transition.Name != "state.transition" || transition.SessionID != "attention" {
		t.Fatalf("transition = %+v", transition)
	}
	if transition.Agent != "claude" || transition.Repo != "org/repo" || transition.CWD != "/home/me/dev/repo" {
		t.Fatalf("transition identity = %+v", transition)
	}
	if transition.Time != since || transition.Payload["state"] != "working" || transition.Payload["reason"] != "tool running" {
		t.Fatalf("transition state = %+v", transition)
	}
	if transition.Payload["has_error"] != true || transition.Payload["last_time"] != last || transition.Payload["source"] != "claude-code" || transition.Payload["reconciled"] != true {
		t.Fatalf("transition payload = %+v", transition.Payload)
	}
}

func recv(t *testing.T, events <-chan event.Event) event.Event {
	t.Helper()
	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatal("subscription closed")
		}
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for event")
		return event.Event{}
	}
}

func waitUntil(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type script struct {
	mu           sync.Mutex
	recent       func(call int) []event.Event
	calls        int
	sessions     []Session
	sessionFails int
	failures     atomic.Int32
	current      *pipe
	cancels      atomic.Int32
}

func (s *script) Recent(ctx context.Context, limit int) ([]event.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.recent == nil {
		return nil, nil
	}
	events := s.recent(s.calls)
	if limit > 0 && len(events) > limit {
		events = events[len(events)-limit:]
	}
	return events, nil
}

func (s *script) Subscribe(ctx context.Context) (<-chan event.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	pipe := newPipe()
	s.mu.Lock()
	s.current = pipe
	s.mu.Unlock()
	go func() {
		<-ctx.Done()
		s.cancels.Add(1)
		pipe.close()
	}()
	return pipe.events, nil
}

func (s *script) Sessions(ctx context.Context) ([]Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessionFails > 0 {
		s.sessionFails--
		s.failures.Add(1)
		return nil, errors.New("sessions unavailable")
	}
	out := make([]Session, len(s.sessions))
	copy(out, s.sessions)
	return out, nil
}

func (s *script) emit(ev event.Event) {
	s.mu.Lock()
	pipe := s.current
	s.mu.Unlock()
	pipe.events <- ev
}

func (s *script) drop() {
	s.mu.Lock()
	pipe := s.current
	s.mu.Unlock()
	pipe.close()
}

func (s *script) cancelled() int { return int(s.cancels.Load()) }

type pipe struct {
	events chan event.Event
	once   sync.Once
}

func newPipe() *pipe { return &pipe{events: make(chan event.Event, 4)} }

func (p *pipe) close() { p.once.Do(func() { close(p.events) }) }
