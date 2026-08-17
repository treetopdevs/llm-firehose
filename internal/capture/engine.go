// Package capture owns Admission, durable history, disposable Projections,
// Live Subscriptions, and Source Adapter lifecycle for Agent Firehose.
package capture

import (
	"context"
	"fmt"
	"sync"

	"agentfirehose/internal/event"
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
}

// New constructs an engine over the configured canonical spool.
func New(options Options) (*Engine, error) {
	if options.SpoolDir == "" {
		return nil, fmt.Errorf("capture: spool directory is required")
	}
	if _, err := privacy.ParseMode(string(options.Policy)); err != nil {
		return nil, err
	}
	return &Engine{
		spoolDir: options.SpoolDir,
		writer:   spool.NewWriter(options.SpoolDir),
		sources:  append([]Source(nil), options.Sources...),
		policy:   options.Policy,
	}, nil
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
	return spool.ReadLastN(e.spoolDir, limit)
}
