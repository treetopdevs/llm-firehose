package codex

import (
	"context"
	"os"
	"strings"
	"time"

	"agentfirehose/internal/durablejsonl"
	"agentfirehose/internal/event"
)

// Watcher streams live rollout appends without a persisted checkpoint. It
// uses the same line, baseline, partial-record, truncation, and rotation core
// as DurableWatcher; daemon mode supplies the durable state path and spool
// sink through DurableWatcher.
type Watcher struct {
	Root     string
	Interval time.Duration
}

func NewWatcher(root string, interval time.Duration) *Watcher {
	return &Watcher{Root: root, Interval: interval}
}

// Run polls until ctx is done, sending mapped events on ch.
func (w *Watcher) Run(ctx context.Context, ch chan<- event.Event) {
	core := durablejsonl.New(durablejsonl.Options{
		Root:     w.Root,
		Interval: w.Interval,
		Match: func(path string, entry os.DirEntry) bool {
			return !entry.IsDir() && strings.HasSuffix(path, ".jsonl")
		},
		NewParser: newDurableParser,
		Sink: func(ev event.Event) error {
			select {
			case ch <- ev:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	})
	core.Run(ctx)
}
