package daemon

import (
	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/capture"
	"agentfirehose/internal/event"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type activityBody struct {
	RepoID            string                 `json:"repo_id"`
	WorkspaceID       string                 `json:"workspace_id"`
	From              time.Time              `json:"from"`
	To                time.Time              `json:"to"`
	BucketSeconds     int                    `json:"bucket_seconds"`
	Buckets           int                    `json:"buckets"`
	Available         bool                   `json:"available"`
	UnavailableReason string                 `json:"unavailable_reason"`
	Paths             []capture.ActivityPath `json:"paths"`
	Groups            []struct {
		ID       string `json:"id"`
		Label    string `json:"label"`
		Resolved bool   `json:"resolved"`
	} `json:"groups"`
	FileEvents           int  `json:"file_events"`
	UnreadableFileEvents int  `json:"unreadable_file_events"`
	Truncated            bool `json:"truncated"`
	TruncatedTotal       int  `json:"truncated_total"`
	CaptureGap           bool `json:"capture_gap"`
}

var activityBase = time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)

// claudeEdit runs the real claude-code PreToolUse:Edit hook fixture through the
// adapter with a chosen cwd and absolute file_path, then admits it.
func claudeEdit(t *testing.T, engine *capture.Engine, id, cwd, filePath string, at time.Time) {
	t.Helper()
	data, err := os.ReadFile("../adapters/claudecode/testdata/pre_tool_use_edit.json")
	if err != nil {
		t.Fatal(err)
	}
	var hook map[string]any
	if err := json.Unmarshal(data, &hook); err != nil {
		t.Fatal(err)
	}
	hook["cwd"] = cwd
	hook["tool_input"].(map[string]any)["file_path"] = filePath
	data, _ = json.Marshal(hook)
	ev, err := claudecode.Parse(data)
	if err != nil || ev == nil || ev.Category != event.CategoryFile {
		t.Fatalf("parse: %+v %v", ev, err)
	}
	ev.ID, ev.Time = id, at
	if _, err := engine.Admit(t.Context(), *ev); err != nil {
		t.Fatal(err)
	}
}

func getActivity(t *testing.T, s *Server, params url.Values) (int, activityBody, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph/activity?"+params.Encode(), nil))
	var body activityBody
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v %s", err, w.Body)
		}
	}
	return w.Code, body, w
}

func window(repoID string) url.Values {
	return url.Values{"repo_id": {repoID}, "from": {activityBase.Format(time.RFC3339)}, "to": {activityBase.Add(time.Hour).Format(time.RFC3339)}, "bucket": {"900"}}
}

func heatByPath(b activityBody) map[string]int {
	out := map[string]int{}
	for _, p := range b.Paths {
		out[p.Group+"|"+p.Path] = p.Total
	}
	return out
}

// twoWorktrees returns a committed repository root and a second linked worktree.
func twoWorktrees(t *testing.T) (string, string) {
	t.Helper()
	root := gitRepo(t)
	graphGit(t, root, "commit", "-q", "--allow-empty", "-m", "init")
	other := filepath.Join(t.TempDir(), "other")
	graphGit(t, root, "worktree", "add", "-q", "-b", "other", other)
	canonical, err := filepath.EvalSymlinks(other)
	if err != nil {
		t.Fatal(err)
	}
	return root, canonical
}

func activityServer(t *testing.T, mode string) (*Server, *capture.Engine) {
	t.Helper()
	cfg := testConfig(t)
	cfg.PrivacyMode = mode
	engine := testEngine(t, cfg)
	return New(engine, cfg, t.TempDir(), "test"), engine
}

func onlyRepo(t *testing.T, s *Server) string {
	t.Helper()
	s.reconcileGraphRoots(t.Context())
	var ids []string
	for _, repo := range listedRepos(t, s) {
		if repo.Status != "unavailable" { // a removed worktree's observed root
			ids = append(ids, repo.ID)
		}
	}
	if len(ids) != 1 {
		t.Fatalf("repos: %v", ids)
	}
	return ids[0]
}

func workspaceID(t *testing.T, s *Server, repoID, label string) string {
	t.Helper()
	snapshot, err := s.graph.service.Snapshot(t.Context(), repoID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, ws := range snapshot.Workspaces {
		if ws.Label == label {
			return ws.ID
		}
	}
	t.Fatalf("no workspace %s in %+v", label, snapshot.Workspaces)
	return ""
}

func TestActivityMergesWorktreesByRelativePath(t *testing.T) {
	root, other := twoWorktrees(t)
	s, engine := activityServer(t, "balanced")
	claudeEdit(t, engine, "e1", root, filepath.Join(root, "internal/a.go"), activityBase.Add(time.Minute))
	claudeEdit(t, engine, "e2", other, filepath.Join(other, "internal/a.go"), activityBase.Add(20*time.Minute))
	claudeEdit(t, engine, "e3", other, filepath.Join(other, "b.go"), activityBase.Add(40*time.Minute))
	repoID := onlyRepo(t, s)

	code, body, w := getActivity(t, s, window(repoID))
	if code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status %d %s", code, w.Body)
	}
	if got := heatByPath(body); !reflect.DeepEqual(got, map[string]int{"|b.go": 1, "|internal/a.go": 2}) {
		t.Fatalf("worktrees merge by repository-relative path: %v", got)
	}
	if body.Paths[1].Path != "internal/a.go" || !reflect.DeepEqual(body.Paths[1].Heat, [][2]int{{0, 1}, {1, 1}}) {
		t.Fatalf("heat buckets: %+v", body.Paths)
	}
	if !body.Available || body.RepoID != repoID || body.Buckets != 4 || body.BucketSeconds != 900 || body.FileEvents != 3 || len(body.Groups) != 1 || body.Groups[0].ID != "" || !body.Groups[0].Resolved {
		t.Fatalf("body: %+v", body)
	}
	if !body.From.Equal(activityBase) || !body.To.Equal(activityBase.Add(time.Hour)) {
		t.Fatalf("window: %v %v", body.From, body.To)
	}
}

func TestActivityWorkspaceFilter(t *testing.T) {
	root, other := twoWorktrees(t)
	s, engine := activityServer(t, "balanced")
	claudeEdit(t, engine, "e1", root, filepath.Join(root, "internal/a.go"), activityBase.Add(time.Minute))
	claudeEdit(t, engine, "e2", other, filepath.Join(other, "internal/a.go"), activityBase.Add(2*time.Minute))
	claudeEdit(t, engine, "e3", other, filepath.Join(other, "b.go"), activityBase.Add(3*time.Minute))
	repoID := onlyRepo(t, s)
	params := window(repoID)
	params.Set("workspace_id", workspaceID(t, s, repoID, other))
	code, body, w := getActivity(t, s, params)
	if code != 200 {
		t.Fatalf("status %d %s", code, w.Body)
	}
	if got := heatByPath(body); !reflect.DeepEqual(got, map[string]int{"|b.go": 1, "|internal/a.go": 1}) || body.WorkspaceID != params.Get("workspace_id") {
		t.Fatalf("only the chosen worktree's events: %v %+v", got, body)
	}
	params.Set("workspace_id", "no-such-workspace")
	if code, _, _ := getActivity(t, s, params); code != 422 {
		t.Fatalf("unknown workspace: %d", code)
	}
}

// An agent in worktree A editing worktree B resolves relative to B; a path in a
// worktree nested inside another resolves to the innermost (longest) root.
func TestActivityCrossWorktreeEditResolvesToOtherRoot(t *testing.T) {
	root := gitRepo(t)
	graphGit(t, root, "commit", "-q", "--allow-empty", "-m", "init")
	nested := filepath.Join(root, ".claude", "worktrees", "feature")
	graphGit(t, root, "worktree", "add", "-q", "-b", "feature", nested)
	s, engine := activityServer(t, "balanced")
	claudeEdit(t, engine, "own", nested, filepath.Join(nested, "x.go"), activityBase.Add(time.Minute))
	claudeEdit(t, engine, "cross", nested, filepath.Join(root, "y.go"), activityBase.Add(2*time.Minute))
	claudeEdit(t, engine, "into-nested", root, filepath.Join(nested, "x.go"), activityBase.Add(3*time.Minute))
	repoID := onlyRepo(t, s)
	code, body, w := getActivity(t, s, window(repoID))
	if code != 200 {
		t.Fatalf("status %d %s", code, w.Body)
	}
	if got := heatByPath(body); !reflect.DeepEqual(got, map[string]int{"|x.go": 2, "|y.go": 1}) {
		t.Fatalf("cross-worktree and nested edits resolve to the containing root: %v", got)
	}
}

// A worktree the current snapshot no longer lists (deleted), and an edit outside
// every known root, keep their raw path under the event's own worktree identity.
func TestActivityUnknownWorktreeFallsBackToRawGroup(t *testing.T) {
	root, other := twoWorktrees(t)
	s, engine := activityServer(t, "balanced")
	outside := filepath.Join(t.TempDir(), "elsewhere.go")
	claudeEdit(t, engine, "gone", other, filepath.Join(other, "gone.go"), activityBase.Add(time.Minute))
	claudeEdit(t, engine, "outside", root, outside, activityBase.Add(2*time.Minute))
	claudeEdit(t, engine, "kept", root, filepath.Join(root, "kept.go"), activityBase.Add(3*time.Minute))
	graphGit(t, root, "worktree", "remove", other)
	repoID := onlyRepo(t, s)
	code, body, w := getActivity(t, s, window(repoID))
	if code != 200 {
		t.Fatalf("status %d %s", code, w.Body)
	}
	digest := func(p string) string { sum := sha256.Sum256([]byte(p)); return hex.EncodeToString(sum[:]) }
	want := map[string]int{
		"|kept.go": 1,
		digest(other) + "|" + filepath.Join(other, "gone.go"): 1,
		digest(root) + "|" + outside:                          1,
	}
	if got := heatByPath(body); !reflect.DeepEqual(got, want) {
		t.Fatalf("unresolved paths stay raw under their own worktree: %v", got)
	}
	if body.Paths[0].Group != "" {
		t.Fatalf("resolved paths sort first: %+v", body.Paths)
	}
	groups := map[string]bool{}
	for _, g := range body.Groups {
		groups[g.ID] = g.Resolved
		if g.ID != "" && g.Label != "Outside known worktrees" {
			t.Fatalf("unresolved label: %+v", g)
		}
	}
	if len(groups) != 3 || !groups[""] || groups[digest(other)] || groups[digest(root)] || body.Groups[0].ID != "" {
		t.Fatalf("groups: %+v", body.Groups)
	}
}

func TestActivityJJRootStripsPrefix(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj unavailable")
	}
	root := t.TempDir()
	jjRun := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("jj", append([]string{"--config", "user.name=F", "--config", "user.email=f@example.invalid"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("jj %v: %v %s", args, err, out)
		}
	}
	jjRun(root, "git", "init")
	other := filepath.Join(t.TempDir(), "other")
	jjRun(root, "workspace", "add", other)
	root, _ = filepath.EvalSymlinks(root)
	other, _ = filepath.EvalSymlinks(other)
	s, engine := activityServer(t, "balanced")
	body, _ := json.Marshal(map[string]string{"root": root, "vcs": "jj"})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/workspace-graph/repos", bytes.NewReader(body)))
	if w.Code != 200 {
		t.Fatalf("register %d %s", w.Code, w.Body)
	}
	claudeEdit(t, engine, "j1", other, filepath.Join(other, "src/lib.rs"), activityBase.Add(time.Minute))
	claudeEdit(t, engine, "j2", root, filepath.Join(root, "src/lib.rs"), activityBase.Add(2*time.Minute))
	repoID := onlyRepo(t, s)
	code, got, rec := getActivity(t, s, window(repoID))
	if code != 200 {
		t.Fatalf("status %d %s", code, rec.Body)
	}
	if paths := heatByPath(got); !reflect.DeepEqual(paths, map[string]int{"|src/lib.rs": 2}) {
		t.Fatalf("jj workspace roots resolve without their jj: prefix: %v", paths)
	}
}

func TestActivityFullModeMatchesRawIdentity(t *testing.T) {
	root, other := twoWorktrees(t)
	s, engine := activityServer(t, "full")
	claudeEdit(t, engine, "f1", root, filepath.Join(root, "a.go"), activityBase.Add(time.Minute))
	claudeEdit(t, engine, "f2", other, filepath.Join(other, "a.go"), activityBase.Add(2*time.Minute))
	repoID := onlyRepo(t, s)
	code, body, w := getActivity(t, s, window(repoID))
	if code != 200 {
		t.Fatalf("status %d %s", code, w.Body)
	}
	if got := heatByPath(body); !reflect.DeepEqual(got, map[string]int{"|a.go": 2}) {
		t.Fatalf("raw full-mode identities resolve: %v (repo %s)", got, repoID)
	}
}

// Minimal mode answers before any spool read: an unreadable day file would
// otherwise fail the request.
func TestActivityMinimalModeUnavailableWithoutScan(t *testing.T) {
	root := gitRepo(t)
	cfg := testConfig(t)
	engine := testEngine(t, cfg)
	s := New(engine, cfg, t.TempDir(), "test")
	claudeEdit(t, engine, "m1", root, filepath.Join(root, "a.go"), activityBase.Add(time.Minute))
	repoID := onlyRepo(t, s)
	if code, body, _ := getActivity(t, s, window(repoID)); code != 200 || len(body.Paths) != 1 {
		t.Fatalf("balanced first: %d %+v", code, body)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/config", bytes.NewReader([]byte(`{"privacy_mode":"minimal"}`))))
	if w.Code != 200 {
		t.Fatalf("config %d %s", w.Code, w.Body)
	}
	day := filepath.Join(cfg.SpoolDir, activityBase.Format("2006-01-02")+".ndjson")
	if err := os.Chmod(day, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(day, 0600) })
	code, body, rec := getActivity(t, s, window(repoID))
	if code != 200 || body.Available || body.UnavailableReason != "minimal" || body.Paths == nil || len(body.Paths) != 0 || body.FileEvents != 0 {
		t.Fatalf("minimal: %d %s", code, rec.Body)
	}
	if body.Buckets != 4 || !body.From.Equal(activityBase) {
		t.Fatalf("the window is still reported: %+v", body)
	}
}

func TestActivityRejectsBadWindowAndBucket(t *testing.T) {
	root := gitRepo(t)
	s, engine := activityServer(t, "balanced")
	claudeEdit(t, engine, "r1", root, filepath.Join(root, "a.go"), activityBase.Add(time.Minute))
	repoID := onlyRepo(t, s)
	at := func(d time.Duration) string { return activityBase.Add(d).Format(time.RFC3339) }
	for name, tc := range map[string]struct {
		params url.Values
		code   int
	}{
		"missing repo":    {url.Values{}, 400},
		"unknown repo":    {url.Values{"repo_id": {"nope"}}, 422},
		"from == to":      {url.Values{"repo_id": {repoID}, "from": {at(0)}, "to": {at(0)}}, 400},
		"from > to":       {url.Values{"repo_id": {repoID}, "from": {at(time.Hour)}, "to": {at(0)}}, 400},
		"over 31 days":    {url.Values{"repo_id": {repoID}, "from": {at(-32 * 24 * time.Hour)}, "to": {at(0)}}, 400},
		"bad time":        {url.Values{"repo_id": {repoID}, "from": {"yesterday"}}, 400},
		"off ladder":      {url.Values{"repo_id": {repoID}, "bucket": {"120"}}, 400},
		"not a number":    {url.Values{"repo_id": {repoID}, "bucket": {"fast"}}, 400},
		"too many bucket": {url.Values{"repo_id": {repoID}, "from": {at(-3 * 24 * time.Hour)}, "to": {at(0)}, "bucket": {"60"}}, 400},
	} {
		if code, _, w := getActivity(t, s, tc.params); code != tc.code {
			t.Errorf("%s: %d want %d %s", name, code, tc.code, w.Body)
		}
	}
	// Defaults: to = now, from = to - 24h, smallest ladder bucket giving <= 240 buckets.
	code, body, w := getActivity(t, s, url.Values{"repo_id": {repoID}})
	if code != 200 || body.BucketSeconds != 900 || body.Buckets < 96 || body.Buckets > 97 || time.Since(body.To) > time.Minute {
		t.Fatalf("defaults: %d %+v %s", code, body, w.Body)
	}
	for span, bucket := range map[time.Duration]int{2 * time.Hour: 60, 8 * time.Hour: 300, 7 * 24 * time.Hour: 3600, 31 * 24 * time.Hour: 21600} {
		_, body, _ := getActivity(t, s, url.Values{"repo_id": {repoID}, "from": {at(-span)}, "to": {at(0)}})
		if body.BucketSeconds != bucket || body.Buckets > 240 {
			t.Errorf("%v window: bucket %d (%d buckets), want %d", span, body.BucketSeconds, body.Buckets, bucket)
		}
	}
}

func TestActivityOriginRestricted(t *testing.T) {
	root := gitRepo(t)
	s, engine := activityServer(t, "balanced")
	claudeEdit(t, engine, "o1", root, filepath.Join(root, "a.go"), activityBase.Add(time.Minute))
	repoID := onlyRepo(t, s)
	for origin, code := range map[string]int{"https://attacker.example": 403, "http://localhost:1420": 200, "tauri://localhost": 200} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/workspace-graph/activity?"+window(repoID).Encode(), nil)
		req.Header.Set("Origin", origin)
		s.Handler().ServeHTTP(w, req)
		if w.Code != code {
			t.Errorf("%s: %d want %d", origin, w.Code, code)
		}
	}
}

// Relative paths (opencode copies its tool's path verbatim) resolve against
// the event's own worktree root; one escaping the root stays unresolved.
func TestActivityRelativePathResolvesAgainstOwnRoot(t *testing.T) {
	root := gitRepo(t)
	s, engine := activityServer(t, "balanced")
	claudeEdit(t, engine, "r1", root, "pkg/./x.go", activityBase.Add(time.Minute))
	claudeEdit(t, engine, "r2", root, "../escape.go", activityBase.Add(2*time.Minute))
	repoID := onlyRepo(t, s)
	_, body, _ := getActivity(t, s, window(repoID))
	sum := sha256.Sum256([]byte(root))
	want := map[string]int{"|pkg/x.go": 1, hex.EncodeToString(sum[:]) + "|../escape.go": 1}
	if got := heatByPath(body); !reflect.DeepEqual(got, want) {
		t.Fatalf("relative paths: %v", got)
	}
}

// A JJ workspace with no root has the raw identity <repo identity>:<name>, which
// still looks absolute once "jj:" is stripped; it must not become a root.
func TestActivityRootlessJJWorkspaceIsNotARoot(t *testing.T) {
	repo := "jj:/work/proj/.jj/repo"
	roots := activityRoots{}
	roots.add(repo, []string{repo + ":ghost", "digest-ghost"})
	roots.add(repo, []string{"jj:/work/proj", "digest-root"})
	if !reflect.DeepEqual(roots.all, []string{"/work/proj"}) || roots.byAlias["digest-ghost"] != "" {
		t.Fatalf("roots: %v %v", roots.all, roots.byAlias)
	}
	if g, p := roots.resolve(event.Event{JJWorkspaceID: "digest-root"}, "/work/proj/.jj/repo:ghost/x.go"); g != "" || p != ".jj/repo:ghost/x.go" {
		t.Fatalf("resolve: %q %q", g, p)
	}
}

func TestActivityReturnsAdditiveErrorPaths(t *testing.T) {
	root, _ := twoWorktrees(t)
	s, engine := activityServer(t, "balanced")
	raw, err := os.ReadFile("../adapters/claudecode/testdata/pre_tool_use_edit.json")
	if err != nil {
		t.Fatal(err)
	}
	ev, err := claudecode.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	// Normalized contract mutation: exercise error attribution, not a claim of
	// newly observed source behavior or an invented raw adapter shape.
	ev.CWD = root
	ev.RepoID = ""
	ev.WorktreeID = ""
	ev.Severity = event.SeverityError
	ev.Payload["file_path"] = filepath.Join(root, "problem.go")
	for i, id := range []string{"error-one", "error-two"} {
		ev.ID = id
		ev.Time = activityBase.Add(time.Duration(i+1) * time.Minute)
		if _, err := engine.Admit(t.Context(), *ev); err != nil {
			t.Fatal(err)
		}
	}
	_, _, w := getActivity(t, s, window(onlyRepo(t, s)))
	var body struct {
		ErrorPaths []capture.ActivityErrorPath `json:"error_paths"`
		Omitted    int                         `json:"omitted_error_paths"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.ErrorPaths) != 1 || body.ErrorPaths[0].Path != "problem.go" || body.ErrorPaths[0].Total != 2 || body.Omitted != 0 {
		t.Fatalf("response: %s", w.Body)
	}
}
