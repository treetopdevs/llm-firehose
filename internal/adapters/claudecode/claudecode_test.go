package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"agentfirehose/internal/event"
)

func parse(t *testing.T, raw string) event.Event {
	t.Helper()
	parsed, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if parsed == nil {
		t.Fatal("Parse unexpectedly skipped event")
	}
	ev := *parsed
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

func TestUserPromptSubmit(t *testing.T) {
	raw := fixture(t, "user_prompt_submit.json")
	ev := parse(t, raw)
	if ev.Category != event.CategoryPrompt {
		t.Errorf("category = %q, want prompt", ev.Category)
	}
	if ev.SessionID != "session-fixture" || ev.CWD != "/tmp/agent-firehose-fixture/work" {
		t.Errorf("context lost: %+v", ev)
	}
	if ev.PromptID != "prompt-fixture" || ev.Transport != "hook" {
		t.Errorf("correlation lost: %+v", ev)
	}
	if strings.Contains(ev.Summary, "SECRET-PROMPT-MARKER") {
		t.Errorf("summary leaked prompt: %q", ev.Summary)
	}
}

func TestRealUserPromptFixturePreservesCorrelationWithoutBody(t *testing.T) {
	ev := parse(t, fixture(t, "user_prompt_submit_bypass.json"))
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
	pre := parse(t, fixture(t, "pre_tool_use.json"))
	post := parse(t, fixture(t, "post_tool_use.json"))

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
	if post.Payload["duration_ms"] != float64(4652) {
		t.Errorf("duration_ms = %#v", post.Payload["duration_ms"])
	}
}

// A single failing tool stays warn-level, matching the opencode and codex
// adapters: it must not flip the session's error overlay, which is reserved
// for session-level failures such as StopFailure.
func TestRealToolFailureKeepsOutcomeNotErrorBody(t *testing.T) {
	ev := parse(t, fixture(t, "post_tool_use_failure.json"))
	if ev.Name != "PostToolUseFailure:Read" || ev.Severity != event.SeverityWarn {
		t.Errorf("failure envelope = %+v", ev)
	}
	if ev.CallID != "toolu_fixture_failure_01" ||
		ev.Payload["phase"] != "end" || ev.Payload["status"] != "error" ||
		ev.Payload["interrupted"] != false ||
		ev.Payload["duration_ms"] != float64(3) {
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
	ev := parse(t, fixture(t, "stop_failure.json"))
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
	ev := parse(t, fixture(t, "post_tool_use_bash.json"))
	if ev.Category != event.CategoryShell {
		t.Errorf("category = %q, want shell", ev.Category)
	}
	if strings.Contains(ev.Summary, "SECRET-TOOL-INPUT-MARKER") {
		t.Errorf("summary contains command input: %q", ev.Summary)
	}
	if ev.Name != "PostToolUse:Bash" {
		t.Errorf("name = %q", ev.Name)
	}
	if ev.CallID != "tool-fixture" || ev.PromptID != "prompt-fixture" {
		t.Errorf("tool correlation lost: %+v", ev)
	}
	if ev.Payload["duration_ms"] != float64(17) || ev.Payload["status"] != "success" {
		t.Errorf("safe tool metadata lost: %+v", ev.Payload)
	}
}

func TestPreToolUseEditIsFile(t *testing.T) {
	ev := parse(t, fixture(t, "pre_tool_use_edit.json"))
	if ev.Category != event.CategoryFile {
		t.Errorf("category = %q, want file", ev.Category)
	}
	if !strings.Contains(ev.Summary, "main.go") {
		t.Errorf("summary lost the file base name: %q", ev.Summary)
	}
	// The full path must survive into the payload: index.EventFilePaths feeds
	// the artifacts/files view from payload.file_path.
	if ev.Payload["file_path"] != "/tmp/agent-firehose-fixture/work/main.go" {
		t.Errorf("file_path lost from payload: %+v", ev.Payload)
	}
	if strings.Contains(safeDetails(t, ev), "SECRET-") {
		t.Errorf("file event leaked tool body: %s", safeDetails(t, ev))
	}
}

func TestFixturePayloadUsesSafeAllowlist(t *testing.T) {
	for _, name := range []string{
		"user_prompt_submit.json",
		"pre_tool_use_bash.json",
		"post_tool_use_bash.json",
		"pre_tool_use_edit.json",
		"notification.json",
		"stop.json",
		"subagent_stop.json",
	} {
		t.Run(name, func(t *testing.T) {
			ev := parse(t, fixture(t, name))
			safe, err := json.Marshal(struct {
				Summary string         `json:"summary"`
				Payload map[string]any `json:"payload"`
			}{ev.Summary, ev.Payload})
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(safe), "SECRET-") {
				t.Errorf("safe fields leaked fixture content: %s", safe)
			}
			if !strings.Contains(ev.Raw, "SECRET-") {
				t.Errorf("fixture no longer proves full-mode raw retention: %s", ev.Raw)
			}
		})
	}
}

func TestRealFixtureFamilies(t *testing.T) {
	tests := []struct {
		file     string
		category event.Category
		name     string
	}{
		{"session_start.json", event.CategorySession, "SessionStart"},
		{"session_end.json", event.CategorySession, "SessionEnd"},
		{"notification.json", event.CategoryPermission, "Notification"},
		{"stop.json", event.CategorySession, "Stop"},
		{"subagent_stop.json", event.CategorySession, "SubagentStop"},
	}
	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			ev := parse(t, fixture(t, tt.file))
			if ev.Category != tt.category || ev.Name != tt.name {
				t.Errorf("got %s/%s, want %s/%s", ev.Category, ev.Name, tt.category, tt.name)
			}
		})
	}
}

func TestStopCarriesCompletedOutcome(t *testing.T) {
	ev := parse(t, fixture(t, "stop.json"))
	if ev.Payload["phase"] != "end" || ev.Payload["status"] != "completed" {
		t.Errorf("stop outcome = %+v", ev.Payload)
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
	ev := parse(t, fixture(t, "notification.json"))
	if ev.Category != event.CategoryPermission {
		t.Errorf("category = %q, want permission", ev.Category)
	}
	if ev.Severity != event.SeverityNotice {
		t.Errorf("severity = %q, want notice", ev.Severity)
	}
	if strings.Contains(safeDetails(t, ev), "SECRET-NOTIFICATION-MARKER") {
		t.Errorf("notification message body was retained: %+v", ev)
	}
}

func TestNotificationWithoutTypeStillNeedsPermissionAttention(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"notification","session_id":"s1"}`)
	if ev.Category != event.CategoryPermission {
		t.Errorf("category = %q, want permission-safe default", ev.Category)
	}
}

func TestFilteredHooksAreSkipped(t *testing.T) {
	for _, name := range Manifest.Filtered {
		t.Run(name, func(t *testing.T) {
			ev, err := Parse([]byte(`{"hook_event_name":"` + name + `","session_id":"s1"}`))
			if err != nil {
				t.Fatal(err)
			}
			if ev != nil {
				t.Fatalf("filtered hook produced event: %+v", ev)
			}
		})
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
		t.Error("tool_output must remain only in full-mode raw input")
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
		t.Errorf("summary leaked command, got %q", ev.Summary)
	}
}

func TestCursorPostToolUseFailureIsWarn(t *testing.T) {
	ev := parse(t, `{"hook_event_name":"postToolUseFailure","session_id":"s1","tool_name":"Shell","tool_input":{"command":"false"}}`)
	if ev.Name != "PostToolUseFailure:Shell" || ev.Severity != event.SeverityWarn {
		t.Fatalf("Cursor failure = %s/%s, want PostToolUseFailure:Shell/warn", ev.Name, ev.Severity)
	}
	if ev.Payload["status"] != "error" {
		t.Fatalf("failure status = %v, want error", ev.Payload["status"])
	}
}

func TestInvalidJSONErrors(t *testing.T) {
	if _, err := Parse([]byte("not json")); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestManifestIsValid(t *testing.T) {
	if err := Manifest.Validate(); err != nil {
		t.Fatalf("manifest: %v", err)
	}
	// Every mapped hook except PreCompact is fixture-proven; PreCompact keeps
	// its pre-merge mapping and awaits a real capture (see testdata/README.md).
	want := []string{
		"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
		"PostToolUseFailure", "StopFailure", "PreCompact",
		"Notification", "SubagentStop", "Stop", "SessionEnd",
	}
	if !reflect.DeepEqual(Manifest.Mapped, want) {
		t.Fatalf("mapped hooks = %v, want %v", Manifest.Mapped, want)
	}
}

func TestRawPreserved(t *testing.T) {
	raw := `{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"hi"}`
	ev := parse(t, raw)
	if ev.Raw != raw {
		t.Errorf("raw not preserved: %q", ev.Raw)
	}
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return strings.TrimSpace(string(data))
}
