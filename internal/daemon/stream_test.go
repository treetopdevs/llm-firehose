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
	"sync"
	"testing"
	"time"

	"agentfirehose/internal/adapters/procwatch"
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
	t.Cleanup(func() {
		cancel()
		s.Wait()
	})
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

func capturedCodexLine(t *testing.T, marker string) string {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "adapters", "codex", "testdata", "rollout_current_sanitized.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.Contains(sc.Text(), marker) {
			return sc.Text()
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	t.Fatalf("captured Codex fixture has no line containing %q", marker)
	return ""
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

func TestStreamBroadcastsStateTransition(t *testing.T) {
	cfg := testConfig(t)
	ts := startedServer(t, cfg)
	ch := streamEvents(t, ts.URL)

	time.Sleep(30 * time.Millisecond)
	line := `{"id":"p1","time":"2026-07-08T12:00:00Z","source":"claude-code","category":"permission","name":"Notification","session_id":"orb1","summary":"Claude needs your permission to use Bash","severity":"notice"}` + "\n"
	resp, err := http.Post(ts.URL+"/events", "application/x-ndjson", strings.NewReader(line))
	if err != nil {
		t.Fatalf("POST /events: %v", err)
	}
	resp.Body.Close()

	deadline := time.After(3 * time.Second)
	sawPerm, sawTransition := false, false
	for !(sawPerm && sawTransition) {
		select {
		case ev := <-ch:
			if ev.Category == event.CategoryPermission && ev.SessionID == "orb1" {
				sawPerm = true
			}
			if ev.Source == "firehose" && ev.Name == "state.transition" && ev.SessionID == "orb1" {
				sawTransition = true
				if ev.Payload["state"] != "needs_input" {
					t.Errorf("transition state = %v, want needs_input", ev.Payload["state"])
				}
			}
		case <-deadline:
			t.Fatalf("sawPerm=%v sawTransition=%v", sawPerm, sawTransition)
		}
	}

	resp, err = http.Get(ts.URL + "/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sessions []Session
	if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range sessions {
		if s.ID == "orb1" {
			found = true
			if string(s.State) != "needs_input" {
				t.Errorf("session state = %q, want needs_input", s.State)
			}
			if s.StateReason == "" {
				t.Error("expected state_reason")
			}
		}
	}
	if !found {
		t.Fatal("orb1 not in /sessions")
	}
}

// The spool is the canonical source of truth: codex watcher events must be
// persisted (redacted at the engine boundary), reach the derived index, and
// stream exactly once.
func TestCodexEventsPersistedToSpoolAndIndex(t *testing.T) {
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

	// The prompt streams once (via the spool tail), never twice.
	var prompt event.Event
	deadline := time.After(3 * time.Second)
waitPrompt:
	for {
		select {
		case ev := <-ch:
			if ev.Source == "codex" && ev.Category == event.CategoryPrompt {
				prompt = ev
				break waitPrompt
			}
		case <-deadline:
			t.Fatal("no codex prompt event streamed")
		}
	}
	quiet := time.After(300 * time.Millisecond)
	for {
		select {
		case ev := <-ch:
			if ev.ID == prompt.ID {
				t.Fatal("codex event streamed twice")
			}
		case <-quiet:
		}
		break
	}

	// Persisted in the spool, redacted per the configured minimal mode.
	resp, err := http.Get(ts.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var evs []event.Event
	if err := json.NewDecoder(resp.Body).Decode(&evs); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ev := range evs {
		if ev.Source != "codex" || ev.Category != event.CategoryPrompt {
			continue
		}
		found = true
		if _, isMap := ev.Payload["message"].(map[string]any); !isMap {
			t.Errorf("spooled codex payload must be digested in minimal mode: %+v", ev.Payload)
		}
	}
	if !found {
		t.Fatal("codex prompt event not persisted to spool")
	}

	// Reached the derived index, so a rebuild sees the session too.
	resp, err = http.Get(ts.URL + "/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sessions []Session
	if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
		t.Fatal(err)
	}
	found = false
	for _, s := range sessions {
		if s.ID == "sess-codex-1" {
			found = true
		}
	}
	if !found {
		t.Fatal("sess-codex-1 not in /sessions")
	}
}

func TestDaemonRestartReplaysMissedCodexLinesAndDeduplicatesStableIDs(t *testing.T) {
	cfg := testConfig(t)
	cfg.CodexDir = t.TempDir()
	home := t.TempDir()
	rolloutDir := filepath.Join(cfg.CodexDir, "2026", "07", "25")
	if err := os.MkdirAll(rolloutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rolloutPath := filepath.Join(rolloutDir, "rollout-restart.jsonl")
	sessionLine := capturedCodexLine(t, `"type":"session_meta"`)

	start := func() (*httptest.Server, func()) {
		s := New(cfg, home, "test-version")
		s.TailInterval = 10 * time.Millisecond
		s.WatchInterval = 10 * time.Millisecond
		s.ProcLister = &fakeLister{}
		ctx, cancel := context.WithCancel(context.Background())
		s.Start(ctx)
		ts := httptest.NewServer(s.Handler())
		var once sync.Once
		stop := func() {
			once.Do(func() {
				cancel()
				s.Wait()
				ts.Close()
			})
		}
		return ts, stop
	}
	readEvents := func(url string) []event.Event {
		t.Helper()
		resp, err := http.Get(url + "/events")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var evs []event.Event
		if err := json.NewDecoder(resp.Body).Decode(&evs); err != nil {
			t.Fatal(err)
		}
		return evs
	}
	waitEvents := func(url string, n int) []event.Event {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			evs := readEvents(url)
			if len(evs) >= n {
				return evs
			}
			if time.Now().After(deadline) {
				t.Fatalf("/events has %d events, want at least %d", len(evs), n)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	ts1, stop1 := start()
	t.Cleanup(stop1)
	if err := os.WriteFile(rolloutPath, []byte(sessionLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first := waitEvents(ts1.URL, 1)[0]
	stop1()

	missedLine := capturedCodexLine(t, `"type":"agent_message"`)
	f, err := os.OpenFile(rolloutPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(missedLine + "\n"); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	// Model the crash window after the first spool append but before the
	// cursor advance. The pending stable id makes the restart replay
	// at-least-once without turning it into a second logical observation.
	statePath := filepath.Join(home, ".agentfirehose", "state", "codex-cursors.json")
	state := map[string]any{
		"saved_at": time.Now().UTC(),
		"files": map[string]any{
			rolloutPath: map[string]any{
				"offset":       0,
				"parser":       map[string]any{},
				"pending_id":   first.ID,
				"pending_next": len(sessionLine) + 1,
			},
		},
	}
	stateData, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, stateData, 0o600); err != nil {
		t.Fatal(err)
	}

	ts2, stop2 := start()
	t.Cleanup(stop2)
	evs := waitEvents(ts2.URL, 3)
	counts := map[string]int{}
	for _, ev := range evs {
		counts[ev.ID]++
	}
	if counts[first.ID] != 2 {
		t.Fatalf("raw at-least-once replay count for %q = %d, want 2", first.ID, counts[first.ID])
	}
	if len(counts) != 2 {
		t.Fatalf("unique stable ids = %d, want 2 across replay plus missed line: %+v", len(counts), evs)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		resp, err := http.Get(ts2.URL + "/sessions")
		if err != nil {
			t.Fatal(err)
		}
		var sessions []Session
		err = json.NewDecoder(resp.Body).Decode(&sessions)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		for _, session := range sessions {
			if session.ID == "019f944c-e8a2-7092-b9e2-1bdfe7ec4ded" && session.Events == 2 {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("deduplicated restarted session did not reach 2 logical events: %+v", sessions)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// fakeLister is an injectable process table for procwatch persistence tests.
type fakeLister struct {
	mu    sync.Mutex
	procs []procwatch.Process
}

func (l *fakeLister) List() ([]procwatch.Process, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]procwatch.Process(nil), l.procs...), nil
}

func (l *fakeLister) set(procs ...procwatch.Process) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.procs = procs
}

func TestProcwatchEventsPersistedToSpool(t *testing.T) {
	cfg := testConfig(t)
	s := New(cfg, t.TempDir(), "test-version")
	s.TailInterval = 10 * time.Millisecond
	s.WatchInterval = 10 * time.Millisecond
	s.ProcInterval = 10 * time.Millisecond
	fl := &fakeLister{}
	s.ProcLister = fl
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		s.Wait()
	})
	s.Start(ctx)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	time.Sleep(50 * time.Millisecond) // let the baseline poll pass
	fl.set(procwatch.Process{PID: 4242, Command: "/usr/local/bin/claude"})

	deadline := time.Now().Add(3 * time.Second)
	for {
		resp, err := http.Get(ts.URL + "/events")
		if err != nil {
			t.Fatal(err)
		}
		var evs []event.Event
		err = json.NewDecoder(resp.Body).Decode(&evs)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range evs {
			if ev.Source == "procwatch" && ev.Name == "agent-start" && ev.Agent == "claude" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("procwatch agent-start not persisted to spool")
		}
		time.Sleep(20 * time.Millisecond)
	}
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
