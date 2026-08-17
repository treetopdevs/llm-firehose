package capture

import (
	"context"
	"errors"

	"agentfirehose/internal/event"
)

const defaultSubscriptionCapacity = 256

// ErrSubscriptionOverflow is the authoritative signal that a live adapter
// must reconcile durable history before resubscribing.
var ErrSubscriptionOverflow = errors.New("capture: live subscription overflow")

// Subscription is a bounded, ordered view of projected Captured Events and
// compatible live-only derived frames.
type Subscription struct {
	Events <-chan event.Event
	Done   <-chan error
}

type subscriber struct {
	events  chan event.Event
	done    chan error
	stopped chan struct{}
}

// Subscribe creates a bounded Live Subscription. It never blocks Admission;
// overflow terminates only this subscription.
func (e *Engine) Subscribe(ctx context.Context) *Subscription {
	sub := &subscriber{
		events:  make(chan event.Event, defaultSubscriptionCapacity),
		done:    make(chan error, 1),
		stopped: make(chan struct{}),
	}
	e.subMu.Lock()
	e.subs[sub] = struct{}{}
	e.subMu.Unlock()
	go func() {
		select {
		case <-ctx.Done():
			e.terminateSubscription(sub, nil)
		case <-sub.stopped:
		}
	}()
	return &Subscription{Events: sub.events, Done: sub.done}
}

func (e *Engine) publish(ev event.Event) {
	e.subMu.Lock()
	defer e.subMu.Unlock()
	for sub := range e.subs {
		select {
		case sub.events <- ev:
		default:
			e.terminateSubscriptionLocked(sub, ErrSubscriptionOverflow)
		}
	}
}

func (e *Engine) terminateSubscription(sub *subscriber, err error) {
	e.subMu.Lock()
	defer e.subMu.Unlock()
	e.terminateSubscriptionLocked(sub, err)
}

func (e *Engine) terminateSubscriptionLocked(sub *subscriber, err error) {
	if _, ok := e.subs[sub]; !ok {
		return
	}
	delete(e.subs, sub)
	sub.done <- err
	close(sub.events)
	close(sub.done)
	close(sub.stopped)
}

func (e *Engine) closeSubscriptions(err error) {
	e.subMu.Lock()
	defer e.subMu.Unlock()
	for sub := range e.subs {
		e.terminateSubscriptionLocked(sub, err)
	}
}
