package host

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
	"agentfirehose/internal/client"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/tui"
)

const twoItemBody = `[
{"repo_id":"r1","worktree_id":"wt-a","label":"/w/a","first_time":"2026-10-30T10:00:00Z","last_time":"2026-10-31T10:00:00Z",
 "sessions":[{"source":"claude-code","session_id":"s1","first_time":"2026-10-30T10:00:00Z","last_time":"2026-10-31T10:00:00Z","events":3}],
 "sessions_total":1,"paths":[],"paths_total":0,"signal_events":3,"meta_events":0,"marks_total":0,"marks_available":false,
 "state":"open","ahead":2,"behind":0,"dirty":true,"last_observed":"2026-10-31T11:00:00Z"},
{"repo_id":"r1","worktree_id":"digest123","first_time":"2026-10-29T10:00:00Z","last_time":"2026-10-30T10:00:00Z",
 "sessions":[{"source":"claude-code","session_id":"s2"},{"source":"codex","session_id":"s3"}],
 "sessions_total":4,"paths":[],"paths_total":0,"signal_events":2,"meta_events":0,"marks_total":0,"marks_available":false,
 "state":"landed","last_observed":"2026-10-31T11:00:00Z"}
]`

func wtServer(t *testing.T, code int, body string) *client.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/worktrees" {
			t.Errorf("path %s", r.URL.Path)
		}
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return client.New(srv.URL)
}

func TestDaemonWorktreesMapsRows(t *testing.T) {
	list, err := DaemonWorktrees(wtServer(t, 200, twoItemBody)).Worktrees(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !list.StateKnown || len(list.Rows) != 2 {
		t.Fatalf("list %+v", list)
	}
	r := list.Rows[0]
	obs := time.Date(2026, 10, 31, 11, 0, 0, 0, time.UTC)
	if r.ID != "wt-a" || r.Repo != "r1" || r.Path != "/w/a" || r.State != "open" ||
		len(r.Sessions) != 1 || r.Sessions[0] != (tui.SessionRef{Source: "claude-code", ID: "s1"}) ||
		r.Ahead == nil || *r.Ahead != 2 || r.Behind == nil || *r.Behind != 0 || r.Dirty == nil || !*r.Dirty ||
		r.LastObserved == nil || !r.LastObserved.Equal(obs) ||
		!r.Last.Equal(time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("row0 %+v", r)
	}
	r = list.Rows[1]
	if r.Path != "digest123" || r.SessionsTotal != 4 || len(r.Sessions) != 2 || r.State != "landed" ||
		r.Ahead != nil || r.Dirty != nil || r.LastObserved == nil {
		t.Fatalf("row1 %+v", r)
	}
}

func TestDaemonWorktreesEmptyArray(t *testing.T) {
	list, err := DaemonWorktrees(wtServer(t, 200, "[]")).Worktrees(context.Background())
	if err != nil || !list.StateKnown || len(list.Rows) != 0 {
		t.Fatalf("%+v %v", list, err)
	}
}

func TestDaemonWorktreesMapsUnsupportedToTUIError(t *testing.T) {
	_, err := DaemonWorktrees(wtServer(t, 404, "nope")).Worktrees(context.Background())
	if !errors.Is(err, tui.ErrWorktreesUnavailable) {
		t.Fatalf("err %v", err)
	}
}

func TestDaemonWorktreesPropagatesOtherErrors(t *testing.T) {
	_, err := DaemonWorktrees(wtServer(t, 500, "boom")).Worktrees(context.Background())
	if err == nil || errors.Is(err, tui.ErrWorktreesUnavailable) {
		t.Fatalf("err %v", err)
	}
}

func newWTEngine(t *testing.T) *capture.Engine {
	t.Helper()
	e, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func admitWT(t *testing.T, e *capture.Engine, id, repo, wt, sess string, at time.Time) {
	t.Helper()
	ev := event.Event{SchemaVersion: event.CurrentSchemaVersion, ID: id, Time: at, CaptureTime: &at,
		Source: "claude-code", Agent: "claude", SessionID: sess, Transport: "hook",
		Category: event.CategorySession, Name: "SessionStart", Severity: event.SeverityInfo,
		Summary: "x", RepoID: repo, WorktreeID: wt}
	if _, err := e.Admit(context.Background(), ev); err != nil {
		t.Fatalf("admit %s: %v", id, err)
	}
}

func TestEngineWorktreesFromInProcessEngine(t *testing.T) {
	e := newWTEngine(t)
	t1 := time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Hour)
	admitWT(t, e, "e1", "r1", "/tmp/wt-a", "s1", t1)
	admitWT(t, e, "e2", "r1", "/tmp/wt-b", "s2", t2)
	list, err := EngineWorktrees(e).Worktrees(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if list.StateKnown || len(list.Rows) != 2 {
		t.Fatalf("%+v", list)
	}
	b, a := list.Rows[0], list.Rows[1] // newest first
	if b.ID != "/tmp/wt-b" || b.Repo != "r1" || b.State != "" || b.Path != "/tmp/wt-b" ||
		!b.Last.Equal(t2) || len(b.Sessions) != 1 || b.Sessions[0] != (tui.SessionRef{Source: "claude-code", ID: "s2"}) ||
		b.Ahead != nil || b.Behind != nil || b.Dirty != nil || b.LastObserved != nil {
		t.Fatalf("b %+v", b)
	}
	if a.Path != "/tmp/wt-a" || !a.Last.Equal(t1) || a.Sessions[0].ID != "s1" {
		t.Fatalf("a %+v", a)
	}
}

// The same worktree id under two repos stays two rows.
func TestEngineWorktreesSplitsMixedModeRows(t *testing.T) {
	e := newWTEngine(t)
	now := time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)
	admitWT(t, e, "e1", "r1", "/tmp/wt", "s1", now)
	admitWT(t, e, "e2", "r2", "/tmp/wt", "s2", now.Add(time.Minute))
	list, err := EngineWorktrees(e).Worktrees(context.Background())
	if err != nil || len(list.Rows) != 2 {
		t.Fatalf("%+v %v", list, err)
	}
	if list.Rows[0].Repo != "r2" || list.Rows[1].Repo != "r1" || list.Rows[0].ID != list.Rows[1].ID {
		t.Fatalf("%+v", list.Rows)
	}
}

func TestEngineWorktreesEmpty(t *testing.T) {
	list, err := EngineWorktrees(newWTEngine(t)).Worktrees(context.Background())
	if err != nil || list.Rows == nil || len(list.Rows) != 0 || list.StateKnown {
		t.Fatalf("%+v %v", list, err)
	}
}

func TestEngineWorktreesHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := EngineWorktrees(newWTEngine(t)).Worktrees(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
}

func TestOpenFeedForEngineExposesWorktreeSource(t *testing.T) {
	cfg := cli.Config{SpoolDir: t.TempDir(), PrivacyMode: "full"}
	e, err := NewEngineWithSources(cfg, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	admitWT(t, e, "e1", "r1", "/tmp/wt-a", "s1", time.Now())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed, err := OpenFeedForEngine(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	if feed.Worktrees == nil {
		t.Fatal("nil Worktrees")
	}
	list, err := feed.Worktrees.Worktrees(ctx)
	if err != nil || len(list.Rows) != 1 || list.Rows[0].ID != "/tmp/wt-a" {
		t.Fatalf("%+v %v", list, err)
	}
	// Later admissions to the same engine appear on the next fetch.
	admitWT(t, e, "e2", "r1", "/tmp/wt-b", "s2", time.Now())
	list, _ = feed.Worktrees.Worktrees(ctx)
	if len(list.Rows) != 2 {
		t.Fatalf("%+v", list)
	}
}

func TestSelectWorktreesPrefersDaemon(t *testing.T) {
	c := wtServer(t, 200, twoItemBody)
	list, err := SelectWorktrees(c, Feed{Worktrees: EngineWorktrees(newWTEngine(t))}).Worktrees(context.Background())
	if err != nil || !list.StateKnown || len(list.Rows) != 2 {
		t.Fatalf("%+v %v", list, err)
	}
}

func TestSelectWorktreesFallsBackToEngine(t *testing.T) {
	e := newWTEngine(t)
	admitWT(t, e, "e1", "r1", "/tmp/wt-a", "s1", time.Now())
	list, err := SelectWorktrees(nil, Feed{Worktrees: EngineWorktrees(e)}).Worktrees(context.Background())
	if err != nil || list.StateKnown || len(list.Rows) != 1 {
		t.Fatalf("%+v %v", list, err)
	}
}
