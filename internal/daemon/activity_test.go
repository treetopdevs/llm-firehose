package daemon

import (
	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/capture"
	"agentfirehose/internal/event"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
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

func TestActivityIncludesUnresolvedErrorOnlyGroups(t *testing.T) {
	root, _ := twoWorktrees(t)
	s, engine := activityServer(t, "balanced")
	claudeEdit(t, engine, "seed", root, filepath.Join(root, "seed.go"), activityBase.Add(time.Minute))
	raw, err := os.ReadFile("../adapters/claudecode/testdata/pre_tool_use_edit.json")
	if err != nil {
		t.Fatal(err)
	}
	ev, err := claudecode.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	// Explicit normalized category/path/identity mutations of a captured receipt.
	ev.Category = event.CategoryError
	ev.Severity = event.SeverityError
	ev.CWD = root
	ev.RepoID = ""
	ev.WorktreeID = ""
	ev.ID = "outside-error"
	ev.Time = activityBase.Add(2 * time.Minute)
	ev.Payload["file_path"] = "/outside/problem.go"
	if _, err := engine.Admit(t.Context(), *ev); err != nil {
		t.Fatal(err)
	}
	ev.ID = "unknown-error"
	ev.CWD = ""
	ev.RepoID = filepath.Join(root, ".git")
	ev.WorktreeID = ""
	ev.Time = activityBase.Add(3 * time.Minute)
	if _, err := engine.Admit(t.Context(), *ev); err != nil {
		t.Fatal(err)
	}
	_, _, w := getActivity(t, s, window(onlyRepo(t, s)))
	var body struct {
		ErrorPaths []capture.ActivityErrorPath `json:"error_paths"`
		Groups     []activityGroup             `json:"groups"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.ErrorPaths) != 2 {
		t.Fatalf("error groups missing: %s", w.Body)
	}
	unknown := false
	for _, p := range body.ErrorPaths {
		found := false
		for _, g := range body.Groups {
			if g.ID == p.Group && !g.Resolved && g.Label == activityOutsideLabel {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing group for %+v: %s", p, w.Body)
		}
		unknown = unknown || p.Group == "unknown"
	}
	if !unknown {
		t.Fatalf("unknown group not exercised: %s", w.Body)
	}
}

// An agent working through a symlinked checkout reports paths through the
// link; they still resolve against the canonical worktree roots, including a
// file deleted after capture inside a directory reached through the link.
func TestActivitySymlinkedPathsResolveToWorktree(t *testing.T) {
	real := gitRepo(t)
	graphGit(t, real, "commit", "-q", "--allow-empty", "-m", "init")
	other := filepath.Join(real, ".claude", "worktrees", "feature")
	graphGit(t, real, "worktree", "add", "-q", "-b", "feature", other)
	link := filepath.Join(t.TempDir(), "l")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	linkedOther := filepath.Join(link, ".claude", "worktrees", "feature")
	if err := os.MkdirAll(filepath.Join(linkedOther, "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	gone := filepath.Join(linkedOther, "pkg", "gone.go")
	if err := os.WriteFile(gone, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s, engine := activityServer(t, "balanced")
	claudeEdit(t, engine, "main", link, filepath.Join(link, "a.go"), activityBase.Add(time.Minute))
	claudeEdit(t, engine, "wt", linkedOther, filepath.Join(linkedOther, "b.go"), activityBase.Add(2*time.Minute))
	claudeEdit(t, engine, "gone", linkedOther, gone, activityBase.Add(3*time.Minute))
	claudeEdit(t, engine, "missing-dir", link, filepath.Join(link, "new", "deep", "c.go"), activityBase.Add(4*time.Minute))
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	repoID := onlyRepo(t, s)
	code, body, w := getActivity(t, s, window(repoID))
	if code != 200 {
		t.Fatalf("status %d %s", code, w.Body)
	}
	want := map[string]int{"|a.go": 1, "|b.go": 1, "|pkg/gone.go": 1, "|new/deep/c.go": 1}
	if got := heatByPath(body); !reflect.DeepEqual(got, want) {
		t.Fatalf("symlinked paths resolve to their worktree: %v", got)
	}
	if len(body.Groups) != 1 || !body.Groups[0].Resolved {
		t.Fatalf("no outside group: %+v", body.Groups)
	}
}

func TestCanonicalPaths(t *testing.T) {
	real := t.TempDir()
	canonicalReal, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(real, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "file.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "l")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	var paths canonicalPaths
	for name, tc := range map[string]struct{ in, want string }{
		"symlinked ancestor": {filepath.Join(link, "dir", "x.go"), filepath.Join(canonicalReal, "dir", "x.go")},
		"non-existent tail":  {filepath.Join(link, "a", "b", "c.go"), filepath.Join(canonicalReal, "a", "b", "c.go")},
		"relative":           {"pkg/./x.go", filepath.Join("pkg", "x.go")},
		"error fallback":     {filepath.Join(link, "file.txt", "sub", "y.go") + string(filepath.Separator), filepath.Join(link, "file.txt", "sub", "y.go")},
	} {
		for i := 0; i < 2; i++ { // the second pass is served from the directory cache
			if got := paths.resolve(tc.in); got != tc.want {
				t.Errorf("%s (pass %d): %q want %q", name, i, got, tc.want)
			}
		}
	}
}

// symlinkOrSkip creates link -> target, skipping where symlinks are unavailable.
func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
}

func canonicalTemp(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// Oversized paths skip resolution, a deep missing tail is resolved without
// caching its prefixes, the cache is bounded, and a cancelled request stops
// resolving.
func TestCanonicalPathsBounded(t *testing.T) {
	real := canonicalTemp(t)
	link := filepath.Join(t.TempDir(), "l")
	symlinkOrSkip(t, real, link)
	sep := string(filepath.Separator)
	many := link + sep + strings.Repeat("m"+sep, 300) + "x.go"
	long := link + sep + strings.Repeat(strings.Repeat("a", 250)+sep, 20) + "x.go"
	var paths canonicalPaths
	for name, in := range map[string]string{"many components": many, "long": long} {
		if got := paths.resolve(in); got != in {
			t.Errorf("%s: resolved %d bytes, want the captured text", name, len(got))
		}
	}
	deep := strings.Repeat("m"+sep, 200) + "x.go"
	paths = canonicalPaths{}
	if got := paths.resolve(filepath.Join(link, deep)); got != filepath.Join(real, deep) {
		t.Errorf("deep missing tail: %q", got)
	}
	if len(paths.dirs) > 1 {
		t.Errorf("deep missing tail cached %d prefixes", len(paths.dirs))
	}
	paths = canonicalPaths{limit: 8}
	for i := range 20 {
		in := filepath.Join(link, fmt.Sprintf("d%d", i), "x.go")
		if got := paths.resolve(in); got != filepath.Join(real, fmt.Sprintf("d%d", i), "x.go") {
			t.Errorf("past the cache limit: %q", got)
		}
	}
	if len(paths.dirs) > 8 {
		t.Errorf("cache grew to %d entries", len(paths.dirs))
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	paths = canonicalPaths{ctx: ctx}
	if in := filepath.Join(link, "x.go"); paths.resolve(in) != in {
		t.Errorf("a cancelled request still resolves")
	}
}

// /alias -> /repo with /repo/escape -> a missing target outside: the dangling
// link is not a missing directory to reattach under the repository.
func TestActivityDanglingSymlinkStaysOutside(t *testing.T) {
	repo, outside := canonicalTemp(t), canonicalTemp(t)
	symlinkOrSkip(t, filepath.Join(outside, "missing"), filepath.Join(repo, "escape"))
	alias := filepath.Join(t.TempDir(), "alias")
	symlinkOrSkip(t, repo, alias)
	roots := activityRoots{}
	roots.add("repo-id", []string{repo, "d"})
	in := filepath.Join(alias, "escape", "x.go")
	if g, p := roots.resolve(event.Event{WorktreeID: "d"}, in); g != "d" || p != in {
		t.Fatalf("dangling symlink escape: %q %q", g, p)
	}
}

// /alias/link/../x.go with /repo/link -> /outside/deep names /outside/x.go:
// ".." applies after the link is followed.
func TestActivityDotDotFollowsSymlinkFirst(t *testing.T) {
	repo, outside := canonicalTemp(t), canonicalTemp(t)
	if err := os.Mkdir(filepath.Join(outside, "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, filepath.Join(outside, "deep"), filepath.Join(repo, "link"))
	alias := filepath.Join(t.TempDir(), "alias")
	symlinkOrSkip(t, repo, alias)
	roots := activityRoots{}
	roots.add("repo-id", []string{repo, "d"})
	in := filepath.Join(alias, "link") + string(filepath.Separator) + ".." + string(filepath.Separator) + "x.go"
	if g, p := roots.resolve(event.Event{WorktreeID: "d"}, in); g != "d" || p != in {
		t.Fatalf("link/.. resolves outside: %q %q", g, p)
	}
	if got := roots.paths.resolve(in); got != filepath.Join(outside, "x.go") {
		t.Fatalf("canonical: %q", got)
	}
}

// A snapshot root replaced by a symlink after the snapshot keeps its boundary:
// roots are used exactly as the graph reports them.
func TestActivityRootsAreNotRecanonicalised(t *testing.T) {
	repo, elsewhere := canonicalTemp(t), canonicalTemp(t)
	wt := filepath.Join(repo, "wt")
	symlinkOrSkip(t, elsewhere, wt)
	roots := activityRoots{}
	roots.add("repo-id", []string{wt, "dwt"})
	in := filepath.Join(elsewhere, "x.go")
	if g, p := roots.resolve(event.Event{}, in); g != "unknown" || p != in {
		t.Fatalf("boundary moved to the symlink target: %q %q", g, p)
	}
}

func TestLocalResolvable(t *testing.T) {
	cases := map[string]bool{
		`\\host\share\x`:     false,
		`//host/share/x`:     false,
		`\\?\UNC\host\x`:     false,
		`\\.\pipe\x`:         false,
		`\\?\C:\x`:           false,
		"/net":               false,
		"/net/host/x":        false,
		"/NET/host/x":        false, // case-insensitive volumes still automount
		"/Network/Servers/x": false,
		"/tmp/../net/host/x": false,
		t.TempDir():          true,
	}
	if filepath.Separator == '/' {
		cases["/netfoo/x"] = true
		cases["/Networking/x"] = true
		cases["relative/x"] = false
	} else {
		cases[`C:\netfoo\x`] = true
		cases[`C:\net\x`] = true   // only unix automount trees are /net
		cases["/netfoo/x"] = false // not drive-rooted
		cases[`C:x`] = false
	}
	for in, want := range cases {
		if got := localResolvable(in); got != want {
			t.Errorf("localResolvable(%q) = %v, want %v", in, got, want)
		}
	}
}

// Captured paths are untrusted: network and automount paths come back as
// their cleaned text without touching the filesystem.
func TestCanonicalPathsSkipsNetworkPaths(t *testing.T) {
	calls := 0
	paths := canonicalPaths{
		lstat:    func(p string) (os.FileInfo, error) { calls++; return os.Lstat(p) },
		readlink: func(p string) (string, error) { calls++; return os.Readlink(p) },
	}
	unc := "//host/share/dir/../x.go"
	if filepath.Separator == '\\' {
		unc = `\\host\share\dir\..\x.go`
	}
	for _, in := range []string{unc, "/net/host/dir/../x.go"} {
		if got := paths.resolve(in); got != filepath.Clean(in) {
			t.Errorf("%q: %q, want %q", in, got, filepath.Clean(in))
		}
	}
	if calls != 0 {
		t.Fatalf("filesystem calls on network paths: %d", calls)
	}
	paths.resolve(filepath.Join(t.TempDir(), "x.go"))
	if calls == 0 {
		t.Fatal("the injected filesystem funcs are not used")
	}
}

// countingPaths records every path handed to lstat or readlink.
func countingPaths(seen *[]string) canonicalPaths {
	return canonicalPaths{
		lstat:    func(p string) (os.FileInfo, error) { *seen = append(*seen, p); return os.Lstat(p) },
		readlink: func(p string) (string, error) { *seen = append(*seen, p); return os.Readlink(p) },
	}
}

// A symlink inside a local path may point at the network; the walk checks
// each link target and never follows one that is not local. The host names
// are reserved (.invalid) so a regression cannot reach a real host.
func TestCanonicalPathsNeverFollowsNetworkLinks(t *testing.T) {
	if filepath.Separator != '/' {
		t.Skip("unix link targets")
	}
	for name, target := range map[string]string{
		"automount": "/net/firehose-test.invalid/x",
		"unc":       "//firehose-test.invalid/share",
	} {
		repo := canonicalTemp(t)
		symlinkOrSkip(t, target, filepath.Join(repo, "docs"))
		var seen []string
		paths := countingPaths(&seen)
		in := filepath.Join(repo, "docs", "a", "x.go")
		if got := paths.resolve(in); got != in {
			t.Errorf("%s: %q, want the captured text", name, got)
		}
		for _, p := range seen {
			if !localResolvable(p) || strings.Contains(p, "firehose-test.invalid") {
				t.Errorf("%s: filesystem call on %q", name, p)
			}
		}
	}
}

func TestCanonicalPathsLinkLoopAndRelativeTarget(t *testing.T) {
	dir := canonicalTemp(t)
	symlinkOrSkip(t, filepath.Join(dir, "b"), filepath.Join(dir, "a"))
	symlinkOrSkip(t, filepath.Join(dir, "a"), filepath.Join(dir, "b"))
	var paths canonicalPaths
	if in := filepath.Join(dir, "a", "x.go"); paths.resolve(in) != in {
		t.Errorf("link loop: %q", paths.resolve(in))
	}
	if err := os.MkdirAll(filepath.Join(dir, "real", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, filepath.Join("..", "real", "sub"), filepath.Join(dir, "d", "rel"))
	link := filepath.Join(t.TempDir(), "l")
	symlinkOrSkip(t, dir, link)
	if got := paths.resolve(filepath.Join(link, "d", "rel", "x.go")); got != filepath.Join(dir, "real", "sub", "x.go") {
		t.Errorf("relative target: %q", got)
	}
}

type fakeInfo struct{ mode fs.FileMode }

func (f fakeInfo) Name() string       { return "" }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return nil }

// The walk does its own resolution through lstat and readlink, so a fake tree
// proves both that links are followed and that a network target never is.
func TestCanonicalPathsWalksThroughInjectedFilesystem(t *testing.T) {
	if filepath.Separator != '/' {
		t.Skip("unix fake tree")
	}
	links := map[string]string{"/v/ok": "real", "/v/docs": "/net/h/x", "/v/up": "/v/real/../real/sub", "/v/unc": "//h/share", "/v/up2": ".."}
	dirs := map[string]bool{"/": true, "/v": true, "/v/real": true, "/v/real/sub": true}
	var seen []string
	paths := canonicalPaths{
		lstat: func(p string) (os.FileInfo, error) {
			seen = append(seen, p)
			if _, ok := links[p]; ok {
				return fakeInfo{fs.ModeSymlink}, nil
			}
			if dirs[p] {
				return fakeInfo{fs.ModeDir}, nil
			}
			return nil, fs.ErrNotExist
		},
		readlink: func(p string) (string, error) { seen = append(seen, p); return links[p], nil },
	}
	for in, want := range map[string]string{
		"/v/ok/x.go":          "/v/real/x.go",
		"/v/up/x.go":          "/v/real/sub/x.go",
		"/v/ok/new/x.go":      "/v/real/new/x.go",
		"/v/docs/a/x.go":      "/v/docs/a/x.go",
		"/v/unc/a/x.go":       "/v/unc/a/x.go",
		"/v/up2/net/h/x.go":   "/v/up2/net/h/x.go", // ".." reaches / before /net
		"/v/real/../../net/h": "/net/h",
	} {
		if got := paths.resolve(in); got != want {
			t.Errorf("%s: %q want %q", in, got, want)
		}
	}
	for _, p := range seen {
		if !localResolvable(p) || strings.Contains(p, "/h/") {
			t.Errorf("filesystem call on %q", p)
		}
	}
}
