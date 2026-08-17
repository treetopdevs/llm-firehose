package host

import (
	"context"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
)

const feedSeenCapacity = 20000

// Feed is the daemonless view's engine-owned durable and live state.
type Feed struct {
	Events   <-chan event.Event
	History  []event.Event
	Sessions []capture.Session
}

// OpenLocalFeed composes the same production Capture Engine used by the
// daemon, preloads its durable Projections, and starts its Sources.
func OpenLocalFeed(ctx context.Context, cfg cli.Config, home string) (Feed, error) {
	engine, err := NewEngine(cfg, home)
	if err != nil {
		return Feed{}, err
	}
	return openEngineFeed(ctx, engine, 500, 10000)
}

func openEngineFeed(ctx context.Context, engine *capture.Engine, initialLimit, reconcileLimit int) (Feed, error) {
	history, err := engine.Recent(initialLimit)
	if err != nil {
		return Feed{}, err
	}
	sessions := engine.Sessions()
	seen := newFeedIDs(feedSeenCapacity)
	for _, ev := range history {
		seen.add(ev.ID)
	}
	subscriptionCtx, stopSubscription := context.WithCancel(ctx)
	subscription := engine.Subscribe(subscriptionCtx)
	catchup, err := engine.Recent(initialLimit)
	if err != nil {
		stopSubscription()
		return Feed{}, err
	}
	for _, ev := range catchup {
		if seen.add(ev.ID) {
			history = append(history, ev)
		}
	}
	engineDone := make(chan error, 1)
	go func() { engineDone <- engine.Run(ctx) }()

	out := make(chan event.Event, 256)
	go pumpEngineFeed(ctx, engine, subscription, stopSubscription, engineDone, reconcileLimit, seen, out)
	return Feed{Events: out, History: history, Sessions: sessions}, nil
}

func pumpEngineFeed(
	ctx context.Context,
	engine *capture.Engine,
	subscription *capture.Subscription,
	stopSubscription context.CancelFunc,
	engineDone <-chan error,
	reconcileLimit int,
	seen *feedIDs,
	out chan<- event.Event,
) {
	defer close(out)
	current := subscription
	stopCurrent := stopSubscription
	defer func() { stopCurrent() }()
	for {
		for current != nil {
			select {
			case <-ctx.Done():
				return
			case <-engineDone:
				return
			case ev, ok := <-current.Events:
				if !ok {
					current = nil
					continue
				}
				if !seen.add(ev.ID) {
					continue
				}
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
		stopCurrent()

		for current == nil {
			if ctx.Err() != nil {
				return
			}
			recovered, err := engine.Recent(reconcileLimit)
			if err == nil {
				replacementCtx, stopReplacement := context.WithCancel(ctx)
				replacement := engine.Subscribe(replacementCtx)
				catchup, catchupErr := engine.Recent(reconcileLimit)
				if catchupErr != nil {
					stopReplacement()
				} else {
					recovered = append(recovered, catchup...)
					for _, ev := range recovered {
						if !seen.add(ev.ID) {
							continue
						}
						select {
						case out <- ev:
						case <-ctx.Done():
							stopReplacement()
							return
						}
					}
					for _, ev := range projectedSessionTransitions(engine.Sessions()) {
						select {
						case out <- ev:
						case <-ctx.Done():
							stopReplacement()
							return
						}
					}
					current = replacement
					stopCurrent = stopReplacement
					break
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-engineDone:
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
}

func projectedSessionTransitions(sessions []capture.Session) []event.Event {
	out := make([]event.Event, 0, len(sessions))
	for _, session := range sessions {
		out = append(out, event.Event{
			Time: session.StateSince, Source: "firehose", SessionID: session.ID,
			Category: event.CategoryMeta, Name: "state.transition",
			Payload: map[string]any{
				"state": string(session.State), "reason": session.StateReason, "reconciled": true,
			},
		})
	}
	return out
}

type feedIDs struct {
	capacity int
	set      map[string]bool
	order    []string
}

func newFeedIDs(capacity int) *feedIDs {
	return &feedIDs{capacity: capacity, set: make(map[string]bool)}
}

func (s *feedIDs) add(id string) bool {
	if id == "" {
		return true
	}
	if s.set[id] {
		return false
	}
	s.set[id] = true
	s.order = append(s.order, id)
	if len(s.order) > s.capacity {
		delete(s.set, s.order[0])
		s.order = s.order[1:]
	}
	return true
}
