package workspace

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func TestObserveRepoRootAndNestedDir(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "project")
	nested := filepath.Join(repo, "internal", "pkg")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	wantRepo, err := filepath.EvalSymlinks(filepath.Join(repo, ".git"))
	if err != nil {
		t.Fatal(err)
	}
	wantWorktree, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}

	for _, cwd := range []string{repo, nested} {
		repoID, worktreeID := Observe(cwd)
		if repoID != wantRepo || worktreeID != wantWorktree {
			t.Fatalf("Observe(%q) = (%q, %q), want (%q, %q)", cwd, repoID, worktreeID, wantRepo, wantWorktree)
		}
	}
}

func TestObserveLinkedWorktree(t *testing.T) {
	root := t.TempDir()
	mainRepo := filepath.Join(root, "main")
	commonDir := filepath.Join(mainRepo, ".git")
	gitDir := filepath.Join(commonDir, "worktrees", "feature")
	worktree := filepath.Join(root, "feature")
	cwd := filepath.Join(worktree, "internal", "thing")
	for _, dir := range []string{commonDir, gitDir, cwd} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: "+gitDir+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "commondir"), []byte("../..\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	repoID, worktreeID := Observe(cwd)
	wantRepo, _ := filepath.EvalSymlinks(commonDir)
	wantWorktree, _ := filepath.EvalSymlinks(worktree)
	if repoID != wantRepo || worktreeID != wantWorktree {
		t.Fatalf("linked worktree identity = (%q, %q), want (%q, %q)", repoID, worktreeID, wantRepo, wantWorktree)
	}
}

func TestObserveRelativeGitdir(t *testing.T) {
	root := t.TempDir()
	mainRepo := filepath.Join(root, "main")
	commonDir := filepath.Join(mainRepo, ".git")
	gitDir := filepath.Join(commonDir, "worktrees", "feature")
	worktree := filepath.Join(root, "feature")
	for _, dir := range []string{commonDir, gitDir, worktree} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: ../main/.git/worktrees/feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitDir, "commondir"), []byte("../..\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	repoID, worktreeID := Observe(worktree)
	wantRepo, _ := filepath.EvalSymlinks(commonDir)
	wantWorktree, _ := filepath.EvalSymlinks(worktree)
	if repoID != wantRepo || worktreeID != wantWorktree {
		t.Fatalf("relative gitdir identity = (%q, %q), want (%q, %q)", repoID, worktreeID, wantRepo, wantWorktree)
	}
}

func TestObserveMalformedMetadata(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "broken")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".git"), []byte("not-a-gitdir-pointer\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	repoID, worktreeID := Observe(repo)
	if repoID != "" || worktreeID != "" {
		t.Fatalf("malformed .git must be unobservable, got (%q, %q)", repoID, worktreeID)
	}
}

func TestObserveMissingGitDirDirectory(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "feature")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(root, "missing-gitdir")
	if err := os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: "+missing+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	repoID, worktreeID := Observe(worktree)
	if repoID != "" || worktreeID != "" {
		t.Fatalf("missing gitdir must be unobservable, got (%q, %q)", repoID, worktreeID)
	}
}

func TestObserveSymlinkResolution(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "project")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(repo, link); err != nil {
		t.Fatal(err)
	}
	repoID, worktreeID := Observe(link)
	wantRepo, _ := filepath.EvalSymlinks(filepath.Join(repo, ".git"))
	wantWorktree, _ := filepath.EvalSymlinks(repo)
	if repoID != wantRepo || worktreeID != wantWorktree {
		t.Fatalf("symlink cwd identity = (%q, %q), want (%q, %q)", repoID, worktreeID, wantRepo, wantWorktree)
	}
}

func TestEnrichSetsObservableIdentity(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "project")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	ev := event.Event{
		ID: "e1", Time: time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC),
		Source: "generic", Category: event.CategoryMeta, CWD: repo,
		RepoID: "unverified", WorktreeID: "unverified",
	}
	got := Enrich(ev)
	wantRepo, _ := filepath.EvalSymlinks(filepath.Join(repo, ".git"))
	wantWorktree, _ := filepath.EvalSymlinks(repo)
	if got.RepoID != wantRepo || got.WorktreeID != wantWorktree {
		t.Fatalf("Enrich = (%q, %q), want (%q, %q)", got.RepoID, got.WorktreeID, wantRepo, wantWorktree)
	}
}

func TestEnrichLeavesUnobservableEventsUnchanged(t *testing.T) {
	ev := event.Event{
		ID: "e1", Time: time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC),
		Source: "generic", Category: event.CategoryMeta,
		CWD:    filepath.Join(t.TempDir(), "not-a-repo", "nested"),
		RepoID: "keep-repo", WorktreeID: "keep-worktree",
	}
	got := Enrich(ev)
	if got.RepoID != "keep-repo" || got.WorktreeID != "keep-worktree" {
		t.Fatalf("unobservable Enrich mutated identity: %+v", got)
	}
	empty := event.Event{
		ID: "e2", Time: ev.Time, Source: "generic", Category: event.CategoryMeta,
	}
	gotEmpty := Enrich(empty)
	if gotEmpty.RepoID != "" || gotEmpty.WorktreeID != "" {
		t.Fatalf("empty cwd must stay empty: %+v", gotEmpty)
	}
}
