package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/host"
)

func admit(t *testing.T, e interface {
	Admit(context.Context, event.Event) (event.Event, error)
}, at time.Time) {
	t.Helper()
	ev := event.Event{SchemaVersion: event.CurrentSchemaVersion, ID: "e1", Time: at, CaptureTime: &at,
		Source: "claude-code", Agent: "claude", SessionID: "s1", Transport: "hook",
		Category: event.CategorySession, Name: "SessionStart", Severity: event.SeverityInfo,
		Summary: "x", RepoID: "r1", WorktreeID: "/tmp/wt-a"}
	if _, err := e.Admit(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
}

func TestViewFeedDaemonlessReturnsWorktreeSource(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	addr := dead.Listener.Addr().String()
	dead.Close() // closed listener: the daemon probe fails

	home := t.TempDir()
	cfg := cli.Config{DaemonAddr: addr, SpoolDir: t.TempDir(), PrivacyMode: "full"}
	engine, err := host.NewEngineWithSources(cfg, home, nil)
	if err != nil {
		t.Fatal(err)
	}
	opener := func(ctx context.Context, _ cli.Config, _ string) (host.Feed, error) {
		return host.OpenFeedForEngine(ctx, engine)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	_, _, _, src, err := viewFeed(ctx, cfg, home, opener)
	if err != nil {
		t.Fatal(err)
	}
	if src == nil {
		t.Fatal("nil WorktreeSource")
	}
	admit(t, engine, time.Now())
	list, err := src.Worktrees(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if list.StateKnown || len(list.Rows) != 1 || list.Rows[0].ID != "/tmp/wt-a" {
		t.Fatalf("list %+v", list)
	}
}

func TestViewFeedDaemonModeReturnsDaemonSource(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			_, _ = w.Write([]byte(`{"ok":true,"schema_version":1}`))
		case "/events", "/sessions":
			_, _ = w.Write([]byte(`[]`))
		case "/events/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case "/worktrees":
			_, _ = w.Write([]byte(`[{"repo_id":"r1","worktree_id":"wt-a","label":"/w/a","last_time":"2026-10-31T10:00:00Z","sessions":[],"sessions_total":0,"state":"open"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cfg := cli.Config{DaemonAddr: srv.Listener.Addr().String(), SpoolDir: t.TempDir()}
	called := false
	opener := func(context.Context, cli.Config, string) (host.Feed, error) {
		called = true
		return host.Feed{}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _, _, src, err := viewFeed(ctx, cfg, t.TempDir(), opener)
	if err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("local opener must not be called in daemon mode")
	}
	list, err := src.Worktrees(ctx)
	if err != nil || !list.StateKnown || len(list.Rows) != 1 || list.Rows[0].ID != "wt-a" {
		t.Fatalf("%+v %v", list, err)
	}
}
