package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/event"
	"agentfirehose/internal/testsupport/capturehistory"
)

func TestSessionCorrelationView(t *testing.T) {
	cfg := testConfig(t)
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	var stored []event.Event
	for _, source := range []string{"opencode", "codex"} {
		ev := event.Event{ID: source, Time: now, SourceTime: &now, Source: source, SessionID: "same", Category: event.CategoryTool, MessageID: "message", ParentID: "parent", PromptID: "prompt", TraceID: "trace", Transport: "plugin", Raw: "secret", CWD: "/private", Payload: map[string]any{"tool_name": "glob", "output": "secret"}}
		got, err := w.Append(ev)
		if err != nil {
			t.Fatal(err)
		}
		stored = append(stored, got)
	}
	if _, err := w.Append(stored[0]); err != nil {
		t.Fatal(err)
	}
	ts := testServer(t, cfg)
	read := func(path string) (int, []byte) {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, body
	}
	status, body := read("/sessions/same?view=correlation")
	if status != 200 {
		t.Fatalf("status=%d body=%s", status, body)
	}
	var got []event.Event
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	_, fullRaw := read("/sessions/same")
	_, explicitRaw := read("/sessions/same?view=full")
	if string(fullRaw) != string(explicitRaw) {
		t.Fatal("full default changed")
	}
	var full []event.Event
	if err := json.Unmarshal(fullRaw, &full); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || len(full) != 2 {
		t.Fatalf("dedupe changed: %d %d", len(got), len(full))
	}
	for i := range full {
		if !reflect.DeepEqual(got[i], capture.CorrelationView(full[i])) {
			t.Fatalf("correlation differs at %d", i)
		}
	}
	// Native session-ID scope remains unchanged; clients must filter source themselves.
	if got[0].Source == got[1].Source {
		t.Fatal("fixture does not cover cross-source native-ID collision")
	}
	_, timelineRaw := read("/sessions/same?view=timeline")
	var timeline []event.Event
	if err := json.Unmarshal(timelineRaw, &timeline); err != nil {
		t.Fatal(err)
	}
	for i := range full {
		if !reflect.DeepEqual(timeline[i], capture.TimelineView(full[i])) {
			t.Fatal("timeline semantics changed")
		}
	}
	if status, _ := read("/sessions/missing?view=correlation"); status != 404 {
		t.Fatalf("unknown status=%d", status)
	}
	if status, _ := read("/sessions/missing?view=invalid"); status != 400 {
		t.Fatalf("invalid view status=%d", status)
	}
}
