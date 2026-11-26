package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func git(t *testing.T, root string, args ...string) string {
	t.Helper()
	c := exec.Command("git", args...)
	c.Dir = root
	c.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid")
	b, e := c.CombinedOutput()
	if e != nil {
		t.Fatalf("git %v: %s %v", args, b, e)
	}
	return strings.TrimSpace(string(b))
}
func fixture(t *testing.T) string {
	t.Helper()
	r := t.TempDir()
	git(t, r, "init", "-b", "main")
	git(t, r, "commit", "--allow-empty", "-m", "sensitive description")
	return r
}
func TestGitGraphNamesReadableIdentitiesPrivateCompareStale(t *testing.T) {
	ctx := context.Background()
	root := fixture(t)
	other := filepath.Join(t.TempDir(), "sensitive-worktree")
	git(t, root, "worktree", "add", "-b", "feature", other)
	git(t, other, "commit", "--allow-empty", "-m", "second")
	os.WriteFile(filepath.Join(other, "secret"), []byte("x"), 0600)
	s := New(privacy.ModeBalanced)
	r, e := s.Register(ctx, root, "git")
	if e != nil {
		t.Fatal(e)
	}
	snap, e := s.Snapshot(ctx, r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	if len(snap.Workspaces) != 2 || len(snap.Nodes) != 2 {
		t.Fatalf("%+v", snap)
	}
	canonicalRoot, _ := canonical(root)
	canonicalOther, _ := canonical(other)
	labels := map[string]bool{}
	for _, w := range snap.Workspaces {
		labels[w.Label] = true
		if strings.Contains(w.ID, root) || strings.Contains(w.ID, other) || len(w.ID) != 64 {
			t.Errorf("balanced workspace identity must stay a digest: %q", w.ID)
		}
	}
	if snap.Repository.Label != canonicalRoot || !labels[canonicalRoot] || !labels[canonicalOther] {
		t.Fatalf("labels must be the readable paths: repo=%q workspaces=%v", snap.Repository.Label, labels)
	}
	if strings.Contains(snap.Repository.ID, root) || len(snap.Repository.ID) != 64 {
		t.Fatalf("balanced repository identity must stay a digest: %q", snap.Repository.ID)
	}
	var selected string
	for _, w := range snap.Workspaces {
		if w.Dirty {
			selected = w.Revision
		}
	}
	cmp, e := s.Compare(ctx, r.ID, selected, snap.DefaultTarget)
	if e != nil || len(cmp.SelectedOnly) != 1 {
		t.Fatalf("%+v %v", cmp, e)
	}
	s.SetPrivacy(privacy.ModeMinimal)
	rs := s.Repositories()
	snap, e = s.Snapshot(ctx, rs[0].ID, "", true)
	b, _ := json.Marshal(snap)
	if e != nil || !strings.Contains(string(b), "sensitive description") || !strings.Contains(string(b), "refs/heads/feature") || rs[0].Label != canonicalRoot {
		t.Fatalf("minimal mode must keep descriptions, refs and labels readable: %s %v", b, e)
	}
	os.Rename(filepath.Join(root, ".git"), filepath.Join(root, "hidden"))
	snap, e = s.Snapshot(ctx, rs[0].ID, "", true)
	if e != nil || !snap.Stale || len(snap.Nodes) != 2 {
		t.Fatalf("stale %+v %v", snap, e)
	}
}

// Display data is identical in every mode. Only the identities that captured
// events carry (Repository.ID, Workspace.ID) follow the privacy mode, so
// session association keeps matching, and EventScope aliases are unchanged.
func TestGraphIdentitiesFollowModeWhileDisplayDataIsReadable(t *testing.T) {
	ctx := context.Background()
	root := fixture(t)
	canonicalRoot, _ := canonical(root)
	long := strings.Repeat("a long readable description ", 20) // > 240 runes
	git(t, root, "commit", "--allow-empty", "-m", long)
	other := filepath.Join(t.TempDir(), "wt-readable")
	git(t, root, "worktree", "add", "-b", "agent/readable", other)
	canonicalOther, _ := canonical(other)
	longPath := strings.Repeat("p", 120) + "/" + strings.Repeat("q", 120) + "/file.txt"
	writeText(t, other, longPath, "x\n")
	for _, mode := range []privacy.Mode{privacy.ModeMinimal, privacy.ModeBalanced, privacy.ModeFull} {
		s := New(mode)
		r, e := s.Register(ctx, root, "git")
		if e != nil {
			t.Fatal(e)
		}
		v, e := s.Snapshot(ctx, r.ID, "", true)
		if e != nil {
			t.Fatal(e)
		}
		wantRepoID, wantOtherID := privacy.HashIdentity(identityRaw(t, root)), privacy.HashIdentity(canonicalOther)
		if mode == privacy.ModeFull {
			wantRepoID, wantOtherID = identityRaw(t, root), canonicalOther
		}
		if r.ID != wantRepoID || v.Repository.ID != wantRepoID || s.Repositories()[0].ID != wantRepoID {
			t.Errorf("%s: repository id %q / %q want %q", mode, r.ID, v.Repository.ID, wantRepoID)
		}
		if r.Label != canonicalRoot || v.Repository.Label != canonicalRoot || s.Repositories()[0].Label != canonicalRoot {
			t.Errorf("%s: repository label %q want %q", mode, v.Repository.Label, canonicalRoot)
		}
		var found bool
		for _, w := range v.Workspaces {
			if w.RepoID != wantRepoID {
				t.Errorf("%s: workspace repo id %q", mode, w.RepoID)
			}
			if w.Label != w.rawIdentity {
				t.Errorf("%s: git workspace label %q must be its worktree path %q", mode, w.Label, w.rawIdentity)
			}
			if w.rawIdentity == canonicalOther {
				found = true
				if w.ID != wantOtherID {
					t.Errorf("%s: workspace id %q want %q", mode, w.ID, wantOtherID)
				}
				if !reflect.DeepEqual(w.Refs, []string{"refs/heads/agent/readable"}) {
					t.Errorf("%s: refs %v", mode, w.Refs)
				}
				got := changesByPath(w.Changes)
				if _, ok := got[longPath]; !ok || len(w.ChangedFiles) == 0 || !strings.Contains(w.ChangedFiles[0], "pppp") {
					t.Errorf("%s: long path must be raw and untruncated: %+v %q", mode, w.Changes, w.ChangedFiles)
				}
				repoAliases, wsAliases, e := s.EventScope(r.ID, w.ID)
				if e != nil || repoAliases[0] != identityRaw(t, root) || repoAliases[1] != privacy.HashIdentity(identityRaw(t, root)) || wsAliases[0] != canonicalOther || wsAliases[1] != privacy.HashIdentity(canonicalOther) {
					t.Errorf("%s: event aliases changed: %v %v %v", mode, repoAliases, wsAliases, e)
				}
			}
		}
		if !found {
			t.Fatalf("%s: linked worktree missing: %+v", mode, v.Workspaces)
		}
		var descriptions []string
		for _, n := range v.Nodes {
			descriptions = append(descriptions, n.Description)
		}
		if !strings.Contains(strings.Join(descriptions, "|"), strings.TrimSpace(long)) {
			t.Errorf("%s: revision description truncated or hashed: %q", mode, descriptions)
		}
		if v.DefaultTargetRef != "main" {
			t.Errorf("%s: default_target_ref %q", mode, v.DefaultTargetRef)
		}
	}
}

// identityRaw is the unprocessed Git repository identity (canonical common dir).
func identityRaw(t *testing.T, root string) string {
	t.Helper()
	common := git(t, root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	c, err := canonical(common)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestGitPaginationRetainsAnchorsAndRealEdges(t *testing.T) {
	ctx := context.Background()
	root := fixture(t)
	for i := 0; i < 7; i++ {
		git(t, root, "commit", "--allow-empty", "-m", "history")
	}
	s := New(privacy.ModeFull)
	s.pageSize = 2
	r, _ := s.Register(ctx, root, "git")
	snap, e := s.Snapshot(ctx, r.ID, "", true)
	if e != nil || snap.NextCursor == "" || len(snap.Boundaries) == 0 {
		t.Fatalf("%+v %v", snap, e)
	}
	next, e := s.Snapshot(ctx, r.ID, snap.NextCursor, false)
	if e != nil || len(next.Nodes) <= len(snap.Nodes) || len(next.Workspaces) != 1 {
		t.Fatalf("%+v %v", next, e)
	}
}
func TestUnborn(t *testing.T) {
	root := t.TempDir()
	git(t, root, "init", "-b", "main")
	s := New(privacy.ModeFull)
	r, e := s.Register(context.Background(), root, "git")
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.Snapshot(context.Background(), r.ID, "", true)
	if e != nil || len(v.Workspaces) != 1 || !v.Workspaces[0].Unborn {
		t.Fatalf("%+v %v", v, e)
	}
}
func jj(t *testing.T, root string, args ...string) string {
	t.Helper()
	c := exec.Command("jj", args...)
	c.Dir = root
	var stderr strings.Builder
	c.Stderr = &stderr
	b, e := c.Output()
	if e != nil {
		t.Fatalf("jj %v: %s %v", args, stderr.String(), e)
	}
	return strings.TrimSpace(string(b))
}
func TestJJReadOnlyWorkspaces(t *testing.T) {
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
	ctx := context.Background()
	root := t.TempDir()
	jj(t, root, "git", "init")
	jj(t, root, "describe", "-m", "private JJ description")
	other := filepath.Join(t.TempDir(), "other")
	jj(t, root, "workspace", "add", other)
	before := jj(t, root, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id")
	s := New(privacy.ModeFull)
	r, e := s.Register(ctx, root, "jj")
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.Snapshot(ctx, r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	if len(v.Workspaces) != 2 || len(v.Nodes) < 2 {
		t.Fatalf("%+v", v)
	}
	after := jj(t, root, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id")
	if before != after {
		t.Fatal("scan mutated JJ operation")
	}
	for _, n := range v.Nodes {
		if n.ChangeID == "" {
			t.Fatal("missing change ID")
		}
	}
	cmp, e := s.Compare(ctx, r.ID, v.Workspaces[0].Revision, v.Workspaces[1].Revision)
	if e != nil {
		t.Fatal(e)
	}
	if len(cmp.MergeBases) == 0 {
		t.Fatal("missing merge base")
	}
}
func TestMergeSharedAnchorsAndPrivacyAliases(t *testing.T) {
	ctx := context.Background()
	root := fixture(t)
	base := git(t, root, "rev-parse", "HEAD")
	other := filepath.Join(t.TempDir(), "sibling")
	git(t, root, "worktree", "add", "-b", "feature", other)
	git(t, other, "commit", "--allow-empty", "-m", "feature")
	git(t, root, "commit", "--allow-empty", "-m", "main")
	git(t, root, "merge", "--no-ff", "feature", "-m", "merge")
	shared := filepath.Join(t.TempDir(), "shared")
	git(t, root, "worktree", "add", "--detach", shared, "HEAD")
	s := New(privacy.ModeBalanced)
	r, _ := s.Register(ctx, root, "git")
	v, e := s.Snapshot(ctx, r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	parents := 0
	for _, n := range v.Nodes {
		if len(n.Parents) == 2 {
			parents++
		}
	}
	if parents != 1 || len(v.Workspaces) != 3 {
		t.Fatalf("%+v", v)
	}
	_, aliases, e := s.EventScope(r.ID, v.Workspaces[0].ID)
	if e != nil || len(aliases) != 2 || aliases[0] == aliases[1] {
		t.Fatalf("aliases %v %v", aliases, e)
	}
	cmp, e := s.Compare(ctx, r.ID, v.DefaultTarget, base)
	if e != nil || len(cmp.SelectedOnly) != 3 {
		t.Fatalf("%+v %v", cmp, e)
	}
}
func TestJJColocationDedup(t *testing.T) {
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
	root := fixture(t)
	jj(t, root, "git", "init", "--colocate")
	s := New(privacy.ModeBalanced)
	ctx := context.Background()
	s.Register(ctx, root, "git")
	_, e := s.Register(ctx, root, "jj")
	if e != nil {
		t.Fatal(e)
	}
	if len(s.Repositories()) != 1 || s.Repositories()[0].VCS != "jj" {
		t.Fatalf("%+v", s.Repositories())
	}
}
func TestJJStaleWorkspaceAndMovement(t *testing.T) {
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
	root := t.TempDir()
	jj(t, root, "git", "init")
	other := filepath.Join(t.TempDir(), "other")
	jj(t, root, "workspace", "add", other)
	jj(t, root, "describe", "-r", "other@", "-m", "rewritten remotely")
	s := New(privacy.ModeFull)
	r, _ := s.Register(context.Background(), root, "jj")
	v, e := s.Snapshot(context.Background(), r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, w := range v.Workspaces {
		if w.Label == "other" {
			found = true
			if w.Availability != "stale" {
				t.Fatalf("%+v", w)
			}
		}
	}
	if !found {
		t.Fatal("missing workspace")
	}
}

// The performance fixture is opt-in so normal capture tests stay fast.
func TestLargeGraphFixture(t *testing.T) {
	if os.Getenv("FIREHOSE_GRAPH_PERF") == "" {
		t.Skip("set FIREHOSE_GRAPH_PERF=1 for 50-workspace / 2100-revision fixture")
	}
	root := t.TempDir()
	git(t, root, "init", "-b", "main")
	var input strings.Builder
	for i := 1; i <= 2100; i++ {
		fmt.Fprintf(&input, "commit refs/heads/main\nmark :%d\ncommitter Fixture <fixture@example.invalid> %d +0000\ndata 7\nfixture\n", i, 1700000000+i)
		if i > 1 {
			fmt.Fprintf(&input, "from :%d\n", i-1)
		}
		input.WriteString("\n")
	}
	cmd := exec.Command("git", "fast-import", "--quiet")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(input.String())
	if b, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("%v %s", e, b)
	}
	for i := 0; i < 49; i++ {
		tip := "HEAD"
		if i >= 7 {
			tip = fmt.Sprintf("HEAD~%d", (i-6)*40)
		}
		git(t, root, "worktree", "add", "--detach", "--no-checkout", filepath.Join(t.TempDir(), fmt.Sprint("workspace", i)), tip)
	}
	s := New(privacy.ModeBalanced)
	r, e := s.Register(context.Background(), root, "git")
	if e != nil {
		t.Fatal(e)
	}
	start := time.Now()
	v, e := s.Snapshot(context.Background(), r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("50 workspaces / %d loaded nodes in %s", len(v.Nodes), time.Since(start))
	if len(v.Workspaces) != 50 || len(v.Nodes) < 2000 || v.NextCursor == "" {
		t.Fatalf("workspaces=%d nodes=%d cursor=%s", len(v.Workspaces), len(v.Nodes), v.NextCursor)
	}
	nodes := map[string]bool{}
	for _, n := range v.Nodes {
		nodes[n.Key] = true
	}
	for _, w := range v.Workspaces {
		if !nodes[w.Revision] {
			t.Fatal("missing anchor")
		}
	}
	v, e = s.Snapshot(context.Background(), r.ID, v.NextCursor, false)
	if e != nil || len(v.Nodes) != 2100 {
		t.Fatalf("expanded nodes=%d %v", len(v.Nodes), e)
	}
}
func TestJJDivergentChangeIDsRemainDistinct(t *testing.T) {
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
	root := t.TempDir()
	jj(t, root, "git", "init")
	op := jj(t, root, "op", "log", "--no-graph", "--limit", "1", "-T", "id")
	jj(t, root, "describe", "-m", "one")
	one := jj(t, root, "log", "--no-graph", "-r", "@", "-T", "commit_id")
	jj(t, root, "--at-op="+op, "describe", "-m", "two")
	// Read each operation head before integrating them, retaining both rewrite identities.
	heads := jj(t, root, "op", "log", "--no-graph", "--limit", "3", "-T", `id ++ "\n"`)
	two := ""
	for _, head := range strings.Fields(heads) {
		candidate := jj(t, root, "--at-op="+head, "log", "--no-graph", "-r", "@", "-T", "commit_id")
		if candidate != one {
			desc := jj(t, root, "--at-op="+head, "log", "--no-graph", "-r", "@", "-T", "description")
			if desc == "two" {
				two = candidate
				break
			}
		}
	}
	if two == "" {
		t.Fatal("fixture missing second rewrite")
	}
	jj(t, root, "log", "--no-graph", "-r", "all()", "-T", "commit_id")
	jj(t, root, "workspace", "add", "--revision", one, filepath.Join(t.TempDir(), "one"))
	jj(t, root, "workspace", "add", "--revision", two, filepath.Join(t.TempDir(), "two"))
	s := New(privacy.ModeFull)
	r, _ := s.Register(context.Background(), root, "jj")
	v, e := s.Snapshot(context.Background(), r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	ids := map[string]string{}
	found := false
	for _, n := range v.Nodes {
		if prev := ids[n.ChangeID]; prev != "" && prev != n.CommitID {
			found = true
		}
		ids[n.ChangeID] = n.CommitID
	}
	if !found {
		t.Fatal("divergent revisions collapsed")
	}
}
func TestShallowBoundaryAndDirtyFiles(t *testing.T) {
	root := fixture(t)
	git(t, root, "commit", "--allow-empty", "-m", "second")
	clone := filepath.Join(t.TempDir(), "clone")
	git(t, root, "clone", "--depth=1", "file://"+root, clone)
	os.WriteFile(filepath.Join(clone, "private-name"), []byte("x"), 0600)
	s := New(privacy.ModeMinimal)
	r, _ := s.Register(context.Background(), clone, "git")
	v, e := s.Snapshot(context.Background(), r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	if len(v.Boundaries) != 1 || len(v.Edges) != 0 || v.NextCursor != "" {
		t.Fatalf("shallow ancestry %+v", v)
	}
	if len(v.Workspaces[0].ChangedFiles) != 1 || !strings.Contains(v.Workspaces[0].ChangedFiles[0], "private-name") {
		t.Fatalf("files %+v", v.Workspaces[0])
	}
}

func TestGitComparisonMultipleMergeBasesAndDisconnectedHistories(t *testing.T) {
	root := fixture(t)
	tree := git(t, root, "rev-parse", "HEAD^{tree}")
	base := git(t, root, "rev-parse", "HEAD")
	a := git(t, root, "commit-tree", tree, "-p", base, "-m", "side a")
	b := git(t, root, "commit-tree", tree, "-p", base, "-m", "side b")
	// Real criss-cross merges: both independent children retain a and b as parents.
	// Identical messages do not make their full revision identities equivalent.
	x := git(t, root, "commit-tree", tree, "-p", a, "-p", b, "-m", "same description")
	y := git(t, root, "commit-tree", tree, "-p", b, "-p", a, "-m", "same description")
	if x == y {
		t.Fatal("fixture needs distinct revision IDs")
	}
	orphan := git(t, root, "commit-tree", tree, "-m", "disconnected history")
	git(t, root, "update-ref", "refs/heads/criss-cross", x)
	git(t, root, "update-ref", "refs/heads/other", y)
	git(t, root, "update-ref", "refs/heads/disconnected", orphan)
	s := New(privacy.ModeFull)
	ctx := context.Background()
	r, e := s.Register(ctx, root, "git")
	if e != nil {
		t.Fatal(e)
	}
	cmp, e := s.Compare(ctx, r.ID, x, y)
	if e != nil {
		t.Fatal(e)
	}
	bases := map[string]bool{}
	for _, id := range cmp.MergeBases {
		bases[id] = true
	}
	if len(bases) != 2 || !bases[a] || !bases[b] || cmp.Disconnected {
		t.Fatalf("merge bases: %+v", cmp)
	}
	if len(cmp.SelectedOnly) != 1 || cmp.SelectedOnly[0] != x || len(cmp.TargetOnly) != 1 || cmp.TargetOnly[0] != y {
		t.Fatalf("same-message revisions incorrectly collapsed: %+v", cmp)
	}
	if len(cmp.ChangedFiles) != 0 {
		t.Fatalf("identical trees should have no changed files: %+v", cmp)
	}
	cmp, e = s.Compare(ctx, r.ID, x, orphan)
	if e != nil {
		t.Fatal(e)
	}
	if !cmp.Disconnected || len(cmp.MergeBases) != 0 || len(cmp.SelectedOnly) != 4 || len(cmp.TargetOnly) != 1 || cmp.TargetOnly[0] != orphan {
		t.Fatalf("disconnected comparison: %+v", cmp)
	}
}

func TestCanceledGitScanRetainsStaleSnapshot(t *testing.T) {
	root := fixture(t)
	s := New(privacy.ModeBalanced)
	r, e := s.Register(context.Background(), root, "git")
	if e != nil {
		t.Fatal(e)
	}
	before, e := s.Snapshot(context.Background(), r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	after, e := s.Snapshot(ctx, r.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("cancelled scan took %s", elapsed)
	}
	if !after.Stale || after.Repository.Status != "stale" || len(after.Warnings) == 0 || after.Generation != before.Generation || len(after.Nodes) != len(before.Nodes) || after.Nodes[0].CommitID != before.Nodes[0].CommitID {
		t.Fatalf("last successful snapshot not retained: %+v", after)
	}
}

// An untrusted repository's own config must never get a command executed by
// the daemon's background scans (clean filters run during `git status`).
// A repository whose config defines a filter still scans: the scan never loads
// that config, so the filter cannot run and no longer hides the repository.
func TestGitScanIgnoresExecutableRepoConfig(t *testing.T) {
	ctx := context.Background()
	root := fixture(t)
	os.WriteFile(filepath.Join(root, ".gitattributes"), []byte("a.txt filter=pwn\n"), 0600)
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\n"), 0600)
	git(t, root, "add", ".")
	git(t, root, "commit", "-m", "tracked")
	marker := filepath.Join(t.TempDir(), "pwned")
	git(t, root, "config", "filter.pwn.clean", "touch "+marker+"; cat")
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("two\n"), 0600)

	s := New(privacy.ModeFull)
	repo, err := s.Register(ctx, root, "git")
	if err != nil {
		t.Fatal(err)
	}
	v, err := s.Snapshot(ctx, repo.ID, "", true)
	if err != nil || !v.Workspaces[0].Dirty {
		t.Fatalf("scan: %+v %v", v.Workspaces, err)
	}
	if _, e := os.Stat(marker); e == nil {
		t.Fatal("repo-local filter command was executed")
	}
}

func TestGitScanAllowsBenignRepoConfig(t *testing.T) {
	root := fixture(t)
	git(t, root, "config", "user.name", "Someone")
	git(t, root, "config", "core.autocrlf", "false")
	git(t, root, "config", "remote.origin.url", "https://example.invalid/x.git")
	git(t, root, "config", "branch.main.remote", "origin")
	s := New(privacy.ModeFull)
	if _, err := s.Register(context.Background(), root, "git"); err != nil {
		t.Fatal(err)
	}
}

// Branch and remote names may contain dots (release/v0.2.0, my.fork); the
// subsection sits between the first and last dot, so such keys stay inert.
// Editors also add per-branch keys (VS Code's vscode-merge-base).
func TestGitScanAllowsDottedBranchAndRemoteNames(t *testing.T) {
	root := fixture(t)
	git(t, root, "config", "branch.release/v0.2.0.remote", "origin")
	git(t, root, "config", "branch.release/v0.2.0.merge", "refs/heads/release/v0.2.0")
	git(t, root, "config", "branch.main.vscode-merge-base", "origin/main")
	git(t, root, "config", "remote.my.fork.url", "https://example.invalid/x.git")
	git(t, root, "config", "remote.my.fork.fetch", "+refs/heads/*:refs/remotes/my.fork/*")
	if _, err := New(privacy.ModeFull).Register(context.Background(), root, "git"); err != nil {
		t.Fatal(err)
	}
}

// The guard protects only the live fallback (a repository the shadow git dir
// cannot mirror); there it still fails closed on any key it does not know.
func TestLiveConfigGuardFailsClosedOnUnknownRepoConfig(t *testing.T) {
	for _, kv := range [][2]string{{"core.fsmonitor", "touch x"}, {"core.sshcommand", "x"}, {"custom.thing", "1"}, {"diff.d.textconv", "x"}, {"diff.a.b.textconv", "x"}, {"remote.my.fork.uploadpack", "x"}, {"submodule.a.b.update", "!x"}} {
		root := fixture(t)
		git(t, root, "config", kv[0], kv[1])
		if err := guardGitConfig(context.Background(), root); err == nil {
			t.Fatalf("%s accepted", kv[0])
		}
	}
}

// A ref backend the shadow does not mirror is read live, behind the guard: an
// inert config scans, an unknown key refuses the repository.
func TestGitReftableRepositoryUsesGuardedLiveSession(t *testing.T) {
	root := t.TempDir()
	if out, e := exec.Command("git", "-C", root, "init", "-b", "main", "--ref-format=reftable").CombinedOutput(); e != nil {
		t.Skipf("git without reftable support: %s", out)
	}
	git(t, root, "commit", "--allow-empty", "-m", "base")
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("x"), 0600)
	ctx := context.Background()
	s := New(privacy.ModeFull)
	repo, err := s.Register(ctx, root, "git")
	if err != nil {
		t.Fatal(err)
	}
	v, err := s.Snapshot(ctx, repo.ID, "", true)
	if err != nil || len(v.Workspaces) != 1 || !v.Workspaces[0].Dirty || len(v.Nodes) != 1 || v.DefaultTargetRef != "main" {
		t.Fatalf("live scan: %+v %v", v, err)
	}
	git(t, root, "config", "custom.thing", "1")
	if _, err := s.Snapshot(ctx, repo.ID, "", true); err != nil {
		t.Fatalf("a failed rescan keeps the stale snapshot: %v", err)
	}
	if _, err := New(privacy.ModeFull).Register(ctx, root, "git"); err == nil {
		t.Fatal("unknown config accepted on the live path")
	}
}

// gitStatus must not depend on the guard: even with an executable filter in
// the live config (config rewritten after any check), status runs against a
// shadow git dir and the filter never fires, while dirty files are still seen.
func TestGitStatusNeverRunsLiveRepoFilters(t *testing.T) {
	ctx := context.Background()
	root := fixture(t)
	os.WriteFile(filepath.Join(root, ".gitattributes"), []byte("a.txt filter=pwn\n"), 0600)
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\n"), 0600)
	git(t, root, "add", ".")
	git(t, root, "commit", "-m", "tracked")
	marker := filepath.Join(t.TempDir(), "pwned")
	git(t, root, "config", "filter.pwn.clean", "touch "+marker+"; cat")
	git(t, root, "config", "core.fsmonitor", "touch "+marker)
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("two\n"), 0600)
	os.WriteFile(filepath.Join(root, "new.txt"), []byte("x"), 0600)

	out, err := gitStatus(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if _, e := os.Stat(marker); e == nil {
		t.Fatal("live repo config command was executed by status")
	}
	if !strings.Contains(out, "a.txt") || !strings.Contains(out, "new.txt") {
		t.Fatalf("status lost dirty files: %q", out)
	}
}

func TestShadowConfigValueIsClosed(t *testing.T) {
	for _, ok := range [][2]string{{"core.autocrlf", "input"}, {"core.filemode", "false"}, {"extensions.objectformat", "sha256"}, {"core.repositoryformatversion", "1"}} {
		if !shadowConfigValue(ok[0], ok[1]) {
			t.Errorf("%v rejected", ok)
		}
	}
	for _, bad := range [][2]string{{"core.autocrlf", "$(touch x)"}, {"core.eol", "x"}, {"extensions.partialclone", "origin"}, {"extensions.refstorage", "reftable"}, {"core.worktree", "/"}, {"core.bare", "true"}, {"core.fsmonitor", "true"}, {"core.repositoryformatversion", "9"}} {
		if shadowConfigValue(bad[0], bad[1]) {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestGitStatusShadowHandlesSHA256Repos(t *testing.T) {
	root := t.TempDir()
	git(t, root, "init", "-b", "main", "--object-format=sha256")
	git(t, root, "commit", "--allow-empty", "-m", "base")
	os.WriteFile(filepath.Join(root, "f.txt"), []byte("x"), 0600)
	out, err := gitStatus(context.Background(), root)
	if err != nil || !strings.Contains(out, "f.txt") {
		t.Fatalf("status %q %v", out, err)
	}
}

func TestSnapshotCoalescesConcurrentRefreshes(t *testing.T) {
	root := fixture(t)
	s := New(privacy.ModeFull)
	ctx := context.Background()
	repo, err := s.Register(ctx, root, "git")
	if err != nil {
		t.Fatal(err)
	}
	var scans int64
	orig := scanFunc
	gate := make(chan struct{})
	started := make(chan struct{}, 4)
	joined := make(chan struct{}, 4)
	scanFunc = func(ctx context.Context, r registration, limit int, m privacy.Mode) (Snapshot, error) {
		atomic.AddInt64(&scans, 1)
		started <- struct{}{}
		<-gate
		return orig(ctx, r, limit, m)
	}
	origJoin := onInflightJoin
	onInflightJoin = func() { joined <- struct{}{} }
	t.Cleanup(func() {
		scanFunc = orig
		onInflightJoin = origJoin
	})

	type res struct {
		snap Snapshot
		err  error
	}
	ch := make(chan res, 2)
	go func() {
		v, e := s.Snapshot(ctx, repo.ID, "", true)
		ch <- res{v, e}
	}()
	<-started
	go func() {
		v, e := s.Snapshot(ctx, repo.ID, "", true)
		ch <- res{v, e}
	}()
	<-joined
	close(gate)
	r1, r2 := <-ch, <-ch
	if r1.err != nil || r2.err != nil {
		t.Fatalf("errs: %v %v", r1.err, r2.err)
	}
	if atomic.LoadInt64(&scans) != 1 {
		t.Fatalf("expected 1 coalesced scan, got %d", scans)
	}
	if r1.snap.Generation != r2.snap.Generation {
		t.Fatalf("expected shared generation, got %q vs %q", r1.snap.Generation, r2.snap.Generation)
	}
}

func TestSnapshotInitiatorCancelDoesNotFailLiveWaiter(t *testing.T) {
	root := fixture(t)
	s := New(privacy.ModeFull)
	repo, err := s.Register(context.Background(), root, "git")
	if err != nil {
		t.Fatal(err)
	}
	orig := scanFunc
	origJoin := onInflightJoin
	gate := make(chan struct{})
	started := make(chan struct{}, 2)
	joined := make(chan struct{}, 2)
	scanFunc = func(ctx context.Context, r registration, limit int, m privacy.Mode) (Snapshot, error) {
		started <- struct{}{}
		select {
		case <-gate:
			return orig(ctx, r, limit, m)
		case <-ctx.Done():
			return Snapshot{}, ctx.Err()
		}
	}
	onInflightJoin = func() { joined <- struct{}{} }
	t.Cleanup(func() {
		scanFunc = orig
		onInflightJoin = origJoin
	})

	ctx1, cancel1 := context.WithCancel(context.Background())
	err1 := make(chan error, 1)
	go func() {
		_, e := s.Snapshot(ctx1, repo.ID, "", true)
		err1 <- e
	}()
	<-started

	type res struct {
		snap Snapshot
		err  error
	}
	res2 := make(chan res, 1)
	go func() {
		v, e := s.Snapshot(context.Background(), repo.ID, "", true)
		res2 <- res{v, e}
	}()
	<-joined

	cancel1()
	if got := <-err1; got != context.Canceled {
		t.Fatalf("initiator err = %v, want context.Canceled", got)
	}
	close(gate)
	r2 := <-res2
	if r2.err != nil || r2.snap.Stale {
		t.Fatalf("live waiter failed or became stale: err=%v stale=%v", r2.err, r2.snap.Stale)
	}
}

func TestWorkspaceAliasesReturnsCachedScopesWithoutNodeClone(t *testing.T) {
	root := fixture(t)
	s := New(privacy.ModeBalanced)
	ctx := context.Background()
	repo, err := s.Register(ctx, root, "git")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s.WorkspaceAliases(repo.ID); ok {
		t.Fatal("expected ok=false before first snapshot")
	}
	snap, err := s.Snapshot(ctx, repo.ID, "", true)
	if err != nil {
		t.Fatal(err)
	}
	repoAliases, wsAliases, ok := s.WorkspaceAliases(repo.ID)
	if !ok || len(repoAliases) == 0 || len(wsAliases) != len(snap.Workspaces) {
		t.Fatalf("ok=%v repo=%v ws=%v", ok, repoAliases, wsAliases)
	}
	for _, ws := range snap.Workspaces {
		got := wsAliases[ws.ID]
		if len(got) != 2 || got[0] == "" || got[1] == "" {
			t.Fatalf("aliases for %s = %v", ws.ID, got)
		}
	}
}

func TestHasTrackedChanges(t *testing.T) {
	if hasTrackedChanges("") {
		t.Fatal("empty status has no tracked changes")
	}
	if hasTrackedChanges("?? a.txt\x00?? dir/\x00") {
		t.Fatal("untracked-only status has no tracked changes")
	}
	if !hasTrackedChanges("?? a.txt\x00 M b.go\x00") {
		t.Fatal("modified tracked file must be detected")
	}
	if !hasTrackedChanges("A  new.go\x00") {
		t.Fatal("staged file must be detected")
	}
}
