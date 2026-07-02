package event

import (
	"encoding/json"
	"testing"
	"time"
)

func sample() Event {
	return Event{
		ID:        "ev-1",
		Time:      time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC),
		Source:    "claude-code",
		Agent:     "claude",
		SessionID: "sess-abc",
		Category:  CategoryTool,
		Name:      "PostToolUse:Bash",
		Severity:  SeverityInfo,
		Summary:   "ran `go test ./...`",
		Repo:      "llmlog",
		CWD:       "/Users/x/llmlog",
		Payload:   map[string]any{"command": "go test ./..."},
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
		got.Name != ev.Name || got.Severity != ev.Severity || got.Summary != ev.Summary ||
		got.CWD != ev.CWD {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", got, ev)
	}
	if got.Payload["command"] != "go test ./..." {
		t.Errorf("payload lost: %+v", got.Payload)
	}
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
