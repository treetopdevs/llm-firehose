// Tests run the real daemon handler so the client is verified against the
// actual API, not a hand-rolled fake.
package client_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/client"
	"agentfirehose/internal/daemon"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/spool"
)

func testDaemon(t *testing.T) (*httptest.Server, cli.Config) {
	t.Helper()
	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "spool"),
		PrivacyMode: "balanced",
	}
	engine, err := capture.New(capture.Options{SpoolDir: cfg.SpoolDir, Policy: privacy.ModeBalanced})
	if err != nil {
		t.Fatal(err)
	}
	s := daemon.New(engine, cfg, t.TempDir(), "test-version")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, cfg
}

func TestHealth(t *testing.T) {
	ts, _ := testDaemon(t)
	c := client.New(ts.URL)
	h, err := c.Health(t.Context())
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if h.Status != "ok" || h.Version != "test-version" || h.SchemaVersion != event.CurrentSchemaVersion {
		t.Errorf("health = %+v", h)
	}
}

func TestHealthDaemonDown(t *testing.T) {
	c := client.New("http://127.0.0.1:1")
	if _, err := c.Health(t.Context()); err == nil {
		t.Fatal("Health must fail when no daemon is listening")
	}
}

func TestRecent(t *testing.T) {
	ts, cfg := testDaemon(t)
	w := spool.NewWriter(cfg.SpoolDir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	for i, id := range []string{"e0", "e1", "e2"} {
		ev := event.Event{ID: id, Time: base.Add(time.Duration(i) * time.Second),
			Source: "generic", Category: event.CategoryMeta}
		if _, err := w.Append(ev); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	c := client.New(ts.URL)
	evs, err := c.Recent(t.Context(), 2)
	if err != nil {
		t.Fatalf("Recent: %v", err)
	}
	if len(evs) != 2 || evs[0].ID != "e1" || evs[1].ID != "e2" {
		t.Fatalf("recent = %+v", evs)
	}
}

func TestSessionsReturnsProjectedAttention(t *testing.T) {
	ts, _ := testDaemon(t)
	c := client.New(ts.URL)
	payload := `{"id":"permission-1","time":"2026-08-17T12:00:00Z","source":"claude-code","category":"permission","session_id":"waiting","summary":"approve Bash"}`
	if err := c.Emit(t.Context(), "generic", strings.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	sessions, err := c.Sessions(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].ID != "waiting" || sessions[0].State != "needs_input" {
		t.Fatalf("sessions = %+v", sessions)
	}
}

func TestEmitNormalizesThroughDaemon(t *testing.T) {
	ts, cfg := testDaemon(t)
	c := client.New(ts.URL)
	payload := `{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"/repo","prompt":"hi"}`
	if err := c.Emit(t.Context(), "claude-code", strings.NewReader(payload)); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 || evs[0].Source != "claude-code" || evs[0].Category != event.CategoryPrompt {
		t.Fatalf("emitted event wrong: %+v", evs)
	}
}

func TestStreamDeliversLiveEvents(t *testing.T) {
	ts, _ := testDaemon(t)
	c := client.New(ts.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := c.Stream(ctx)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	// Readiness handshake: wait until the live stream delivers a probe so the
	// tailer has recorded initial offsets before the event under test.
	probe := `{"time":"2026-07-02T09:59:00Z","source":"probe","category":"meta","summary":"stream-ready"}`
	if err := c.Emit(t.Context(), "generic", strings.NewReader(probe)); err != nil {
		t.Fatalf("probe Emit: %v", err)
	}
	deadline := time.After(3 * time.Second)
ready:
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("stream closed before probe")
			}
			if ev.Summary == "stream-ready" {
				break ready
			}
		case <-deadline:
			t.Fatal("stream not ready (probe not delivered)")
		}
	}

	line := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"via client"}`
	if err := c.Emit(t.Context(), "generic", strings.NewReader(line)); err != nil {
		t.Fatalf("Emit: %v", err)
	}

	deadline = time.After(3 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("stream closed before delivering event")
			}
			if ev.Summary == "via client" {
				if ev.Source != "my-tool" {
					t.Errorf("event mangled: %+v", ev)
				}
				return
			}
		case <-deadline:
			t.Fatal("no event delivered through client stream")
		}
	}
}

func TestStreamClosesOnCancel(t *testing.T) {
	ts, _ := testDaemon(t)
	c := client.New(ts.URL)
	ctx, cancel := context.WithCancel(context.Background())
	ch, err := c.Stream(ctx)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	cancel()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("stream channel not closed after cancel")
		}
	}
}

func TestFeedReconcilesHistoryBeforeReplacingClosedStream(t *testing.T) {
	var histories, streams atomic.Int32
	e1 := event.Event{ID: "history-1", Time: time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC), Source: "generic", Category: event.CategoryMeta}
	e2 := event.Event{ID: "gap-2", Time: e1.Time.Add(time.Second), Source: "generic", Category: event.CategoryMeta}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/events":
			call := histories.Add(1)
			if call == 1 {
				_ = json.NewEncoder(w).Encode([]event.Event{e1})
				return
			}
			_ = json.NewEncoder(w).Encode([]event.Event{e1, e2})
		case "/events/stream":
			call := streams.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			if call == 1 {
				data, _ := json.Marshal(e2)
				fmt.Fprintf(w, "data: %s\n\n", data)
				return
			}
			<-r.Context().Done()
		}
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed, history, err := client.New(server.URL).Feed(ctx, 500, 10000)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].ID != e1.ID {
		t.Fatalf("initial history = %+v", history)
	}
	select {
	case got := <-feed:
		if got.ID != e2.ID {
			t.Fatalf("live event = %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("first stream event missing")
	}
	deadline := time.Now().Add(3 * time.Second)
	for histories.Load() < 2 || streams.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("feed did not reconcile and resubscribe: histories=%d streams=%d", histories.Load(), streams.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case duplicate := <-feed:
		t.Fatalf("reconciliation duplicated a buffered id: %+v", duplicate)
	case <-time.After(100 * time.Millisecond):
	}
}
