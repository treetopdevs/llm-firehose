package capture

import (
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"context"
	"testing"
	"time"
)

func TestTimelineStablePagingAndSourceScope(t *testing.T) {
	e, err := New(Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	for i, source := range []string{"codex", "claude-code", "codex"} {
		_, err = e.Admit(context.Background(), event.Event{ID: []string{"a", "b", "c"}[i], Time: time.Unix(100, 0), Source: source, Category: event.CategoryMeta, SessionID: "same", RepoID: "repo", WorktreeID: []string{"one", "one", "two"}[i]})
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err := e.Timeline(TimelineQuery{RepoID: "repo", Source: "codex", SessionID: "same", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 1 || page.Events[0].ID != "c" || !page.HasMore {
		t.Fatalf("page: %+v", page)
	}
	page, err = e.Timeline(TimelineQuery{RepoID: "repo", Source: "codex", SessionID: "same", Limit: 1, Cursor: page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 1 || page.Events[0].ID != "a" || page.HasMore {
		t.Fatalf("second: %+v", page)
	}
	scoped, _ := e.Timeline(TimelineQuery{RepoID: "repo", WorkspaceID: "one", Source: "codex", Limit: 10})
	if len(scoped.Events) != 1 || scoped.Events[0].ID != "a" {
		t.Fatalf("scope: %+v", scoped)
	}
}

func TestTimelineJJAndHistoricalAliasScope(t *testing.T) {
	e, err := New(Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	for i, ev := range []event.Event{
		{RepoID: "old-repo", WorktreeID: "old-ws"},
		{JJRepoID: "jj-repo", JJWorkspaceID: "jj-ws"},
	} {
		ev.ID = []string{"old", "jj"}[i]
		ev.Time = time.Unix(100, 0)
		ev.Source = "codex"
		ev.SessionID = "shared"
		ev.Category = event.CategoryMeta
		if _, err := e.Admit(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}
	page, err := e.Timeline(TimelineQuery{RepoID: "current", WorkspaceID: "current-ws", RepoAliases: []string{"old-repo"}, WorkspaceAliases: []string{"old-ws"}})
	if err != nil || len(page.Events) != 1 || page.Events[0].ID != "old" {
		t.Fatalf("historical: %+v %v", page, err)
	}
	page, err = e.Timeline(TimelineQuery{RepoID: "jj-repo", WorkspaceID: "jj-ws"})
	if err != nil || len(page.Events) != 1 || page.Events[0].ID != "jj" {
		t.Fatalf("JJ: %+v %v", page, err)
	}
}

func TestSessionMovementClearsOppositeIdentityFamily(t *testing.T) {
	e, err := New(Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		ev      event.Event
		git, jj string
	}{
		{event.Event{ID: "a", Time: time.Unix(100, 0), JJRepoID: "jj:r", JJWorkspaceID: "jj:w"}, "", "jj:w"},
		{event.Event{ID: "b", Time: time.Unix(200, 0), RepoID: "g", WorktreeID: "w"}, "w", ""},
		{event.Event{ID: "late", Time: time.Unix(150, 0), JJRepoID: "jj:r", JJWorkspaceID: "jj:w"}, "w", ""},
		{event.Event{ID: "c", Time: time.Unix(300, 0), RepoID: "g", WorktreeID: "w", JJRepoID: "jj:r", JJWorkspaceID: "jj:w"}, "w", "jj:w"},
	}
	for _, tc := range cases {
		ev := tc.ev
		ev.Source = "codex"
		ev.SessionID = "shared"
		ev.Category = event.CategoryMeta
		if _, err := e.Admit(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
		sessions := e.Attention().Sessions
		if len(sessions) != 1 || sessions[0].WorktreeID != tc.git || sessions[0].JJWorkspaceID != tc.jj {
			t.Fatalf("after %s: %+v", ev.ID, sessions)
		}
	}
}

func TestDiscoveryRejectsUnobservableSuppliedIdentity(t *testing.T) {
	e, err := New(Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.Admit(context.Background(), event.Event{ID: "forged", Time: time.Now(), Source: "generic", Category: event.CategoryMeta, CWD: "/missing-firehose-directory", WorktreeID: "/unobserved-private-root"})
	if err != nil {
		t.Fatal(err)
	}
	if roots := e.ObservedRoots(); len(roots) != 0 {
		t.Fatalf("unobserved roots: %v", roots)
	}
}
