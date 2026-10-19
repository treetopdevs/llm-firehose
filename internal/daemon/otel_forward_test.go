package daemon

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"agentfirehose/internal/cli"
)

type forwarded struct {
	path, contentType string
	body              []byte
}

// collector is a stand-in for the user's existing OTLP collector.
func collector(t *testing.T, block <-chan struct{}) (*httptest.Server, <-chan forwarded) {
	t.Helper()
	got := make(chan forwarded, 256)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got <- forwarded{r.URL.Path, r.Header.Get("Content-Type"), body}
		if block != nil {
			<-block
		}
	}))
	t.Cleanup(ts.Close)
	return ts, got
}

func writeForwardFile(t *testing.T, home, body string) {
	t.Helper()
	path := cli.OTelForwardPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func forwardServer(t *testing.T, home string) (*Server, *httptest.Server) {
	t.Helper()
	cfg := testConfig(t)
	srv := New(testEngine(t, cfg), cfg, home, "test-version")
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

func postOTLP(t *testing.T, base, path string, body []byte) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, base+path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func TestOTLPForwardsRawBodyToTheExistingCollector(t *testing.T) {
	target, got := collector(t, nil)
	home := t.TempDir()
	writeForwardFile(t, home, fmt.Sprintf(`{"logs":%q,"metrics":%q}`, target.URL+"/v1/logs", target.URL+"/v1/metrics"))
	srv, ts := forwardServer(t, home)
	body := otelFixture(t, "logs.json")
	if resp := postOTLP(t, ts.URL, "/v1/logs", body); resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	metrics := otelFixture(t, "metrics.json")
	postOTLP(t, ts.URL, "/v1/metrics", metrics)

	for _, want := range []forwarded{{"/v1/logs", "application/json", body}, {"/v1/metrics", "application/json", metrics}} {
		select {
		case f := <-got:
			if f.path != want.path || f.contentType != want.contentType || string(f.body) != string(want.body) {
				t.Fatalf("forwarded %s %q (%d bytes), want %s %q (%d bytes)", f.path, f.contentType, len(f.body), want.path, want.contentType, len(want.body))
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("nothing forwarded to %s", want.path)
		}
	}
	events, err := srv.engine.Recent(20)
	if err != nil || len(events) == 0 {
		t.Fatalf("local capture must be unaffected by forwarding: %v %v", events, err)
	}
}

func TestOTLPForwardFailureNeverBlocksTheExporterAndWarnsOnce(t *testing.T) {
	dead, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := dead.Addr().String()
	dead.Close() // nothing listens here any more
	home := t.TempDir()
	writeForwardFile(t, home, fmt.Sprintf(`{"logs":"http://%s/v1/logs"}`, addr))
	srv, ts := forwardServer(t, home)

	for i := 0; i < 3; i++ {
		start := time.Now()
		if resp := postOTLP(t, ts.URL, "/v1/logs", otelFixture(t, "logs.json")); resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		if time.Since(start) > time.Second {
			t.Fatalf("exporter waited %s on a dead collector", time.Since(start))
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		warnings := 0
		events, _ := srv.engine.Recent(100)
		for _, ev := range events {
			if ev.Name == "otel_forward_error" {
				warnings++
			}
		}
		if warnings == 1 {
			time.Sleep(200 * time.Millisecond) // a second warning would land by now
			events, _ = srv.engine.Recent(100)
			warnings = 0
			for _, ev := range events {
				if ev.Name == "otel_forward_error" {
					warnings++
				}
			}
			if warnings != 1 {
				t.Fatalf("forward failures warned %d times, want once until recovery", warnings)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no otel_forward_error warning surfaced (saw %d)", warnings)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestOTLPForwardDropsOldestWhenTheCollectorStalls(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	target, _ := collector(t, release)
	home := t.TempDir()
	writeForwardFile(t, home, fmt.Sprintf(`{"logs":%q}`, target.URL+"/v1/logs"))
	srv, ts := forwardServer(t, home)

	start := time.Now()
	for i := 0; i < forwardQueueDepth*2+5; i++ {
		postOTLP(t, ts.URL, "/v1/logs", otelFixture(t, "logs.json"))
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("a stalled collector slowed the exporter: %s", time.Since(start))
	}
	if srv.forwarder.dropped.Load() == 0 {
		t.Fatal("queue overflowed without dropping anything")
	}
	once.Do(func() { close(release) })
}

func TestOTLPForwardTargetsAreReloadedAndMustBeLoopback(t *testing.T) {
	target, got := collector(t, nil)
	home := t.TempDir()
	srv, ts := forwardServer(t, home)

	postOTLP(t, ts.URL, "/v1/logs", otelFixture(t, "logs.json"))
	select {
	case f := <-got:
		t.Fatalf("forwarded with no forwarding configured: %+v", f)
	case <-time.After(150 * time.Millisecond):
	}

	writeForwardFile(t, home, fmt.Sprintf(`{"logs":%q}`, target.URL+"/v1/logs"))
	postOTLP(t, ts.URL, "/v1/logs", otelFixture(t, "logs.json"))
	select {
	case <-got:
	case <-time.After(3 * time.Second):
		t.Fatal("an install made while the daemon runs was not picked up")
	}

	for _, bad := range []string{"http://example.com/v1/logs", "https://127.0.0.1:1738/v1/logs", "http://user:pw@127.0.0.1:1738/v1/logs", "http://127.0.0.1:4517/v1/logs"} {
		writeForwardFile(t, home, fmt.Sprintf(`{"logs":%q}`, bad))
		if tg := srv.forwarder.targets(); tg.Logs != "" {
			t.Errorf("target %q accepted", bad)
		}
	}
}

func TestInstallEndpointClaudeOTelForwardBody(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	settings := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settings), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"http://127.0.0.1:1738","OTEL_EXPORTER_OTLP_PROTOCOL":"http/json","OTEL_LOGS_EXPORTER":"otlp","OTEL_METRICS_EXPORTER":"otlp"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := New(testEngine(t, cfg), cfg, home, "test-version")
	srv.Environ = []string{"PATH=/usr/bin"}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Post(ts.URL+"/install/claude-otel", "application/json", strings.NewReader(`{"forward":true}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("forward install status = %d", resp.StatusCode)
	}
	targets, err := cli.LoadOTelForward(home)
	if err != nil || targets.Logs != "http://127.0.0.1:1738/v1/logs" {
		t.Fatalf("forward targets = %+v, %v", targets, err)
	}
	both, err := http.Post(ts.URL+"/install/claude-otel", "application/json", strings.NewReader(`{"forward":true,"replace":true}`))
	if err != nil {
		t.Fatal(err)
	}
	both.Body.Close()
	if both.StatusCode != http.StatusBadRequest {
		t.Fatalf("forward+replace status = %d, want 400", both.StatusCode)
	}
}
