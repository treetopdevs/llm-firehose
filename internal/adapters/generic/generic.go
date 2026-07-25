// Package generic accepts NDJSON from any tool. A line that already looks
// like a valid envelope passes through (with defaults filled in); anything
// else is wrapped as a meta event so nothing is silently dropped.
package generic

import (
	"encoding/json"
	"fmt"
	"time"

	"agentfirehose/internal/event"
)

// Source is the agent family identifier for wrapped generic events.
const Source = "generic"

// Parse converts one NDJSON line into a normalized event.
func Parse(raw []byte) (event.Event, error) {
	var ev event.Event
	if err := json.Unmarshal(raw, &ev); err == nil {
		fill(&ev, !ev.Time.IsZero())
		if ev.Validate() == nil {
			return ev, nil
		}
	}
	// Not an envelope: wrap arbitrary JSON.
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return event.Event{}, fmt.Errorf("generic: not valid JSON: %w", err)
	}
	captured := time.Now().UTC()
	ev = event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: &captured,
		Source:      Source,
		Category:    event.CategoryMeta,
		Name:        "ingest",
		Severity:    event.SeverityInfo,
		Summary:     fmt.Sprintf("ingested event (%d keys)", len(payload)),
		Payload:     payload,
		Raw:         string(raw),
	}
	return ev, nil
}

func fill(ev *event.Event, suppliedTime bool) {
	if ev.ID == "" {
		ev.ID = event.NewID()
	}
	if suppliedTime && ev.SourceTime == nil && ev.CaptureTime == nil {
		sourceTime := ev.Time
		ev.SourceTime = &sourceTime
	}
	if ev.CaptureTime == nil {
		captured := time.Now().UTC()
		ev.CaptureTime = &captured
	}
	if ev.Time.IsZero() {
		ev.Time = *ev.CaptureTime
	}
	if ev.Severity == "" {
		ev.Severity = event.SeverityInfo
	}
}
