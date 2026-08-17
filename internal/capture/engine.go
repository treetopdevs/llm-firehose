// Package capture owns Admission, durable history, disposable Projections,
// Live Subscriptions, and Source Adapter lifecycle for Agent Firehose.
package capture

import (
	"context"
	"fmt"
	"sync"
	"time"

	"agentfirehose/internal/capture/internal/projection"
	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
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

type appender interface {
	Append(event.Event) (event.Event, error)
}

// engineSeams keeps deterministic failure, clock, scheduling, persistence,
// Projection, and queue controls private to Capture Engine tests.
type engineSeams struct {
	writer               appender
	now                  func() time.Time
	newID                func() string
	projector            func(*Engine) func(event.Event) error
	subscriptionCapacity int
	retryInitial         time.Duration
	retryMaximum         time.Duration
	idleInterval         time.Duration
}

// Engine turns Observations into Captured Events.
type Engine struct {
	spoolDir string
	writer   appender
	sources  []Source

	sequence   sync.Mutex
	policyMu   sync.RWMutex
	policy     privacy.Mode
	projection *projection.Projection
	project    func(event.Event) error
	tailer     *spool.Tailer
	run        runtimeState
	subMu      sync.Mutex
	subs       map[*subscriber]struct{}
	prepareErr []error

	now                  func() time.Time
	subscriptionCapacity int
	retryInitial         time.Duration
	retryMaximum         time.Duration
	idleInterval         time.Duration
}

// New constructs an engine over the configured canonical spool.
func New(options Options) (*Engine, error) {
	return newEngine(options, engineSeams{})
}

func newEngine(options Options, seams engineSeams) (*Engine, error) {
	if options.SpoolDir == "" {
		return nil, fmt.Errorf("capture: spool directory is required")
	}
	if _, err := privacy.ParseMode(string(options.Policy)); err != nil {
		return nil, err
	}
	tailer := spool.NewTailer(options.SpoolDir, defaultReconcileInterval)
	tailer.Prime()
	projections, err := projection.Build(options.SpoolDir)
	if err != nil {
		return nil, fmt.Errorf("capture: rebuild projection: %w", err)
	}
	if seams.now == nil {
		seams.now = time.Now
	}
	if seams.newID == nil {
		seams.newID = event.NewID
	}
	if seams.writer == nil {
		seams.writer = spool.NewWriterWithSeams(options.SpoolDir, seams.now, seams.newID)
	}
	if seams.subscriptionCapacity <= 0 {
		seams.subscriptionCapacity = defaultSubscriptionCapacity
	}
	if seams.retryInitial <= 0 {
		seams.retryInitial = sourceRetryInitial
	}
	if seams.retryMaximum <= 0 {
		seams.retryMaximum = sourceRetryMaximum
	}
	if seams.idleInterval <= 0 {
		seams.idleInterval = idleInterval
	}
	engine := &Engine{
		spoolDir:             options.SpoolDir,
		writer:               seams.writer,
		sources:              append([]Source(nil), options.Sources...),
		prepareErr:           make([]error, len(options.Sources)),
		policy:               options.Policy,
		projection:           projections,
		tailer:               tailer,
		subs:                 make(map[*subscriber]struct{}),
		now:                  seams.now,
		subscriptionCapacity: seams.subscriptionCapacity,
		retryInitial:         seams.retryInitial,
		retryMaximum:         seams.retryMaximum,
		idleInterval:         seams.idleInterval,
	}
	if seams.projector == nil {
		engine.project = engine.applyProjection
	} else {
		engine.project = seams.projector(engine)
	}
	for i, source := range engine.sources {
		if preparer, ok := source.(interface{ prepare(Sink) error }); ok {
			if err := preparer.prepare(engine); err != nil {
				engine.prepareErr[i] = err
			}
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
	return spool.ReadLastDistinctN(e.spoolDir, limit)
}
