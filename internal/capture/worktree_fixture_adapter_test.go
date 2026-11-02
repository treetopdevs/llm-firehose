package capture_test

import (
	"bufio"
	"encoding/json"
	"os"
	"testing"

	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/event"
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
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	for name, summary := range map[string]string{"PreToolUse:Bash": "will run shell tool", "PostToolUse:Bash": "ran shell tool", "PostToolUseFailure:Bash": "failed shell tool"} {
		if seen[name] == 0 {
			t.Errorf("fixture has no %s record (%s)", name, summary)
		}
	}
}
