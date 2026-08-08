// Tests run the real daemon handler so the client is verified against the
// actual API, not a hand-rolled fake.
package client_test

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/client"
	"agentfirehose/internal/daemon"
	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

func testDaemon(t *testing.T) (*httptest.Server, cli.Config) {
	t.Helper()
	cfg := cli.Config{
		SpoolDir:    filepath.Join(t.TempDir(), "spool"),
		PrivacyMode: "balanced",
	}
	s := daemon.New(cfg, t.TempDir(), "test-version")
	s.TailInterval = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		s.Wait()
	})
	s.Start(ctx)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, cfg
}

func TestHealth(t *testing.T) {
	ts, _ := testDaemon(t)
	c := client.New(ts.URL)
	h, err := c.Health()
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if h.Status != "ok" || h.Version != "test-version" || h.SchemaVersion != event.CurrentSchemaVersion {
		t.Errorf("health = %+v", h)
	}
}

func TestHealthDaemonDown(t *testing.T) {
	c := client.New("http://127.0.0.1:1")
	if _, err := c.Health(); err == nil {
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
		if err := w.Append(ev); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	c := client.New(ts.URL)
	evs, err := c.Recent(2)
	if err != nil {
		t.Fatalf("Recent: %v", err)
	}
	if len(evs) != 2 || evs[0].ID != "e1" || evs[1].ID != "e2" {
		t.Fatalf("recent = %+v", evs)
	}
}

func TestEmitNormalizesThroughDaemon(t *testing.T) {
	ts, cfg := testDaemon(t)
	c := client.New(ts.URL)
	payload := `{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"/repo","prompt":"hi"}`
	if err := c.Emit("claude-code", strings.NewReader(payload)); err != nil {
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

	time.Sleep(30 * time.Millisecond) // let the tailer record initial offsets
	line := `{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"via client"}`
	if err := c.Emit("generic", strings.NewReader(line)); err != nil {
		t.Fatalf("Emit: %v", err)
	}

	deadline := time.After(3 * time.Second)
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
	select {
	case _, ok := <-ch:
		if ok {
			// Drain any buffered event; channel must close soon after.
			for range ch {
			}
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stream channel not closed after cancel")
	}
}
