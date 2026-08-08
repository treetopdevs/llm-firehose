package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

func httptestNewServerWithHome(t *testing.T, cfg cli.Config, home string) *httptest.Server {
	t.Helper()
	srv := New(cfg, home, "test-version")
	// Hermetic: the host running the tests may itself export Claude
	// telemetry variables, which must not leak into install decisions.
	srv.Environ = []string{}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func seedSessions(t *testing.T, dir string) {
	t.Helper()
	w := spool.NewWriter(dir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	evs := []event.Event{
		{ID: "a1", Time: base, Source: "claude-code", Agent: "claude", SessionID: "s1",
			Category: event.CategorySession, Summary: "session started", Repo: "myrepo"},
		{ID: "a2", Time: base.Add(time.Minute), Source: "claude-code", SessionID: "s1", TraceID: "tr1",
			Category: event.CategoryTool, Summary: "ran a tool"},
		{ID: "b1", Time: base.Add(2 * time.Minute), Source: "codex", SessionID: "s2", TraceID: "tr1",
			Category: event.CategoryPrompt, Summary: "hello"},
		{ID: "c1", Time: base.Add(3 * time.Minute), Source: "procwatch",
			Category: event.CategoryMeta, Summary: "no session id"},
	}
	for _, ev := range evs {
		if err := w.Append(ev); err != nil {
			t.Fatalf("seed append: %v", err)
		}
	}
}

func TestSessionsAggregatesSpool(t *testing.T) {
	cfg := testConfig(t)
	seedSessions(t, cfg.SpoolDir)
	ts := testServer(t, cfg)

	resp, err := http.Get(ts.URL + "/sessions")
	if err != nil {
		t.Fatalf("GET /sessions: %v", err)
	}
	defer resp.Body.Close()
	var sessions []Session
	if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2 (events without session_id excluded): %+v", len(sessions), sessions)
	}
	// Most recently active first.
	if sessions[0].ID != "s2" || sessions[1].ID != "s1" {
		t.Errorf("session order wrong: %+v", sessions)
	}
	s1 := sessions[1]
	if s1.Events != 2 || s1.Source != "claude-code" || s1.Repo != "myrepo" || s1.Agent != "claude" {
		t.Errorf("s1 summary wrong: %+v", s1)
	}
	if !s1.LastTime.After(s1.FirstTime) {
		t.Errorf("s1 time range wrong: %+v", s1)
	}
	if s1.State == "" || s1.StateSince.IsZero() {
		t.Errorf("s1 missing attention fields: state=%q since=%v", s1.State, s1.StateSince)
	}
	if string(s1.State) != "working" {
		t.Errorf("s1 state = %q, want working (last event was tool)", s1.State)
	}
}

func TestSessionByID(t *testing.T) {
	cfg := testConfig(t)
	seedSessions(t, cfg.SpoolDir)
	ts := testServer(t, cfg)

	resp, err := http.Get(ts.URL + "/sessions/s1")
	if err != nil {
		t.Fatalf("GET /sessions/s1: %v", err)
	}
	defer resp.Body.Close()
	var evs []event.Event
	if err := json.NewDecoder(resp.Body).Decode(&evs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(evs) != 2 || evs[0].ID != "a1" || evs[1].ID != "a2" {
		t.Fatalf("session events wrong: %+v", evs)
	}

	notFound, err := http.Get(ts.URL + "/sessions/does-not-exist")
	if err != nil {
		t.Fatalf("GET missing session: %v", err)
	}
	notFound.Body.Close()
	if notFound.StatusCode != http.StatusNotFound {
		t.Errorf("missing session status = %d, want 404", notFound.StatusCode)
	}
}

func TestTraceByID(t *testing.T) {
	cfg := testConfig(t)
	seedSessions(t, cfg.SpoolDir)
	ts := testServer(t, cfg)

	resp, err := http.Get(ts.URL + "/traces/tr1")
	if err != nil {
		t.Fatalf("GET /traces/tr1: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var evs []event.Event
	if err := json.NewDecoder(resp.Body).Decode(&evs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// tr1 spans sessions s1 and s2; oldest first.
	if len(evs) != 2 || evs[0].ID != "a2" || evs[1].ID != "b1" {
		t.Fatalf("trace events wrong: %+v", evs)
	}

	notFound, err := http.Get(ts.URL + "/traces/does-not-exist")
	if err != nil {
		t.Fatalf("GET missing trace: %v", err)
	}
	notFound.Body.Close()
	if notFound.StatusCode != http.StatusNotFound {
		t.Errorf("missing trace status = %d, want 404", notFound.StatusCode)
	}
}

func TestArtifactFiles(t *testing.T) {
	cfg := testConfig(t)
	w := spool.NewWriter(cfg.SpoolDir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	evs := []event.Event{
		{ID: "f1", Time: base, Source: "claude-code", SessionID: "s1", Category: event.CategoryFile,
			Payload: map[string]any{"file_path": "/repo/auth.go"}},
		{ID: "f2", Time: base.Add(time.Minute), Source: "opencode", SessionID: "s2", Category: event.CategoryFile,
			Payload: map[string]any{"file": "/repo/a.ts"}},
		{ID: "f3", Time: base.Add(2 * time.Minute), Source: "codex", SessionID: "s3", Category: event.CategoryFile,
			Payload: map[string]any{"changes": map[string]any{"/repo/auth.go": map[string]any{}, "/repo/b.go": map[string]any{}}}},
		{ID: "x1", Time: base.Add(3 * time.Minute), Source: "claude-code", SessionID: "s1", Category: event.CategoryShell,
			Summary: "not a file event"},
	}
	for _, ev := range evs {
		if err := w.Append(ev); err != nil {
			t.Fatalf("seed append: %v", err)
		}
	}
	ts := testServer(t, cfg)

	resp, err := http.Get(ts.URL + "/artifacts/files")
	if err != nil {
		t.Fatalf("GET /artifacts/files: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var files []FileArtifact
	if err := json.NewDecoder(resp.Body).Decode(&files); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("got %d artifacts, want 3: %+v", len(files), files)
	}
	// Most recently touched first; /repo/auth.go and /repo/b.go tie on f3's
	// time, auth.go seen first in a sorted walk of the changes map.
	byPath := map[string]FileArtifact{}
	for _, f := range files {
		byPath[f.Path] = f
	}
	auth := byPath["/repo/auth.go"]
	if auth.Events != 2 {
		t.Errorf("auth.go events = %d, want 2 (claude-code + codex)", auth.Events)
	}
	if len(auth.Sources) != 2 {
		t.Errorf("auth.go sources = %v, want [claude-code codex]", auth.Sources)
	}
	if !auth.LastTime.After(auth.FirstTime) {
		t.Errorf("auth.go time range wrong: %+v", auth)
	}
	if files[len(files)-1].Path != "/repo/a.ts" && files[0].Path == "/repo/a.ts" {
		t.Errorf("ordering wrong, a.ts is oldest by last touch: %+v", files)
	}
}

func TestArtifactFilesEmpty(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := http.Get(ts.URL + "/artifacts/files")
	if err != nil {
		t.Fatalf("GET /artifacts/files: %v", err)
	}
	defer resp.Body.Close()
	var files []FileArtifact
	if err := json.NewDecoder(resp.Body).Decode(&files); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if files == nil || len(files) != 0 {
		t.Errorf("want empty JSON array, got %v", files)
	}
}

// The daemon must reflect spool appends while running: the tailer feeds the
// derived index, so /sessions stays correct after the first query without
// re-reading the whole spool.
func TestSessionsLiveUpdateWhileRunning(t *testing.T) {
	cfg := testConfig(t)
	s := New(cfg, t.TempDir(), "test-version")
	s.TailInterval = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		s.Wait()
	})
	s.Start(ctx)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)

	getSessions := func() []Session {
		resp, err := http.Get(ts.URL + "/sessions")
		if err != nil {
			t.Fatalf("GET /sessions: %v", err)
		}
		defer resp.Body.Close()
		var out []Session
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out
	}

	if got := getSessions(); len(got) != 0 {
		t.Fatalf("expected empty sessions, got %+v", got)
	}

	w := spool.NewWriter(cfg.SpoolDir)
	ev := mkEvent(9, time.Now().UTC())
	ev.SessionID = "s9"
	if err := w.Append(ev); err != nil {
		t.Fatalf("append: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		got := getSessions()
		if len(got) == 1 && got[0].ID == "s9" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("appended session never appeared: %+v", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDoctorEndpoint(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := http.Get(ts.URL + "/doctor")
	if err != nil {
		t.Fatalf("GET /doctor: %v", err)
	}
	defer resp.Body.Close()
	var checks []struct {
		Name   string `json:"name"`
		OK     bool   `json:"ok"`
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&checks); err != nil {
		t.Fatalf("decode: %v", err)
	}
	found := false
	for _, c := range checks {
		if c.Name == "spool writable" {
			found = true
			if !c.OK {
				t.Errorf("spool writable should pass: %+v", c)
			}
		}
	}
	if !found {
		t.Errorf("no 'spool writable' check in %+v", checks)
	}
}

func TestInstallEndpoint(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	ts := httptestNewServerWithHome(t, cfg, home)

	resp, err := http.Post(ts.URL+"/install/claude-code", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /install/claude-code: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		OK     bool   `json:"ok"`
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.OK || got.Detail == "" {
		t.Errorf("install response = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); err != nil {
		t.Errorf("hooks not installed: %v", err)
	}
	settings, _ := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if !strings.Contains(string(settings), "hook-forward --source claude-code") {
		t.Fatalf("desktop install did not use the sidecar-compatible forwarder: %s", settings)
	}

	otel, err := http.Post(ts.URL+"/install/claude-otel", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /install/claude-otel: %v", err)
	}
	otel.Body.Close()
	if otel.StatusCode != http.StatusOK {
		t.Fatalf("Claude OTel install status = %d, want 200", otel.StatusCode)
	}
	if !cli.ClaudeOTelConfigured(home, cli.DefaultDaemonAddr) {
		t.Fatal("desktop Claude OTel install did not configure the local receiver")
	}

	unknown, err := http.Post(ts.URL+"/install/emacs", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /install/emacs: %v", err)
	}
	unknown.Body.Close()
	if unknown.StatusCode != http.StatusNotFound {
		t.Errorf("unknown adapter status = %d, want 404", unknown.StatusCode)
	}
}

func TestInstallEndpointClaudeOTelRefusesEnvironmentTelemetry(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	srv := New(cfg, home, "test-version")
	srv.Environ = []string{"PATH=/usr/bin", "CLAUDE_CODE_ENABLE_TELEMETRY=1"}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Post(ts.URL+"/install/claude-otel", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /install/claude-otel: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409 when the environment already configures telemetry", resp.StatusCode)
	}
	if cli.ClaudeOTelConfigured(home, cli.DefaultDaemonAddr) {
		t.Fatal("refused install still configured the local receiver")
	}
}

func TestInstallEndpointOpenCode(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	ts := httptestNewServerWithHome(t, cfg, home)

	resp, err := http.Post(ts.URL+"/install/opencode", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /install/opencode: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	matches, _ := filepath.Glob(filepath.Join(home, ".config", "opencode", "plugin", "*"))
	if len(matches) == 0 {
		t.Error("opencode plugin not written")
	}
	plugin, _ := os.ReadFile(matches[0])
	if !strings.Contains(string(plugin), `"hook-forward","--source","opencode"`) {
		t.Fatalf("desktop install did not use the sidecar-compatible forwarder: %s", plugin)
	}
}

func TestInstallEndpointCodex(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	ts := httptestNewServerWithHome(t, cfg, home)

	resp, err := http.Post(ts.URL+"/install/codex", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /install/codex: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.Detail, "configured") || !strings.Contains(got.Detail, "/hooks") {
		t.Fatalf("detail must distinguish configured from trust review: %q", got.Detail)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "hooks.json")); err != nil {
		t.Fatalf("hooks not installed: %v", err)
	}
}

func TestExportEndpoint(t *testing.T) {
	cfg := testConfig(t)
	seedSessions(t, cfg.SpoolDir)
	ts := testServer(t, cfg)

	resp, err := http.Post(ts.URL+"/export", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /export: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if v := resp.Header.Get("X-Firehose-Export-Version"); v != "1" {
		t.Errorf("export version header = %q, want 1", v)
	}
	var n int
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		var ev event.Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("export line %d not an event: %v", n, err)
		}
		if ev.SchemaVersion != event.CurrentSchemaVersion {
			t.Errorf("export line %d schema_version = %d", n, ev.SchemaVersion)
		}
		n++
	}
	if n != 4 {
		t.Errorf("exported %d lines, want 4", n)
	}
}

func TestInstallEndpointAntigravity(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	ts := httptestNewServerWithHome(t, cfg, home)

	resp, err := http.Post(ts.URL+"/install/antigravity", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /install/antigravity: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		OK     bool   `json:"ok"`
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || !strings.Contains(got.Detail, ".gemini/config/hooks.json") {
		t.Fatalf("install response = %+v", got)
	}
	data, err := os.ReadFile(filepath.Join(home, ".gemini", "config", "hooks.json"))
	if err != nil {
		t.Fatalf("hooks not installed: %v", err)
	}
	// The desktop sidecar path must carry the event name per registration:
	// Antigravity payloads name no event themselves.
	for _, name := range []string{"PostToolUse", "PostInvocation", "Stop"} {
		if !strings.Contains(string(data), "hook-forward --source antigravity --event "+name) {
			t.Errorf("missing %s forwarder in %s", name, data)
		}
	}
	for _, name := range []string{"PreToolUse", "PreInvocation"} {
		if strings.Contains(string(data), "--event "+name) {
			t.Errorf("pre-event %s must never be installed: %s", name, data)
		}
	}
}

func TestEmitEndpointAntigravityUsesAdditiveEventParameter(t *testing.T) {
	cfg := testConfig(t)
	ts := testServer(t, cfg)
	raw, err := os.ReadFile(filepath.Join("..", "adapters", "antigravity", "testdata", "post_tool_use_list_dir.json"))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(ts.URL+"/emit?source=antigravity&event=PostToolUse", "application/json", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatalf("POST /emit: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 || evs[0].Source != "antigravity" || evs[0].Name != "PostToolUse:list_dir" {
		t.Fatalf("emit not normalized: %+v", evs)
	}

	// Without the event name the payload cannot be attributed; the daemon
	// rejects it instead of guessing.
	missing, err := http.Post(ts.URL+"/emit?source=antigravity", "application/json", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatalf("POST /emit without event: %v", err)
	}
	missing.Body.Close()
	if missing.StatusCode != http.StatusBadRequest {
		t.Errorf("status without event = %d, want 400", missing.StatusCode)
	}
}
