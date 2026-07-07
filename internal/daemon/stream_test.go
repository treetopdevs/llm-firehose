package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
)

// startedServer runs a daemon with capture started against fast pollers.
func startedServer(t *testing.T, cfg cli.Config) *httptest.Server {
	t.Helper()
	s := New(cfg, t.TempDir(), "test-version")
	s.TailInterval = 10 * time.Millisecond
	s.WatchInterval = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s.Start(ctx)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// streamEvents connects to /events/stream and forwards decoded events.
func streamEvents(t *testing.T, url string) <-chan event.Event {
	t.Helper()
	resp, err := http.Get(url + "/events/stream")
	if err != nil {
		t.Fatalf("GET /events/stream: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	ch := make(chan event.Event, 16)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev event.Event
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev) == nil {
				ch <- ev
			}
		}
	}()
	return ch
}

// waitFor drains ch until an event matches or the deadline passes.
func waitFor(t *testing.T, ch <-chan event.Event, want string) event.Event {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Summary == want {
				return ev
			}
		case <-deadline:
			t.Fatalf("no streamed event with summary %q", want)
		}
	}
}

func TestStreamDeliversIngestedEvents(t *testing.T) {
	cfg := testConfig(t)
	ts := startedServer(t, cfg)
	ch := streamEvents(t, ts.URL)

	time.Sleep(30 * time.Millisecond) // let the tailer record initial offsets
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"stream me"}` + "\n"
	resp, err := http.Post(ts.URL+"/events", "application/x-ndjson", strings.NewReader(line))
	if err != nil {
		t.Fatalf("POST /events: %v", err)
	}
	resp.Body.Close()

	ev := waitFor(t, ch, "stream me")
	if ev.Source != "my-tool" || ev.Category != event.CategoryShell {
		t.Errorf("streamed event mangled: %+v", ev)
	}
}

func TestStreamFanOutToMultipleSubscribers(t *testing.T) {
	cfg := testConfig(t)
	ts := startedServer(t, cfg)
	ch1 := streamEvents(t, ts.URL)
	ch2 := streamEvents(t, ts.URL)

	time.Sleep(30 * time.Millisecond)
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"fan out"}` + "\n"
	resp, err := http.Post(ts.URL+"/events", "application/x-ndjson", strings.NewReader(line))
	if err != nil {
		t.Fatalf("POST /events: %v", err)
	}
	resp.Body.Close()

	waitFor(t, ch1, "fan out")
	waitFor(t, ch2, "fan out")
}

// The engine owns codex capture: session files are tailed, redacted per the
// configured privacy mode, and broadcast — clients never touch codex files.
func TestStreamIncludesRedactedCodexEvents(t *testing.T) {
	cfg := testConfig(t)
	cfg.PrivacyMode = "minimal"
	cfg.CodexDir = t.TempDir()
	ts := startedServer(t, cfg)
	ch := streamEvents(t, ts.URL)

	time.Sleep(30 * time.Millisecond) // let the watcher record initial state
	day := filepath.Join(cfg.CodexDir, "2026", "07", "02")
	os.MkdirAll(day, 0o755)
	lines := `{"timestamp":"2026-05-07T15:12:00.000Z","type":"session_meta","payload":{"id":"sess-codex-1","timestamp":"2026-05-07T15:11:59.000Z","cwd":"/Users/x/proj","originator":"Codex CLI","cli_version":"0.100.0","source":"vscode"}}` + "\n" +
		`{"timestamp":"2026-07-02T10:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello codex"}}` + "\n"
	os.WriteFile(filepath.Join(day, "rollout-2026-07-02T10-00-00-abc.jsonl"), []byte(lines), 0o644)

	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Source != "codex" || ev.Category != event.CategoryPrompt {
				continue
			}
			if _, isMap := ev.Payload["message"].(map[string]any); !isMap {
				t.Fatalf("codex payload must be digested in minimal mode: %+v", ev.Payload)
			}
			return
		case <-deadline:
			t.Fatal("no codex prompt event streamed")
		}
	}
}
