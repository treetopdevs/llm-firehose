package daemon

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/testsupport/capturehistory"
)

// assertKeys fails unless every key in obj is in required∪optional and every
// required key is present. It reads raw JSON maps on purpose: decoding into the
// Go structs would hide a renamed tag.
func assertKeys(t *testing.T, where string, obj map[string]any, required, optional []string) {
	t.Helper()
	allowed := map[string]bool{}
	for _, k := range required {
		allowed[k] = true
	}
	for _, k := range optional {
		allowed[k] = true
	}
	for k := range obj {
		if !allowed[k] {
			t.Errorf("%s: unexpected key %q (frozen API: add it to docs/contracts.md and this test only if additive)", where, k)
		}
	}
	for _, k := range required {
		if _, ok := obj[k]; !ok {
			t.Errorf("%s: missing required key %q", where, k)
		}
	}
}

// optionalSeen records which optional keys appeared across a set of objects, so
// a renamed omitempty tag cannot hide behind a fixture that never populates it.
type optionalSeen map[string]bool

func (o optionalSeen) note(obj map[string]any, optional []string) {
	for _, k := range optional {
		if _, ok := obj[k]; ok {
			o[k] = true
		}
	}
}

// requireAll fails for every optional key that no seeded object populated.
func (o optionalSeen) requireAll(t *testing.T, where string, optional []string) {
	t.Helper()
	for _, k := range optional {
		if !o[k] {
			t.Errorf("%s: optional key %q never populated by the fixtures; seed it so a tag rename is caught", where, k)
		}
	}
}

func getRaw(t *testing.T, url string, out any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s status = %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		t.Fatalf("decode %s: %v", url, err)
	}
}

func TestWireShapeSessions(t *testing.T) {
	cfg := testConfig(t)
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	for _, ev := range []event.Event{
		{ID: "ws1", Time: base, Source: "claude-code", Agent: "claude", SessionID: "s1", Repo: "myrepo", CWD: "/work/proj",
			Category: event.CategorySession, Summary: "session started"},
		{ID: "ws3", Time: base.Add(30 * time.Second), Source: "claude-code", SessionID: "s1",
			Category: event.CategoryPrompt, Summary: "prompt", Payload: map[string]any{"prompt": "fix the login bug"}},
		{ID: "ws2", Time: base.Add(time.Minute), Source: "claude-code", SessionID: "s1",
			Category: event.CategoryTool, Severity: event.SeverityError, Summary: "tool failed"},
		{ID: "ws4", Time: base.Add(3 * time.Minute), Source: "codex", SessionID: "s4",
			Category: event.CategoryPermission, Name: "PermissionRequest", Summary: "approve rm -rf build"},
	} {
		if _, err := w.Append(ev); err != nil {
			t.Fatalf("seed append: %v", err)
		}
	}
	ts := testServer(t, cfg)

	var sessions []map[string]any
	getRaw(t, ts.URL+"/sessions", &sessions)
	if len(sessions) < 1 {
		t.Fatal("no sessions returned")
	}
	found := false
	sessionOpt := []string{"agent", "repo", "cwd", "state_reason", "has_error", "last_summary", "last_category", "title"}
	seen := optionalSeen{}
	for _, s := range sessions {
		assertKeys(t, "/sessions element", s,
			[]string{"id", "source", "first_time", "last_time", "events", "state", "state_since"}, sessionOpt)
		seen.note(s, sessionOpt)
		if s["id"] == "s1" {
			found = true
			for _, k := range []string{"agent", "repo", "last_summary"} {
				if _, ok := s[k]; !ok {
					t.Errorf("/sessions s1: expected optional key %q to be present", k)
				}
			}
		}
	}
	if !found {
		t.Fatal("session s1 not returned")
	}
	seen.requireAll(t, "/sessions", sessionOpt)
}

func TestWireShapeArtifactFiles(t *testing.T) {
	cfg := testConfig(t)
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	if _, err := w.Append(event.Event{ID: "wf1", Time: base, Source: "claude-code", SessionID: "s1", Category: event.CategoryFile,
		Payload: map[string]any{"file_path": "/repo/auth.go"}}); err != nil {
		t.Fatalf("seed append: %v", err)
	}
	ts := testServer(t, cfg)

	var files []map[string]any
	getRaw(t, ts.URL+"/artifacts/files", &files)
	if len(files) < 1 {
		t.Fatal("no file artifacts returned")
	}
	for _, f := range files {
		assertKeys(t, "/artifacts/files element", f,
			[]string{"path", "events", "sources", "first_time", "last_time"}, nil)
	}
}

func TestWireShapeAttention(t *testing.T) {
	cfg := testConfig(t)
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	now := time.Now().UTC()
	srcTime := now.Add(-time.Second)
	for _, ev := range []event.Event{
		{ID: "wa0", Time: now.Add(-time.Minute), Source: "codex", SessionID: "s2", Agent: "codex", Repo: "myrepo", CWD: "/work/proj",
			RepoID: "/work/proj/.git", WorktreeID: "/work/proj", Category: event.CategoryPrompt, Summary: "hello",
			Payload: map[string]any{"message": "fix the login bug"}},
		{ID: "req1", Time: now, SourceTime: &srcTime, Source: "codex", SessionID: "s2", Category: event.CategoryPermission, Name: "PermissionRequest"},
		// A second session on the JJ identity family, so jj_* keys are populated.
		{ID: "wa1", Time: now.Add(-time.Minute), Source: "codex", SessionID: "s3", JJRepoID: "jj:/work/jjrepo", JJWorkspaceID: "jj:/work/jjws",
			Category: event.CategoryPrompt, Summary: "hi"},
		// Uncertain: a permission-class notification that is not a recognized request, newer than any signal.
		{ID: "unc1", Time: now, Source: "codex", SessionID: "s3", Category: event.CategoryPermission, Name: "Notification"},
		// A capture warning and an unreadable-record gap.
		{ID: "warn1", Time: now, Source: "claude-code", Category: event.CategoryMeta, Severity: event.SeverityWarn, Name: "hook-failed", Summary: "hook failed"},
		{ID: "gap1", Time: now, Source: "firehose", Category: event.CategoryMeta, Name: "parse-error", Summary: "unreadable record"},
	} {
		if _, err := w.Append(ev); err != nil {
			t.Fatalf("seed append: %v", err)
		}
	}
	ts := testServer(t, cfg)

	var snap map[string]any
	getRaw(t, ts.URL+"/attention", &snap)
	assertKeys(t, "/attention", snap, []string{"gaps", "sessions", "warnings"}, nil)

	evReq := []string{"source", "event_id", "kind", "summary", "time", "observed_at"}
	evOpt := []string{"episode_id", "source_time"}
	sessOpt := []string{"agent", "repo", "cwd", "jj_repo_id", "jj_workspace_id", "repo_id", "worktree_id", "pending", "uncertainty", "title"}
	sessSeen, evSeen := optionalSeen{}, optionalSeen{}
	asMap := func(where string, v any) map[string]any {
		m, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("%s: not an object: %T", where, v)
		}
		return m
	}

	sessions, _ := snap["sessions"].([]any)
	if len(sessions) < 1 {
		t.Fatal("no attention sessions returned")
	}
	pendingSeen := false
	for _, raw := range sessions {
		s := asMap("session", raw)
		assertKeys(t, "/attention session", s,
			[]string{"last_observed_at", "id", "source", "events", "state", "last"},
			sessOpt)
		sessSeen.note(s, sessOpt)
		last := asMap("last", s["last"])
		assertKeys(t, "/attention session.last", last, evReq, evOpt)
		evSeen.note(last, evOpt)
		if p, ok := s["pending"]; ok {
			pendingSeen = true
			pm := asMap("pending", p)
			assertKeys(t, "/attention session.pending", pm, evReq, evOpt)
			evSeen.note(pm, evOpt)
		}
	}
	if !pendingSeen {
		t.Fatal("no attention session has a pending key")
	}
	sessSeen.requireAll(t, "/attention session", sessOpt)
	warnings, _ := snap["warnings"].([]any)
	if len(warnings) < 1 {
		t.Fatal("no attention warnings returned")
	}
	for _, raw := range warnings {
		wm := asMap("warning", raw)
		assertKeys(t, "/attention warning", wm, evReq, evOpt)
		evSeen.note(wm, evOpt)
	}
	evSeen.requireAll(t, "/attention evidence", evOpt)
	gaps, _ := snap["gaps"].([]any)
	if len(gaps) < 1 {
		t.Fatal("no attention gaps returned")
	}
	for _, raw := range gaps {
		assertKeys(t, "/attention gap", asMap("gap", raw), []string{"source", "time", "summary"}, nil)
	}
}
