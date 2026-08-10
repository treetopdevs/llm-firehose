package codexhook

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestRealLifecycleAndPromptFixtures(t *testing.T) {
	start, err := Parse(fixture(t, "session_start"))
	if err != nil || start.Name != "SessionStart" || start.Category != event.CategorySession {
		t.Fatalf("SessionStart = %+v, %v", start, err)
	}
	if start.Source != "codex" || start.Payload["transport"] != "hook" {
		t.Fatalf("transport = %+v", start)
	}
	if start.CaptureTime == nil || !start.Time.Equal(*start.CaptureTime) {
		t.Errorf("capture_time = %v, want hook observation time %v", start.CaptureTime, start.Time)
	}
	if start.SourceTime != nil {
		t.Errorf("source_time = %v, want absent because the native hook supplies no timestamp", start.SourceTime)
	}

	prompt, err := Parse(fixture(t, "user_prompt_submit"))
	if err != nil || prompt.Category != event.CategoryPrompt || prompt.TurnID != "019f9488-turn" {
		t.Fatalf("UserPromptSubmit = %+v, %v", prompt, err)
	}
	if prompt.Payload["message"] != "Use the shell tool to run pwd, then report the path." {
		t.Fatalf("prompt payload = %+v", prompt.Payload)
	}
}

func TestRealToolFixturesCorrelateAndFlattenOutput(t *testing.T) {
	pre, err := Parse(fixture(t, "pre_tool_use"))
	if err != nil {
		t.Fatal(err)
	}
	post, err := Parse(fixture(t, "post_tool_use"))
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range []event.Event{pre, post} {
		if (ev.Name != "PreToolUse" && ev.Name != "PostToolUse") ||
			ev.Category != event.CategoryShell || ev.CallID != "call_xYz123" ||
			ev.TurnID != "019f9488-turn" || ev.Payload["tool_name"] != "exec_command" {
			t.Fatalf("tool event = %+v", ev)
		}
	}
	if pre.Payload["phase"] != "start" || post.Payload["phase"] != "end" {
		t.Fatalf("phases: pre=%+v post=%+v", pre.Payload, post.Payload)
	}
	if output, ok := post.Payload["output"].(string); !ok || !strings.Contains(output, "Process exited") {
		t.Fatalf("top-level output = %#v", post.Payload["output"])
	}
}

func TestDocumentedHookNamesUseCommonEnvelopeAndFailureSeverity(t *testing.T) {
	// Codex does not deterministically emit the remaining lifecycle hooks in a
	// short disposable task. Validate only their documented common envelope
	// here; event-specific payload mapping is covered exclusively by the real
	// captured fixtures above and in testdata/README.md.
	tests := []struct {
		name string
		cat  event.Category
	}{
		{"SessionEnd", event.CategorySession},
		{"PermissionRequest", event.CategoryPermission},
		{"PreCompact", event.CategoryMeta},
		{"PostCompact", event.CategoryMeta},
		{"SubagentStart", event.CategorySession},
		{"SubagentStop", event.CategorySession},
	}
	for _, tt := range tests {
		raw := []byte(`{"session_id":"s","turn_id":"t","hook_event_name":"` + tt.name + `","cwd":"/repo"}`)
		ev, err := Parse(raw)
		if err != nil || ev.Name != tt.name || ev.Category != tt.cat {
			t.Errorf("%s = %+v, %v", tt.name, ev, err)
		}
	}

	raw := []byte(`{"session_id":"s","hook_event_name":"PostToolUse","tool_name":"apply_patch","tool_use_id":"c","tool_response":{"success":false,"error":"patch rejected"}}`)
	ev, err := Parse(raw)
	if err != nil || ev.Category != event.CategoryFile || ev.Severity != event.SeverityError {
		t.Fatalf("failed patch = %+v, %v", ev, err)
	}
}

func TestRealStopFixturePreservesSafeActivity(t *testing.T) {
	ev, err := Parse(fixture(t, "stop"))
	if err != nil || ev.Name != "Stop" || ev.TurnID != "019f9488-turn" {
		t.Fatalf("Stop = %+v, %v", ev, err)
	}
	if output, ok := ev.Payload["output"].(string); !ok || !strings.Contains(output, "working directory") {
		t.Fatalf("Stop output = %#v", ev.Payload["output"])
	}
}

func TestNonzeroProcessExitCodeIsFailed(t *testing.T) {
	raw := []byte(`{"session_id":"s","hook_event_name":"PostToolUse","tool_name":"exec_command","tool_use_id":"c","tool_response":"Process exited with code 3\nFinal output:\nboom\n"}`)
	ev, err := Parse(raw)
	if err != nil || ev.Severity != event.SeverityError {
		t.Fatalf("exit 3 = %+v, %v", ev, err)
	}
}

func TestOutputIsTopLevelForFrozenPrivacyModes(t *testing.T) {
	raw := []byte(`{"session_id":"s","hook_event_name":"PostToolUse","tool_name":"exec_command","tool_response":"` +
		strings.Repeat("x", 500) + `"}`)
	ev, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	balanced := privacy.Redact(ev, privacy.ModeBalanced)
	output, ok := balanced.Payload["output"].(string)
	if !ok || len([]rune(output)) != 241 {
		t.Fatalf("balanced output = %#v", balanced.Payload["output"])
	}
	minimal := privacy.Redact(ev, privacy.ModeMinimal)
	if _, ok := minimal.Payload["output"].(map[string]any); !ok {
		t.Fatalf("minimal output = %#v", minimal.Payload["output"])
	}
}
