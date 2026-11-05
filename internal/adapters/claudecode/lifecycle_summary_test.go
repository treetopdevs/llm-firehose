package claudecode

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"agentfirehose/internal/event"
)

// lifecycleHook derives a hook payload from the real captured Bash fixtures by
// replacing only hook_event_name and tool_input.command.
func lifecycleHook(t *testing.T, base, hook, command string) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(fixture(t, base)), &m); err != nil {
		t.Fatal(err)
	}
	m["hook_event_name"] = hook
	in := m["tool_input"].(map[string]any)
	in["command"] = command
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestNonLifecycleSummariesAreByteIdentical(t *testing.T) {
	cases := []struct {
		file, summary, name string
		cat                 event.Category
		sev                 event.Severity
	}{
		{"post_tool_use_bash.json", "ran shell tool", "PostToolUse:Bash", event.CategoryShell, event.SeverityInfo},
		{"pre_tool_use_bash.json", "will run shell tool", "PreToolUse:Bash", event.CategoryShell, event.SeverityInfo},
		{"pre_tool_use.json", "will run shell tool", "PreToolUse:Bash", event.CategoryShell, event.SeverityInfo},
		{"post_tool_use.json", "ran shell tool", "PostToolUse:Bash", event.CategoryShell, event.SeverityInfo},
		{"post_tool_use_failure.json", "failed tool Read", "PostToolUseFailure:Read", event.CategoryTool, event.SeverityWarn},
		{"pre_tool_use_edit.json", "will run Edit on main.go", "PreToolUse:Edit", event.CategoryFile, event.SeverityInfo},
	}
	for _, c := range cases {
		ev := parse(t, fixture(t, c.file))
		if ev.Summary != c.summary || ev.Name != c.name || ev.Category != c.cat || ev.Severity != c.sev {
			t.Errorf("%s: got %q %q %q %q", c.file, ev.Summary, ev.Name, ev.Category, ev.Severity)
		}
	}
	// A non-shell tool whose input mentions git push keeps its non-shell shape.
	var m map[string]any
	_ = json.Unmarshal([]byte(fixture(t, "post_tool_use_bash.json")), &m)
	m["tool_name"] = "Read"
	m["tool_input"].(map[string]any)["command"] = "git push"
	raw, _ := json.Marshal(m)
	ev := parse(t, string(raw))
	if ev.Summary != "ran tool Read" || ev.Category != event.CategoryTool {
		t.Errorf("Read with command: %q %q", ev.Summary, ev.Category)
	}
}

func TestBashSummaryCarriesLifecycleVerbs(t *testing.T) {
	const post, pre = "post_tool_use_bash.json", "pre_tool_use_bash.json"
	all := "git worktree add ../x -b x; git worktree remove ../x; git commit -m a; git push; gh pr create --title t; gh pr merge"
	cases := []struct{ name, base, hook, cmd, want string }{
		{"commit", post, "PostToolUse", `git commit -m "fix: thing"`, "ran shell tool: git commit"},
		{"worktree add", post, "PostToolUse", `git worktree add ../x -b x`, "ran shell tool: git worktree add"},
		{"chain", post, "PostToolUse", `git add -A && git commit -m x && git push`, "ran shell tool: git commit, git push"},
		{"pr merge", post, "PostToolUse", `gh pr merge --squash`, "ran shell tool: gh pr merge"},
		{"heredoc", post, "PostToolUse", "git commit -F - <<'EOF'\nnotes: git push later\nEOF", "ran shell tool: git commit"},
		{"dry run", post, "PostToolUse", `git commit --dry-run`, "ran shell tool"},
		{"status", post, "PostToolUse", `git status`, "ran shell tool"},
		{"or true", post, "PostToolUse", `git commit -m x || true`, "ran shell tool"},
		{"nested quotes", post, "PostToolUse", `echo "$(printf "%s" "x; git commit -m x")"`, "ran shell tool"},
		{"conditional body", post, "PostToolUse", `if false; then :; git commit -m x; fi`, "ran shell tool"},
		{"pre push", pre, "PreToolUse", `git push origin HEAD`, "will run shell tool"},
		{"failure", post, "PostToolUseFailure", `git commit -m x`, "failed shell tool"},
		{"dedupe", post, "PostToolUse", `git commit; git commit -m b; git push; git push`, "ran shell tool: git commit, git push"},
		{"all six", post, "PostToolUse", all, "ran shell tool: git worktree add, git worktree remove, git commit, git push, gh pr create, gh pr merge"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ev := parse(t, lifecycleHook(t, c.base, c.hook, c.cmd))
			if ev.Summary != c.want {
				t.Errorf("summary = %q, want %q", ev.Summary, c.want)
			}
			if ev.Category != event.CategoryShell {
				t.Errorf("category = %q", ev.Category)
			}
			if c.hook == "PostToolUseFailure" && ev.Severity != event.SeverityWarn {
				t.Errorf("severity = %q", ev.Severity)
			}
			if !strings.Contains(ev.Raw, "git") && !strings.Contains(ev.Raw, "gh") {
				t.Errorf("raw lost command: %q", ev.Raw)
			}
		})
	}

	t.Run("cursor shell", func(t *testing.T) {
		ev := parse(t, `{"hook_event_name":"preToolUse","session_id":"s1","tool_name":"Shell","tool_input":{"command":"git push origin HEAD"}}`)
		if ev.Summary != "will run shell tool" {
			t.Errorf("summary = %q", ev.Summary)
		}
	})
	t.Run("json escaped", func(t *testing.T) {
		raw := strings.Replace(lifecycleHook(t, post, "PostToolUse", "git commit -m x"), "git commit", `\u0067it commit`, 1)
		if strings.Contains(raw, "git commit -m x") || !strings.Contains(raw, `\u0067it commit`) {
			t.Fatal("escape not applied")
		}
		ev := parse(t, raw)
		if ev.Summary != "ran shell tool: git commit" {
			t.Errorf("summary = %q", ev.Summary)
		}
	})
}

func TestInterruptedBashHasNoVerbSuffix(t *testing.T) {
	for _, cmd := range []string{"sleep 100 && git commit -m x", "git push"} {
		var m map[string]any
		_ = json.Unmarshal([]byte(lifecycleHook(t, "post_tool_use_bash.json", "PostToolUse", cmd)), &m)
		m["tool_response"] = map[string]any{"interrupted": true, "stdout": ""}
		raw, _ := json.Marshal(m)
		ev := parse(t, string(raw))
		if ev.Summary != "interrupted shell tool" || ev.Payload["status"] != "interrupted" {
			t.Errorf("%q: summary=%q status=%v", cmd, ev.Summary, ev.Payload["status"])
		}
	}
}

func TestBashSummaryNeverLeaksArguments(t *testing.T) {
	cmds := []string{
		`git commit -m "SECRET-msg"`,
		`git worktree add ../SECRET-path -b SECRET-branch`,
		`git push SECRET-remote SECRET-branch`,
		`gh pr create --title "SECRET-title" --body SECRET-body`,
		`git commit -m SECRET && git push SECRET-r && gh pr merge SECRET-n`,
	}
	for _, cmd := range cmds {
		ev := parse(t, lifecycleHook(t, "post_tool_use_bash.json", "PostToolUse", cmd))
		details := strings.ReplaceAll(safeDetails(t, ev), "SECRET-DESCRIPTION-MARKER", "")
		if strings.Contains(details, "SECRET") {
			t.Errorf("%q leaked: %s", cmd, details)
		}
		if n := utf8.RuneCountInString(ev.Summary); n > 130 {
			t.Errorf("summary too long: %d", n)
		}
	}
}
