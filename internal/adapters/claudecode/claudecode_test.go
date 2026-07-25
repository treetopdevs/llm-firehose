package claudecode

import (
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

func TestUserPromptSubmit(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"/repo","prompt":"fix the login bug"}`)
	if ev.Category != event.CategoryPrompt {
		t.Errorf("category = %q, want prompt", ev.Category)
	}
	if ev.SessionID != "s1" || ev.CWD != "/repo" {
		t.Errorf("context lost: %+v", ev)
	}
	if !strings.Contains(ev.Summary, "fix the login bug") {
		t.Errorf("summary should quote prompt, got %q", ev.Summary)
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
	if !strings.Contains(ev.Summary, "go test ./...") {
		t.Errorf("summary should show command, got %q", ev.Summary)
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
	if !strings.Contains(ev.Summary, "main.go") {
		t.Errorf("summary should show file, got %q", ev.Summary)
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
	if ev.Payload["tool_response"] == nil {
		t.Error("tool_output should map into payload tool_response")
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
	if !strings.Contains(ev.Summary, "go test ./...") {
		t.Errorf("summary should show command, got %q", ev.Summary)
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
