package capture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/adapters/opencode"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func TestCorrelationViewMetadataAndPrivacy(t *testing.T) {
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	sequence := int64(0)
	ev := event.Event{SchemaVersion: 1, ID: "captured", Time: now, SourceTime: &now, CaptureTime: &now, Source: "codex", SessionID: "session", Category: event.CategoryTool, TraceID: "trace", TurnID: "turn", CallID: "call", PromptID: "prompt", MessageID: "message", ParentID: "parent", UpstreamEventID: "upstream", RequestID: "request", Sequence: &sequence, Transport: "hook", SourceVersion: "1", Raw: "SECRET-RAW", CWD: "/secret", Repo: "/secret", RepoID: "/secret", WorktreeID: "/secret", JJRepoID: "/secret", JJWorkspaceID: "/secret", Payload: map[string]any{"phase": "end", "output": "SECRET-BODY", "arguments": "SECRET-ARGS", "error_class": "failed"}}
	for _, mode := range []privacy.Mode{privacy.ModeMinimal, privacy.ModeBalanced, privacy.ModeFull} {
		t.Run(string(mode), func(t *testing.T) {
			red := privacy.Redact(ev, mode)
			got := CorrelationView(red)
			want := TimelineView(red)
			want.SourceTime, want.CaptureTime = red.SourceTime, red.CaptureTime
			want.TraceID, want.PromptID, want.MessageID, want.ParentID = red.TraceID, red.PromptID, red.MessageID, red.ParentID
			want.UpstreamEventID, want.RequestID, want.Sequence = red.UpstreamEventID, red.RequestID, red.Sequence
			want.Transport, want.SourceVersion = red.Transport, red.SourceVersion
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got=%+v want=%+v", got, want)
			}
			if got.Payload["output"] != nil || got.Payload["arguments"] != nil || got.Raw != "" || got.CWD != "" {
				t.Fatal("unapproved body/path retained")
			}
			got.Payload["phase"] = "changed"
			if reflect.DeepEqual(red.Payload["phase"], "changed") {
				t.Fatal("mutated input payload map")
			}
		})
	}
	if got := CorrelationView(event.Event{}); got.SourceTime != nil || got.CaptureTime != nil || got.Sequence != nil || got.Payload != nil {
		t.Fatalf("invented absent metadata: %+v", got)
	}
}

func normalizedLoomFixture(t *testing.T) []event.Event {
	t.Helper()
	var events []event.Event
	for i, name := range []string{"message_updated_user.json", "message_updated_assistant_started.json", "tool_completed_glob.json"} {
		raw, err := os.ReadFile(filepath.Join("..", "adapters", "opencode", "testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		ev, err := opencode.Parse(raw)
		if err != nil || ev == nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		ev.ID = []string{"loom-user", "loom-assistant", "loom-tool"}[i]
		ev.SchemaVersion = 1
		// The source clock is real fixture data. Test-only capture time is pinned to it.
		captureTime := *ev.SourceTime
		ev.CaptureTime = &captureTime
		ev.Time = captureTime
		events = append(events, CorrelationView(*ev))
	}
	return events
}
func TestCorrelationOpenCodeFixture(t *testing.T) {
	want := normalizedLoomFixture(t)
	path := filepath.Join("..", "..", "apps", "tauri-desktop", "src", "ui", "loom", "fixture.opencode.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		data, _ := json.MarshalIndent(want, "", "  ")
		t.Fatalf("fixture missing: %v\nFIXTURE_START\n%s\nFIXTURE_END", err, data)
	}
	var got []event.Event
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("frontend fixture differs from current adapter + CorrelationView: got=%+v want=%+v", got, want)
	}
}
