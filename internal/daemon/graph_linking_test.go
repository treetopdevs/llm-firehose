package daemon

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"agentfirehose/internal/workspacegraph"
)

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	c.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid")
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

// linkedRepo is a repository with a commit and n linked worktrees.
func linkedRepo(t *testing.T, n int) (root string, linked []string) {
	t.Helper()
	root = gitRepo(t)
	gitIn(t, root, "commit", "-q", "--allow-empty", "-m", "base")
	holder, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		path := filepath.Join(holder, "wt"+string(rune('a'+i)))
		gitIn(t, root, "worktree", "add", "-q", "--detach", path)
		linked = append(linked, path)
	}
	return root, linked
}

func observe(t *testing.T, s *Server, cwds ...string) {
	t.Helper()
	for i, cwd := range cwds {
		ev := mkEvent(i+1, time.Now())
		ev.Source, ev.SessionID, ev.CWD = "codex", "session-"+string(rune('a'+i)), cwd
		if _, err := s.engine.Admit(t.Context(), ev); err != nil {
			t.Fatal(err)
		}
	}
}

// Agents working in several worktrees of one repository are one project, named
// after the main checkout, and that is what is remembered across restarts.
func TestWorktreesOfOneRepositoryAreOneProject(t *testing.T) {
	root, linked := linkedRepo(t, 2)
	cfg := testConfig(t)
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	observe(t, s, linked[0], linked[1], root)
	s.reconcileGraphRoots(t.Context())

	repos := listedRepos(t, s)
	if len(repos) != 1 || repos[0].Status != "ready" || repos[0].ProjectLabel != root || repos[0].ProjectID != repos[0].ID {
		t.Fatalf("one project named after the main checkout: %+v", repos)
	}
	// label keeps its meaning: a checkout of the repository that registered it.
	if l := repos[0].Label; l != root && l != linked[0] && l != linked[1] {
		t.Fatalf("label must be a checkout that was observed: %q", l)
	}
	roots := readRoots(t, home)
	if len(roots) != 1 || roots[0].Root != root {
		t.Fatalf("the main checkout is what persists: %+v", roots)
	}

	// The worktree that was observed first goes away; the project does not.
	if err := os.RemoveAll(linked[0]); err != nil {
		t.Fatal(err)
	}
	restarted := New(testEngine(t, cfg), cfg, home, "test")
	restarted.reconcileGraphRoots(t.Context())
	if repos := listedRepos(t, restarted); len(repos) != 1 || repos[0].Label != root || repos[0].Status != "ready" {
		t.Fatalf("after restart: %+v", repos)
	}
}

// A remembered root that was deleted, or is no longer a repository, is not a
// project: it is neither listed nor kept.
func TestDeletedRootsAreForgotten(t *testing.T) {
	root := gitRepo(t)
	gitIn(t, root, "commit", "-q", "--allow-empty", "-m", "base")
	deleted := filepath.Join(t.TempDir(), "scratch", "repo")
	plain, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".agentfirehose"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plain, "notes.txt"), []byte("not a repository\n"), 0600); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal([]graphRoot{{deleted, ""}, {plain, ""}, {root, ""}})
	if err := os.WriteFile(graphRootsPath(home), data, 0600); err != nil {
		t.Fatal(err)
	}
	s := New(testEngine(t, cfg), cfg, home, "test")
	observe(t, s, filepath.Join(t.TempDir(), "never-existed"))
	s.reconcileGraphRoots(t.Context())
	if repos := listedRepos(t, s); len(repos) != 1 || repos[0].Label != root {
		t.Fatalf("only the live repository is a project: %+v", repos)
	}
	if roots := readRoots(t, home); len(roots) != 1 || roots[0].Root != root {
		t.Fatalf("dead roots are dropped from the file: %+v", roots)
	}
}

// A repository on a volume that is not mounted is not "deleted": it stays
// remembered and is listed as unavailable until the volume returns.
func TestUnmountedRootStaysRemembered(t *testing.T) {
	if !rootMayReturn("/Volumes/NotMounted/work/repo") || rootMayReturn(filepath.Join(t.TempDir(), "gone")) {
		t.Fatal("removable-mount detection")
	}
}

// A repository that cannot be scanned is one unavailable project, however many
// of its worktrees were observed, and it carries the project identity events use.
func TestUnreadableRepositoryIsOneUnavailableProject(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if out, e := exec.Command("git", "-C", root, "init", "-q", "--ref-format=reftable").CombinedOutput(); e != nil {
		t.Skipf("git without reftable support: %s", out)
	}
	gitIn(t, root, "commit", "-q", "--allow-empty", "-m", "base")
	linked := filepath.Join(filepath.Dir(root), filepath.Base(root)+"-linked")
	gitIn(t, root, "worktree", "add", "-q", "--detach", linked)
	t.Cleanup(func() { os.RemoveAll(linked) })
	// Read live (the shadow does not mirror reftable), where unknown config refuses the scan.
	gitIn(t, root, "config", "custom.thing", "1")

	cfg := testConfig(t)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	observe(t, s, linked, root)
	s.reconcileGraphRoots(t.Context())
	repos := listedRepos(t, s)
	if len(repos) != 1 || repos[0].Status != "unavailable" || repos[0].Label != root || repos[0].VCS != "git" {
		t.Fatalf("one unavailable project: %+v", repos)
	}
	if want := digestString(filepath.Join(root, ".git")); repos[0].ProjectID != want || repos[0].ProjectLabel != root {
		t.Fatalf("project identity: %+v want %s", repos[0], want)
	}
	var _ workspacegraph.Repository = repos[0]
}

// In a bare repository every worktree is a fork: none is "primary", so each is
// compared with the default branch, and the project is named after the git dir.
func TestBareRepositoryWorktreesAreAllForks(t *testing.T) {
	holder, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bare := filepath.Join(holder, "project.git")
	gitIn(t, holder, "init", "-q", "--bare", "-b", "main", bare)
	seed := filepath.Join(holder, "seed")
	gitIn(t, holder, "clone", "-q", bare, seed)
	gitIn(t, seed, "commit", "-q", "--allow-empty", "-m", "base")
	gitIn(t, seed, "push", "-q", "origin", "HEAD:main")
	one, two := filepath.Join(holder, "one"), filepath.Join(holder, "two")
	gitIn(t, bare, "worktree", "add", "-q", "-b", "one", one, "main")
	gitIn(t, bare, "worktree", "add", "-q", "-b", "two", two, "main")
	gitIn(t, one, "commit", "-q", "--allow-empty", "-m", "ahead")

	s, home := newWorktreeServer(t, "full")
	admitSession(t, engineAdmitter{s.engine}, "sess-one", one, "2026-10-31T12:10:00Z", "2026-10-31T12:30:00Z")
	admitSession(t, engineAdmitter{s.engine}, "sess-two", two, "2026-10-31T12:10:00Z", "2026-10-31T12:30:00Z")
	s.reconcileGraphRoots(t.Context())

	repos := listedRepos(t, s)
	if len(repos) != 1 || repos[0].ProjectLabel != bare || repos[0].ID != bare {
		t.Fatalf("one project named after the git dir: %+v", repos)
	}
	if roots := readRoots(t, home); len(roots) != 1 || roots[0].Root != bare {
		t.Fatalf("persisted: %+v", roots)
	}
	if row := wtByLabel(t, s, one); row["state"] != "open" || row["repo_id"] != bare {
		t.Fatalf("the first worktree is a fork, not a primary checkout: %v", row)
	}
	if row := wtByLabel(t, s, two); row["state"] != "never_diverged" {
		t.Fatalf("second worktree: %v", row)
	}
}

// A remembered root is forgotten only when it is confirmed gone: one that
// merely cannot be read stays remembered and is listed as unavailable.
func TestUnreadableRootIsNotForgotten(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permissions are not enforced for root")
	}
	root := gitRepo(t)
	gitIn(t, root, "commit", "-q", "--allow-empty", "-m", "base")
	cfg := testConfig(t)
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	observe(t, s, root)
	s.reconcileGraphRoots(t.Context())
	if roots := readRoots(t, home); len(roots) != 1 {
		t.Fatalf("remembered: %+v", roots)
	}
	if err := os.Chmod(root, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o700) })
	restarted := New(testEngine(t, cfg), cfg, home, "test")
	restarted.reconcileGraphRoots(t.Context())
	if roots := readRoots(t, home); len(roots) != 1 || roots[0].Root != root {
		t.Fatalf("an unreadable root must stay remembered: %+v", roots)
	}
	if repos := listedRepos(t, restarted); len(repos) != 1 || repos[0].Status != "unavailable" || repos[0].Label != root {
		t.Fatalf("listed as unavailable: %+v", repos)
	}
}

// An explicit VCS for a colocated root is that root's only registration, and
// it is stable: reconciling again neither adds the other side nor drops the
// snapshot already taken.
func TestExplicitVCSChoiceIsStableAcrossReconciles(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj unavailable")
	}
	root := gitRepo(t)
	gitIn(t, root, "commit", "-q", "--allow-empty", "-m", "base")
	if out, err := exec.Command("jj", "git", "init", "--colocate", root).CombinedOutput(); err != nil {
		t.Fatalf("jj: %v %s", err, out)
	}
	cfg := testConfig(t)
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	if err := s.rememberGraphRoot(root, "jj"); err != nil {
		t.Fatal(err)
	}
	s.reconcileGraphRoots(t.Context())
	first := listedRepos(t, s)
	if len(first) != 1 || first[0].VCS != "jj" || first[0].Status != "ready" {
		t.Fatalf("explicit jj: %+v", first)
	}
	s.reconcileGraphRoots(t.Context())
	second := listedRepos(t, s)
	if len(second) != 1 || second[0].ID != first[0].ID || second[0].Status != "ready" {
		t.Fatalf("after a second reconcile: %+v", second)
	}
	if roots := readRoots(t, home); len(roots) != 1 || roots[0].VCS != "jj" {
		t.Fatalf("persisted choice: %+v", roots)
	}
}

// Captured history is not a discovery hint. An ingested event can claim any
// repo_id, so a repository named only there is never registered or scanned;
// only a root observed from a live cwd, or registered explicitly, is.
func TestCapturedHistoryIsNotADiscoveryHint(t *testing.T) {
	_, linked := linkedRepo(t, 1)
	cfg := testConfig(t)
	cfg.PrivacyMode = "full"
	earlier := testEngine(t, cfg)
	admitSession(t, engineAdmitter{earlier}, "old", linked[0], "2026-10-31T12:10:00Z", "2026-10-31T12:30:00Z")
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	if len(s.engine.ObservedRoots()) != 0 || len(s.engine.Worktrees()) == 0 {
		t.Fatal("fixture: history must name the repository and nothing may be observed live")
	}
	s.reconcileGraphRoots(t.Context())
	if repos := listedRepos(t, s); len(repos) != 0 {
		t.Fatalf("history must not register a repository: %+v", repos)
	}
	if _, err := os.Stat(graphRootsPath(home)); err == nil {
		t.Fatalf("history must not persist a root: %+v", readRoots(t, home))
	}
}

// Metadata that is present but cannot be read is not proof the repository is
// gone: the root stays remembered and is listed as unavailable.
func TestRootWithUnreadableMetadataIsNotForgotten(t *testing.T) {
	if os.Geteuid() == 0 || runtime.GOOS == "windows" {
		t.Skip("needs enforced directory permissions")
	}
	root := gitRepo(t)
	gitIn(t, root, "commit", "-q", "--allow-empty", "-m", "base")
	cfg := testConfig(t)
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	observe(t, s, root)
	s.reconcileGraphRoots(t.Context())
	if err := os.Chmod(filepath.Join(root, ".git"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, ".git"), 0o700) })
	restarted := New(testEngine(t, cfg), cfg, home, "test")
	restarted.reconcileGraphRoots(t.Context())
	if roots := readRoots(t, home); len(roots) != 1 || roots[0].Root != root {
		t.Fatalf("a root with unreadable metadata must stay remembered: %+v", roots)
	}
	if repos := listedRepos(t, restarted); len(repos) != 1 || repos[0].Status != "unavailable" {
		t.Fatalf("listed as unavailable: %+v", repos)
	}
}

// An empty directory is what an unmounted mount point looks like, so it is not
// proof either; a directory under a mount prefix never is.
func TestEmptyOrMountedRootIsNotConfirmedGone(t *testing.T) {
	empty := t.TempDir()
	if rootIsGone(empty) {
		t.Fatal("an empty directory may be an unmounted mount point")
	}
	if err := os.WriteFile(filepath.Join(empty, "notes.txt"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if !rootIsGone(empty) {
		t.Fatal("a readable directory with content and no VCS metadata is confirmed not a repository")
	}
	if rootIsGone("/mnt/nas/repo") || rootIsGone("/Volumes/NotMounted/repo") {
		t.Fatal("a root under a mount point is never confirmed gone")
	}
	if !rootIsGone(filepath.Join(empty, "deleted")) {
		t.Fatal("a missing path off any mount point is gone")
	}
}
