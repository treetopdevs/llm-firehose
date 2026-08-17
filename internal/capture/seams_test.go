package capture

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

type failingAppender struct{ err error }

func (w failingAppender) Append(event.Event) (event.Event, error) {
	return event.Event{}, w.err
}

type retryingSeamSource struct {
	attempts atomic.Int32
	event    event.Event
}

type preparedSeamSource struct {
	name       string
	prepareErr error
	ran        chan struct{}
}

type alwaysFailingSeamSource struct {
	attempts atomic.Int32
	err      error
}

type recurringFailureSeamSource struct {
	attempts atomic.Int32
	err      error
	recovery time.Duration
}

func (*recurringFailureSeamSource) Name() string { return "recurring-failure" }

func (s *recurringFailureSeamSource) Run(ctx context.Context, _ Sink) error {
	switch s.attempts.Add(1) {
	case 1:
		return s.err
	case 2:
		timer := time.NewTimer(s.recovery)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
			return s.err
		}
	default:
		<-ctx.Done()
		return nil
	}
}

func (*alwaysFailingSeamSource) Name() string { return "persistent-failure" }

func (s *alwaysFailingSeamSource) Run(context.Context, Sink) error {
	s.attempts.Add(1)
	return s.err
}

func (s *preparedSeamSource) Name() string { return s.name }

func (s *preparedSeamSource) prepare(Sink) error { return s.prepareErr }

func (s *preparedSeamSource) Run(ctx context.Context, _ Sink) error {
	close(s.ran)
	<-ctx.Done()
	return nil
}

func (*retryingSeamSource) Name() string { return "retry-seam" }

func (s *retryingSeamSource) Run(ctx context.Context, sink Sink) error {
	if s.attempts.Add(1) == 1 {
		return errors.New("retry me")
	}
	if _, err := sink.Admit(ctx, s.event); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

func TestAppendFailureDoesNotReachProjectionOrSubscription(t *testing.T) {
	wantErr := errors.New("disk unavailable")
	engine, err := newEngine(Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull}, engineSeams{
		writer: failingAppender{err: wantErr}, subscriptionCapacity: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	subscription := engine.Subscribe(context.Background())
	_, err = engine.Admit(context.Background(), event.Event{
		Time: time.Date(2026, 8, 17, 15, 0, 0, 0, time.UTC), Source: "generic", Category: event.CategoryMeta,
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("Admit error = %v", err)
	}
	if sessions := engine.Sessions(); len(sessions) != 0 {
		t.Fatalf("append failure reached Projection: %+v", sessions)
	}
	select {
	case ev := <-subscription.Events:
		t.Fatalf("append failure reached subscription: %+v", ev)
	default:
	}
}

func TestClockIDAndQueueCapacityAreInternalConstructionSeams(t *testing.T) {
	fixed := time.Date(2026, 8, 17, 15, 1, 0, 0, time.UTC)
	engine, err := newEngine(Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull}, engineSeams{
		now: func() time.Time { return fixed }, newID: func() string { return "fixed-id" },
		subscriptionCapacity: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	subscription := engine.Subscribe(context.Background())
	stored, err := engine.Admit(context.Background(), event.Event{
		Time: fixed.Add(-time.Minute), Source: "generic", Category: event.CategoryMeta,
	})
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != "fixed-id" || stored.CaptureTime == nil || !stored.CaptureTime.Equal(fixed) {
		t.Fatalf("deterministic persisted event = %+v", stored)
	}
	if _, err := engine.Admit(context.Background(), event.Event{
		ID: "overflow", Time: fixed, Source: "generic", Category: event.CategoryMeta,
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-subscription.Done:
		if !errors.Is(err, ErrSubscriptionOverflow) {
			t.Fatalf("subscription error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("injected queue capacity did not overflow")
	}
}

func TestRetryDelaysAreInternalConstructionSeams(t *testing.T) {
	fixed := time.Date(2026, 8, 17, 15, 2, 0, 0, time.UTC)
	source := &retryingSeamSource{event: event.Event{
		ID: "retried-with-injected-delay", Time: fixed, Source: "generic", Category: event.CategoryMeta,
	}}
	engine, err := newEngine(Options{
		SpoolDir: t.TempDir(), Policy: privacy.ModeFull, Sources: []Source{source},
	}, engineSeams{retryInitial: time.Millisecond, retryMaximum: 2 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()
	deadline := time.Now().Add(time.Second)
	for {
		history, err := engine.Recent(10)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		for _, ev := range history {
			if ev.ID == source.event.ID {
				cancel()
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				return
			}
		}
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatalf("injected retry did not run: attempts=%d", source.attempts.Load())
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPreparationFailuresAreTrackedBySourceInstance(t *testing.T) {
	failed := &preparedSeamSource{
		name: "duplicate-name", prepareErr: errors.New("prepare failed"), ran: make(chan struct{}),
	}
	healthy := &preparedSeamSource{name: "duplicate-name", ran: make(chan struct{})}
	engine, err := newEngine(Options{
		SpoolDir: t.TempDir(), Policy: privacy.ModeFull, Sources: []Source{failed, healthy},
	}, engineSeams{retryInitial: 500 * time.Millisecond, retryMaximum: 500 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()
	select {
	case <-healthy.ran:
	case <-time.After(100 * time.Millisecond):
		cancel()
		<-done
		t.Fatal("healthy source with duplicate name inherited another source's preparation failure")
	}
	select {
	case <-failed.ran:
		cancel()
		<-done
		t.Fatal("failed source ran before its retry delay")
	default:
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRepeatedIdenticalSourceFailureWritesOneWarning(t *testing.T) {
	source := &alwaysFailingSeamSource{err: errors.New("still unavailable")}
	engine, err := newEngine(Options{
		SpoolDir: t.TempDir(), Policy: privacy.ModeFull, Sources: []Source{source},
	}, engineSeams{retryInitial: time.Millisecond, retryMaximum: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()
	deadline := time.Now().Add(time.Second)
	for source.attempts.Load() < 4 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	history, err := engine.Recent(20)
	if err != nil {
		t.Fatal(err)
	}
	warnings := 0
	for _, ev := range history {
		if ev.Name == "source_capture_error" {
			warnings++
		}
	}
	if source.attempts.Load() < 4 || warnings != 1 {
		t.Fatalf("attempts=%d warnings=%d history=%+v", source.attempts.Load(), warnings, history)
	}
}

func TestIdenticalSourceFailureWarnsAgainAfterHealthyRun(t *testing.T) {
	source := &recurringFailureSeamSource{
		err: errors.New("unavailable again"), recovery: 10 * time.Millisecond,
	}
	engine, err := newEngine(Options{
		SpoolDir: t.TempDir(), Policy: privacy.ModeFull, Sources: []Source{source},
	}, engineSeams{retryInitial: time.Millisecond, retryMaximum: 5 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()
	deadline := time.Now().Add(time.Second)
	for {
		history, err := engine.Recent(20)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		warnings := 0
		for _, ev := range history {
			if ev.Name == "source_capture_error" {
				warnings++
			}
		}
		if warnings == 2 {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatalf("recurring failure was not announced after recovery: %+v", history)
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
