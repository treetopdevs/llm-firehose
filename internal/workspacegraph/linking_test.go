package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Local config copied from real repositories on a developer machine: Tower,
// git-flow, the GitHub Desktop account marker, beads and a hooks path. None of
// it is read by the scanner's commands, and none of it may stop a scan.
var toolConfig = [][2]string{
	{"submodule.active", "."},
	{"remote.origin.url", "https://example.invalid/x.git"},
	{"remote.origin.gtserviceaccountidentifier", "41022ee68dc66ee359c547d94877fa289f2e6c5d1193e8ee91a9d462c426e77f"},
	{"mergetool.tower.cmd", `"/Applications/Tower.app/Contents/Resources/filemerge.sh" "$LOCAL" "$REMOTE" "$BASE" "$MERGED"`},
	{"mergetool.tower.trustexitcode", "true"},
	{"difftool.tower.cmd", `"/Applications/Tower.app/Contents/Resources/kaleidoscope.sh" "$LOCAL" "$REMOTE" "$MERGED"`},
	{"gitflow.branch.feature/vcp.base", "ga"},
	{"extensions.worktreeconfig", "true"},
	{"beads.role", "maintainer"},
}

func TestGitScanReadsRepositoriesWithToolConfig(t *testing.T) {
	ctx := context.Background()
	root := fixture(t)
	for _, kv := range toolConfig {
		git(t, root, "config", kv[0], kv[1])
	}
	git(t, root, "config", "core.hookspath", filepath.Join(root, ".beads", "hooks"))
	other := filepath.Join(t.TempDir(), "linked")
	git(t, root, "worktree", "add", "-b", "feature", other)
	os.WriteFile(filepath.Join(other, "new.txt"), []byte("x"), 0600)

	s := New(privacy.ModeFull)
	repo, err := s.Register(ctx, root, "git")
	if err != nil {
		t.Fatalf("a repository with tool config must register: %v", err)
	}
	v, err := s.Snapshot(ctx, repo.ID, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Workspaces) != 2 || !v.Workspaces[1].Dirty || v.Workspaces[0].Dirty {
		t.Fatalf("workspaces: %+v", v.Workspaces)
	}
	if v.DefaultTargetRef != "main" || len(v.Nodes) == 0 {
		t.Fatalf("history: target=%q nodes=%d", v.DefaultTargetRef, len(v.Nodes))
	}
}

// No command of a scan or a comparison may load the repository's own config:
// a filter, an fsmonitor hook, a pager and a diff driver defined there never run.
func TestGitScanNeverRunsRepoConfigCommands(t *testing.T) {
	ctx := context.Background()
	root := fixture(t)
	os.WriteFile(filepath.Join(root, ".gitattributes"), []byte("a.txt filter=pwn diff=pwn\n"), 0600)
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\n"), 0600)
	git(t, root, "add", ".")
	git(t, root, "commit", "-m", "tracked")
	base := git(t, root, "rev-parse", "HEAD")
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("two\n"), 0600)
	git(t, root, "commit", "-am", "second")
	head := git(t, root, "rev-parse", "HEAD")
	marker := filepath.Join(t.TempDir(), "pwned")
	touch := "touch " + marker
	git(t, root, "config", "filter.pwn.clean", touch+"; cat")
	git(t, root, "config", "core.fsmonitor", touch)
	git(t, root, "config", "core.pager", touch)
	git(t, root, "config", "diff.pwn.textconv", touch+"; cat")
	git(t, root, "config", "diff.external", touch)
	git(t, root, "config", "core.sshcommand", touch)
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("three\n"), 0600)

	s := New(privacy.ModeFull)
	repo, err := s.Register(ctx, root, "git")
	if err != nil {
		t.Fatal(err)
	}
	v, err := s.Snapshot(ctx, repo.ID, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if !v.Workspaces[0].Dirty {
		t.Fatalf("dirty file lost: %+v", v.Workspaces[0])
	}
	c, err := s.Compare(ctx, repo.ID, head, base)
	if err != nil || len(c.ChangedFiles) != 1 {
		t.Fatalf("compare: %+v %v", c, err)
	}
	if _, e := os.Stat(marker); e == nil {
		t.Fatal("a repo-config command was executed")
	}
}

// The repository is the same project whichever checkout led to it: it is named
// after the main checkout and listed once, and it survives the removal of the
// linked worktree that first registered it.
func TestGitRepositoryAnchorsOnMainCheckout(t *testing.T) {
	ctx := context.Background()
	root, _ := canonical(fixture(t))
	holder, _ := canonical(t.TempDir())
	first, second := filepath.Join(holder, "first"), filepath.Join(holder, "second")
	git(t, root, "worktree", "add", "-b", "one", first)
	git(t, root, "worktree", "add", "-b", "two", second)

	s := New(privacy.ModeFull)
	a, err := s.Register(ctx, first, "")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := s.Register(ctx, second, "git")
	c, _ := s.Register(ctx, filepath.Join(root), "")
	if a.ID != b.ID || a.ID != c.ID || len(s.Repositories()) != 1 {
		t.Fatalf("one repository expected: %+v", s.Repositories())
	}
	if a.Label != root || a.ID != filepath.Join(root, ".git") {
		t.Fatalf("anchor: %+v want label %s", a, root)
	}
	if a.ProjectID != a.ID || a.ProjectLabel != root {
		t.Fatalf("project: %+v", a)
	}
	if e := os.RemoveAll(first); e != nil {
		t.Fatal(e)
	}
	v, err := s.Snapshot(ctx, a.ID, "", true)
	if err != nil {
		t.Fatalf("scan must not depend on the registering worktree: %v", err)
	}
	if len(v.Workspaces) != 3 || v.Workspaces[0].Label != root {
		t.Fatalf("workspaces: %+v", v.Workspaces)
	}
	states := map[string]string{}
	for _, w := range v.Workspaces {
		states[w.Label] = w.Availability
	}
	if states[first] != "pruned" || states[second] != "available" {
		t.Fatalf("availability: %v", states)
	}
}

func TestGitRepositoryIdentityFollowsMode(t *testing.T) {
	root, _ := canonical(fixture(t))
	r, err := New(privacy.ModeBalanced).Register(context.Background(), root, "git")
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != digest(filepath.Join(root, ".git")) || r.ProjectID != r.ID || r.ProjectLabel != root {
		t.Fatalf("%+v", r)
	}
}

// A colocated repository is one project with two registrations, whichever
// checkout led to it: Git carries the identity events are stamped with, JJ
// shows the same project through its workspaces.
func TestColocatedJJAndGitShareOneProject(t *testing.T) {
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
	ctx := context.Background()
	root, _ := canonical(fixture(t))
	jj(t, root, "git", "init", "--colocate")
	linked := filepath.Join(t.TempDir(), "linked")
	git(t, root, "worktree", "add", "--detach", linked)
	for _, first := range []string{root, linked} {
		s := New(privacy.ModeFull)
		for _, from := range []string{first, linked, root} {
			if _, err := s.Register(ctx, from, ""); err != nil {
				t.Fatal(err)
			}
		}
		repos := s.Repositories()
		if len(repos) != 2 {
			t.Fatalf("both sides stay registered (from %s): %+v", first, repos)
		}
		vcs := []string{}
		for _, r := range repos {
			vcs = append(vcs, r.VCS)
			if r.ProjectID != filepath.Join(root, ".git") || r.ProjectLabel != root || r.Label != root {
				t.Fatalf("shared project: %+v", r)
			}
		}
		if strings.Join(vcs, ",") != "git,jj" || repos[0].ID != repos[0].ProjectID {
			t.Fatalf("order and identity: %+v", repos)
		}
		for _, r := range repos {
			if _, err := s.Snapshot(ctx, r.ID, "", true); err != nil {
				t.Fatalf("%s scan: %v", r.VCS, err)
			}
		}
	}
}

// A Git worktree nested inside a JJ workspace's directory is a Git checkout.
func TestNestedGitWorktreeResolvesToGit(t *testing.T) {
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
	root, _ := canonical(fixture(t))
	jj(t, root, "git", "init", "--colocate")
	nested := filepath.Join(root, ".claude", "worktrees", "x")
	git(t, root, "worktree", "add", "--detach", nested)
	if id, anchor, vcs, ok := Identify(nested, ""); !ok || vcs != "git" || id != filepath.Join(root, ".git") || anchor != root {
		t.Fatalf("nested: %s %s %s %v", id, anchor, vcs, ok)
	}
	if id, _, vcs, ok := Identify(root, ""); !ok || vcs != "jj" || id != "jj:"+filepath.Join(root, ".jj", "repo") {
		t.Fatalf("colocated root: %s %s %v", id, vcs, ok)
	}
	if _, _, _, ok := Identify(t.TempDir(), ""); ok {
		t.Fatal("a plain directory is not a repository")
	}
}

func TestJJRepositoryAnchorsOnMainWorkspace(t *testing.T) {
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
	root, _ := canonical(t.TempDir())
	jj(t, root, "git", "init", "--no-colocate")
	other := filepath.Join(t.TempDir(), "other")
	jj(t, root, "workspace", "add", other)
	s := New(privacy.ModeFull)
	r, err := s.Register(context.Background(), other, "")
	if err != nil {
		t.Fatal(err)
	}
	if r.Label != root || r.ProjectID != r.ID || r.ProjectLabel != root || len(s.Repositories()) != 1 {
		t.Fatalf("%+v", r)
	}
}

func TestSweepStaleShadowsRemovesOnlyOldShadowDirs(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	old, _ := os.MkdirTemp("", "firehose-shadow-*")
	fresh, _ := os.MkdirTemp("", "firehose-shadow-*")
	other, _ := os.MkdirTemp("", "unrelated-*")
	past := time.Now().Add(-time.Hour)
	for _, dir := range []string{old, other} {
		if e := os.Chtimes(dir, past, past); e != nil {
			t.Fatal(e)
		}
	}
	SweepStaleShadows()
	if _, e := os.Stat(old); e == nil {
		t.Fatal("stale shadow kept")
	}
	for _, dir := range []string{fresh, other} {
		if _, e := os.Stat(dir); e != nil {
			t.Fatalf("%s removed", dir)
		}
	}
}

// A bare repository has no main checkout: it is named after its git dir, never
// after whichever linked worktree led to it, and none of its worktrees is primary.
func TestBareRepositoryAnchorsOnItsGitDir(t *testing.T) {
	ctx := context.Background()
	holder, _ := canonical(t.TempDir())
	bare := filepath.Join(holder, "project.git")
	git(t, holder, "init", "--bare", "-b", "main", bare)
	seed := filepath.Join(holder, "seed")
	git(t, holder, "clone", "-q", bare, seed)
	git(t, seed, "commit", "--allow-empty", "-m", "base")
	git(t, seed, "push", "-q", "origin", "HEAD:main")
	one, two := filepath.Join(holder, "one"), filepath.Join(holder, "two")
	git(t, bare, "worktree", "add", "-b", "one", one, "main")
	git(t, bare, "worktree", "add", "-b", "two", two, "main")
	git(t, two, "commit", "--allow-empty", "-m", "ahead")

	for _, from := range []string{two, one, bare} {
		s := New(privacy.ModeFull)
		repo, err := s.Register(ctx, from, "")
		if err != nil {
			t.Fatalf("register from %s: %v", from, err)
		}
		if repo.ID != bare || repo.Label != bare || repo.ProjectLabel != bare {
			t.Fatalf("from %s: %+v", from, repo)
		}
		v, err := s.Snapshot(ctx, repo.ID, "", true)
		if err != nil {
			t.Fatal(err)
		}
		if len(v.Workspaces) != 2 || v.Workspaces[0].Label != one || v.Workspaces[1].Label != two || v.DefaultTargetRef != "main" {
			t.Fatalf("workspaces: %+v", v.Workspaces)
		}
		for _, w := range v.Workspaces {
			if w.Primary || w.Availability != "available" {
				t.Fatalf("a bare repository has no primary checkout: %+v", w)
			}
		}
	}
}

func TestMainCheckoutIsPrimary(t *testing.T) {
	ctx := context.Background()
	root, _ := canonical(fixture(t))
	linked := filepath.Join(t.TempDir(), "linked")
	git(t, root, "worktree", "add", "--detach", linked)
	s := New(privacy.ModeFull)
	repo, _ := s.Register(ctx, linked, "")
	v, err := s.Snapshot(ctx, repo.ID, "", true)
	if err != nil || len(v.Workspaces) != 2 || !v.Workspaces[0].Primary || v.Workspaces[0].Label != root || v.Workspaces[1].Primary {
		t.Fatalf("%+v %v", v.Workspaces, err)
	}
}

// A repository whose git dir lives elsewhere is still named after its checkout.
func TestSeparateGitDirAnchorsOnItsCheckout(t *testing.T) {
	holder, _ := canonical(t.TempDir())
	work, gitDir := filepath.Join(holder, "work"), filepath.Join(holder, "store", "repo.git")
	os.MkdirAll(work, 0700)
	os.MkdirAll(filepath.Dir(gitDir), 0700)
	git(t, work, "init", "-b", "main", "--separate-git-dir", gitDir)
	git(t, work, "commit", "--allow-empty", "-m", "base")
	s := New(privacy.ModeFull)
	repo, err := s.Register(context.Background(), work, "")
	if err != nil || repo.ID != gitDir || repo.Label != work {
		t.Fatalf("%+v %v", repo, err)
	}
	v, err := s.Snapshot(context.Background(), repo.ID, "", true)
	if err != nil || len(v.Workspaces) != 1 || v.Workspaces[0].Label != work || !v.Workspaces[0].Primary {
		t.Fatalf("%+v %v", v.Workspaces, err)
	}
}
