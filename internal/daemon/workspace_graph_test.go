package daemon

import (
	"agentfirehose/internal/capture"
	"agentfirehose/internal/privacy"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
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

func TestGraphRegistrationPrivatePersistenceAndOrigin(t *testing.T) {
	root := t.TempDir()
	cmd := exec.Command("git", "init", "-q", root)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, output)
	}
	cfg := testConfig(t)
	home := t.TempDir()
	s := New(testEngine(t, cfg), cfg, home, "test")
	body, _ := json.Marshal(map[string]string{"root": root, "vcs": "git"})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/workspace-graph/repos", bytes.NewReader(body)))
	if w.Code != 200 {
		t.Fatalf("register %d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), root) {
		t.Fatal("registration leaked root")
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

func TestUnavailableRegisteredRootStaysVisibleAndPrivate(t *testing.T) {
	cfg := testConfig(t)
	s := New(testEngine(t, cfg), cfg, t.TempDir(), "test")
	root := filepath.Join(t.TempDir(), "missing-private-root")
	s.graph.unavailable = map[string]string{root: "jj"}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph/repos", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), root) || !strings.Contains(w.Body.String(), `"status":"unavailable"`) {
		t.Fatalf("response %d %s", w.Code, w.Body)
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
func TestPrivacyChangeWaitsForGraphResponseAndProtectsNextResponse(t *testing.T) {
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
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/workspace-graph/repos", nil))
	if strings.Contains(w.Body.String(), privateRoot) {
		t.Fatal("new response leaked full-mode root")
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
