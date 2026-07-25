package event

import (
	"encoding/json"
	"testing"
	"time"
)

func sample() Event {
	sourceTime := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	captureTime := sourceTime.Add(2 * time.Second)
	return Event{
		ID:              "ev-1",
		Time:            sourceTime,
		SourceTime:      &sourceTime,
		CaptureTime:     &captureTime,
		Source:          "claude-code",
		Agent:           "claude",
		SessionID:       "sess-abc",
		UpstreamEventID: "native-1",
		PromptID:        "prompt-1",
		MessageID:       "message-1",
		ParentID:        "parent-1",
		RequestID:       "request-1",
		Sequence:        int64ptr(42),
		Transport:       "hook",
		SourceVersion:   "2.1.218",
		Category:        CategoryTool,
		Name:            "PostToolUse:Bash",
		Severity:        SeverityInfo,
		Summary:         "ran `go test ./...`",
		Repo:            "llmlog",
		CWD:             "/Users/x/llmlog",
		RepoID:          "/Users/x/llmlog/.git",
		WorktreeID:      "/Users/x/llmlog",
		Payload:         map[string]any{"command": "go test ./..."},
	}
}

func TestJSONRoundTrip(t *testing.T) {
	ev := sample()
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got Event
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ID != ev.ID || !got.Time.Equal(ev.Time) || got.Source != ev.Source ||
		got.SessionID != ev.SessionID || got.Category != ev.Category ||
		got.UpstreamEventID != ev.UpstreamEventID || got.PromptID != ev.PromptID ||
		got.MessageID != ev.MessageID || got.ParentID != ev.ParentID ||
		got.RequestID != ev.RequestID || got.Sequence == nil || *got.Sequence != *ev.Sequence ||
		got.Transport != ev.Transport || got.SourceVersion != ev.SourceVersion ||
		got.Name != ev.Name || got.Severity != ev.Severity || got.Summary != ev.Summary ||
		got.CWD != ev.CWD || got.SourceTime == nil || !got.SourceTime.Equal(*ev.SourceTime) ||
		got.CaptureTime == nil || !got.CaptureTime.Equal(*ev.CaptureTime) ||
		got.RepoID != ev.RepoID || got.WorktreeID != ev.WorktreeID {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", got, ev)
	}
	if got.Payload["command"] != "go test ./..." {
		t.Errorf("payload lost: %+v", got.Payload)
	}
}

func int64ptr(value int64) *int64 {
	return &value
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Event)
		wantErr bool
	}{
		{"valid", func(e *Event) {}, false},
		{"empty source", func(e *Event) { e.Source = "" }, true},
		{"zero time", func(e *Event) { e.Time = time.Time{} }, true},
		{"empty category", func(e *Event) { e.Category = "" }, true},
		{"unknown category", func(e *Event) { e.Category = "bogus" }, true},
		{"unknown severity", func(e *Event) { e.Severity = "loud" }, true},
		{"empty severity defaults ok", func(e *Event) { e.Severity = "" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := sample()
			tc.mutate(&ev)
			err := ev.Validate()
			if (err != nil) != tc.wantErr {
				t.Errorf("Validate() err=%v, wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestSchemaVersionSerializes(t *testing.T) {
	if CurrentSchemaVersion != 1 {
		t.Fatalf("CurrentSchemaVersion = %d, want 1", CurrentSchemaVersion)
	}
	ev := sample()
	ev.SchemaVersion = CurrentSchemaVersion
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}
	if v, ok := raw["schema_version"].(float64); !ok || int(v) != 1 {
		t.Errorf("schema_version = %v, want 1", raw["schema_version"])
	}
}

func TestSchemaVersionAbsentIsZero(t *testing.T) {
	// Pre-versioning spool lines have no schema_version field; they must
	// still unmarshal, with SchemaVersion reporting zero.
	line := `{"id":"a","time":"2026-07-01T10:00:00Z","source":"generic","category":"meta"}`
	var ev Event
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		t.Fatalf("unmarshal legacy line: %v", err)
	}
	if ev.SchemaVersion != 0 {
		t.Errorf("SchemaVersion = %d, want 0 for legacy line", ev.SchemaVersion)
	}
	if err := ev.Validate(); err != nil {
		t.Errorf("legacy event must stay valid: %v", err)
	}
}

func TestNewIDUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := NewID()
		if id == "" {
			t.Fatal("empty id")
		}
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
	}
}
