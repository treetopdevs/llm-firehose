package capture

import (
	"context"
	"os"
	"time"

	"agentfirehose/internal/adapters/codex"
	"agentfirehose/internal/adapters/procwatch"
	"agentfirehose/internal/event"
)

const (
	defaultCodexInterval = 250 * time.Millisecond
	defaultProcInterval  = 2 * time.Second
)

// LocalSourceOptions locates the built-in passive Sources. Polling and
// implementation types remain private to the Capture Engine.
type LocalSourceOptions struct {
	CodexDir       string
	CodexStatePath string
	OwnershipPath  string
}

// LocalSources returns the production local Source Adapters without exposing
// watcher, cursor, or process-list implementation types to hosts.
func LocalSources(options LocalSourceOptions) []Source {
	var sources []Source
	if options.CodexDir != "" {
		if _, err := os.Stat(options.CodexDir); err == nil {
			sources = append(sources, newCodexSource(options.CodexDir, options.CodexStatePath, defaultCodexInterval))
		}
	}
	sources = append(sources, newProcessSource(procwatch.PSLister{}, defaultProcInterval))
	if options.OwnershipPath != "" {
		lease := &sourceLease{path: options.OwnershipPath}
		for i, source := range sources {
			sources[i] = &leasedSource{lease: lease, source: source}
		}
	}
	return sources
}

type codexSource struct {
	watcher  *codex.DurableWatcher
	prepared bool
}

func newCodexSource(root, statePath string, interval time.Duration) *codexSource {
	return &codexSource{watcher: codex.NewDurableWatcher(root, statePath, interval, nil)}
}

func (*codexSource) Name() string { return codex.Source }

func (s *codexSource) prepare(sink Sink) error {
	s.watcher.Sink = func(ev event.Event) error {
		_, err := sink.Admit(context.Background(), ev)
		return err
	}
	if s.prepared {
		return nil
	}
	if err := s.watcher.Initialize(); err != nil {
		return err
	}
	s.prepared = true
	return nil
}

func (s *codexSource) Run(ctx context.Context, sink Sink) error {
	s.watcher.Sink = func(ev event.Event) error {
		_, err := sink.Admit(ctx, ev)
		return err
	}
	s.watcher.Run(ctx)
	return nil
}

type processSource struct {
	lister   procwatch.Lister
	interval time.Duration
}

func newProcessSource(lister procwatch.Lister, interval time.Duration) *processSource {
	return &processSource{lister: lister, interval: interval}
}

func (*processSource) Name() string { return procwatch.Source }

func (s *processSource) Run(ctx context.Context, sink Sink) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	events := make(chan event.Event, 64)
	go procwatch.NewWatcher(s.lister, s.interval).Run(runCtx, events)
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-events:
			if _, err := sink.Admit(ctx, ev); err != nil {
				return err
			}
		}
	}
}
