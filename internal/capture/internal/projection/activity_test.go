package projection

import (
	"context"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

func TestProjectionActivityRecordsTracksFileAndErrorObservations(t *testing.T) {
	ix := New()
	base := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)

	// Non-file, non-error events must not enter the activity index.
	ix.Apply(event.Event{
		ID:       "shell-1",
		Time:     base.Add(time.Minute),
		Source:   "claude-code",
		Category: event.CategoryShell,
		RepoID:   "repo-a",
		Payload:  map[string]any{"command": "go test"},
	})

	// File event with explicit path and root_alias.
	ix.Apply(event.Event{
		ID:         "file-1",
		Time:       base.Add(2 * time.Minute),
		Source:     "claude-code",
		Category:   event.CategoryFile,
		Name:       "PreToolUse:Edit",
		RepoID:     "repo-a",
		WorktreeID: "wt-1",
		RootAlias:  "/alias/repo",
		Payload:    map[string]any{"file_path": "/alias/repo/a.go"},
	})

	// Duplicate ID on the same day must be ignored.
	ix.Apply(event.Event{
		ID:         "file-1",
		Time:       base.Add(3 * time.Minute),
		Source:     "claude-code",
		Category:   event.CategoryFile,
		Name:       "PreToolUse:Edit",
		RepoID:     "repo-a",
		WorktreeID: "wt-1",
		Payload:    map[string]any{"file_path": "/alias/repo/a.go"},
	})

	// Same ID replayed on another day must be ignored.
	ix.Apply(event.Event{
		ID:         "file-1",
		Time:       base.Add(24 * time.Hour),
		Source:     "claude-code",
		Category:   event.CategoryFile,
		Name:       "PreToolUse:Edit",
		RepoID:     "repo-a",
		WorktreeID: "wt-1",
		Payload:    map[string]any{"file_path": "/alias/repo/a.go"},
	})

	// Non-file, non-error record followed on the same day by an eligible error
	// record with the same ID must NOT shadow the error record.
	ix.Apply(event.Event{
		ID:       "shared-id",
		Time:     base.Add(4 * time.Minute),
		Source:   "codex",
		Category: event.CategoryTool,
		Severity: event.SeverityInfo,
		Name:     "custom_tool_call:apply_patch",
		RepoID:   "repo-a",
	})
	ix.Apply(event.Event{
		ID:       "shared-id",
		Time:     base.Add(4 * time.Minute),
		Source:   "codex",
		Category: event.CategoryTool,
		Severity: event.SeverityError,
		Name:     "custom_tool_call:apply_patch",
		RepoID:   "repo-a",
		Payload:  map[string]any{"tool_name": "apply_patch", "input": "*** Begin Patch\n*** Update File: /work/proj/b.go\n"},
	})

	// Other repo must not appear when querying repo-a.
	ix.Apply(event.Event{
		ID:       "other-1",
		Time:     base.Add(5 * time.Minute),
		Source:   "claude-code",
		Category: event.CategoryFile,
		RepoID:   "repo-b",
		Payload:  map[string]any{"file_path": "/other/c.go"},
	})

	// Event with both Git and JJ repo IDs must only be yielded once when both
	// aliases are queried together.
	ix.Apply(event.Event{
		ID:            "colocated-1",
		Time:          base.Add(6 * time.Minute),
		Source:        "claude-code",
		Category:      event.CategoryFile,
		RepoID:        "repo-a",
		JJRepoID:      "jj:repo-a",
		WorktreeID:    "wt-1",
		JJWorkspaceID: "jj:wt-1",
		Payload:       map[string]any{"file_path": "/work/proj/d.go"},
	})

	var got []ActivityRecord
	if err := ix.ActivityRecords(context.Background(), []string{"repo-a", "jj:repo-a"}, base, base.Add(time.Hour), func(rec ActivityRecord) bool {
		got = append(got, rec)
		return true
	}); err != nil {
		t.Fatal(err)
	}

	if len(got) != 3 {
		t.Fatalf("got %d records, want 3: %+v", len(got), got)
	}
	if !got[0].IsFile || got[0].RootAlias != "/alias/repo" || !reflect.DeepEqual(got[0].Paths, []string{"/alias/repo/a.go"}) {
		t.Fatalf("rec[0] = %+v", got[0])
	}
	if got[1].IsFile || got[1].ErrorSig == "" || !reflect.DeepEqual(got[1].Paths, []string{"/work/proj/b.go"}) {
		t.Fatalf("rec[1] = %+v", got[1])
	}
	if !got[2].IsFile || got[2].JJRepoID != "jj:repo-a" || !reflect.DeepEqual(got[2].Paths, []string{"/work/proj/d.go"}) {
		t.Fatalf("rec[2] = %+v", got[2])
	}

	// Early stop when yield returns false.
	stopped := 0
	if err := ix.ActivityRecords(context.Background(), []string{"repo-a"}, base, base.Add(time.Hour), func(ActivityRecord) bool {
		stopped++
		return false
	}); err != nil {
		t.Fatal(err)
	}
	if stopped != 1 {
		t.Fatalf("expected early stop after 1 record, got %d", stopped)
	}

	// Pre-cancelled context returns immediately with context.Canceled.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := ix.ActivityRecords(ctx, []string{"repo-a"}, base, base.Add(time.Hour), func(ActivityRecord) bool {
		t.Fatal("yield called on cancelled context")
		return true
	}); err != context.Canceled {
		t.Fatalf("got err %v, want context.Canceled", err)
	}
}
