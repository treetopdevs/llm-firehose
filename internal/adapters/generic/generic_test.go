package generic

import (
	"testing"

	"agentfirehose/internal/event"
)

func TestFullEnvelopePassthrough(t *testing.T) {
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-agent","category":"shell","summary":"ran make"}`
	ev, err := Parse([]byte(line))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if ev.Source != "my-agent" || ev.Category != event.CategoryShell || ev.Summary != "ran make" {
		t.Errorf("passthrough mangled: %+v", ev)
	}
	if ev.ID == "" {
		t.Error("missing ID should be filled in")
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
