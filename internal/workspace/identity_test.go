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

// symlinkedRepo returns a real Git repo with a nested directory, and a symlink
// to it. The test's own temp root is canonicalised first, because macOS temp
// directories are themselves reached through a symlink.
func symlinkedRepo(t *testing.T) (real, link string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	real = filepath.Join(root, "real")
	if err := os.MkdirAll(filepath.Join(real, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(real, "pkg", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	link = filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	return real, link
}

func TestEnrichRecordsRootAliasWhenCwdIsSymlinked(t *testing.T) {
	real, link := symlinkedRepo(t)
	for _, cwd := range []string{link, filepath.Join(link, "pkg"), filepath.Join(link, "pkg", "sub")} {
		got := Enrich(event.Event{CWD: cwd})
		if got.WorktreeID != real {
			t.Fatalf("cwd %q: worktree = %q, want canonical %q", cwd, got.WorktreeID, real)
		}
		if got.RootAlias != link {
			t.Fatalf("cwd %q: root alias = %q, want %q", cwd, got.RootAlias, link)
		}
		if got.CWD != cwd {
			t.Fatalf("cwd rewritten: %q", got.CWD)
		}
	}
}

func TestEnrichRecordsNoAliasForCanonicalCwd(t *testing.T) {
	real, _ := symlinkedRepo(t)
	for _, cwd := range []string{real, filepath.Join(real, "pkg")} {
		if got := Enrich(event.Event{CWD: cwd}); got.RootAlias != "" {
			t.Fatalf("cwd %q: unexpected alias %q", cwd, got.RootAlias)
		}
	}
}

// A symlink below the root leaves no spelling of the root in cwd, so there is
// nothing truthful to record.
func TestEnrichRecordsNoAliasForSymlinkInsideRepo(t *testing.T) {
	real, _ := symlinkedRepo(t)
	inner := filepath.Join(real, "inner")
	if err := os.Symlink(filepath.Join(real, "pkg", "sub"), inner); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	got := Enrich(event.Event{CWD: inner})
	if got.WorktreeID != real || got.RootAlias != "" {
		t.Fatalf("worktree %q alias %q", got.WorktreeID, got.RootAlias)
	}
}

// The alias is a local observation. A caller cannot use it to persist text.
func TestEnrichDiscardsCallerSuppliedRootAlias(t *testing.T) {
	real, link := symlinkedRepo(t)
	for name, tc := range map[string]struct{ cwd, want string }{
		"unobservable": {cwd: filepath.Join(real, "does-not-exist"), want: ""},
		"canonical":    {cwd: real, want: ""},
		"symlinked":    {cwd: link, want: link},
	} {
		got := Enrich(event.Event{CWD: tc.cwd, RootAlias: "/caller/supplied"})
		if got.RootAlias != tc.want {
			t.Fatalf("%s: alias %q, want %q", name, got.RootAlias, tc.want)
		}
	}
}

func TestEnrichRootAliasForJJWorkspace(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(filepath.Join(real, ".jj", "repo"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	got := Enrich(event.Event{CWD: link})
	if got.JJWorkspaceID != "jj:"+real || got.RootAlias != link {
		t.Fatalf("workspace %q alias %q", got.JJWorkspaceID, got.RootAlias)
	}
}

// /other/pkg -> /real/pkg ends in the same folder name as the cwd below the
// root, so the text alone would claim /other is a spelling of /real.
func TestEnrichRecordsNoAliasForSymlinkFromAnotherRepo(t *testing.T) {
	real, _ := symlinkedRepo(t)
	other := filepath.Join(filepath.Dir(real), "other")
	if err := os.MkdirAll(filepath.Join(other, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	cwd := filepath.Join(other, "pkg")
	if err := os.Symlink(filepath.Join(real, "pkg"), cwd); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	got := Enrich(event.Event{CWD: cwd})
	if got.WorktreeID != real || got.RootAlias != "" {
		t.Fatalf("worktree %q alias %q", got.WorktreeID, got.RootAlias)
	}
}

// In a colocated repo the Git worktree and the JJ workspace can differ. The
// alias must spell the root that Activity maps it onto: the Git one.
func TestEnrichRootAliasPrefersGitRootWhenColocated(t *testing.T) {
	real, link := symlinkedRepo(t)
	if err := os.MkdirAll(filepath.Join(real, ".jj", "repo"), 0o755); err != nil {
		t.Fatal(err)
	}
	feature := filepath.Join(real, "feature")
	if err := os.MkdirAll(filepath.Join(feature, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := Enrich(event.Event{CWD: filepath.Join(link, "feature")})
	if got.WorktreeID != feature || got.JJWorkspaceID != "jj:"+real {
		t.Fatalf("fixture: worktree %q workspace %q", got.WorktreeID, got.JJWorkspaceID)
	}
	if want := filepath.Join(link, "feature"); got.RootAlias != want {
		t.Fatalf("alias %q, want %q", got.RootAlias, want)
	}
}

func TestTrimPathSuffix(t *testing.T) {
	for name, tc := range map[string]struct {
		path, suffix string
		fold         bool
		want         string
		ok           bool
	}{
		"match":           {"/link/pkg", "/pkg", false, "/link", true},
		"no match":        {"/link/pkg", "/lib", false, "", false},
		"case differs":    {"/link/pkg", "/Pkg", false, "", false},
		"case folded":     {`C:\link\pkg`, `\Pkg`, true, `C:\link`, true},
		"suffix too long": {"/a", "/abc", true, "", false},
	} {
		got, ok := trimPathSuffix(tc.path, tc.suffix, tc.fold)
		if got != tc.want || ok != tc.ok {
			t.Errorf("%s: got (%q, %v)", name, got, ok)
		}
	}
}
