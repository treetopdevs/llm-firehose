package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
func TestGitGraphPrivacyCompareStale(t *testing.T) {
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
	b, _ := json.Marshal(snap)
	if strings.Contains(string(b), root) || strings.Contains(string(b), other) {
		t.Fatal("path leak")
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
	b, _ = json.Marshal(snap)
	if e != nil || strings.Contains(string(b), "sensitive description") || strings.Contains(string(b), "feature") {
		t.Fatalf("privacy %s %v", b, e)
	}
	os.Rename(filepath.Join(root, ".git"), filepath.Join(root, "hidden"))
	snap, e = s.Snapshot(ctx, rs[0].ID, "", true)
	if e != nil || !snap.Stale || len(snap.Nodes) != 2 {
		t.Fatalf("stale %+v %v", snap, e)
	}
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
	if len(v.Workspaces[0].ChangedFiles) != 1 || strings.Contains(v.Workspaces[0].ChangedFiles[0], "private-name") {
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
func TestGitScanRefusesExecutableRepoConfig(t *testing.T) {
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
	if err == nil {
		_, err = s.Snapshot(ctx, repo.ID, "", true)
	}
	if err == nil {
		t.Fatal("scan of a repo with an executable filter config succeeded")
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

func TestGitScanFailsClosedOnUnknownRepoConfig(t *testing.T) {
	for _, kv := range [][2]string{{"core.fsmonitor", "touch x"}, {"core.sshcommand", "x"}, {"custom.thing", "1"}, {"diff.d.textconv", "x"}} {
		root := fixture(t)
		git(t, root, "config", kv[0], kv[1])
		if _, err := New(privacy.ModeFull).Register(context.Background(), root, "git"); err == nil {
			t.Fatalf("%s accepted", kv[0])
		}
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
