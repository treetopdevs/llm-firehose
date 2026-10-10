package workspacegraph

import (
	"agentfirehose/internal/privacy"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fixtureScript is the documented manual-verification fixture generator.
const fixtureScript = "../../scripts/workspace-graph-fixture.py"

func runFixture(t *testing.T, args ...string) (root string) {
	t.Helper()
	python, e := exec.LookPath("python3")
	if e != nil {
		t.Skip("python3 unavailable")
	}
	if _, e := exec.LookPath("git"); e != nil {
		t.Skip("git unavailable")
	}
	if e := exec.Command(python, "-I", "-c", "").Run(); e != nil {
		t.Skip("python3 -I unavailable (shim without a configured interpreter?)")
	}
	cmd := exec.Command(python, append([]string{"-I", fixtureScript}, args...)...)
	cmd.Env = append(os.Environ(), "TMPDIR="+t.TempDir())
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, e := cmd.Output()
	if e != nil {
		t.Fatalf("fixture %v: %v\n%s", args, e, stderr.String())
	}
	root = strings.TrimSpace(string(out))
	if !filepath.IsAbs(root) {
		t.Fatalf("stdout must be exactly the fixture root, got %q", out)
	}
	return root
}

type fixtureManifest struct {
	Repository string   `json:"repository"`
	Workspaces []string `json:"workspaces"`
	Revisions  int      `json:"revisions"`
	Shape      string   `json:"shape"`
	Expected   struct {
		Workspaces   int `json:"workspaces"`
		Revisions    int `json:"revisions"`
		MergeCommits int `json:"merge_commits"`
		Detached     int `json:"detached"`
		Dirty        int `json:"dirty"`
		MaxDepth     int `json:"max_depth"`
	} `json:"expected"`
}

func TestMockupFixtureShape(t *testing.T) {
	t.Parallel()
	root := runFixture(t, "--shape", "mockup", "--workspaces", "25", "--check")
	var manifest fixtureManifest
	data, e := os.ReadFile(filepath.Join(root, "fixture.json"))
	if e != nil || json.Unmarshal(data, &manifest) != nil {
		t.Fatalf("fixture.json: %v %s", e, data)
	}
	if manifest.Shape != "mockup" || len(manifest.Workspaces) != 25 || manifest.Expected.Workspaces != 25 {
		t.Fatalf("manifest: %+v", manifest)
	}

	s := New(privacy.ModeFull)
	ctx := context.Background()
	repo, e := s.Register(ctx, manifest.Repository, "git")
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.Snapshot(ctx, repo.ID, "", true)
	if e != nil {
		t.Fatal(e)
	}
	if len(v.Workspaces) != 25 {
		t.Fatalf("workspaces: %d", len(v.Workspaces))
	}
	if len(v.Nodes) < 100 || len(v.Nodes) != manifest.Expected.Revisions || manifest.Revisions != len(v.Nodes) {
		t.Fatalf("nodes: %d (manifest %d/%d)", len(v.Nodes), manifest.Revisions, manifest.Expected.Revisions)
	}
	if v.NextCursor != "" || len(v.Boundaries) != 0 || v.Stale {
		t.Fatalf("whole history must be loaded: cursor=%q boundaries=%d stale=%v", v.NextCursor, len(v.Boundaries), v.Stale)
	}

	merges := 0
	byKey := map[string]Revision{}
	for _, n := range v.Nodes {
		byKey[n.Key] = n
		if len(n.Parents) >= 2 {
			merges++
		}
	}
	if merges < 2 || merges != manifest.Expected.MergeCommits {
		t.Errorf("merge commits: %d (manifest %d)", merges, manifest.Expected.MergeCommits)
	}
	// depth: longest parent path from a loaded root, the layout's rank
	depth := map[string]int{}
	var rank func(key string) int
	rank = func(key string) int {
		if d, ok := depth[key]; ok {
			return d
		}
		d := 0
		for _, p := range byKey[key].Parents {
			if _, ok := byKey[p]; ok {
				if r := rank(p) + 1; r > d {
					d = r
				}
			}
		}
		depth[key] = d
		return d
	}
	maxDepth := 0
	for key := range byKey {
		if d := rank(key); d > maxDepth {
			maxDepth = d
		}
	}
	if maxDepth < 25 || maxDepth != manifest.Expected.MaxDepth {
		t.Errorf("max depth %d (manifest %d)", maxDepth, manifest.Expected.MaxDepth)
	}

	detached, dirty, hosts := 0, 0, map[string]int{}
	statuses := map[string]bool{}
	binary := false
	var demo *Workspace
	for i, w := range v.Workspaces {
		if w.Availability != "available" || w.Unborn || w.Revision == "" {
			t.Errorf("workspace %s: %+v", w.Label, w)
		}
		for _, r := range w.Refs {
			if r == "detached" {
				detached++
			}
		}
		hosts[w.Revision]++
		if w.Dirty {
			if len(w.Changes) == 0 {
				t.Errorf("dirty workspace %s has no changes", w.Label)
			}
			dirty++
		}
		for _, c := range w.Changes {
			statuses[c.Status] = true
			binary = binary || c.Binary
		}
		if filepath.Base(w.Label) == "wt-07-fix" {
			demo = &v.Workspaces[i]
		}
	}
	if detached != 1 || manifest.Expected.Detached != 1 {
		t.Errorf("detached workspaces: %d", detached)
	}
	if dirty < 6 || dirty != manifest.Expected.Dirty {
		t.Errorf("dirty workspaces: %d (manifest %d)", dirty, manifest.Expected.Dirty)
	}
	shared := 0
	for _, n := range hosts {
		if n >= 2 {
			shared++
		}
	}
	if shared < 1 {
		t.Errorf("no revision hosts two worktrees: %v", hosts)
	}
	for _, want := range []string{"M", "A", "D", "R", "?"} {
		if !statuses[want] {
			t.Errorf("fixture never produces status %s: %v", want, statuses)
		}
	}
	if !binary {
		t.Error("fixture has no binary change")
	}

	// the selected-demo worktree: exactly three changed files with fixed counts
	if demo == nil {
		t.Fatal("wt-07-fix missing")
	}
	want := map[string][2]int{"session.go": {42, 11}, "graph.go": {18, 6}, "graph_test.go": {120, 4}}
	if len(demo.Changes) != 3 || len(demo.ChangedFiles) != 3 {
		t.Fatalf("wt-07-fix changes: %+v", demo.Changes)
	}
	for _, c := range demo.Changes {
		counts, ok := want[c.Path]
		if !ok {
			t.Errorf("unexpected file %s", c.Path)
			continue
		}
		wantCounts(t, c, "M", counts[0], counts[1])
	}
	if len(demo.Refs) != 1 || demo.Refs[0] != "refs/heads/agent/cache-fix" {
		t.Errorf("wt-07-fix branch: %v", demo.Refs)
	}
	if v.DefaultTargetRef != "main" || v.DefaultTarget == "" {
		t.Errorf("default target: %q %q", v.DefaultTargetRef, v.DefaultTarget)
	}
}

// The default shape must stay exactly what the documented performance command builds.
func TestLinearFixtureShapeUnchanged(t *testing.T) {
	t.Parallel()
	root := runFixture(t, "--workspaces", "12", "--revisions", "40", "--check")
	var manifest fixtureManifest
	data, e := os.ReadFile(filepath.Join(root, "fixture.json"))
	if e != nil || json.Unmarshal(data, &manifest) != nil {
		t.Fatalf("fixture.json: %v %s", e, data)
	}
	if len(manifest.Workspaces) != 12 || manifest.Revisions != 40 || (manifest.Shape != "linear" && manifest.Shape != "") {
		t.Fatalf("manifest: %+v", manifest)
	}
	s := New(privacy.ModeFull)
	repo, e := s.Register(context.Background(), manifest.Repository, "git")
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.Snapshot(context.Background(), repo.ID, "", true)
	if e != nil || len(v.Workspaces) != 12 {
		t.Fatalf("%v %d", e, len(v.Workspaces))
	}
	// the linear fixture builds an empty tree, so its checkouts have no file content
	for _, w := range v.Workspaces {
		for _, c := range w.Changes {
			if c.Path != "uncommitted.txt" || c.Status != "?" {
				t.Errorf("linear fixture only leaves untracked uncommitted.txt: %+v", c)
			}
		}
	}
}

func TestFixtureRejectsBadShapeArguments(t *testing.T) {
	t.Parallel()
	python, e := exec.LookPath("python3")
	if e != nil {
		t.Skip("python3 unavailable")
	}
	if exec.Command(python, "-I", "-c", "").Run() != nil {
		t.Skip("python3 -I unavailable")
	}
	for _, args := range [][]string{{"--shape", "bogus"}, {"--shape", "mockup", "--workspaces", "30"}} {
		cmd := exec.Command(python, append([]string{"-I", fixtureScript}, args...)...)
		cmd.Env = append(os.Environ(), "TMPDIR="+t.TempDir())
		if cmd.Run() == nil {
			t.Errorf("%v should be rejected", args)
		}
	}
}
