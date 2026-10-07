package host

import (
	"context"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/livesubscription"
)

// Feed is the daemonless view's Live Subscription.
type Feed struct {
	Events   <-chan event.Event
	History  []event.Event
	Sessions []livesubscription.Session
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
	feedCtx, stopFeed := context.WithCancel(ctx)
	sub, err := livesubscription.Open(feedCtx, engineSource{engine}, initialLimit, reconcileLimit)
	if err != nil {
		stopFeed()
		return Feed{}, err
	}
	go func() {
		_ = engine.Run(ctx)
		stopFeed()
	}()
	return Feed{Events: sub.Events, History: sub.History, Sessions: sub.Sessions}, nil
}

type engineSource struct{ engine *capture.Engine }

func (s engineSource) Recent(_ context.Context, limit int) ([]event.Event, error) {
	return s.engine.Recent(limit)
}

func (s engineSource) Subscribe(ctx context.Context) (<-chan event.Event, error) {
	return s.engine.Subscribe(ctx).Events, nil
}

func (s engineSource) Sessions(context.Context) ([]livesubscription.Session, error) {
	projected := s.engine.Sessions()
	sessions := make([]livesubscription.Session, len(projected))
	for i, session := range projected {
		sessions[i] = livesubscription.Session{
			ID: session.ID, Source: session.Source, Agent: session.Agent,
			Repo: session.Repo, CWD: session.CWD, State: string(session.State),
			StateSince: session.StateSince, StateReason: session.StateReason,
			LastTime: session.LastTime, HasError: session.HasError,
		}
	}
	return sessions, nil
}
