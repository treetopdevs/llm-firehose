package claudeotel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

var fixtureCaptureTime = time.Date(2026, 7, 25, 16, 0, 0, 0, time.UTC)

func TestParseRealLogBatchMapsSafeMetadata(t *testing.T) {
	events := ParseLogs(fixture(t, "logs.json"), fixtureCaptureTime)
	if len(events) != 3 {
		t.Fatalf("log events = %d, want 3: %+v", len(events), events)
	}
	prompt, api, tool := events[0], events[1], events[2]
	if prompt.Category != event.CategoryPrompt || prompt.SessionID != "session-fixture" ||
		prompt.PromptID != "prompt-fixture" || prompt.MessageID != "message-fixture" {
		t.Fatalf("prompt correlation = %+v", prompt)
	}
	if prompt.Sequence == nil || *prompt.Sequence != 1 {
		t.Fatalf("prompt sequence = %v, want 1", prompt.Sequence)
	}
	if api.RequestID != "request-fixture" || api.Payload["client_request_id"] != "client-request-fixture" {
		t.Fatalf("request correlation = %+v", api)
	}
	if api.Payload["input_tokens"] != int64(10) || api.Payload["cost_usd"] != 0.125 {
		t.Fatalf("usage allowlist = %+v", api.Payload)
	}
	if tool.Category != event.CategoryTool || tool.CallID != "tool-fixture" ||
		tool.Payload["success"] != "true" {
		t.Fatalf("tool metadata = %+v", tool)
	}
	for _, ev := range events {
		assertSanitized(t, ev)
		if !ev.Time.Equal(fixtureCaptureTime) || ev.CaptureTime == nil ||
			!ev.CaptureTime.Equal(fixtureCaptureTime) || ev.SourceTime == nil {
			t.Fatalf("safe source/capture timing = %+v", ev)
		}
		if ev.SourceVersion != "2.1.218" || ev.Transport != Transport {
			t.Fatalf("source metadata = %+v", ev)
		}
	}
}

func TestParseRealMetricBatchMapsSafeUsage(t *testing.T) {
	events := ParseMetrics(fixture(t, "metrics.json"), fixtureCaptureTime)
	if len(events) != 2 {
		t.Fatalf("metric events = %d, want 2: %+v", len(events), events)
	}
	token, cost := events[0], events[1]
	if token.Name != "claude_code.token.usage" || token.Payload["value"] != 20.0 ||
		token.Payload["unit"] != "tokens" || token.Payload["type"] != "output" {
		t.Fatalf("token metric = %+v", token)
	}
	if cost.Name != "claude_code.cost.usage" || cost.Payload["value"] != 0.125 ||
		cost.Payload["unit"] != "USD" {
		t.Fatalf("cost metric = %+v", cost)
	}
	for _, ev := range events {
		assertSanitized(t, ev)
	}
}

func TestMalformedRecordProducesBoundedWarningWithoutDroppingSiblings(t *testing.T) {
	raw := []byte(`{"resourceLogs":[{"scopeLogs":[{"scope":{"version":"2.1.218"},"logRecords":[` +
		`{"timeUnixNano":"1784995425549000000","attributes":[` +
		`{"key":"event.name","value":{"stringValue":"api_request"}},` +
		`{"key":"session.id","value":{"stringValue":"s1"}}]},42]}]}]}`)
	events := ParseLogs(raw, fixtureCaptureTime)
	if len(events) != 2 || events[0].Name != "api_request" || events[1].Name != "otel.parse_warning" {
		t.Fatalf("partial malformed batch = %+v", events)
	}
	assertSanitized(t, events[1])
}

func TestAttributeLimitSkipsOversizedRecord(t *testing.T) {
	attrs := make([]map[string]any, maxAttributesPerRecord+1)
	for i := range attrs {
		attrs[i] = map[string]any{
			"key":   "model",
			"value": map[string]any{"stringValue": "safe"},
		}
	}
	record, _ := json.Marshal(map[string]any{"attributes": attrs})
	batch := []byte(`{"resourceLogs":[{"scopeLogs":[{"logRecords":[` + string(record) + `]}]}]}`)
	events := ParseLogs(batch, fixtureCaptureTime)
	if len(events) != 1 || events[0].Name != "otel.parse_warning" {
		t.Fatalf("oversized record = %+v, want one bounded warning", events)
	}
}

func TestManifestIsValid(t *testing.T) {
	if err := Manifest.Validate(); err != nil {
		t.Fatalf("manifest: %v", err)
	}
}

func assertSanitized(t *testing.T, ev event.Event) {
	t.Helper()
	encoded, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "SECRET-") {
		t.Fatalf("identity/content marker escaped allowlist: %s", encoded)
	}
	if ev.Raw != "" {
		t.Fatalf("OTel raw payload must never be retained: %q", ev.Raw)
	}
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return data
}
