// Package capture owns Admission, durable history, disposable Projections,
// Live Subscriptions, and Source Adapter lifecycle for Agent Firehose.
package capture

import (
	"context"
	"fmt"
	"sync"

	"agentfirehose/internal/event"
	"agentfirehose/internal/index"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
)

// Options configures one Capture Engine. Configuration loading and persistence
// remain host responsibilities.
type Options struct {
	SpoolDir string
	Policy   privacy.Mode
	Sources  []Source
}

// Source is a long-running Source Adapter at the normalized Observation seam.
type Source interface {
	Name() string
	Run(context.Context, Sink) error
}

// Sink admits normalized Observations into canonical history.
type Sink interface {
	Admit(context.Context, event.Event) (event.Event, error)
}

// Engine turns Observations into Captured Events.
type Engine struct {
	spoolDir string
	writer   *spool.Writer
	sources  []Source

	sequence sync.Mutex
	policyMu sync.RWMutex
	policy   privacy.Mode
	index    *index.Index
	project  func(event.Event) error
	tailer   *spool.Tailer
	run      runtimeState
	subMu    sync.Mutex
	subs     map[*subscriber]struct{}
}

// New constructs an engine over the configured canonical spool.
func New(options Options) (*Engine, error) {
	if options.SpoolDir == "" {
		return nil, fmt.Errorf("capture: spool directory is required")
	}
	if _, err := privacy.ParseMode(string(options.Policy)); err != nil {
		return nil, err
	}
	tailer := spool.NewTailer(options.SpoolDir, defaultReconcileInterval)
	tailer.Prime()
	projection, err := index.Build(options.SpoolDir)
	if err != nil {
		return nil, fmt.Errorf("capture: rebuild projection: %w", err)
	}
	engine := &Engine{
		spoolDir: options.SpoolDir,
		writer:   spool.NewWriter(options.SpoolDir),
		sources:  append([]Source(nil), options.Sources...),
		policy:   options.Policy,
		index:    projection,
		tailer:   tailer,
		subs:     make(map[*subscriber]struct{}),
	}
	engine.project = engine.applyProjection
	for _, source := range engine.sources {
		if preparer, ok := source.(interface{ prepare() error }); ok {
			_ = preparer.prepare()
		}
	}
	return engine, nil
}

// SetPolicy atomically changes the active Capture Policy for later Admissions.
func (e *Engine) SetPolicy(policy privacy.Mode) {
	e.policyMu.Lock()
	e.policy = policy
	e.policyMu.Unlock()
}

func (e *Engine) activePolicy() privacy.Mode {
	e.policyMu.RLock()
	defer e.policyMu.RUnlock()
	return e.policy
}

// Recent returns up to limit recent Captured Events, oldest first.
func (e *Engine) Recent(limit int) ([]event.Event, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("capture: recent limit must be positive")
	}
	events, err := spool.ReadLastN(e.spoolDir, int(^uint(0)>>1))
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	deduplicated := make([]event.Event, 0, len(events))
	for _, ev := range events {
		if ev.ID != "" && seen[ev.ID] {
			continue
		}
		if ev.ID != "" {
			seen[ev.ID] = true
		}
		deduplicated = append(deduplicated, ev)
	}
	if len(deduplicated) > limit {
		deduplicated = deduplicated[len(deduplicated)-limit:]
	}
	return deduplicated, nil
}
