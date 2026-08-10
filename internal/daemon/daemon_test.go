package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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

func testGET(t *testing.T, rawURL string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	return http.DefaultClient.Do(req)
}

func testPOST(t *testing.T, rawURL, contentType string, body io.Reader) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, rawURL, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return http.DefaultClient.Do(req)
}

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

func TestRunServesUntilCanceled(t *testing.T) {
	cfg := testConfig(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, cfg, t.TempDir(), "test-version", "127.0.0.1:0", func(bound string) { ready <- bound })
	}()

	var bound string
	select {
	case bound = <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("Run never became ready")
	}
	resp, err := testGET(t, "http://"+bound+"/health")
	if err != nil {
		t.Fatalf("GET /health while running: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d, want 200", resp.StatusCode)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v on clean shutdown, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}

// Desktop-shell webviews call the API from tauri://localhost (and the vite
// dev server); those origins get CORS access. Arbitrary web origins must
// not — a random website may not read the local event feed.
func TestCORSAllowsDesktopShellOnly(t *testing.T) {
	ts := testServer(t, testConfig(t))

	for _, origin := range []string{"tauri://localhost", "http://tauri.localhost", "http://localhost:1420"} {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/health", nil)
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET /health: %v", err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("origin %s: ACAO = %q, want echoed origin", origin, got)
		}
	}

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin got ACAO %q, want none", got)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("disallowed origin status = %d, want 403", resp.StatusCode)
	}
}

func TestCORSPreflight(t *testing.T) {
	ts := testServer(t, testConfig(t))
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/config", nil)
	req.Header.Set("Origin", "tauri://localhost")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("OPTIONS /config: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Methods"); !strings.Contains(got, "POST") {
		t.Errorf("allow-methods = %q, want POST included", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(strings.ToLower(got), "content-type") {
		t.Errorf("allow-headers = %q, want content-type included", got)
	}
}

func TestServeRejectsNonLoopbackAddresses(t *testing.T) {
	s := New(testConfig(t), t.TempDir(), "test-version")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for _, addr := range []string{"0.0.0.0:0", "[::]:0", ":0", "192.0.2.10:4517"} {
		if _, _, err := s.Serve(ctx, addr); err == nil {
			t.Errorf("Serve(%q) succeeded, want a loopback-only error", addr)
		}
	}
}

func TestHealth(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := testGET(t, ts.URL+"/health")
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
	resp, err := testGET(t, ts.URL+"/config")
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

func TestConfigUpdateEndpoint(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	ts := httptest.NewServer(New(cfg, home, "test-version").Handler())
	t.Cleanup(ts.Close)

	resp, err := testPOST(t, ts.URL+"/config", "application/json", strings.NewReader(`{"privacy_mode":"minimal"}`))
	if err != nil {
		t.Fatalf("POST /config: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	// live: GET /config reflects the new mode immediately
	get, err := testGET(t, ts.URL+"/config")
	if err != nil {
		t.Fatalf("GET /config: %v", err)
	}
	defer get.Body.Close()
	var live cli.Config
	if err := json.NewDecoder(get.Body).Decode(&live); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if live.PrivacyMode != "minimal" {
		t.Errorf("live privacy = %q, want minimal", live.PrivacyMode)
	}

	// persisted: config.json under the daemon's home carries the change
	saved, err := cli.LoadConfig(home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if saved.PrivacyMode != "minimal" {
		t.Errorf("saved privacy = %q, want minimal", saved.PrivacyMode)
	}
	if saved.SpoolDir != cfg.SpoolDir {
		t.Errorf("saved spool dir = %q, want %q", saved.SpoolDir, cfg.SpoolDir)
	}
}

func TestConfigUpdateRestartRequiredFields(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	ts := httptest.NewServer(New(cfg, home, "test-version").Handler())
	t.Cleanup(ts.Close)

	newSpool := filepath.Join(home, "elsewhere")
	resp, err := testPOST(t, ts.URL+"/config", "application/json",
		strings.NewReader(`{"spool_dir":"`+newSpool+`"}`))
	if err != nil {
		t.Fatalf("POST /config: %v", err)
	}
	defer resp.Body.Close()
	var got struct {
		RestartRequired []string `json:"restart_required"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.RestartRequired) != 1 || got.RestartRequired[0] != "spool_dir" {
		t.Errorf("restart_required = %v, want [spool_dir]", got.RestartRequired)
	}
	// runtime keeps the old spool dir; disk carries the new one
	get, err := testGET(t, ts.URL+"/config")
	if err != nil {
		t.Fatalf("GET /config: %v", err)
	}
	defer get.Body.Close()
	var live cli.Config
	json.NewDecoder(get.Body).Decode(&live)
	if live.SpoolDir != cfg.SpoolDir {
		t.Errorf("runtime spool dir changed without restart: %q", live.SpoolDir)
	}
	saved, _ := cli.LoadConfig(home)
	if saved.SpoolDir != newSpool {
		t.Errorf("saved spool dir = %q, want %q", saved.SpoolDir, newSpool)
	}
}

func TestConfigUpdateRejectsBadMode(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := testPOST(t, ts.URL+"/config", "application/json", strings.NewReader(`{"privacy_mode":"everything"}`))
	if err != nil {
		t.Fatalf("POST /config: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestIngestEndpoint(t *testing.T) {
	cfg := testConfig(t)
	ts := testServer(t, cfg)
	body := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"ran make"}` + "\n" +
		`{"custom":"thing"}` + "\n"
	resp, err := testPOST(t, ts.URL+"/events", "application/x-ndjson", strings.NewReader(body))
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
	resp, err := testPOST(t, ts.URL+"/events", "application/x-ndjson", strings.NewReader(body))
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
	resp, err := testPOST(t, ts.URL+"/emit?source=claude-code", "application/json", strings.NewReader(payload))
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
	resp, err := testPOST(t, ts.URL+"/emit?source=generic", "application/json", strings.NewReader("not json"))
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
	resp, err := testGET(t, ts.URL+"/events?limit=2")
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
	resp, err := testGET(t, ts.URL+"/events?limit=bogus")
	if err != nil {
		t.Fatalf("GET /events: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestRecentEventsClampsMaxLimit(t *testing.T) {
	cfg := testConfig(t)
	w := spool.NewWriter(cfg.SpoolDir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	if err := w.Append(mkEvent(0, base)); err != nil {
		t.Fatal(err)
	}
	ts := testServer(t, cfg)
	resp, err := testGET(t, fmt.Sprintf("%s/events?limit=%d", ts.URL, maxRecentLimit+1))
	if err != nil {
		t.Fatalf("GET /events: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (oversized limit clamped)", resp.StatusCode)
	}
	var evs []event.Event
	if err := json.NewDecoder(resp.Body).Decode(&evs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(evs) != 1 || evs[0].ID != "ev-0" {
		t.Fatalf("clamped recent = %+v", evs)
	}
}
