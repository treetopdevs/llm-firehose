package daemon

import (
	"agentfirehose/internal/capture"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/workspacegraph"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGraphTimelineRejectsUnscopedSession(t *testing.T) {
	cfg := testConfig(t)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph/timeline?session_id=shared", nil))
	if w.Code != 400 {
		t.Fatalf("status %d", w.Code)
	}
}
func TestGraphTimelineEmptyIsExplicit(t *testing.T) {
	cfg := testConfig(t)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph/timeline?repo_id=unknown", nil))
	var page capture.TimelinePage
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || page.Events == nil || page.Order != "newest_first" {
		t.Fatalf("response %d %s", w.Code, w.Body)
	}
}

func TestGraphTimelineAbandonedRequestStopsWithoutAClientError(t *testing.T) {
	cfg := testConfig(t)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph/timeline?repo_id=unknown", nil).WithContext(ctx))
	if w.Code == 400 || w.Body.Len() != 0 {
		t.Fatalf("an abandoned timeline request is not a bad request and has no reader: %d %q", w.Code, w.Body)
	}
}

func TestGraphRegistrationPrivatePersistenceAndOrigin(t *testing.T) {
	root := t.TempDir()
	cmd := exec.Command("git", "init", "-q", root)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, output)
	}
	cfg := testConfig(t)
	cfg.PrivacyMode = "full"
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	body, _ := json.Marshal(map[string]string{"root": root, "vcs": "git"})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/workspace-graph/repos", bytes.NewReader(body)))
	if w.Code != 200 {
		t.Fatalf("register %d %s", w.Code, w.Body)
	}
	path := filepath.Join(home, ".agentfirehose", "graph-roots.json")
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Contains(data, []byte(root)) {
		t.Fatalf("host roots: %s %v", data, err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("root mode: %v", info.Mode())
	}
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/workspace-graph/repos", nil)
	req.Header.Set("Origin", "https://attacker.example")
	s.Handler().ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatalf("origin status %d", w.Code)
	}
}

func TestUnavailableRegisteredRootStaysVisibleAndReadable(t *testing.T) {
	cfg := testConfig(t)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	root := filepath.Join(t.TempDir(), "missing-private-root")
	s.graph.unavailable = map[string]string{root: "jj"}
	repos := listedRepos(t, s)
	if len(repos) != 1 || repos[0].Status != "unavailable" || repos[0].Label != root || repos[0].VCS != "jj" {
		t.Fatalf("an unavailable root is listed with its readable path: %+v", repos)
	}
	if len(repos[0].ID) != 64 || strings.Contains(repos[0].ID, "missing-private-root") {
		t.Fatalf("the synthetic id stays an opaque digest: %q", repos[0].ID)
	}
}

// Balanced mode (the default) shows readable names, while the ids stay the
// digests Capture stamps on events, so a captured session still attaches to its
// workspace.
func TestGraphBalancedModeReadableLabelsKeepSessionAssociation(t *testing.T) {
	root := gitRepo(t)
	cfg := testConfig(t)
	cfg.PrivacyMode = "balanced"
	engine := testEngine(t, cfg)
	ev := mkEvent(1, time.Now())
	ev.Source, ev.SessionID, ev.CWD = "codex", "session-1", root
	if _, err := engine.Admit(t.Context(), ev); err != nil {
		t.Fatal(err)
	}
	s := New(engine, cfg, t.TempDir(), "test")
	s.reconcileGraphRoots(t.Context())
	repos := listedRepos(t, s)
	if len(repos) != 1 || repos[0].Label != root || len(repos[0].ID) != 64 || strings.Contains(repos[0].ID, root) {
		t.Fatalf("readable label, digest id: %+v", repos)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph?repo_id="+repos[0].ID, nil))
	var snapshot struct {
		Repository workspacegraph.Repository  `json:"repository"`
		Workspaces []workspacegraph.Workspace `json:"workspaces"`
		Attached   map[string]struct {
			RepoID      string `json:"repo_id"`
			WorkspaceID string `json:"workspace_id"`
		} `json:"attention_associations"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &snapshot) != nil || len(snapshot.Workspaces) != 1 {
		t.Fatalf("graph %d %s", w.Code, w.Body)
	}
	if snapshot.Repository.Label != root || snapshot.Workspaces[0].Label != root {
		t.Fatalf("labels must be readable: %+v", snapshot)
	}
	got := snapshot.Attached["codex\x00session-1"]
	if got.RepoID != repos[0].ID || got.WorkspaceID != snapshot.Workspaces[0].ID {
		t.Fatalf("session no longer associates with its workspace: %+v", snapshot.Attached)
	}
}

func TestGraphRootRegistrationKeepsExplicitAuthority(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.PrivacyMode = "full"
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	for _, r := range []graphRoot{{root, "git"}, {alias, ""}, {root, "jj"}, {alias, ""}} {
		if err := s.rememberGraphRoot(r.Root, r.VCS); err != nil {
			t.Fatal(err)
		}
	}
	if len(s.graph.roots) != 1 || s.graph.roots[0].VCS != "jj" {
		t.Fatalf("authorities: %+v", s.graph.roots)
	}
	restored := New(testEngine(t, cfg), cfg, home, "test")
	if len(restored.graph.roots) != 1 || restored.graph.roots[0].VCS != "jj" {
		t.Fatalf("roots must load before requests: %+v", restored.graph.roots)
	}
}

type heldGraphWriter struct {
	*httptest.ResponseRecorder
	entered chan struct{}
	release chan struct{}
}

func (w *heldGraphWriter) Write(data []byte) (int, error) {
	close(w.entered)
	<-w.release
	return w.ResponseRecorder.Write(data)
}
func TestPrivacyChangeWaitsForInFlightGraphResponse(t *testing.T) {
	cfg := testConfig(t)
	cfg.PrivacyMode = "full"
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	privateRoot := "/private/test-sensitive-root"
	s.graph.unavailable = map[string]string{privateRoot: "git"}
	writer := &heldGraphWriter{httptest.NewRecorder(), make(chan struct{}), make(chan struct{})}
	graphDone := make(chan struct{})
	go func() {
		s.Handler().ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/workspace-graph/repos", nil))
		close(graphDone)
	}()
	<-writer.entered
	changed := make(chan struct{})
	s.setPolicy = func(privacy.Mode) { close(changed) }
	configDone := make(chan struct{})
	go func() {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/config", strings.NewReader(`{"privacy_mode":"balanced"}`)))
		close(configDone)
	}()
	select {
	case <-changed:
		close(writer.release)
		<-graphDone
		<-configDone
		t.Fatal("privacy transition overtook an old-mode response")
	case <-time.After(30 * time.Millisecond):
	}
	close(writer.release)
	<-graphDone
	<-configDone
	// Labels are readable in every mode, so the transition changes nothing the
	// next response shows for an unavailable root.
	if repos := listedRepos(t, s); len(repos) != 1 || repos[0].Label != privateRoot {
		t.Fatalf("next response after the transition: %+v", repos)
	}
}

func TestUnavailableKnownRepositoryDoesNotDuplicateDescriptor(t *testing.T) {
	root := t.TempDir()
	cmd := exec.Command("git", "init", "-q", root)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("init: %v %s", err, out)
	}
	cfg := testConfig(t)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	repo, err := s.graph.service.Register(t.Context(), root, "git")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.graph.service.Snapshot(t.Context(), repo.ID, "", false); err != nil {
		t.Fatal(err)
	}
	if err = os.RemoveAll(filepath.Join(root, ".git")); err != nil {
		t.Fatal(err)
	}
	if _, err = s.graph.service.Snapshot(t.Context(), repo.ID, "", true); err != nil {
		t.Fatal(err)
	}
	s.graph.unavailable = map[string]string{root: "git"}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph/repos", nil))
	var repos []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &repos); err != nil {
		t.Fatal(err)
	}
	if len(repos) != 1 || repos[0].ID != repo.ID || repos[0].Status != "stale" {
		t.Fatalf("duplicate or lost stale repository: %s", w.Body)
	}
}

func graphRootsPath(home string) string {
	return filepath.Join(home, ".agentfirehose", "graph-roots.json")
}

func gitRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if out, err := exec.Command("git", "init", "-q", root).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

func listedRepos(t *testing.T, s *Server) []workspacegraph.Repository {
	t.Helper()
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph/repos", nil))
	var repos []workspacegraph.Repository
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &repos) != nil {
		t.Fatalf("repos %d %s", w.Code, w.Body)
	}
	return repos
}

func readRoots(t *testing.T, home string) []graphRoot {
	t.Helper()
	data, err := os.ReadFile(graphRootsPath(home))
	if err != nil {
		t.Fatalf("graph-roots.json: %v", err)
	}
	var roots []graphRoot
	if err := json.Unmarshal(data, &roots); err != nil {
		t.Fatalf("graph-roots.json: %v %s", err, data)
	}
	return roots
}

// A registered repository must survive a daemon restart in every privacy mode.
func TestRegisteredGraphRootsPersistAndSurviveRestartInEveryMode(t *testing.T) {
	root := gitRepo(t)
	for _, mode := range []string{"minimal", "balanced", "full"} {
		t.Run(mode, func(t *testing.T) {
			cfg := testConfig(t)
			cfg.PrivacyMode = mode
			home := t.TempDir()
			s := New(testEngine(t, cfg), cfg, home, "test")
			body, _ := json.Marshal(map[string]string{"root": root, "vcs": "git"})
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/workspace-graph/repos", bytes.NewReader(body)))
			if w.Code != 200 {
				t.Fatalf("register %d %s", w.Code, w.Body)
			}
			info, err := os.Stat(graphRootsPath(home))
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("roots file must exist with mode 0600 in %s mode: %v %v", mode, info, err)
			}
			if roots := readRoots(t, home); len(roots) != 1 || roots[0].Root != root {
				t.Fatalf("persisted roots: %+v", roots)
			}

			// Restart: a new server over the same home and an engine that has
			// observed nothing. The repository list must not come back empty.
			restored := New(testEngine(t, cfg), cfg, home, "test")
			restored.reconcileGraphRoots(t.Context())
			if repos := listedRepos(t, restored); len(repos) != 1 || repos[0].Status == "unavailable" {
				t.Fatalf("repository list emptied by restart in %s mode: %+v", mode, repos)
			}
		})
	}
}

// Repositories first seen through agent activity are remembered once they scan.
func TestObservedGraphRootDiscoveredInBalancedModeSurvivesRestart(t *testing.T) {
	root := gitRepo(t)
	broken := t.TempDir() // a .git directory that is not a repository never scans
	if err := os.Mkdir(filepath.Join(broken, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.PrivacyMode = "balanced"
	home := t.TempDir()
	engine := testEngine(t, cfg)
	for i, cwd := range []string{root, broken} {
		ev := mkEvent(i, time.Now())
		ev.CWD = cwd
		if _, err := engine.Admit(t.Context(), ev); err != nil {
			t.Fatal(err)
		}
	}
	s := New(engine, cfg, home, "test")
	s.reconcileGraphRoots(t.Context())
	roots := readRoots(t, home)
	if len(roots) != 1 || roots[0].Root != root {
		t.Fatalf("only the successfully scanned observed root is persisted: %+v", roots)
	}
	if info, err := os.Stat(graphRootsPath(home)); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("roots file mode: %v %v", info, err)
	}

	restored := New(testEngine(t, cfg), cfg, home, "test")
	restored.reconcileGraphRoots(t.Context())
	if repos := listedRepos(t, restored); len(repos) != 1 || repos[0].Status == "unavailable" {
		t.Fatalf("observed repository lost across restart: %+v", repos)
	}
}

func TestPrivacyModeChangeKeepsPersistedGraphRoots(t *testing.T) {
	root := gitRepo(t)
	cfg := testConfig(t)
	cfg.PrivacyMode = "balanced"
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	if err := s.rememberGraphRoot(root, "git"); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(graphRootsPath(home))
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"minimal", "full", "balanced"} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/config", strings.NewReader(`{"privacy_mode":"`+mode+`"}`)))
		if w.Code != 200 {
			t.Fatalf("config %d %s", w.Code, w.Body)
		}
		after, err := os.ReadFile(graphRootsPath(home))
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("switching to %s changed the roots file: %q %v", mode, after, err)
		}
	}
	if len(s.graph.roots) != 1 {
		t.Fatalf("roots must stay usable in memory: %+v", s.graph.roots)
	}
}

func TestPersistedGraphRootsLoadOnStartInEveryMode(t *testing.T) {
	root := gitRepo(t)
	for _, mode := range []string{"minimal", "balanced", "full"} {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, ".agentfirehose"), 0700); err != nil {
			t.Fatal(err)
		}
		file := `[{"root":` + strconv.Quote(root) + `,"vcs":"git"},{"root":"relative/escape","vcs":"git"},{"root":"/ignored/bad-vcs","vcs":"svn"}]`
		if err := os.WriteFile(graphRootsPath(home), []byte(file), 0600); err != nil {
			t.Fatal(err)
		}
		cfg := testConfig(t)
		cfg.PrivacyMode = mode
		s := New(testEngine(t, cfg), cfg, home, "test")
		if len(s.graph.roots) != 1 || s.graph.roots[0].Root != root || s.graph.roots[0].VCS != "git" {
			t.Fatalf("%s: roots loaded: %+v", mode, s.graph.roots)
		}
		if _, err := os.Stat(graphRootsPath(home)); err != nil {
			t.Fatalf("%s: startup must not delete the roots file: %v", mode, err)
		}
	}
}

func graphGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=F", "GIT_AUTHOR_EMAIL=f@example.invalid", "GIT_COMMITTER_NAME=F", "GIT_COMMITTER_EMAIL=f@example.invalid")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// The wire contract for the additive change-stat fields: names, omission when a
// workspace is clean, no counts for untracked files, and the default ref.
func TestGraphJSONChangeFieldsMatchContract(t *testing.T) {
	root := t.TempDir()
	graphGit(t, root, "init", "-q", "-b", "main")
	for name, text := range map[string]string{"session.go": "one\ntwo\nthree\n", "graph.go": "a\nb\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	graphGit(t, root, "add", ".")
	graphGit(t, root, "commit", "-q", "-m", "base")
	base := graphGit(t, root, "rev-parse", "HEAD")
	dirty := filepath.Join(t.TempDir(), "wt-dirty")
	graphGit(t, root, "worktree", "add", "-q", "-b", "agent/cache-fix", dirty)
	if err := os.WriteFile(filepath.Join(dirty, "session.go"), []byte("one\nTWO\nthree\nfour\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dirty, "scratch.txt"), []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	graphGit(t, dirty, "add", "session.go")
	graphGit(t, dirty, "commit", "-q", "-m", "work")
	tip := graphGit(t, dirty, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(dirty, "graph.go"), []byte("a\nb\nc\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := testConfig(t)
	cfg.PrivacyMode = "full"
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	body, _ := json.Marshal(map[string]string{"root": root, "vcs": "git"})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/workspace-graph/repos", bytes.NewReader(body)))
	var repo struct {
		ID string `json:"id"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &repo) != nil || repo.ID == "" {
		t.Fatalf("register %d %s", w.Code, w.Body)
	}

	get := func(path string) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		var out map[string]any
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
		return out
	}
	snapshot := get("/workspace-graph?refresh=true&repo_id=" + repo.ID)
	if snapshot["default_target_ref"] != "main" || snapshot["default_target"] != base {
		t.Fatalf("default target: ref=%v target=%v", snapshot["default_target_ref"], snapshot["default_target"])
	}
	var clean, changed map[string]any
	for _, raw := range snapshot["workspaces"].([]any) {
		ws := raw.(map[string]any)
		if ws["dirty"] == true {
			changed = ws
		} else {
			clean = ws
		}
	}
	if clean == nil || changed == nil {
		t.Fatalf("expected one clean and one dirty workspace: %v", snapshot["workspaces"])
	}
	for _, key := range []string{"changes", "changes_truncated"} {
		if _, present := clean[key]; present {
			t.Errorf("clean workspace must omit %q: %v", key, clean)
		}
	}
	if _, present := changed["changes_truncated"]; present {
		t.Errorf("changes_truncated is only present when truncated: %v", changed)
	}
	if _, present := changed["changed_files"]; !present {
		t.Errorf("legacy changed_files must stay: %v", changed)
	}
	byPath := map[string]map[string]any{}
	for _, raw := range changed["changes"].([]any) {
		entry := raw.(map[string]any)
		byPath[entry["path"].(string)] = entry
		for key := range entry {
			switch key {
			case "path", "status", "additions", "deletions", "binary":
			default:
				t.Errorf("unexpected field %q in %v", key, entry)
			}
		}
	}
	if len(byPath) != 2 {
		t.Fatalf("changes: %v", changed["changes"])
	}
	if g := byPath["graph.go"]; g["status"] != "M" || g["additions"] != float64(1) || g["deletions"] != float64(0) {
		t.Errorf("graph.go: %v", g)
	}
	if u := byPath["scratch.txt"]; u["status"] != "?" || u["additions"] != nil || u["deletions"] != nil || u["binary"] != nil {
		t.Errorf("untracked must carry no counts: %v", u)
	}

	cmp := get("/workspace-graph/compare?repo_id=" + repo.ID + "&revision=" + tip + "&target=" + base)
	list, _ := cmp["changes"].([]any)
	if len(list) != 1 || cmp["changed_files"] == nil {
		t.Fatalf("comparison: %v", cmp)
	}
	entry := list[0].(map[string]any)
	if entry["path"] != "session.go" || entry["status"] != "M" || entry["additions"] != float64(2) || entry["deletions"] != float64(1) {
		t.Errorf("comparison entry: %v", entry)
	}
	if _, present := cmp["changes_truncated"]; present {
		t.Errorf("comparison changes_truncated only when truncated: %v", cmp)
	}
	same := get("/workspace-graph/compare?repo_id=" + repo.ID + "&revision=" + base + "&target=" + base)
	if _, present := same["changes"]; present {
		t.Errorf("identical revisions must omit changes: %v", same)
	}

	// privacy transition: identities become digests, display data stays readable
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/config", strings.NewReader(`{"privacy_mode":"minimal"}`)))
	if w.Code != 200 {
		t.Fatalf("config %d %s", w.Code, w.Body)
	}
	canonicalRoot, _ := filepath.EvalSymlinks(root)
	canonicalDirty, _ := filepath.EvalSymlinks(dirty)
	repos := listedRepos(t, s)
	if len(repos) != 1 || repos[0].ID == repo.ID || len(repos[0].ID) != 64 || repos[0].Label != canonicalRoot {
		t.Fatalf("minimal: id must be a digest of the full-mode id, label the readable root: %+v (full id %q)", repos, repo.ID)
	}
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph?refresh=true&repo_id="+repos[0].ID, nil))
	text := w.Body.String()
	if w.Code != 200 || !strings.Contains(text, `"path":"graph.go"`) || !strings.Contains(text, `"path":"scratch.txt"`) || !strings.Contains(text, `"default_target_ref":"main"`) || !strings.Contains(text, `"refs":["refs/heads/agent/cache-fix"]`) || !strings.Contains(text, `"label":"`+canonicalDirty+`"`) {
		t.Fatalf("minimal response must keep names, paths and refs readable: %d %s", w.Code, text)
	}
	if strings.Contains(text, `"id":"`+repo.ID+`"`) || strings.Contains(text, `"id":"`+canonicalRoot+`"`) || strings.Contains(text, `"id":"`+canonicalDirty+`"`) {
		t.Fatalf("minimal identities must not be raw paths: %s", text)
	}
	if !strings.Contains(text, `"additions":1`) || !strings.Contains(text, `"status":"M"`) {
		t.Fatalf("minimal must keep structural metadata: %s", text)
	}
}
