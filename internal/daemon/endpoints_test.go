package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/cli"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/testsupport/capturehistory"
)

func httptestNewServerWithHome(t *testing.T, cfg cli.Config, home string) *httptest.Server {
	t.Helper()
	srv := New(testEngine(t, cfg), cfg, home, "test-version")
	// Hermetic: the host running the tests may itself export Claude
	// telemetry variables, which must not leak into install decisions.
	srv.Environ = []string{}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func seedSessions(t *testing.T, dir string) {
	t.Helper()
	w := capturehistory.NewAdmitter(dir)
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
		if _, err := w.Append(ev); err != nil {
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
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
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
		if _, err := w.Append(ev); err != nil {
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
	if files[len(files)-1].Path != "/repo/a.ts" {
		t.Errorf("ordering wrong, a.ts should be oldest by last touch: %+v", files)
	}
}

// A real codex patch_apply_end recorded in minimal mode holds a {sha256,len}
// digest where its changes map was; /artifacts/files must not list "len" and
// "sha256" as touched files.
func TestArtifactFilesSkipMinimalModeChangesDigest(t *testing.T) {
	f, err := os.Open("../capture/testdata/activity_real_shapes.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var real event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		if strings.Contains(sc.Text(), `"name":"patch_apply_end"`) {
			if err := json.Unmarshal(sc.Bytes(), &real); err != nil {
				t.Fatal(err)
			}
		}
	}
	if real.ID == "" {
		t.Fatal("no patch_apply_end record in fixture")
	}

	cfg := testConfig(t)
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	if _, err := w.Append(privacy.Redact(real, privacy.ModeMinimal)); err != nil {
		t.Fatalf("seed append: %v", err)
	}
	ts := testServer(t, cfg)

	resp, err := http.Get(ts.URL + "/artifacts/files")
	if err != nil {
		t.Fatalf("GET /artifacts/files: %v", err)
	}
	defer resp.Body.Close()
	var files []FileArtifact
	if err := json.NewDecoder(resp.Body).Decode(&files); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("minimal-mode digest listed as touched files: %+v", files)
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
	engine := testEngine(t, cfg)
	s := New(engine, cfg, t.TempDir(), "test-version")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		<-done
	})
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

	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	ev := mkEvent(9, time.Now().UTC())
	ev.SessionID = "s9"
	if _, err := w.Append(ev); err != nil {
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
	srv := New(testEngine(t, cfg), cfg, home, "test-version")
	srv.Environ = []string{"PATH=/usr/bin", "OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example"}
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

func TestInstallEndpointClaudeOTelReplaceBody(t *testing.T) {
	cfg := testConfig(t)
	home := t.TempDir()
	settings := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settings), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"env":{"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT":"http://127.0.0.1:1738/v1/logs"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := New(testEngine(t, cfg), cfg, home, "test-version")
	srv.Environ = []string{"PATH=/usr/bin"}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	plain, err := http.Post(ts.URL+"/install/claude-otel", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(plain.Body)
	plain.Body.Close()
	if plain.StatusCode != http.StatusConflict || !strings.Contains(string(body), "127.0.0.1:1738") {
		t.Fatalf("plain install = %d %q, want 409 naming the existing destination", plain.StatusCode, body)
	}

	resp, err := http.Post(ts.URL+"/install/claude-otel", "application/json", strings.NewReader(`{"replace":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK     bool   `json:"ok"`
		Detail string `json:"detail"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !out.OK || !strings.Contains(out.Detail, "backup") {
		t.Fatalf("replace install = %d %+v, want 200 mentioning the backup", resp.StatusCode, out)
	}
	if !cli.ClaudeOTelConfigured(home, cli.DefaultDaemonAddr) {
		t.Fatal("replace did not configure the local receiver")
	}
}

func TestInstallEndpointClaudeOTelNonConflictFailureIs500(t *testing.T) {
	cfg := testConfig(t)
	cfg.DaemonAddr = "example.com:80" // non-loopback: an install failure that is not a settings conflict
	home := t.TempDir()
	srv := New(testEngine(t, cfg), cfg, home, "test-version")
	srv.Environ = []string{"PATH=/usr/bin"}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Post(ts.URL+"/install/claude-otel", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /install/claude-otel: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 for a non-conflict installer failure", resp.StatusCode)
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
	if err := sc.Err(); err != nil {
		t.Fatalf("export scan: %v", err)
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
	evs, _ := capturehistory.Recent(cfg.SpoolDir, 10)
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

func TestAttentionAPIAndExactEvidence(t *testing.T) {
	cfg := testConfig(t)
	seedSessions(t, cfg.SpoolDir)
	ids := []string{"stream", ".", "..", "a/b?&= %+"}
	for _, id := range ids {
		if _, err := capturehistory.NewAdmitter(cfg.SpoolDir).Append(event.Event{ID: id, Source: "codex", SessionID: "s2", Time: time.Now().UTC(), Category: event.CategoryPermission, Name: "PermissionRequest"}); err != nil {
			t.Fatal(err)
		}
	}
	ts := testServer(t, cfg)
	resp, err := http.Get(ts.URL + "/attention")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("attention status: %d", resp.StatusCode)
	}
	var snapshot struct {
		Sessions []struct {
			ID string `json:"id"`
		}
		Warnings []any `json:"warnings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Sessions) != 2 || snapshot.Warnings == nil {
		t.Fatalf("bad snapshot: %+v", snapshot)
	}
	for _, id := range ids {
		evidence, err := http.Get(ts.URL + "/attention/event?id=" + url.QueryEscape(id))
		if err != nil {
			t.Fatal(err)
		}
		defer evidence.Body.Close()
		if evidence.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("captured evidence response can be cached")
		}
		var ev event.Event
		if err := json.NewDecoder(evidence.Body).Decode(&ev); err != nil {
			t.Fatal(err)
		}
		if ev.ID != id || ev.SessionID != "s2" {
			t.Fatalf("wrong evidence: %+v", ev)
		}
	}
	missing, err := http.Get(ts.URL + "/attention/event?id=absent")
	if err != nil {
		t.Fatal(err)
	}
	defer missing.Body.Close()
	if missing.StatusCode != http.StatusNotFound {
		t.Fatalf("missing evidence status %d", missing.StatusCode)
	}
	if missing.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("missing evidence response can be cached")
	}
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/attention", nil)
	req.Header.Set("Origin", "https://untrusted.example")
	denied, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatal("attention bypassed local API origin policy")
	}
}

// seedErrorFixture admits the real captured Error Signature fixture through a
// standalone engine, so the daemon under test rebuilds it from the spool.
func seedErrorFixture(t *testing.T, dir string) {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "capture", "internal", "projection", "testdata", "errsig.ndjson"))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	w := capturehistory.NewAdmitter(dir)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var ev event.Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("decode fixture: %v", err)
		}
		if _, err := w.Append(ev); err != nil {
			t.Fatalf("seed append: %v", err)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan fixture: %v", err)
	}
}

func getErrors(t *testing.T, ts *httptest.Server, query string) (int, []ErrorSignature, string) {
	t.Helper()
	resp, err := http.Get(ts.URL + "/errors" + query)
	if err != nil {
		t.Fatalf("GET /errors%s: %v", query, err)
	}
	defer resp.Body.Close()
	var raw strings.Builder
	var sigs []ErrorSignature
	dec := json.NewDecoder(resp.Body)
	var msg json.RawMessage
	if err := dec.Decode(&msg); err != nil {
		t.Fatalf("decode: %v", err)
	}
	raw.Write(msg)
	if err := json.Unmarshal(msg, &sigs); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	return resp.StatusCode, sigs, raw.String()
}

func TestErrorsEndpoint(t *testing.T) {
	cfg := testConfig(t)
	seedErrorFixture(t, cfg.SpoolDir)
	ts := testServer(t, cfg)

	status, sigs, unfilteredRaw := getErrors(t, ts, "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	// members is session-scoped: the unfiltered listing never carries it.
	if strings.Contains(unfilteredRaw, `"members"`) {
		t.Errorf("unfiltered /errors must omit members: %s", unfilteredRaw)
	}
	if len(sigs) != 5 {
		t.Fatalf("got %d signatures, want 5: %+v", len(sigs), sigs)
	}
	total := 0
	byKey := map[string]ErrorSignature{}
	for i, s := range sigs {
		total += s.Count
		byKey[s.Key] = s
		if i > 0 && sigs[i-1].LastTime.Before(s.LastTime) {
			t.Errorf("not most-recent-first at %d: %v before %v", i, sigs[i-1].LastTime, s.LastTime)
		}
	}
	if total != 11 {
		t.Errorf("total count = %d, want 11 fixture events", total)
	}
	mix := byKey["codex|shell|PostToolUse|failed: mix test"]
	if mix.Count != 3 || mix.Sessions != 2 {
		t.Errorf("mix test signature = %+v, want Count 3 Sessions 2", mix)
	}

	// Session filter selects signatures; counts stay global.
	// This session holds one of the three mix test errors; the signature must
	// still report the global Count 3 / Sessions 2.
	sessionID := "019faf77-c87d-7b22-a292-75e4f40f25bf"
	_, filtered, filteredRaw := getErrors(t, ts, "?session="+url.QueryEscape(sessionID))
	if len(filtered) != 1 || filtered[0].Key != mix.Key || filtered[0].Count != 3 || filtered[0].Sessions != 2 {
		t.Errorf("filtered = %+v, want only the mix test signature with global Count 3 Sessions 2", filtered)
	}
	// With the session filter each signature carries that session's qualifying
	// event ids — only that session's, even though the signature spans two.
	if want := []string{"c5089b7d2673ba045c26b47175717f12"}; len(filtered) != 1 || !reflect.DeepEqual(filtered[0].Members, want) {
		t.Errorf("filtered members = %+v, want %v", filtered, want)
	}
	if !strings.Contains(filteredRaw, `"members"`) {
		t.Errorf("filtered /errors must carry members: %s", filteredRaw)
	}
}

func TestErrorsEndpointEmptyIsArray(t *testing.T) {
	ts := testServer(t, testConfig(t))
	for _, q := range []string{"", "?session=nope"} {
		status, sigs, raw := getErrors(t, ts, q)
		if status != http.StatusOK {
			t.Fatalf("%q status = %d, want 200", q, status)
		}
		if sigs == nil || len(sigs) != 0 || strings.TrimSpace(raw) != "[]" {
			t.Errorf("%q body = %s, want []", q, raw)
		}
	}
	// An unknown session on a populated engine is also [] rather than 404.
	cfg := testConfig(t)
	seedErrorFixture(t, cfg.SpoolDir)
	_, sigs, raw := getErrors(t, testServer(t, cfg), "?session=nope")
	if len(sigs) != 0 || strings.TrimSpace(raw) != "[]" {
		t.Errorf("unknown session body = %s, want []", raw)
	}
}

func TestSessionByIDTimelineView(t *testing.T) {
	cfg := testConfig(t)
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	base := time.Date(2026, 7, 3, 10, 0, 0, 0, time.UTC)
	for i, ev := range []event.Event{
		{ID: "t1", Time: base, Source: "claude-code", Agent: "claude", SessionID: "sv", CallID: "c1",
			Category: event.CategoryTool, Name: "PreToolUse", Summary: "Bash", Transport: "hook",
			CWD: "/work/proj", RepoID: "/work/proj/.git",
			Payload: map[string]any{"tool_name": "Bash", "phase": "start", "command": "ls"}},
		{ID: "t2", Time: base.Add(time.Minute), Source: "claude-code", SessionID: "sv", CallID: "c1",
			Category: event.CategoryTool, Name: "PostToolUse", Summary: "Bash done", Transport: "hook",
			CWD: "/work/proj", RepoID: "/work/proj/.git",
			Payload: map[string]any{"output": "secret-ish"}},
	} {
		if _, err := w.Append(ev); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	ts := testServer(t, cfg)
	get := func(q string) (int, []byte) {
		resp, err := http.Get(ts.URL + "/sessions/sv" + q)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var buf strings.Builder
		if _, err := bufio.NewReader(resp.Body).WriteTo(&buf); err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, []byte(buf.String())
	}

	fullStatus, full := get("")
	if fullStatus != http.StatusOK {
		t.Fatalf("full status = %d", fullStatus)
	}
	if st, explicit := get("?view=full"); st != http.StatusOK || string(explicit) != string(full) {
		t.Fatalf("view=full differs from absent view (status %d)", st)
	}
	status, body := get("?view=timeline")
	if status != http.StatusOK {
		t.Fatalf("timeline status = %d: %s", status, body)
	}
	var fullEvs, tlEvs []event.Event
	if err := json.Unmarshal(full, &fullEvs); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &tlEvs); err != nil {
		t.Fatal(err)
	}
	if len(tlEvs) != len(fullEvs) || len(tlEvs) != 2 {
		t.Fatalf("timeline len = %d, full len = %d", len(tlEvs), len(fullEvs))
	}
	for i := range tlEvs {
		if tlEvs[i].ID != fullEvs[i].ID {
			t.Fatalf("event %d id = %s, want %s", i, tlEvs[i].ID, fullEvs[i].ID)
		}
	}
	for _, banned := range []string{`"transport"`, `"cwd"`, `"repo_id"`, `"capture_time"`, "secret-ish", `"command"`} {
		if strings.Contains(string(body), banned) {
			t.Errorf("timeline body contains %s: %s", banned, body)
		}
	}
	if !strings.Contains(string(full), `"transport"`) {
		t.Errorf("full body lost transport; fixture is not exercising the projection")
	}
	if tlEvs[0].Payload["tool_name"] != "Bash" || tlEvs[1].Payload != nil {
		t.Errorf("timeline payloads wrong: %+v / %+v", tlEvs[0].Payload, tlEvs[1].Payload)
	}

	if st, msg := get("?view=bogus"); st != http.StatusBadRequest || !strings.Contains(string(msg), "timeline") {
		t.Errorf("view=bogus = %d %q, want 400 naming accepted values", st, msg)
	}
	// An invalid view is rejected before the lookup, so even an unknown
	// session answers 400, not 404.
	resp, err := http.Get(ts.URL + "/sessions/does-not-exist?view=bogus")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("bogus view on unknown session = %d, want 400", resp.StatusCode)
	}
	resp, err = http.Get(ts.URL + "/sessions/does-not-exist?view=timeline")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("timeline on unknown session = %d, want 404", resp.StatusCode)
	}
}
