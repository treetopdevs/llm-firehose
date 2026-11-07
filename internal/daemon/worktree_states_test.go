package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/cli"
)

func sha(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func worktreeStatesPath(home string) string {
	return filepath.Join(home, ".agentfirehose", "worktree-states.json")
}

// newWorktreeServer builds a hermetic server: temp home, temp spool, a
// non-default daemon address, and no reconcile goroutine (tests call observe
// directly).
func newWorktreeServer(t *testing.T, mode string) (*Server, string) {
	t.Helper()
	cfg := testConfig(t)
	cfg.PrivacyMode = mode
	cfg.DaemonAddr = "127.0.0.1:0"
	home := t.TempDir()
	return New(testEngine(t, cfg), cfg, home, "test"), home
}

// refreshObserve re-scans every registered repository, then observes.
func refreshObserve(t *testing.T, s *Server) {
	t.Helper()
	for _, repo := range s.graph.service.Repositories() {
		_, _ = s.graph.service.Snapshot(context.Background(), repo.ID, "", true)
	}
	s.observeWorktrees(context.Background())
}

func registerFixture(t *testing.T, s *Server, root string) {
	t.Helper()
	if _, err := s.graph.service.Register(context.Background(), root, "git"); err != nil {
		t.Fatalf("register: %v", err)
	}
}

// classifyNamed classifies a linked worktree (or "" for the primary checkout)
// using raw identities.
func classifyNamed(s *Server, f *worktreeGitFixture, name string, evidence bool) worktreeClass {
	path := f.Main
	if name != "" {
		path = f.Wt[name]
	}
	return classifyWorktree(capture.WorktreeLifetime{RepoID: f.Common, WorktreeID: path}, s.worktrees.observation(), evidence, false)
}

func expectClass(t *testing.T, got worktreeClass, state, outcome, reason string) {
	t.Helper()
	if got.State != state || got.Outcome != outcome || got.Reason != reason {
		t.Fatalf("got %s/%s/%s want %s/%s/%s", got.State, got.Outcome, got.Reason, state, outcome, reason)
	}
}

func TestWorktreeStatesPersistPrivately(t *testing.T) {
	f := newWorktreeGitFixture(t)
	for _, mode := range []string{"minimal", "balanced", "full"} {
		t.Run(mode, func(t *testing.T) {
			s, home := newWorktreeServer(t, mode)
			registerFixture(t, s, f.Main)
			s.observeWorktrees(context.Background())
			dir := filepath.Join(home, ".agentfirehose")
			di, err := os.Stat(dir)
			if err != nil || di.Mode().Perm() != 0o700 {
				t.Fatalf("dir: %v %v", di, err)
			}
			fi, err := os.Stat(worktreeStatesPath(home))
			if err != nil || fi.Mode().Perm() != 0o600 {
				t.Fatalf("file must exist 0600 in %s mode: %v %v", mode, fi, err)
			}
			if tmp, _ := filepath.Glob(filepath.Join(dir, "worktree-states-*.tmp")); len(tmp) != 0 {
				t.Fatalf("temp leftovers: %v", tmp)
			}
			data, _ := os.ReadFile(worktreeStatesPath(home))
			var env struct {
				Version   int              `json:"version"`
				Worktrees []worktreeRecord `json:"worktrees"`
			}
			if err := json.Unmarshal(data, &env); err != nil || env.Version != 1 || len(env.Worktrees) != 5 {
				t.Fatalf("envelope: %v %s", err, data)
			}
			// A new server reloads the same records.
			cfg := testConfig(t)
			cfg.PrivacyMode = mode
			s2 := New(testEngine(t, cfg), cfg, home, "test")
			if len(s2.worktrees.records) != 5 {
				t.Fatalf("reloaded %d records", len(s2.worktrees.records))
			}
		})
	}

	t.Run("invalid entries are ignored and the file survives", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, ".agentfirehose"), 0o700); err != nil {
			t.Fatal(err)
		}
		good := `{"repo":"/r/.git","worktree":"/r/wt","head":"` + strings.Repeat("a", 40) + `","present":true}`
		bad := []string{
			`{"repo":"/r/.git","worktree":"relative/path"}`,
			`{"repo":"rel/.git","worktree":"/r/other"}`,
			`{"repo":"/r/.git","worktree":"/r/x","gone_outcome":"exploded"}`,
			`{"repo":"/r/.git","worktree":"/r/y","head":"not-a-sha"}`,
			`{"repo":"/r/.git","worktree":"/r/z","ahead":-4}`,
		}
		file := `{"version":1,"worktrees":[` + good + `,` + strings.Join(bad, ",") + `]}`
		p := worktreeStatesPath(home)
		if err := os.WriteFile(p, []byte(file), 0o600); err != nil {
			t.Fatal(err)
		}
		cfg := testConfig(t)
		s := New(testEngine(t, cfg), cfg, home, "test")
		if len(s.worktrees.records) != 1 {
			t.Fatalf("records: %+v", s.worktrees.records)
		}
		for _, corrupt := range []string{`{not json`, `{"version":2,"worktrees":[` + good + `]}`} {
			if err := os.WriteFile(p, []byte(corrupt), 0o600); err != nil {
				t.Fatal(err)
			}
			s = New(testEngine(t, cfg), cfg, home, "test")
			if len(s.worktrees.records) != 0 {
				t.Fatalf("corrupt file must load nothing: %+v", s.worktrees.records)
			}
			if got, err := os.ReadFile(p); err != nil || string(got) != corrupt {
				t.Fatalf("startup must not touch the file: %v %q", err, got)
			}
		}
	})

	t.Run("never exposed", func(t *testing.T) {
		s, home := newWorktreeServer(t, "full")
		registerFixture(t, s, f.Main)
		s.observeWorktrees(context.Background())
		for _, path := range []string{"/config", "/doctor", "/worktree-states.json", "/.agentfirehose/worktree-states.json", "/graph-roots.json"} {
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
			body := w.Body.String()
			if strings.Contains(body, home) || strings.Contains(body, f.Common) || strings.Contains(body, "worktree-states") {
				t.Fatalf("%s leaks host-private state: %d %s", path, w.Code, body)
			}
			if path != "/config" && path != "/doctor" && w.Code != http.StatusNotFound {
				t.Fatalf("%s must not be routed: %d", path, w.Code)
			}
		}
	})
}

func TestWorktreeObservationClassifiesRealGitFork(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, _ := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	s.observeWorktrees(context.Background())

	landed := classifyNamed(s, f, "feat-landed", false)
	expectClass(t, landed, "open", "", "")
	if landed.Ahead == nil || *landed.Ahead != 1 {
		t.Fatalf("landed ahead: %+v", landed.Ahead)
	}
	open := classifyNamed(s, f, "feat-open", false)
	expectClass(t, open, "open", "", "")
	if open.Ahead == nil || *open.Ahead != 2 || open.Behind == nil || *open.Behind != 0 || open.Dirty == nil || !*open.Dirty {
		t.Fatalf("open: ahead %v behind %v dirty %v", open.Ahead, open.Behind, open.Dirty)
	}
	if open.TargetRef != "main" || len(open.Head) != 40 || open.LastObserved.IsZero() {
		t.Fatalf("open metadata: %+v", open)
	}
	expectClass(t, classifyNamed(s, f, "feat-abandoned", false), "open", "", "")
	expectClass(t, classifyNamed(s, f, "feat-idle", false), "never_diverged", "", "")
	expectClass(t, classifyNamed(s, f, "", false), "unknown", "", "primary_worktree")

	f.git(f.Main, "2026-10-31T13:30:00Z", "merge", "-q", "--ff-only", "feat-landed")
	refreshObserve(t, s)
	expectClass(t, classifyNamed(s, f, "feat-landed", false), "landed", "", "")
	if !s.worktrees.records[recordKey(f.Common, f.Wt["feat-landed"])].EverAhead {
		t.Fatal("ever_ahead must be recorded")
	}

	for _, name := range []string{"feat-abandoned", "feat-landed", "feat-idle"} {
		f.git(f.Main, "", "worktree", "remove", "--force", f.Wt[name])
	}
	refreshObserve(t, s)
	expectClass(t, classifyNamed(s, f, "feat-abandoned", false), "gone", "abandoned", "")
	expectClass(t, classifyNamed(s, f, "feat-landed", false), "gone", "landed", "")
	expectClass(t, classifyNamed(s, f, "feat-idle", false), "gone", "never_diverged", "")
	expectClass(t, classifyNamed(s, f, "feat-open", false), "open", "", "")
}

// Limitation (documented): the daemon only learns that a worktree diverged by
// observing it. A branch merged before the daemon's first look is
// indistinguishable from one that never moved, except where full-mode capture
// recorded a commit command.
func TestWorktreeLandedBeforeFirstObservation(t *testing.T) {
	f := newWorktreeGitFixture(t)
	f.git(f.Main, "2026-10-31T13:30:00Z", "merge", "-q", "--ff-only", "feat-landed")
	s, _ := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	s.observeWorktrees(context.Background())

	landed, idle := classifyNamed(s, f, "feat-landed", false), classifyNamed(s, f, "feat-idle", false)
	expectClass(t, landed, "never_diverged", "", "")
	expectClass(t, idle, "never_diverged", "", "")
	if landed.Ahead == nil || idle.Ahead == nil || *landed.Ahead != 0 || *idle.Ahead != 0 {
		t.Fatalf("compare output must agree: %v %v", landed.Ahead, idle.Ahead)
	}
	expectClass(t, classifyNamed(s, f, "feat-landed", true), "landed", "", "")
	expectClass(t, classifyNamed(s, f, "feat-idle", false), "never_diverged", "", "")
}

func TestWorktreeGoneEdgeCases(t *testing.T) {
	t.Run("directory removed by hand", func(t *testing.T) {
		f := newWorktreeGitFixture(t)
		s, _ := newWorktreeServer(t, "full")
		registerFixture(t, s, f.Main)
		s.observeWorktrees(context.Background())
		if err := os.RemoveAll(f.Wt["feat-open"]); err != nil {
			t.Fatal(err)
		}
		refreshObserve(t, s) // still listed, but prunable
		expectClass(t, classifyNamed(s, f, "feat-open", false), "gone", "abandoned", "")
		f.git(f.Main, "", "worktree", "prune")
		refreshObserve(t, s) // no longer listed
		expectClass(t, classifyNamed(s, f, "feat-open", false), "gone", "abandoned", "")
	})
	t.Run("detached head, branch deleted, gc", func(t *testing.T) {
		f := newWorktreeGitFixture(t)
		s, _ := newWorktreeServer(t, "full")
		registerFixture(t, s, f.Main)
		f.git(f.Wt["feat-abandoned"], "", "checkout", "-q", "--detach")
		s.observeWorktrees(context.Background())
		expectClass(t, classifyNamed(s, f, "feat-abandoned", false), "open", "", "")
		f.git(f.Main, "", "worktree", "remove", "--force", f.Wt["feat-abandoned"])
		f.git(f.Main, "", "branch", "-D", "feat-abandoned")
		f.git(f.Main, "", "reflog", "expire", "--expire=now", "--all")
		f.git(f.Main, "", "gc", "-q", "--prune=now")
		refreshObserve(t, s)
		expectClass(t, classifyNamed(s, f, "feat-abandoned", false), "gone", "unknown", "compare_failed")
	})
	t.Run("reset to main after diverging reads as landed", func(t *testing.T) {
		// Pinned behaviour: a worktree whose work was thrown away by resetting to
		// the default branch is indistinguishable from a merged one.
		f := newWorktreeGitFixture(t)
		s, _ := newWorktreeServer(t, "full")
		registerFixture(t, s, f.Main)
		s.observeWorktrees(context.Background())
		f.git(f.Wt["feat-open"], "", "reset", "-q", "--hard", "main")
		refreshObserve(t, s)
		expectClass(t, classifyNamed(s, f, "feat-open", false), "landed", "", "")
	})
}

func TestWorktreeObservationStaleUnregisteredUnborn(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, home := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)

	// A second repository with no default branch and a third with no commits.
	base := t.TempDir()
	trunk, _ := filepath.EvalSymlinks(filepath.Join(base, "trunk"))
	if err := os.MkdirAll(filepath.Join(base, "trunk"), 0o700); err != nil {
		t.Fatal(err)
	}
	trunk, _ = filepath.EvalSymlinks(filepath.Join(base, "trunk"))
	graphGitAt(t, trunk, "", "init", "-q", "-b", "trunk")
	graphGitAt(t, trunk, "2026-10-31T09:00:00Z", "commit", "-q", "--allow-empty", "-m", "init")
	trunkWt := filepath.Join(base, "trunk-wt")
	graphGitAt(t, trunk, "", "worktree", "add", "-q", "-b", "side", trunkWt)
	trunkWt, _ = filepath.EvalSymlinks(trunkWt)
	registerFixture(t, s, trunk)
	empty := filepath.Join(base, "empty")
	if err := os.MkdirAll(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	empty, _ = filepath.EvalSymlinks(empty)
	graphGitAt(t, empty, "", "init", "-q", "-b", "main")
	registerFixture(t, s, empty)
	s.observeWorktrees(context.Background())

	obs := s.worktrees.observation()
	got := classifyWorktree(capture.WorktreeLifetime{RepoID: filepath.Join(trunk, ".git"), WorktreeID: trunkWt}, obs, false, false)
	expectClass(t, got, "unknown", "", "no_default_target")
	if got.Ahead != nil || got.Behind != nil {
		t.Fatalf("no compare ran, so ahead/behind are unknown: %v %v", got.Ahead, got.Behind)
	}
	got = classifyWorktree(capture.WorktreeLifetime{RepoID: filepath.Join(empty, ".git"), WorktreeID: empty}, obs, false, false)
	expectClass(t, got, "unknown", "", "unborn_head")
	if got.Ahead != nil || got.Behind != nil {
		t.Fatalf("unborn head has no counts: %v %v", got.Ahead, got.Behind)
	}
	got = classifyWorktree(capture.WorktreeLifetime{RepoID: "/not/registered/.git", WorktreeID: "/not/registered"}, obs, false, false)
	expectClass(t, got, "unknown", "", "repo_unregistered")
	got = classifyWorktree(capture.WorktreeLifetime{RepoID: f.Common, WorktreeID: filepath.Join(f.Main, "never-seen")}, obs, false, false)
	expectClass(t, got, "gone", "unknown", "never_observed")
	// Before any observation exists the graph is simply unavailable.
	expectClass(t, classifyWorktree(capture.WorktreeLifetime{RepoID: f.Common, WorktreeID: f.Main}, nil, false, false), "unknown", "", "graph_unavailable")

	// Delete the registered root: the retained snapshot is stale, and no record
	// flips to gone.
	before := map[string]worktreeRecord{}
	for k, v := range s.worktrees.records {
		before[k] = v
	}
	fileBefore, _ := os.ReadFile(worktreeStatesPath(home))
	if err := os.RemoveAll(f.Main); err != nil {
		t.Fatal(err)
	}
	repoID := ""
	for _, r := range s.graph.service.Repositories() {
		if r.Label == f.Main {
			repoID = r.ID
		}
	}
	snap, err := s.graph.service.Snapshot(context.Background(), repoID, "", true)
	if err != nil || !snap.Stale {
		t.Fatalf("snapshot must be the retained stale one: %v stale=%v", err, snap.Stale)
	}
	s.observeWorktrees(context.Background())
	expectClass(t, classifyNamed(s, f, "feat-open", false), "unknown", "", "graph_stale")
	for k, v := range before {
		if k == "" {
			continue
		}
		after := s.worktrees.records[k]
		v.LastSeen, after.LastSeen = time.Time{}, time.Time{}
		if !reflect.DeepEqual(v, after) {
			t.Fatalf("stale snapshot must not change records:\n%+v\n%+v", v, after)
		}
	}
	if fileAfter, _ := os.ReadFile(worktreeStatesPath(home)); string(fileAfter) != string(fileBefore) {
		t.Fatal("stale snapshot must not rewrite the file")
	}
}

func TestWorktreeStatesMatchByAliasInBalancedMode(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, home := newWorktreeServer(t, "balanced")
	registerFixture(t, s, f.Main)
	s.observeWorktrees(context.Background())
	obs := s.worktrees.observation()
	path := f.Wt["feat-open"]
	for _, repoID := range []string{f.Common, sha(f.Common)} {
		for _, wtID := range []string{path, sha(path)} {
			got := classifyWorktree(capture.WorktreeLifetime{RepoID: repoID, WorktreeID: wtID}, obs, false, false)
			if got.State != "open" || got.Ahead == nil || *got.Ahead != 2 {
				t.Fatalf("alias %q %q: %+v", repoID, wtID, got)
			}
		}
	}
	data, _ := os.ReadFile(worktreeStatesPath(home))
	if !strings.Contains(string(data), path) || !strings.Contains(string(data), f.Common) || strings.Contains(string(data), sha(path)) {
		t.Fatalf("file must store raw paths only: %s", data)
	}
}

func TestWorktreeObservationIsIdempotentAndCached(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, home := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	s.observeWorktrees(context.Background())
	p := worktreeStatesPath(home)
	first, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	calls := s.worktrees.compareCalls
	if calls == 0 {
		t.Fatal("first observation must compare")
	}
	time.Sleep(30 * time.Millisecond)
	s.observeWorktrees(context.Background())
	second, err := os.Stat(p)
	if err != nil || !second.ModTime().Equal(first.ModTime()) {
		t.Fatalf("file rewritten without change: %v %v", first.ModTime(), second.ModTime())
	}
	if s.worktrees.compareCalls != calls {
		t.Fatalf("compare ran again: %d -> %d", calls, s.worktrees.compareCalls)
	}
	if tmp, _ := filepath.Glob(filepath.Join(home, ".agentfirehose", "worktree-states-*.tmp")); len(tmp) != 0 {
		t.Fatalf("temp leftovers: %v", tmp)
	}
}

func TestWorktreeStateRecordCap(t *testing.T) {
	s, home := newWorktreeServer(t, "full")
	base := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	s.worktrees.records = map[string]worktreeRecord{}
	for i := 0; i < 2100; i++ {
		r := worktreeRecord{Repo: "/r/.git", Worktree: fmt.Sprintf("/r/wt%04d", i), Present: i%2 == 0, LastSeen: base.Add(time.Duration(i) * time.Second)}
		s.worktrees.records[recordKey(r.Repo, r.Worktree)] = r
	}
	if err := s.persistWorktreeStates(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(worktreeStatesPath(home))
	var env struct {
		Worktrees []worktreeRecord `json:"worktrees"`
	}
	if err := json.Unmarshal(data, &env); err != nil || len(env.Worktrees) != maxWorktreeRecords {
		t.Fatalf("persisted %d: %v", len(env.Worktrees), err)
	}
	kept := map[string]bool{}
	present := 0
	for _, r := range env.Worktrees {
		kept[r.Worktree] = true
		if r.Present {
			present++
		}
	}
	if present != 1050 {
		t.Fatalf("present records must all survive: %d", present)
	}
	if kept["/r/wt0001"] || kept["/r/wt0199"] || !kept["/r/wt0201"] {
		t.Fatalf("oldest not-present records must be dropped first")
	}
}

func TestWorktreeTestsAreHermetic(t *testing.T) {
	realHome := os.Getenv("HOME")
	f := newWorktreeGitFixture(t) // swaps in a temp HOME
	s, home := newWorktreeServer(t, "full")
	if os.Getenv("HOME") == realHome {
		t.Fatal("HOME must be a temp dir")
	}
	tmp, _ := filepath.EvalSymlinks(os.TempDir())
	for name, p := range map[string]string{"HOME": os.Getenv("HOME"), "server home": home, "spool": s.config().SpoolDir, "git fixture": f.Main} {
		r, err := filepath.EvalSymlinks(filepath.Dir(p))
		if err != nil {
			r = p
		}
		if !strings.HasPrefix(r, tmp) {
			t.Fatalf("%s %s is outside the temp dir %s", name, p, tmp)
		}
	}
	if addr := s.config().DaemonAddr; addr == cli.DefaultDaemonAddr || strings.HasSuffix(addr, ":4517") {
		t.Fatalf("daemon addr must not be the real one: %s", addr)
	}
	if s.worktrees.latest != nil {
		t.Fatal("no reconcile goroutine may run: nothing has been observed yet")
	}
}

func TestWorktreeGoneSquashMergedIsLandedByPRMergeMark(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, _ := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	s.observeWorktrees(context.Background())
	f.git(f.Main, "", "worktree", "remove", "--force", f.Wt["feat-abandoned"])
	refreshObserve(t, s)
	path := f.Wt["feat-abandoned"]
	lt := capture.WorktreeLifetime{RepoID: f.Common, WorktreeID: path}
	expectClass(t, classifyWorktree(lt, s.worktrees.observation(), false, false), "gone", "abandoned", "")
	expectClass(t, classifyWorktree(lt, s.worktrees.observation(), false, true), "gone", "landed", "pr_merge_mark")
}

func TestWorktreeRecreatedAtSamePathDoesNotInheritDivergence(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, _ := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	s.observeWorktrees(context.Background())
	path := f.Wt["feat-open"]
	expectClass(t, classifyNamed(s, f, "feat-open", false), "open", "", "")
	f.git(f.Main, "", "worktree", "remove", "--force", path)
	refreshObserve(t, s)
	f.git(f.Main, "", "worktree", "add", "-q", "-b", "fresh", path, "main")
	refreshObserve(t, s)
	expectClass(t, classifyNamed(s, f, "feat-open", false), "never_diverged", "", "")
}
