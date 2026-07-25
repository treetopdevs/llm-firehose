package daemon

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

func TestOTLPLogsPersistSanitizedEventsAndReturnSuccess(t *testing.T) {
	cfg := testConfig(t)
	ts := testServer(t, cfg)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/logs",
		strings.NewReader(string(otelFixture(t, "logs.json"))))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var response map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		t.Fatalf("OTLP success response: %v", err)
	}

	events, err := spool.ReadLastN(cfg.SpoolDir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("spooled logs = %d, want 3: %+v", len(events), events)
	}
	assertNoOTelSecrets(t, events)
}

func TestOTLPMetricsPersistSanitizedEvents(t *testing.T) {
	cfg := testConfig(t)
	ts := testServer(t, cfg)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/metrics",
		strings.NewReader(string(otelFixture(t, "metrics.json"))))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	events, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(events) != 2 || events[0].Name != "claude_code.token.usage" {
		t.Fatalf("spooled metrics = %+v", events)
	}
	assertNoOTelSecrets(t, events)
}

func TestOTLPMalformedRecordReturnsSuccessAndPersistsWarning(t *testing.T) {
	cfg := testConfig(t)
	ts := testServer(t, cfg)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/logs", strings.NewReader(`{"resourceLogs":`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("malformed batch status = %d, want OTLP success", resp.StatusCode)
	}
	events, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(events) != 1 || events[0].Name != "otel.parse_warning" ||
		events[0].Severity != event.SeverityWarn {
		t.Fatalf("malformed batch warning = %+v", events)
	}
}

func TestOTLPRejectsOversizedBodiesAndBrowserOrigins(t *testing.T) {
	ts := testServer(t, testConfig(t))
	oversized, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/logs",
		strings.NewReader(strings.Repeat("x", maxOTLPBodyBytes+1)))
	oversized.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(oversized)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d, want 413", resp.StatusCode)
	}

	browser, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/logs", strings.NewReader(`{}`))
	browser.Header.Set("Content-Type", "application/json")
	browser.Header.Set("Origin", "tauri://localhost")
	resp, err = http.DefaultClient.Do(browser)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("browser-origin status = %d, want 403", resp.StatusCode)
	}
}

func assertNoOTelSecrets(t *testing.T, events []event.Event) {
	t.Helper()
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "SECRET-") {
		t.Fatalf("OTel identity/content reached spool: %s", encoded)
	}
}

func otelFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "adapters", "claudeotel", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}
