package capture_test

import (
	"bufio"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

// TestWorktreeFixtureShellRecordsMatchAdapter proves the shell records in
// testdata/worktrees_full.ndjson are what the real claude-code adapter makes of
// their own raw hook payload: they are adapter-derived, not spool-captured.
func TestWorktreeFixtureShellRecordsMatchAdapter(t *testing.T) {
	f, err := os.Open("testdata/worktrees_full.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	seen := map[string]int{}
	suffix := regexp.MustCompile(`: (git|gh) `)
	suffixed, plainRan, commitRan := 0, 0, 0
	for sc.Scan() {
		var want event.Event
		if err := json.Unmarshal(sc.Bytes(), &want); err != nil {
			t.Fatal(err)
		}
		if want.Source != "claude-code" || want.Category != event.CategoryShell {
			continue
		}
		got, err := claudecode.Parse([]byte(want.Raw))
		if err != nil || got == nil {
			t.Fatalf("%s: adapter rejected raw: %v", want.ID, err)
		}
		if got.Name != want.Name || got.Summary != want.Summary || got.Category != want.Category || got.Severity != want.Severity || got.CallID != want.CallID {
			t.Errorf("%s: fixture (%s, %q, %s, %s, %s) != adapter (%s, %q, %s, %s, %s)", want.ID,
				want.Name, want.Summary, want.Category, want.Severity, want.CallID,
				got.Name, got.Summary, got.Category, got.Severity, got.CallID)
		}
		seen[want.Name]++
		// Hardcoded, adapter-independent expectations on the stored summary.
		has := suffix.MatchString(want.Summary)
		if has {
			suffixed++
		}
		switch {
		case strings.HasPrefix(want.Name, "PreToolUse:"):
			if want.Summary != "will run shell tool" {
				t.Errorf("%s: pre summary %q", want.ID, want.Summary)
			}
		case strings.HasPrefix(want.Name, "PostToolUseFailure:"):
			if want.Summary != "failed shell tool" {
				t.Errorf("%s: failure summary %q", want.ID, want.Summary)
			}
		}
		if strings.Contains(want.Summary, "interrupted") && has {
			t.Errorf("%s: interrupted record carries a verb suffix: %q", want.ID, want.Summary)
		}
		if want.Summary == "ran shell tool" {
			plainRan++
		}
		if want.Summary == "ran shell tool: git commit" {
			commitRan++
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	// Pinned from the fixture refresh: 10 shell records carry a suffix, all
	// "ran". Pre ("will run"), failed and interrupted summaries carry none.
	if suffixed != 10 {
		t.Errorf("suffixed shell records = %d, want 10", suffixed)
	}
	if commitRan < 1 || plainRan < 1 {
		t.Errorf("ran shell tool: git commit = %d, plain ran shell tool = %d; want both >= 1", commitRan, plainRan)
	}
	for name, summary := range map[string]string{"PreToolUse:Bash": "will run shell tool", "PostToolUse:Bash": "ran shell tool", "PostToolUseFailure:Bash": "failed shell tool"} {
		if seen[name] == 0 {
			t.Errorf("fixture has no %s record (%s)", name, summary)
		}
	}
}

// TestWorktreeBalancedFixtureIsRedactFullFixture pins worktrees_balanced.ndjson
// as the production balanced redaction of the full fixture. Run with
// UPDATE_WORKTREE_FIXTURES=1 to rewrite it.
func TestWorktreeBalancedFixtureIsRedactFullFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/worktrees_full.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	// Argument markers: worktree-add path and branch, commit messages, push
	// refs. Each must occur in a full-fixture raw command (checked below) and
	// must not survive balanced redaction.
	markers := []string{"../alpha-feat", "-b feat", "wip; git push", "Add the feature flag plumbing", "origin feat", "origin fix", "origin main", "tail -5", "--squash"}
	var rawCmds strings.Builder
	for i, line := range strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n") {
		var ev event.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatal(err)
		}
		// Round trip: no unknown fields, and marshal/unmarshal is stable (the
		// stored time text is microsecond-padded; Event re-encodes it compactly).
		dec := json.NewDecoder(strings.NewReader(line))
		dec.DisallowUnknownFields()
		var strict event.Event
		if err := dec.Decode(&strict); err != nil {
			t.Fatalf("line %d has fields event.Event does not know: %v", i+1, err)
		}
		back, err := json.Marshal(ev)
		var again event.Event
		if err != nil || json.Unmarshal(back, &again) != nil {
			t.Fatalf("line %d does not round-trip", i+1)
		}
		if back2, _ := json.Marshal(again); string(back2) != string(back) {
			t.Fatalf("line %d does not round-trip through event.Event", i+1)
		}
		rawCmds.WriteString(ev.Raw)
		red := privacy.Redact(ev, privacy.ModeBalanced)
		if red.Raw != "" {
			t.Fatalf("line %d: balanced Raw not empty", i+1)
		}
		b, err := json.Marshal(red)
		if err != nil {
			t.Fatal(err)
		}
		out.Write(b)
		out.WriteByte('\n')
	}
	if os.Getenv("UPDATE_WORKTREE_FIXTURES") != "" {
		if err := os.WriteFile("testdata/worktrees_balanced.ndjson", []byte(out.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile("testdata/worktrees_balanced.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != out.String() {
		t.Fatal("worktrees_balanced.ndjson differs from Redact(full); rerun with UPDATE_WORKTREE_FIXTURES=1")
	}
	if n := strings.Count(string(got), "\n"); n != 94 {
		t.Errorf("lines = %d, want 94", n)
	}
	if len(got) > 150000 {
		t.Errorf("size %d > 150000", len(got))
	}
	if strings.Contains(string(got), "tool_input") {
		t.Error("balanced fixture contains tool_input")
	}
	for _, m := range markers {
		if !strings.Contains(rawCmds.String(), m) {
			t.Fatalf("marker %q not in any full-fixture raw command; test is vacuous", m)
		}
		if strings.Contains(string(got), m) {
			t.Errorf("argument marker %q leaked into balanced fixture", m)
		}
	}
}
