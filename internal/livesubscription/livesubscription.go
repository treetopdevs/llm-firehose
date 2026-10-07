// Package livesubscription is the viewer's Live Subscription: durable history,
// one live channel, and the session Projection, reconciled together after
// interruption.
package livesubscription

import (
	"context"
	"time"

	"agentfirehose/internal/event"
)

const (
	seenCapacity  = 20000
	retryInterval = 250 * time.Millisecond
)

// Session is the session Projection a Live Subscription reconciles.
type Session struct {
	ID          string
	Source      string
	Agent       string
	Repo        string
	CWD         string
	State       string
	StateSince  time.Time
	StateReason string
	LastTime    time.Time
	HasError    bool
}

// Source supplies the three reads a Live Subscription reconciles. The
// daemonless host and the HTTP client are the adapters.
type Source interface {
	Recent(ctx context.Context, limit int) ([]event.Event, error)
	Subscribe(ctx context.Context) (<-chan event.Event, error)
	Sessions(ctx context.Context) ([]Session, error)
}

// Subscription is a Live Subscription opened against one Source.
type Subscription struct {
	Events   <-chan event.Event
	History  []event.Event
	Sessions []Session
}

type live struct {
	events <-chan event.Event
	cancel context.CancelFunc
}

// Open returns history, the session snapshot, and a live channel together.
// A replacement channel is adopted only after history, the subscription, and
// the session snapshot have all succeeded.
func Open(ctx context.Context, source Source, initialLimit, reconcileLimit int) (Subscription, error) {
	seen := newSeen(seenCapacity)
	opened, pending, sessions, err := openBracket(ctx, source, initialLimit, seen)
	if err != nil {
		return Subscription{}, err
	}
	for _, ev := range pending {
		seen.add(ev.ID)
	}
	out := make(chan event.Event, 256)
	go pump(ctx, source, opened, reconcileLimit, seen, out)
	return Subscription{Events: out, History: pending, Sessions: sessions}, nil
}

func openBracket(ctx context.Context, source Source, limit int, seen *seenIDs) (live, []event.Event, []Session, error) {
	recovered, err := source.Recent(ctx, limit)
	if err != nil {
		return live{}, nil, nil, err
	}
	subCtx, cancel := context.WithCancel(ctx)
	events, err := source.Subscribe(subCtx)
	if err != nil {
		cancel()
		return live{}, nil, nil, err
	}
	catchup, err := source.Recent(ctx, limit)
	if err != nil {
		cancel()
		return live{}, nil, nil, err
	}
	sessions, err := source.Sessions(ctx)
	if err != nil {
		cancel()
		return live{}, nil, nil, err
	}
	combined := make([]event.Event, 0, len(recovered)+len(catchup))
	combined = append(combined, recovered...)
	combined = append(combined, catchup...)
	return live{events: events, cancel: cancel}, novel(combined, seen), sessions, nil
}

func pump(ctx context.Context, source Source, current live, reconcileLimit int, seen *seenIDs, out chan<- event.Event) {
	defer close(out)
	defer func() { current.cancel() }()
	for {
		for current.events != nil {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-current.events:
				if !ok {
					current.events = nil
					continue
				}
				if !forward(ctx, out, ev, seen) {
					return
				}
			}
		}
		current.cancel()
		for {
			if ctx.Err() != nil {
				return
			}
			next, pending, sessions, err := openBracket(ctx, source, reconcileLimit, seen)
			if err != nil {
				if ctx.Err() != nil || !sleep(ctx, retryInterval) {
					return
				}
				continue
			}
			delivered := true
			for _, ev := range pending {
				if !forward(ctx, out, ev, seen) {
					delivered = false
					break
				}
			}
			if delivered {
				for _, ev := range sessionTransitions(sessions) {
					if !send(ctx, out, ev) {
						delivered = false
						break
					}
				}
			}
			if !delivered {
				next.cancel()
				return
			}
			current = next
			break
		}
	}
}

func novel(events []event.Event, seen *seenIDs) []event.Event {
	out := make([]event.Event, 0, len(events))
	batch := make(map[string]bool, len(events))
	for _, ev := range events {
		if ev.ID != "" && (seen.has(ev.ID) || batch[ev.ID]) {
			continue
		}
		if ev.ID != "" {
			batch[ev.ID] = true
		}
		out = append(out, ev)
	}
	return out
}

func forward(ctx context.Context, out chan<- event.Event, ev event.Event, seen *seenIDs) bool {
	if ev.ID != "" && seen.has(ev.ID) {
		return true
	}
	if !send(ctx, out, ev) {
		return false
	}
	seen.add(ev.ID)
	return true
}

func send(ctx context.Context, out chan<- event.Event, ev event.Event) bool {
	select {
	case out <- ev:
		return true
	case <-ctx.Done():
		return false
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func sessionTransitions(sessions []Session) []event.Event {
	out := make([]event.Event, 0, len(sessions))
	for _, session := range sessions {
		out = append(out, event.Event{
			Time: session.StateSince, Source: "firehose", SessionID: session.ID,
			// Agent/Repo/CWD carry the session's workspace identity. Source
			// stays "firehose" because this is a synthetic transition, so the
			// originating adapter travels in Payload["source"].
			Agent: session.Agent, Repo: session.Repo, CWD: session.CWD,
			Category: event.CategoryMeta, Name: "state.transition",
			Payload: map[string]any{
				"state": session.State, "reason": session.StateReason, "reconciled": true,
				"has_error": session.HasError, "last_time": session.LastTime,
				"source": session.Source,
			},
		})
	}
	return out
}

type seenIDs struct {
	capacity int
	set      map[string]bool
	order    []string
}

func newSeen(capacity int) *seenIDs {
	return &seenIDs{capacity: capacity, set: make(map[string]bool)}
}

func (s *seenIDs) has(id string) bool { return s.set[id] }

func (s *seenIDs) add(id string) {
	if id == "" || s.has(id) {
		return
	}
	s.set[id] = true
	s.order = append(s.order, id)
	if len(s.order) > s.capacity {
		delete(s.set, s.order[0])
		s.order = s.order[1:]
	}
}
