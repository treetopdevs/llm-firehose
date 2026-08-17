// Package capturehistory provides black-box Capture Engine history helpers for
// tests outside the sealed capture implementation.
package capturehistory

import (
	"context"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

// Admitter submits test Observations through a standalone Capture Engine.
type Admitter struct {
	engine *capture.Engine
	err    error
}

func NewAdmitter(dir string) *Admitter {
	engine, err := capture.New(capture.Options{SpoolDir: dir, Policy: privacy.ModeFull})
	return &Admitter{engine: engine, err: err}
}

func (w *Admitter) Append(ev event.Event) (event.Event, error) {
	if w.err != nil {
		return event.Event{}, w.err
	}
	return w.engine.Admit(context.Background(), ev)
}

// Recent queries presentation-deduplicated durable history.
func Recent(dir string, limit int) ([]event.Event, error) {
	engine, err := capture.New(capture.Options{SpoolDir: dir, Policy: privacy.ModeFull})
	if err != nil {
		return nil, err
	}
	return engine.Recent(limit)
}
