package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func serve(t *testing.T, code int, body string) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/worktrees" && r.URL.Path != "/sessions" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL)
}

// Built from the exact daemon worktreeView tags.
const wtBody = `[{"repo_id":"r1","worktree_id":"w1","label":"feat-x",
"first_time":"2026-10-30T10:00:00Z","last_time":"2026-10-31T11:00:00Z",
"sessions":[{"source":"codex","session_id":"s1","first_time":"2026-10-30T10:00:00Z","last_time":"2026-10-31T11:00:00Z","events":7}],
"sessions_total":3,"paths":["/a/b"],"paths_total":1,"signal_events":5,"meta_events":2,
"marks":[{"kind":"x"}],"marks_total":1,"marks_available":true,"state":"open",
"default_target_ref":"origin/main","head":"abc123","ahead":2,"behind":0,"dirty":true,
"last_observed":"2026-10-31T11:30:00Z"}]`

func TestWorktreesDecodesDaemonShape(t *testing.T) {
	got, err := serve(t, 200, wtBody).Worktrees(context.Background())
	if err != nil || len(got) != 1 {
		t.Fatalf("got %v err %v", got, err)
	}
	w := got[0]
	if w.RepoID != "r1" || w.WorktreeID != "w1" || w.Label != "feat-x" || w.State != "open" ||
		w.DefaultTargetRf != "origin/main" || w.Head != "abc123" || w.SessionsTotal != 3 ||
		w.PathsTotal != 1 || len(w.Paths) != 1 || w.Paths[0] != "/a/b" || w.SignalEvents != 5 ||
		w.MetaEvents != 2 || w.MarksTotal != 1 || !w.MarksAvailable {
		t.Fatalf("fields: %+v", w)
	}
	if w.FirstTime.Day() != 30 || w.LastTime.Day() != 31 {
		t.Fatalf("times: %v %v", w.FirstTime, w.LastTime)
	}
	if w.Ahead == nil || *w.Ahead != 2 || w.Behind == nil || *w.Behind != 0 || w.Dirty == nil || !*w.Dirty {
		t.Fatalf("pointers: %+v", w)
	}
	if w.LastObserved == nil || w.LastObserved.Minute() != 30 {
		t.Fatalf("last_observed: %v", w.LastObserved)
	}
	if len(w.Sessions) != 1 || w.Sessions[0].Source != "codex" || w.Sessions[0].SessionID != "s1" || w.Sessions[0].Events != 7 ||
		w.Sessions[0].FirstTime.Day() != 30 || w.Sessions[0].LastTime.Day() != 31 {
		t.Fatalf("sessions: %+v", w.Sessions)
	}
}

func TestWorktreesOmittedPointersStayNil(t *testing.T) {
	got, err := serve(t, 200, `[{"repo_id":"r","worktree_id":"w","state":"unknown"}]`).Worktrees(context.Background())
	if err != nil || len(got) != 1 {
		t.Fatal(got, err)
	}
	w := got[0]
	if w.Ahead != nil || w.Behind != nil || w.Dirty != nil || w.LastObserved != nil {
		t.Fatalf("expected nil pointers: %+v", w)
	}
}

func TestWorktreesEmptyArray(t *testing.T) {
	got, err := serve(t, 200, `[]`).Worktrees(context.Background())
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("got %#v err %v", got, err)
	}
	got, err = serve(t, 200, `null`).Worktrees(context.Background())
	if err != nil || got == nil {
		t.Fatalf("null: %#v err %v", got, err)
	}
}

func TestWorktreesOldDaemonReturns404(t *testing.T) {
	// Any 404 deliberately means unsupported: an old daemon has no route.
	_, err := serve(t, 404, "404 page not found").Worktrees(context.Background())
	if !errors.Is(err, ErrWorktreesUnsupported) {
		t.Fatalf("err = %v", err)
	}
}

func TestWorktreesOtherStatusIsPlainError(t *testing.T) {
	_, err := serve(t, 500, "boom").Worktrees(context.Background())
	if err == nil || errors.Is(err, ErrWorktreesUnsupported) ||
		!strings.Contains(err.Error(), "GET /worktrees") || !strings.Contains(err.Error(), "500") {
		t.Fatalf("err = %v", err)
	}
}

func TestWorktreesDaemonDown(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	_, err := New(url).Worktrees(context.Background())
	if err == nil || errors.Is(err, ErrWorktreesUnsupported) {
		t.Fatalf("err = %v", err)
	}
}

func TestGetJSONErrorTextUnchanged(t *testing.T) {
	_, err := serve(t, 500, " boom \n").Sessions(context.Background())
	want := "client: GET /sessions: 500 Internal Server Error: boom"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}
