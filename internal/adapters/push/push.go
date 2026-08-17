// Package push dispatches pushed native payloads to their Source Adapter.
// It owns parsing only; Capture Policy and durability belong to capture.
package push

import (
	"agentfirehose/internal/adapters/antigravity"
	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/adapters/codexhook"
	"agentfirehose/internal/adapters/generic"
	"agentfirehose/internal/adapters/opencode"
	"agentfirehose/internal/event"
)

// Parse maps one pushed native payload into zero or one normalized
// Observation. A nil Observation is a deliberate Source Adapter filter.
func Parse(source, eventName string, raw []byte) (*event.Event, error) {
	switch source {
	case antigravity.Source:
		return antigravity.Parse(eventName, raw)
	case claudecode.Source:
		return claudecode.Parse(raw)
	case opencode.Source:
		return opencode.Parse(raw)
	case codexhook.Source:
		parsed, err := codexhook.Parse(raw)
		return &parsed, err
	default:
		parsed, err := generic.Parse(raw)
		return &parsed, err
	}
}
