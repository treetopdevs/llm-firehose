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
	for _, source := range e.sources {
		source := source
		launch(func() { e.superviseSource(runCtx, source) })
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

func (e *Engine) superviseSource(ctx context.Context, source Source) {
	backoff := sourceRetryInitial
	for {
		err := source.Run(ctx, e)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			err = fmt.Errorf("source stopped unexpectedly")
		}
		e.captureSourceWarning(ctx, source.Name(), err)
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		backoff *= 2
		if backoff > sourceRetryMaximum {
			backoff = sourceRetryMaximum
		}
	}
}

func (e *Engine) captureSourceWarning(ctx context.Context, source string, sourceErr error) {
	now := time.Now().UTC()
	_, _ = e.Admit(ctx, event.Event{
		Time:     now,
		Source:   "firehose",
		Category: event.CategoryMeta,
		Name:     "source_capture_error",
		Severity: event.SeverityWarn,
		Summary:  fmt.Sprintf("%s Source Adapter warning: %v", source, sourceErr),
		Payload: map[string]any{
			"adapter_source": source,
			"status":         "error",
		},
	})
}

func (e *Engine) advanceIdle(ctx context.Context) {
	ticker := time.NewTicker(idleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for _, transition := range e.index.AdvanceIdle(now) {
				if transition != nil {
					e.publish(*transition)
				}
			}
		}
	}
}
