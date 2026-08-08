package capturemeta

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func TestManifestValidate(t *testing.T) {
	valid := Manifest{
		Source:       "opencode",
		Transport:    "plugin",
		Fidelity:     SupportedPassiveStream,
		Mapped:       []string{"session.created", "session.idle"},
		Filtered:     []string{"message.part.delta"},
		SourceSchema: "opencode@1.18.x",
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid manifest: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{"source", func(m *Manifest) { m.Source = "" }},
		{"transport", func(m *Manifest) { m.Transport = "websocket" }},
		{"fidelity", func(m *Manifest) { m.Fidelity = "guessed" }},
		{"duplicate mapped", func(m *Manifest) { m.Mapped = append(m.Mapped, m.Mapped[0]) }},
		{"duplicate filtered", func(m *Manifest) { m.Filtered = append(m.Filtered, m.Filtered[0]) }},
		{"mapped and filtered overlap", func(m *Manifest) { m.Filtered = append(m.Filtered, m.Mapped[0]) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manifest := valid
			manifest.Mapped = append([]string(nil), valid.Mapped...)
			manifest.Filtered = append([]string(nil), valid.Filtered...)
			tt.mutate(&manifest)
			if err := manifest.Validate(); err == nil {
				t.Fatal("Validate() unexpectedly succeeded")
			}
		})
	}
}

func TestUnknownEventIsStableBoundedAndSafe(t *testing.T) {
	now := time.Date(2026, 7, 25, 14, 30, 0, 0, time.UTC)
	reason := "SECRET-MARKER " + strings.Repeat("x", 800)
	first := UnknownEvent("opencode", "plugin", "future.event", "1.18.0", reason, now)
	sameDay := UnknownEvent("opencode", "plugin", "future.event", "1.18.0", "different raw detail", now.Add(time.Hour))
	nextDay := UnknownEvent("opencode", "plugin", "future.event", "1.18.0", reason, now.Add(24*time.Hour))

	if first.ID != sameDay.ID {
		t.Errorf("same native event/day IDs differ: %q != %q", first.ID, sameDay.ID)
	}
	if first.ID == nextDay.ID {
		t.Errorf("next-day ID did not rotate: %q", first.ID)
	}
	if first.Category != event.CategoryMeta || first.Name != "adapter.unknown_event" ||
		first.Severity != event.SeverityWarn || first.Raw != "" {
		t.Errorf("unexpected warning envelope: %+v", first)
	}
	data, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "SECRET-MARKER") || len(first.Summary) > 240 {
		t.Errorf("warning leaked or was unbounded: %s", data)
	}
	for _, key := range []string{"source", "transport", "native_event_name", "source_version", "reason"} {
		if _, ok := first.Payload[key]; !ok {
			t.Errorf("payload missing %q: %+v", key, first.Payload)
		}
	}
	if len(first.Payload) != 5 {
		t.Errorf("payload has unsafe extra fields: %+v", first.Payload)
	}

	oversized := UnknownEvent(
		"opencode",
		"plugin",
		"SECRET-NAME-"+strings.Repeat("n", 800),
		"SECRET-VERSION-"+strings.Repeat("v", 800),
		"untrusted",
		now,
	)
	encoded, _ := json.Marshal(oversized.Payload)
	if len(encoded) > 800 {
		t.Errorf("unknown payload is not bounded: %d bytes", len(encoded))
	}
}

func TestManifestValidateRequiresSourceSchema(t *testing.T) {
	m := Manifest{
		Source:    "test",
		Transport: "hook",
		Fidelity:  SupportedInBandHook,
		Mapped:    []string{"A"},
	}
	if err := m.Validate(); err == nil {
		t.Fatal("empty SourceSchema must not validate")
	}
	m.SourceSchema = "   "
	if err := m.Validate(); err == nil {
		t.Fatal("whitespace SourceSchema must not validate")
	}
	m.SourceSchema = "test@1.0"
	if err := m.Validate(); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
}

func TestUnknownEventIDDiffersByTransport(t *testing.T) {
	now := time.Date(2026, 8, 7, 12, 0, 0, 0, time.UTC)
	a := UnknownEvent("codex", "hook", "SessionStart", "1.0", "r", now)
	b := UnknownEvent("codex", "durable-jsonl", "SessionStart", "1.0", "r", now)
	if a.ID == b.ID {
		t.Fatalf("same ID %q across transports hides one transport's drift", a.ID)
	}
	c := UnknownEvent("codex", "hook", "SessionStart", "1.0", "r", now)
	if a.ID != c.ID {
		t.Fatalf("ID not stable for identical observation: %q vs %q", a.ID, c.ID)
	}
}
