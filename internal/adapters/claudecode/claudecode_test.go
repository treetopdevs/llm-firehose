package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agentfirehose/internal/event"
)

func parse(t *testing.T, raw string) event.Event {
	t.Helper()
	ev, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if ev.Source != "claude-code" {
		t.Errorf("source = %q, want claude-code", ev.Source)
	}
	if ev.Time.IsZero() {
		t.Error("time not set")
	}
	if ev.CaptureTime == nil || !ev.Time.Equal(*ev.CaptureTime) {
		t.Errorf("capture_time = %v, want the locally assigned event time %v", ev.CaptureTime, ev.Time)
	}
	if ev.SourceTime != nil {
		t.Errorf("source_time = %v, want absent because Claude hooks supply no timestamp", ev.SourceTime)
	}
	return ev
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func envelopeField(t *testing.T, ev event.Event, name string) any {
	t.Helper()
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	return fields[name]
}

func safeDetails(t *testing.T, ev event.Event) string {
	t.Helper()
	data, err := json.Marshal(struct {
		Summary string         `json:"summary"`
		Payload map[string]any `json:"payload"`
	}{ev.Summary, ev.Payload})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestRealUserPromptFixturePreservesCorrelationWithoutBody(t *testing.T) {
	ev := parse(t, string(fixture(t, "user_prompt_submit")))
	if ev.Category != event.CategoryPrompt {
		t.Errorf("category = %q, want prompt", ev.Category)
	}
	if ev.SessionID != "claude-fixture-session" ||
		ev.CWD != "/tmp/agent-firehose-hook-fixture/work" {
		t.Errorf("context lost: %+v", ev)
	}
	if got := envelopeField(t, ev, "prompt_id"); got != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("prompt_id = %v", got)
	}
	if got := safeDetails(t, ev); strings.Contains(got, "sanitized prompt body") ||
		strings.Contains(got, "transcript.jsonl") {
		t.Errorf("safe prompt details contain a body or transcript path: %s", got)
	}
}

func TestRealToolFixturesPreserveCorrelationTimingAndOutcomeWithoutBodies(t *testing.T) {
	pre := parse(t, string(fixture(t, "pre_tool_use")))
	post := parse(t, string(fixture(t, "post_tool_use")))

	for _, ev := range []event.Event{pre, post} {
		if ev.CallID != "toolu_fixture_01" {
			t.Errorf("%s call_id = %q", ev.Name, ev.CallID)
		}
		if got := envelopeField(t, ev, "prompt_id"); got != "550e8400-e29b-41d4-a716-446655440000" {
			t.Errorf("%s prompt_id = %v", ev.Name, got)
		}
		if got := safeDetails(t, ev); strings.Contains(got, "sanitized tool input") ||
			strings.Contains(got, "sanitized tool output") ||
			strings.Contains(got, "transcript.jsonl") {
			t.Errorf("%s safe details contain sensitive hook fields: %s", ev.Name, got)
		}
	}
	if pre.Payload["phase"] != "start" || pre.Payload["status"] != "started" {
		t.Errorf("pre outcome = %+v", pre.Payload)
	}
	if post.Payload["phase"] != "end" || post.Payload["status"] != "success" {
		t.Errorf("post outcome = %+v", post.Payload)
	}
	if post.Payload["interrupted"] != false {
		t.Errorf("post interrupted = %#v", post.Payload["interrupted"])
	}
	if post.Payload["duration_ms"] != int64(4652) {
		t.Errorf("duration_ms = %#v", post.Payload["duration_ms"])
	}
}

func TestRealToolFailureKeepsOutcomeNotErrorBody(t *testing.T) {
	ev := parse(t, string(fixture(t, "post_tool_use_failure")))
	if ev.Name != "PostToolUseFailure:Read" || ev.Severity != event.SeverityError {
		t.Errorf("failure envelope = %+v", ev)
	}
	if ev.CallID != "toolu_fixture_failure_01" ||
		ev.Payload["phase"] != "end" || ev.Payload["status"] != "error" ||
		ev.Payload["interrupted"] != false ||
		ev.Payload["duration_ms"] != int64(3) {
		t.Errorf("failure outcome = %+v", ev.Payload)
	}
	if _, ok := ev.Payload["error_class"]; ok {
		t.Errorf("free-form tool error must not be promoted to a class: %+v", ev.Payload)
	}
	if got := safeDetails(t, ev); strings.Contains(got, "sanitized tool error") ||
		strings.Contains(got, "sanitized tool input") {
		t.Errorf("failure details contain an error or tool body: %s", got)
	}
}

func TestRealStopFailureKeepsOnlyOfficialErrorClass(t *testing.T) {
	ev := parse(t, string(fixture(t, "stop_failure")))
	if ev.Category != event.CategoryError || ev.Severity != event.SeverityError ||
		ev.Payload["status"] != "error" || ev.Payload["error_class"] != "model_not_found" {
		t.Errorf("stop failure = %+v", ev)
	}
	if got := safeDetails(t, ev); strings.Contains(got, "sanitized error") {
		t.Errorf("stop failure contains error details or rendered message: %s", got)
	}
}

func TestObservableGitIdentityIsAttachedBeforePersistence(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "project")
	cwd := filepath.Join(repo, "subdir")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	ev := parse(t, `{"hook_event_name":"SessionStart","session_id":"s1","cwd":"`+cwd+`"}`)
	wantRepo, _ := filepath.EvalSymlinks(filepath.Join(repo, ".git"))
	wantWorktree, _ := filepath.EvalSymlinks(repo)
	if ev.RepoID != wantRepo || ev.WorktreeID != wantWorktree {
		t.Errorf("identity = repo %q worktree %q, want repo %q worktree %q",
			ev.RepoID, ev.WorktreeID, wantRepo, wantWorktree)
	}
}

func TestPostToolUseBashIsShell(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"PostToolUse","session_id":"s1","cwd":"/repo","tool_name":"Bash","tool_input":{"command":"go test ./..."},"tool_response":{"stdout":"ok"}}`)
	if ev.Category != event.CategoryShell {
		t.Errorf("category = %q, want shell", ev.Category)
	}
	if strings.Contains(ev.Summary, "go test ./...") {
		t.Errorf("summary contains command input: %q", ev.Summary)
	}
	if ev.Name != "PostToolUse:Bash" {
		t.Errorf("name = %q", ev.Name)
	}
}

func TestPreToolUseEditIsFile(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Edit","tool_input":{"file_path":"/repo/main.go"}}`)
	if ev.Category != event.CategoryFile {
		t.Errorf("category = %q, want file", ev.Category)
	}
	if strings.Contains(ev.Summary, "main.go") {
		t.Errorf("summary contains file input: %q", ev.Summary)
	}
}

func TestGenericToolUse(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"WebSearch","tool_input":{"query":"golang"}}`)
	if ev.Category != event.CategoryTool {
		t.Errorf("category = %q, want tool", ev.Category)
	}
}

func TestSessionLifecycle(t *testing.T) {
	start := parse(t, `{"hook_event_name":"SessionStart","session_id":"s1","source":"startup"}`)
	if start.Category != event.CategorySession || start.Severity != event.SeverityNotice {
		t.Errorf("SessionStart => %q/%q, want session/notice", start.Category, start.Severity)
	}
	end := parse(t, `{"hook_event_name":"SessionEnd","session_id":"s1","reason":"exit"}`)
	if end.Category != event.CategorySession {
		t.Errorf("SessionEnd category = %q", end.Category)
	}
	stop := parse(t, `{"hook_event_name":"Stop","session_id":"s1"}`)
	if stop.Category != event.CategorySession {
		t.Errorf("Stop category = %q", stop.Category)
	}
}

func TestNotificationIsPermission(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"Notification","session_id":"s1","message":"Claude needs your permission to use Bash"}`)
	if ev.Category != event.CategoryPermission {
		t.Errorf("category = %q, want permission", ev.Category)
	}
	if ev.Severity != event.SeverityNotice {
		t.Errorf("severity = %q, want notice", ev.Severity)
	}
	if strings.Contains(safeDetails(t, ev), "permission to use Bash") {
		t.Errorf("notification message body was retained: %+v", ev)
	}
}

func TestUnknownHookIsMetaWarn(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"SomethingNew","session_id":"s1"}`)
	if ev.Category != event.CategoryMeta || ev.Severity != event.SeverityWarn {
		t.Errorf("unknown hook => %q/%q, want meta/warn", ev.Category, ev.Severity)
	}
}

// Cursor hooks use camelCase event names and tool_output (not Claude Code's
// PascalCase + tool_response). Captured from a live Cursor agent session.
func TestCursorPostToolUseCamelCase(t *testing.T) {
	ev := parse(t, `{"conversation_id":"e2bc0b89-8121-49b5-98f9-c497526a3c45","tool_name":"Read","tool_input":{"file_path":"/Users/nicholas/develop/llm-firehose/terminals/1937.txt"},"tool_output":"{\"content_length\":44896}","session_id":"e2bc0b89-8121-49b5-98f9-c497526a3c45","hook_event_name":"postToolUse","cursor_version":"3.12.29","workspace_roots":["/Users/nicholas/develop/llm-firehose"]}`)
	if ev.Category != event.CategoryTool {
		t.Errorf("category = %q, want tool", ev.Category)
	}
	if ev.Severity != event.SeverityInfo {
		t.Errorf("severity = %q, want info (not unrecognized warn)", ev.Severity)
	}
	if ev.Name != "PostToolUse:Read" {
		t.Errorf("name = %q, want PostToolUse:Read", ev.Name)
	}
	if strings.Contains(ev.Summary, "unrecognized") {
		t.Errorf("summary still unrecognized: %q", ev.Summary)
	}
	if _, ok := ev.Payload["tool_response"]; ok {
		t.Error("tool_output must not map into the safe payload")
	}
}

func TestCursorPreToolUseShellIsShell(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"preToolUse","session_id":"s1","tool_name":"Shell","tool_input":{"command":"go test ./..."}}`)
	if ev.Category != event.CategoryShell {
		t.Errorf("category = %q, want shell", ev.Category)
	}
	if ev.Name != "PreToolUse:Shell" {
		t.Errorf("name = %q, want PreToolUse:Shell", ev.Name)
	}
	if strings.Contains(ev.Summary, "go test ./...") {
		t.Errorf("summary contains command input: %q", ev.Summary)
	}
}

func TestInvalidJSONErrors(t *testing.T) {
	if _, err := Parse([]byte("not json")); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestRawPreserved(t *testing.T) {
	raw := `{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"hi"}`
	ev := parse(t, raw)
	if ev.Raw != raw {
		t.Errorf("raw not preserved: %q", ev.Raw)
	}
}
