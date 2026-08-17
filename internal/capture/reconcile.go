package capture

import (
	"context"
	"errors"
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

// Run reconciles external/one-shot writes until cancellation. Source Adapter
// supervision is added at the same lifecycle seam in the next migration slice.
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

	e.tailer.RunAck(ctx, e.reconcile)
	return nil
}

var ErrAlreadyRunning = errors.New("capture: engine already running")
