package capture

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"agentfirehose/internal/event"
)

const defaultReconcileInterval = 100 * time.Millisecond

// Runtime state is kept separate from the Admission locks.
type runtimeState struct {
	mu      sync.Mutex
	running bool
}

func (e *Engine) reconcile(ev event.Event) error {
	e.sequence.Lock()
	defer e.sequence.Unlock()
	return e.project(ev)
}

// Run supervises reconciliation, Source Adapters, and idle Projection until
// cancellation. One Source failure never stops another capture path.
func (e *Engine) Run(ctx context.Context) error {
	e.run.mu.Lock()
	if e.run.running {
		e.run.mu.Unlock()
		return ErrAlreadyRunning
	}
	e.run.running = true
	e.run.mu.Unlock()
	defer func() {
		e.closeSubscriptions(nil)
		e.run.mu.Lock()
		e.run.running = false
		e.run.mu.Unlock()
	}()

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var workers sync.WaitGroup
	launch := func(run func()) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			run()
		}()
	}
	launch(func() { e.tailer.RunAck(runCtx, e.reconcile) })
	prepareErrors := e.prepareErr
	e.prepareErr = nil
	for i, source := range e.sources {
		source := source
		var prepareErr error
		if i < len(prepareErrors) {
			prepareErr = prepareErrors[i]
		}
		launch(func() { e.superviseSource(runCtx, source, prepareErr) })
	}
	launch(func() { e.advanceIdle(runCtx) })
	<-runCtx.Done()
	cancel()
	workers.Wait()
	return nil
}

var ErrAlreadyRunning = errors.New("capture: engine already running")

const (
	sourceRetryInitial = 100 * time.Millisecond
	sourceRetryMaximum = 5 * time.Second
	idleInterval       = 5 * time.Second
)

func (e *Engine) superviseSource(ctx context.Context, source Source, initialErr error) {
	backoff := e.retryInitial
	lastWarning := ""
	hasWarning := false
	warn := func(sourceErr error) {
		key := sourceErr.Error()
		if hasWarning && key == lastWarning {
			return
		}
		lastWarning = key
		hasWarning = true
		e.captureSourceWarning(ctx, source.Name(), sourceErr)
	}
	if initialErr != nil {
		warn(initialErr)
		if !waitForRetry(ctx, backoff) {
			return
		}
		backoff = nextRetry(backoff, e.retryMaximum)
	}
	for {
		started := time.Now()
		err := source.Run(ctx, e)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) >= e.retryMaximum {
			hasWarning = false
			backoff = e.retryInitial
		}
		if err == nil {
			err = fmt.Errorf("source stopped unexpectedly")
		}
		warn(err)
		if !waitForRetry(ctx, backoff) {
			return
		}
		backoff = nextRetry(backoff, e.retryMaximum)
	}
}

func nextRetry(current, maximum time.Duration) time.Duration {
	next := current * 2
	if next > maximum {
		return maximum
	}
	return next
}

func waitForRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (e *Engine) captureSourceWarning(ctx context.Context, source string, sourceErr error) {
	now := e.now().UTC()
	_, _ = e.Admit(ctx, event.Event{
		Time:     now,
		Source:   "firehose",
		Category: event.CategoryMeta,
		Name:     "source_capture_error",
		Severity: event.SeverityWarn,
		Summary:  fmt.Sprintf("%s Source Adapter warning", source),
		Payload: map[string]any{
			"adapter_source": source,
			"status":         "error",
			"error":          sourceErr.Error(),
		},
	})
}

func (e *Engine) advanceIdle(ctx context.Context) {
	ticker := time.NewTicker(e.idleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.sequence.Lock()
			now := e.now()
			for _, transition := range e.projection.AdvanceIdle(now) {
				if transition != nil {
					e.publish(*transition)
				}
			}
			e.sequence.Unlock()
		}
	}
}
