package privacy

import (
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func sample() event.Event {
	return event.Event{
		ID:       "ev-1",
		Time:     time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC),
		Source:   "claude-code",
		Category: event.CategoryPrompt,
		Summary:  "user prompt (1024 chars)",
		Payload: map[string]any{
			"prompt": strings.Repeat("secret ", 200), // 1400 chars
			"count":  3,
		},
		Raw: `{"prompt":"..."}`,
	}
}

func TestParseMode(t *testing.T) {
	for _, s := range []string{"minimal", "balanced", "full"} {
		if _, err := ParseMode(s); err != nil {
			t.Errorf("ParseMode(%q) unexpected error: %v", s, err)
		}
	}
	if _, err := ParseMode("paranoid"); err == nil {
		t.Error("ParseMode(paranoid) should fail")
	}
}

func TestRedactFullKeepsEverything(t *testing.T) {
	ev := Redact(sample(), ModeFull)
	if ev.Raw == "" {
		t.Error("full mode dropped Raw")
	}
	if got := ev.Payload["prompt"].(string); len(got) != 1400 {
		t.Errorf("full mode altered payload, len=%d", len(got))
	}
}

func TestRedactBalancedTruncatesAndDropsRaw(t *testing.T) {
	ev := Redact(sample(), ModeBalanced)
	if ev.Raw != "" {
		t.Error("balanced mode kept Raw")
	}
	got, ok := ev.Payload["prompt"].(string)
	if !ok {
		t.Fatalf("prompt not a string: %T", ev.Payload["prompt"])
	}
	if len([]rune(got)) > 241 { // 240 + ellipsis
		t.Errorf("balanced mode did not truncate: len=%d", len([]rune(got)))
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncated value should end with ellipsis, got %q", got[len(got)-10:])
	}
	if ev.Payload["count"] != 3 {
		t.Errorf("non-string payload value altered: %v", ev.Payload["count"])
	}
	// original event must not be mutated
	orig := sample()
	if len(orig.Payload["prompt"].(string)) != 1400 {
		t.Error("source event mutated")
	}
}

func TestRedactMinimalDigestsPayload(t *testing.T) {
	ev := Redact(sample(), ModeMinimal)
	if ev.Raw != "" {
		t.Error("minimal mode kept Raw")
	}
	if ev.Summary == "" {
		t.Error("minimal mode should keep summary")
	}
	d, ok := ev.Payload["prompt"].(map[string]any)
	if !ok {
		t.Fatalf("prompt not digested: %#v", ev.Payload["prompt"])
	}
	if d["len"] != 1400 {
		t.Errorf("digest len = %v, want 1400", d["len"])
	}
	sha, _ := d["sha256"].(string)
	if len(sha) != 64 {
		t.Errorf("digest sha256 = %q", sha)
	}
}

func TestRedactBalancedDoesNotMutateOriginal(t *testing.T) {
	orig := sample()
	_ = Redact(orig, ModeBalanced)
	if len(orig.Payload["prompt"].(string)) != 1400 {
		t.Error("Redact mutated the input event's payload")
	}
}

func TestRedactBalancedTruncatesNestedStringsWithoutMutatingOriginal(t *testing.T) {
	secret := strings.Repeat("nested-secret ", 40)
	orig := sample()
	orig.Payload = map[string]any{
		"tool_input": map[string]any{
			"command": secret,
			"args": []any{
				map[string]any{"response": secret},
			},
		},
	}

	redacted := Redact(orig, ModeBalanced)
	toolInput := redacted.Payload["tool_input"].(map[string]any)
	if got := toolInput["command"].(string); len([]rune(got)) != 241 || !strings.HasSuffix(got, "…") {
		t.Fatalf("nested command was not bounded: %q", got)
	}
	args := toolInput["args"].([]any)
	if got := args[0].(map[string]any)["response"].(string); len([]rune(got)) != 241 || !strings.HasSuffix(got, "…") {
		t.Fatalf("nested response was not bounded: %q", got)
	}

	originalToolInput := orig.Payload["tool_input"].(map[string]any)
	if got := originalToolInput["command"].(string); got != secret {
		t.Fatal("Redact mutated the original nested map")
	}
	originalArgs := originalToolInput["args"].([]any)
	if got := originalArgs[0].(map[string]any)["response"].(string); got != secret {
		t.Fatal("Redact mutated the original nested slice")
	}
}

func TestRedactDigestsPathIdentityOutsideFullMode(t *testing.T) {
	ev := sample()
	ev.CWD = "/Users/me/project/nested"
	ev.RepoID = "/Users/me/project/.git"
	ev.WorktreeID = "/Users/me/project"

	for _, mode := range []Mode{ModeMinimal, ModeBalanced} {
		got := Redact(ev, mode)
		for _, path := range []string{got.CWD, got.RepoID, got.WorktreeID} {
			if path == "" {
				t.Fatalf("%s cleared a path identity field", mode)
			}
			if strings.Contains(path, "/") || strings.Contains(path, "\\") {
				t.Fatalf("%s persisted absolute path %q", mode, path)
			}
			if len(path) != 64 {
				t.Fatalf("%s path digest length = %d, want 64: %q", mode, len(path), path)
			}
		}
		if got.CWD == ev.CWD || got.RepoID == ev.RepoID || got.WorktreeID == ev.WorktreeID {
			t.Fatalf("%s left path identity unchanged", mode)
		}
	}

	full := Redact(ev, ModeFull)
	if full.CWD != ev.CWD || full.RepoID != ev.RepoID || full.WorktreeID != ev.WorktreeID {
		t.Fatalf("full mode altered path identity: %+v", full)
	}
}
