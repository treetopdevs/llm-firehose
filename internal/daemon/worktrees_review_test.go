package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/capture"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

// engineAdmitter lets admitSession write through the server's own engine.
type engineAdmitter struct{ e *capture.Engine }

func (a engineAdmitter) Append(ev event.Event) (event.Event, error) {
	return a.e.Admit(context.Background(), ev)
}

// admitBash admits a full-mode claude-code PostToolUse Bash event run in cwd.
func admitBash(t *testing.T, s *Server, id, cwd, at, cmd string) {
	t.Helper()
	when, err := time.Parse(time.RFC3339, at)
	if err != nil {
		t.Fatal(err)
	}
	raw := fmt.Sprintf(`{"tool_name":"Bash","tool_input":{"command":%q},"tool_response":{"stdout":"ok"}}`, cmd)
	if _, err := s.engine.Admit(context.Background(), event.Event{
		ID: id, Time: when, Source: "claude-code", SessionID: "sess-" + id, Category: event.CategoryShell,
		Name: "PostToolUse:Bash", Summary: "bash", CWD: cwd, Raw: raw,
	}); err != nil {
		t.Fatal(err)
	}
}

func wtByLabel(t *testing.T, s *Server, path string) map[string]any {
	t.Helper()
	return wtRow(t, wtList(t, s), path)
}

// A merge command that does not name this fork's own pull request proves
// nothing: the fork stays abandoned. A plain `gh pr merge` run in the fork does.
func TestWorktreeLandingNeedsVerifiedSelfMerge(t *testing.T) {
	for _, tc := range []struct {
		cmd, outcome, reason string
	}{
		{"gh pr merge 123 --squash", "abandoned", ""},
		{"gh pr merge --auto --squash", "abandoned", ""},
		{"if false; then gh pr merge --squash; fi", "abandoned", ""},
		{"gh pr merge --squash --delete-branch", "landed", "pr_merge_mark"},
	} {
		t.Run(tc.cmd, func(t *testing.T) {
			f := newWorktreeGitFixture(t)
			s, _ := newWorktreeServer(t, "full")
			registerFixture(t, s, f.Main)
			path := f.Wt["feat-abandoned"]
			admitSession(t, engineAdmitter{s.engine}, "sess-ab", path, "2026-10-31T12:10:00Z", "2026-10-31T12:30:00Z")
			admitBash(t, s, "merge", path, "2026-10-31T12:40:00Z", tc.cmd)
			refreshObserve(t, s)
			f.git(f.Main, "", "worktree", "remove", "--force", path)
			refreshObserve(t, s)
			row := wtByLabel(t, s, path)
			reason, _ := row["state_reason"].(string)
			if row["state"] != "gone" || row["outcome"] != tc.outcome || reason != tc.reason {
				t.Fatalf("row: %v", row)
			}
		})
	}
}

// A cancelled `sleep 100 && gh pr merge --squash` never reached the merge, so
// it is no evidence of landing. This walks the real path: adapter, privacy in
// Admit, projection, classification. The payload is the captured
// post_tool_use.json; no interrupted:true capture exists, so only that flag
// (plus the command and cwd) differs from what Claude Code sent.
func TestWorktreeInterruptedMergeIsNotLanded(t *testing.T) {
	for _, tc := range []struct {
		name            string
		interrupted     bool
		outcome, reason string
	}{
		{"interrupted", true, "abandoned", ""},
		{"completed", false, "landed", "pr_merge_mark"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newWorktreeGitFixture(t)
			s, _ := newWorktreeServer(t, "full")
			registerFixture(t, s, f.Main)
			path := f.Wt["feat-abandoned"]
			admitSession(t, engineAdmitter{s.engine}, "sess-ab", path, "2026-10-31T12:10:00Z", "2026-10-31T12:30:00Z")

			data, err := os.ReadFile("../adapters/claudecode/testdata/post_tool_use.json")
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]any
			if err := json.Unmarshal(data, &payload); err != nil {
				t.Fatal(err)
			}
			payload["cwd"] = path
			payload["tool_input"].(map[string]any)["command"] = "sleep 100 && gh pr merge --squash"
			payload["tool_response"].(map[string]any)["interrupted"] = tc.interrupted
			raw, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			ev, err := claudecode.Parse(raw)
			if err != nil || ev == nil {
				t.Fatalf("adapter: %v %v", ev, err)
			}
			when := time.Date(2026, 10, 31, 12, 40, 0, 0, time.UTC)
			ev.Time, ev.CaptureTime = when, &when
			if _, err := s.engine.Admit(context.Background(), *ev); err != nil {
				t.Fatal(err)
			}

			refreshObserve(t, s)
			f.git(f.Main, "", "worktree", "remove", "--force", path)
			refreshObserve(t, s)
			row := wtByLabel(t, s, path)
			reason, _ := row["state_reason"].(string)
			if row["state"] != "gone" || row["outcome"] != tc.outcome || reason != tc.reason {
				t.Fatalf("row: %v", row)
			}
		})
	}
}

// A path recreated from main at the very head the old lifetime was removed at
// is a fresh lifetime: neither the old divergence nor the old marks carry over.
func TestWorktreeRecreatedAtSameHeadStartsFreshLifetime(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, _ := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	path := f.Wt["feat-landed"]
	admitSession(t, engineAdmitter{s.engine}, "sess-l", path, "2026-10-31T09:55:00Z", "2026-10-31T10:20:00Z")
	admitBash(t, s, "c1", path, "2026-10-31T10:06:00Z", "git commit -m landed")
	admitBash(t, s, "m1", path, "2026-10-31T10:21:00Z", "gh pr merge --squash")
	refreshObserve(t, s) // ahead: ever_ahead
	f.git(f.Main, "2026-10-31T13:30:00Z", "merge", "-q", "--ff-only", "feat-landed")
	refreshObserve(t, s)
	if row := wtByLabel(t, s, path); row["state"] != "landed" {
		t.Fatalf("before removal: %v", row)
	}
	f.git(f.Main, "", "worktree", "remove", "--force", path)
	refreshObserve(t, s)
	if row := wtByLabel(t, s, path); row["state"] != "gone" || row["outcome"] != "landed" {
		t.Fatalf("after removal: %v", row)
	}
	f.git(f.Main, "", "worktree", "add", "-q", "-b", "fresh", path, "main") // same head as at removal
	refreshObserve(t, s)
	row := wtByLabel(t, s, path)
	if row["state"] != "never_diverged" {
		t.Fatalf("recreated path inherited the previous lifetime: %v", row)
	}
	// And the new lifetime's own evidence still counts.
	admitBash(t, s, "c2", path, time.Now().UTC().Add(time.Minute).Format(time.RFC3339), "git commit -m again")
	if row := wtByLabel(t, s, path); row["state"] != "landed" {
		// At the default branch's tip with a commit by this lifetime: landed.
		t.Fatalf("row: %v", row)
	}
	f.git(f.Main, "", "worktree", "remove", "--force", path)
	refreshObserve(t, s)
	if row := wtByLabel(t, s, path); row["state"] != "gone" || row["outcome"] != "landed" {
		t.Fatalf("a commit in the new lifetime proves divergence: %v", row)
	}
}

// git still lists a checkout whose state cannot be read; that is not removal.
func TestWorktreeUnreadableCheckoutIsNotGone(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permissions are not enforced for root")
	}
	f := newWorktreeGitFixture(t)
	s, _ := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	path := f.Wt["feat-abandoned"]
	admitSession(t, engineAdmitter{s.engine}, "sess-ab", path, "2026-10-31T12:10:00Z", "2026-10-31T12:30:00Z")
	refreshObserve(t, s)
	if row := wtByLabel(t, s, path); row["state"] != "open" {
		t.Fatalf("before: %v", row)
	}
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o700) })
	refreshObserve(t, s)
	row := wtByLabel(t, s, path)
	if row["state"] != "unknown" || row["state_reason"] != "worktree_unavailable" {
		t.Fatalf("unreadable checkout: %v", row)
	}
	if _, has := row["outcome"]; has {
		t.Fatalf("no outcome while merely unreadable: %v", row)
	}
	if _, has := row["dirty"]; has {
		t.Fatalf("dirty is unknown while unreadable: %v", row)
	}
	if rec := s.worktrees.records[recordKey(f.Common, path)]; !rec.Present || rec.GoneOutcome != "" {
		t.Fatalf("record settled: %+v", rec)
	}
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
	refreshObserve(t, s)
	if row := wtByLabel(t, s, path); row["state"] != "open" {
		t.Fatalf("after: %v", row)
	}
}

// Detail never scans: with no cached snapshot (a privacy change cleared it) it
// still answers, and runs only its one compare.
func TestWorktreeDetailNeverScansWithoutCachedSnapshot(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, _ := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	path := f.Wt["feat-open"]
	admitSession(t, engineAdmitter{s.engine}, "sess-o", path, "2026-10-31T11:00:00Z", "2026-10-31T11:50:00Z")
	refreshObserve(t, s)
	repoID := s.graph.service.Repositories()[0].ID
	if _, ok := s.graph.service.CachedSnapshot(repoID); !ok {
		t.Fatal("expected a cached snapshot after refresh")
	}
	s.graph.service.SetPrivacy(privacy.ModeMinimal)
	if _, ok := s.graph.service.CachedSnapshot(repoID); ok {
		t.Fatal("a privacy change must clear the snapshot cache")
	}
	s.graph.service.SetPrivacy(privacy.ModeFull)
	d := wtDetail(t, s, path)
	if d["state"] != "open" {
		t.Fatalf("detail: %v", d)
	}
	if _, ok := s.graph.service.CachedSnapshot(repoID); ok {
		t.Fatal("the detail route scanned the repository")
	}
}

// Unestablished body commands must not fabricate divergence at the base tip.
func TestWorktreeCompoundBodyDoesNotProveLanding(t *testing.T) {
	f := newWorktreeGitFixture(t)
	s, _ := newWorktreeServer(t, "full")
	registerFixture(t, s, f.Main)
	path := f.Wt["feat-idle"]
	admitSession(t, engineAdmitter{s.engine}, "sess-idle", path, "2026-10-31T12:10:00Z", "2026-10-31T12:30:00Z")
	refreshObserve(t, s)
	for i, cmd := range []string{
		"if false; then :; git commit -m x; fi",
		"if false\nthen\n :\n git commit -m x\nfi",
		"while false; do :; git commit -m x; done",
		"until true; do :; git commit -m x; done",
		"for f in; do :; git commit -m x; done",
	} {
		admitBash(t, s, fmt.Sprintf("compound-%d", i), path, "2026-10-31T12:40:00Z", cmd)
		if row := wtByLabel(t, s, path); row["state"] != "never_diverged" {
			t.Fatalf("%q fabricated landing: %v", cmd, row)
		}
	}
	admitBash(t, s, "condition", path, "2026-10-31T12:41:00Z", "if git commit -m x; then :; fi")
	if row := wtByLabel(t, s, path); row["state"] != "landed" {
		t.Fatalf("executed top-level condition lost its evidence: %v", row)
	}
}
