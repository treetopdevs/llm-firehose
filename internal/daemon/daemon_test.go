package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

func testConfig(t *testing.T) cli.Config {
	t.Helper()
	return cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "spool"),
		PrivacyMode: "balanced",
	}
}

func testServer(t *testing.T, cfg cli.Config) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(New(cfg, t.TempDir(), "test-version").Handler())
	t.Cleanup(ts.Close)
	return ts
}

func mkEvent(i int, ts time.Time) event.Event {
	return event.Event{
		ID:       fmt.Sprintf("ev-%d", i),
		Time:     ts,
		Source:   "generic",
		Category: event.CategoryMeta,
		Summary:  fmt.Sprintf("event %d", i),
	}
}

func TestHealth(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var body struct {
		Status        string `json:"status"`
		Version       string `json:"version"`
		SchemaVersion int    `json:"schema_version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Status != "ok" || body.Version != "test-version" || body.SchemaVersion != event.CurrentSchemaVersion {
		t.Errorf("health = %+v", body)
	}
}

func TestConfigEndpoint(t *testing.T) {
	cfg := testConfig(t)
	ts := testServer(t, cfg)
	resp, err := http.Get(ts.URL + "/config")
	if err != nil {
		t.Fatalf("GET /config: %v", err)
	}
	defer resp.Body.Close()
	var got cli.Config
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.SpoolDir != cfg.SpoolDir || got.PrivacyMode != cfg.PrivacyMode {
		t.Errorf("config = %+v, want %+v", got, cfg)
	}
}

func TestIngestEndpoint(t *testing.T) {
	cfg := testConfig(t)
	ts := testServer(t, cfg)
	body := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"ran make"}` + "\n" +
		`{"custom":"thing"}` + "\n"
	resp, err := http.Post(ts.URL+"/events", "application/x-ndjson", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /events: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		Ingested int `json:"ingested"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Ingested != 2 {
		t.Errorf("ingested = %d, want 2", got.Ingested)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 2 {
		t.Fatalf("spool has %d events, want 2", len(evs))
	}
}

func TestIngestAppliesPrivacyMode(t *testing.T) {
	cfg := testConfig(t)
	cfg.PrivacyMode = "minimal"
	ts := testServer(t, cfg)
	body := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"x","payload":{"secret":"hunter2"}}` + "\n"
	resp, err := http.Post(ts.URL+"/events", "application/x-ndjson", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /events: %v", err)
	}
	resp.Body.Close()
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 {
		t.Fatalf("spool has %d events, want 1", len(evs))
	}
	if _, isMap := evs[0].Payload["secret"].(map[string]any); !isMap {
		t.Errorf("minimal mode must digest payload values, got %+v", evs[0].Payload["secret"])
	}
}

func TestEmitEndpointNormalizesRawPayload(t *testing.T) {
	cfg := testConfig(t)
	ts := testServer(t, cfg)
	payload := `{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"/repo","prompt":"hello"}`
	resp, err := http.Post(ts.URL+"/emit?source=claude-code", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST /emit: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 || evs[0].Source != "claude-code" || evs[0].Category != event.CategoryPrompt {
		t.Fatalf("emit not normalized: %+v", evs)
	}
}

func TestEmitEndpointBadPayload(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := http.Post(ts.URL+"/emit?source=generic", "application/json", strings.NewReader("not json"))
	if err != nil {
		t.Fatalf("POST /emit: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestRecentEvents(t *testing.T) {
	cfg := testConfig(t)
	w := spool.NewWriter(cfg.SpoolDir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	for i := range 3 {
		if err := w.Append(mkEvent(i, base.Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	ts := testServer(t, cfg)
	resp, err := http.Get(ts.URL + "/events?limit=2")
	if err != nil {
		t.Fatalf("GET /events: %v", err)
	}
	defer resp.Body.Close()
	var evs []event.Event
	if err := json.NewDecoder(resp.Body).Decode(&evs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(evs) != 2 || evs[0].ID != "ev-1" || evs[1].ID != "ev-2" {
		t.Fatalf("recent events wrong: %+v", evs)
	}
}

func TestRecentEventsBadLimit(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := http.Get(ts.URL + "/events?limit=bogus")
	if err != nil {
		t.Fatalf("GET /events: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}
