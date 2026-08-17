package host

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/adapters/generic"
	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/daemon"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

type feedSource struct{ event event.Event }

func (feedSource) Name() string { return "feed-test" }

func (s feedSource) Run(ctx context.Context, sink capture.Sink) error {
	if _, err := sink.Admit(ctx, s.event); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

func TestEngineFeedPersistsSourcesAndPreloadsProjectedSessions(t *testing.T) {
	ev := event.Event{
		ID: "daemonless-source", Time: time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC),
		Source: "procwatch", Category: event.CategoryPermission, SessionID: "session-needs-input",
		Summary: "needs approval",
	}
	engine, err := capture.New(capture.Options{
		SpoolDir: t.TempDir(), Policy: privacy.ModeFull, Sources: []capture.Source{feedSource{event: ev}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed, err := openEngineFeed(ctx, engine, 500, 10000)
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.After(3 * time.Second)
	for {
		select {
		case got := <-feed.Events:
			if got.ID == ev.ID {
				goto persisted
			}
		case <-deadline:
			t.Fatal("source event did not reach daemonless feed")
		}
	}

persisted:
	history, err := engine.Recent(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].ID != ev.ID {
		t.Fatalf("durable history = %+v", history)
	}
}

func TestEngineFeedPreloadsHistoryAndSessionAttention(t *testing.T) {
	engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	ev := event.Event{
		ID: "preloaded", Time: time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC),
		Source: "claude-code", Category: event.CategoryPermission, SessionID: "session-needs-input",
		Summary: "approve Bash",
	}
	if _, err := engine.Admit(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed, err := openEngineFeed(ctx, engine, 500, 10000)
	if err != nil {
		t.Fatal(err)
	}
	if len(feed.History) != 1 || feed.History[0].ID != ev.ID {
		t.Fatalf("history = %+v", feed.History)
	}
	if len(feed.Sessions) != 1 || string(feed.Sessions[0].State) != "needs_input" {
		t.Fatalf("sessions = %+v", feed.Sessions)
	}
}

func TestEngineFeedReloadsDurableHistoryAfterSubscriptionOverflow(t *testing.T) {
	engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed, err := openEngineFeed(ctx, engine, 10, 10000)
	if err != nil {
		t.Fatal(err)
	}

	const total = 700
	for i := range total {
		ev := event.Event{
			ID: fmt.Sprintf("overflow-%03d", i), Time: time.Date(2026, 8, 17, 13, 0, i, 0, time.UTC),
			Source: "generic", Category: event.CategoryMeta,
		}
		if _, err := engine.Admit(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}

	seen := make(map[string]bool, total)
	deadline := time.After(5 * time.Second)
	for len(seen) < total {
		select {
		case ev := <-feed.Events:
			if seen[ev.ID] {
				t.Fatalf("duplicate after reconciliation: %s", ev.ID)
			}
			seen[ev.ID] = true
		case <-deadline:
			t.Fatalf("recovered %d/%d durable events", len(seen), total)
		}
	}
}

func TestDaemonAndDaemonlessAdmissionPersistEquivalentCapturedEvents(t *testing.T) {
	raw := `{"schema_version":1,"id":"fixed-admission","time":"2026-08-17T14:00:00Z","capture_time":"2026-08-17T14:00:01Z","source":"generic","category":"meta","severity":"info","summary":"same boundary"}`
	observation, err := generic.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}

	local, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeBalanced})
	if err != nil {
		t.Fatal(err)
	}
	localStored, err := local.Admit(context.Background(), observation)
	if err != nil {
		t.Fatal(err)
	}

	cfg := cli.Config{SpoolDir: t.TempDir(), PrivacyMode: "balanced"}
	daemonEngine, err := capture.New(capture.Options{SpoolDir: cfg.SpoolDir, Policy: privacy.ModeBalanced})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(daemon.New(daemonEngine, cfg, t.TempDir(), "test").Handler())
	t.Cleanup(server.Close)
	resp, err := http.Post(server.URL+"/emit?source=generic", "application/json", strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("daemon emit status = %d", resp.StatusCode)
	}
	daemonHistory, err := daemonEngine.Recent(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(daemonHistory) != 1 {
		t.Fatalf("daemon history = %+v", daemonHistory)
	}
	localBytes, _ := json.Marshal(localStored)
	daemonBytes, _ := json.Marshal(daemonHistory[0])
	if !bytes.Equal(localBytes, daemonBytes) {
		t.Fatalf("Captured Events differ\nlocal:  %s\ndaemon: %s", localBytes, daemonBytes)
	}
}
