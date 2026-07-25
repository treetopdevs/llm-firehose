package generic

import (
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func TestFullEnvelopePassthrough(t *testing.T) {
	before := time.Now().UTC()
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-agent","category":"shell","summary":"ran make"}`
	ev, err := Parse([]byte(line))
	after := time.Now().UTC()
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if ev.Source != "my-agent" || ev.Category != event.CategoryShell || ev.Summary != "ran make" {
		t.Errorf("passthrough mangled: %+v", ev)
	}
	if ev.ID == "" {
		t.Error("missing ID should be filled in")
	}
	wantSource := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	if ev.SourceTime == nil || !ev.SourceTime.Equal(wantSource) {
		t.Errorf("source_time = %v, want supplied envelope time %v", ev.SourceTime, wantSource)
	}
	if ev.CaptureTime == nil || ev.CaptureTime.Before(before) || ev.CaptureTime.After(after) {
		t.Errorf("capture_time = %v, want ingest observation between %v and %v", ev.CaptureTime, before, after)
	}
}

func TestTraceIDPassthrough(t *testing.T) {
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-agent","category":"shell","session_id":"s1","trace_id":"tr1"}`
	ev, err := Parse([]byte(line))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if ev.TraceID != "tr1" {
		t.Errorf("trace_id = %q, want tr1", ev.TraceID)
	}
}

func TestCaptureOnlyEnvelopeDoesNotInventSourceTime(t *testing.T) {
	line := `{"time":"2026-07-02T10:00:00Z","capture_time":"2026-07-02T10:00:00Z","source":"claude-code","category":"prompt"}`
	ev, err := Parse([]byte(line))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if ev.SourceTime != nil {
		t.Errorf("source_time = %v, want absent on capture-only envelope replay", ev.SourceTime)
	}
	wantCapture := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	if ev.CaptureTime == nil || !ev.CaptureTime.Equal(wantCapture) {
		t.Errorf("capture_time = %v, want preserved %v", ev.CaptureTime, wantCapture)
	}
}

func TestArbitraryJSONWrapped(t *testing.T) {
	ev, err := Parse([]byte(`{"foo":"bar","n":1}`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if ev.Source != "generic" || ev.Category != event.CategoryMeta {
		t.Errorf("wrap wrong: %+v", ev)
	}
	if ev.Payload["foo"] != "bar" {
		t.Errorf("payload lost: %+v", ev.Payload)
	}
	if ev.Time.IsZero() {
		t.Error("time should default to now")
	}
}

func TestInvalidLineErrors(t *testing.T) {
	if _, err := Parse([]byte("not json at all")); err == nil {
		t.Error("expected error")
	}
}
