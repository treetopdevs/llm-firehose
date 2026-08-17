package capture

import (
	"context"
	"fmt"

	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
	"agentfirehose/internal/workspace"
)

// OneShotOptions configures short-lived Admission without Sources or
// Projections.
type OneShotOptions struct {
	SpoolDir string
	Policy   privacy.Mode
}

// Admit serializes the engine-local commit path.
func (e *Engine) Admit(ctx context.Context, observation event.Event) (event.Event, error) {
	e.sequence.Lock()
	defer e.sequence.Unlock()
	stored, err := admit(ctx, e.writer, e.activePolicy(), observation)
	if err != nil {
		return event.Event{}, err
	}
	// Append is the commit point. Projection failure is reconciled from the
	// canonical spool and must never ask a durable Source Adapter to retry.
	_ = e.project(stored)
	return stored, nil
}

// AdmitOnce performs Admission for a short-lived process without constructing
// Projections or starting Source Adapters.
func AdmitOnce(ctx context.Context, options OneShotOptions, observation event.Event) (event.Event, error) {
	if options.SpoolDir == "" {
		return event.Event{}, fmt.Errorf("capture: spool directory is required")
	}
	if _, err := privacy.ParseMode(string(options.Policy)); err != nil {
		return event.Event{}, err
	}
	return admit(ctx, spool.NewWriter(options.SpoolDir), options.Policy, observation)
}

func admit(ctx context.Context, writer *spool.Writer, policy privacy.Mode, observation event.Event) (event.Event, error) {
	if err := ctx.Err(); err != nil {
		return event.Event{}, err
	}
	if err := observation.Validate(); err != nil {
		return event.Event{}, err
	}
	enriched := workspace.Enrich(observation)
	protected := privacy.Redact(enriched, policy)
	return writer.Append(protected)
}
