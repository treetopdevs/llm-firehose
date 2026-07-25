package opencode

import (
	"strings"
	"testing"

	"agentfirehose/internal/event"
)

func parse(t *testing.T, raw string) *event.Event {
	t.Helper()
	ev, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if ev != nil {
		if ev.CaptureTime == nil || !ev.Time.Equal(*ev.CaptureTime) {
			t.Errorf("capture_time = %v, want the locally assigned event time %v", ev.CaptureTime, ev.Time)
		}
		if ev.SourceTime != nil {
			t.Errorf("source_time = %v, want absent because OpenCode bus events supply no timestamp", ev.SourceTime)
		}
	}
	return ev
}

func TestSessionIdle(t *testing.T) {
	ev := parse(t, `{"type":"session.idle","properties":{"sessionID":"oc-1"},"directory":"/repo"}`)
	if ev == nil || ev.Category != event.CategorySession {
		t.Fatalf("session.idle => %+v, want session", ev)
	}
	if ev.SessionID != "oc-1" || ev.CWD != "/repo" || ev.Source != "opencode" {
		t.Errorf("context wrong: %+v", ev)
	}
}

func TestSessionError(t *testing.T) {
	ev := parse(t, `{"type":"session.error","properties":{"sessionID":"oc-1","error":{"name":"ProviderAuthError","data":{"message":"bad key"}}}}`)
	if ev == nil || ev.Category != event.CategoryError || ev.Severity != event.SeverityError {
		t.Fatalf("session.error => %+v, want error/error", ev)
	}
	if strings.Contains(ev.Summary, "bad key") {
		t.Fatalf("session error summary leaked provider body: %q", ev.Summary)
	}
}

func TestMessageRoles(t *testing.T) {
	user := parse(t, `{"type":"message.updated","properties":{"info":{"id":"m1","sessionID":"oc-1","role":"user"}}}`)
	if user == nil || user.Category != event.CategoryPrompt {
		t.Fatalf("user message => %+v, want prompt", user)
	}
	asst := parse(t, `{"type":"message.updated","properties":{"info":{"id":"m2","sessionID":"oc-1","role":"assistant"}}}`)
	if asst == nil || asst.Category != event.CategoryMessage {
		t.Fatalf("assistant message => %+v, want message", asst)
	}
	if asst.SessionID != "oc-1" {
		t.Errorf("sessionID lost: %+v", asst)
	}
}

func TestToolPartBashIsShell(t *testing.T) {
	raw := `{"type":"message.part.updated","properties":{"part":{"id":"p1","sessionID":"oc-1","type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"SECRET-COMMAND"}}}}}`
	ev := parse(t, raw)
	if ev == nil || ev.Category != event.CategoryShell {
		t.Fatalf("bash tool part => %+v, want shell", ev)
	}
	if ev.CallID != "p1" || ev.Payload["tool_name"] != "bash" || ev.Payload["status"] != "completed" {
		t.Fatalf("tool correlation = %+v", ev)
	}
	if strings.Contains(ev.Summary, "SECRET-COMMAND") {
		t.Errorf("summary leaked shell command: %q", ev.Summary)
	}
	if !strings.Contains(ev.Raw, "SECRET-COMMAND") {
		t.Errorf("full-mode raw no longer retains source payload: %q", ev.Raw)
	}
}

func TestToolPartEditIsFile(t *testing.T) {
	ev := parse(t, `{"type":"message.part.updated","properties":{"part":{"id":"p2","sessionID":"oc-1","type":"tool","tool":"edit","state":{"status":"completed","input":{"filePath":"/repo/main.go"}}}}}`)
	if ev == nil || ev.Category != event.CategoryFile {
		t.Fatalf("edit tool part => %+v, want file", ev)
	}
}

func TestTextPartsSkipped(t *testing.T) {
	ev := parse(t, `{"type":"message.part.updated","properties":{"part":{"id":"p3","sessionID":"oc-1","type":"text","text":"streaming..."}}}`)
	if ev != nil {
		t.Fatalf("text part should be skipped (streaming noise), got %+v", ev)
	}
	pending := parse(t, `{"type":"message.part.updated","properties":{"part":{"id":"p4","sessionID":"oc-1","type":"tool","tool":"bash","state":{"status":"running"}}}}`)
	if pending != nil {
		t.Fatalf("non-terminal tool part should be skipped, got %+v", pending)
	}
}

func TestManifestFilteredBusTypesAreSkipped(t *testing.T) {
	for _, eventType := range Manifest.Filtered {
		t.Run(eventType, func(t *testing.T) {
			ev := parse(t, `{"type":"`+eventType+`","properties":{"secret":"SECRET-FILTERED"}}`)
			if ev != nil {
				t.Fatalf("filtered type produced event: %+v", ev)
			}
		})
	}
}

func TestPermissionEvents(t *testing.T) {
	ask := parse(t, `{"type":"permission.updated","properties":{"sessionID":"oc-1","title":"Run: rm -rf build","type":"bash"}}`)
	if ask == nil || ask.Category != event.CategoryPermission || ask.Severity != event.SeverityNotice {
		t.Fatalf("permission.updated => %+v", ask)
	}
	if strings.Contains(ask.Summary, "rm -rf") {
		t.Fatalf("permission summary leaked title: %q", ask.Summary)
	}
	reply := parse(t, `{"type":"permission.replied","properties":{"sessionID":"oc-1","response":"always"}}`)
	if reply == nil || reply.Category != event.CategoryPermission {
		t.Fatalf("permission.replied => %+v", reply)
	}
	if !strings.Contains(reply.Summary, "always") {
		t.Errorf("summary should include decision: %q", reply.Summary)
	}
}

func TestFileEdited(t *testing.T) {
	ev := parse(t, `{"type":"file.edited","properties":{"file":"/repo/src/app.ts"}}`)
	if ev == nil || ev.Category != event.CategoryFile {
		t.Fatalf("file.edited => %+v, want file", ev)
	}
	if !strings.Contains(ev.Summary, "app.ts") {
		t.Errorf("summary %q", ev.Summary)
	}
}

func TestUnknownBecomesSafeDriftWarning(t *testing.T) {
	ev := parse(t, `{"type":"lsp.client.diagnostics","properties":{}}`)
	if ev == nil || ev.Category != event.CategoryMeta || ev.Severity != event.SeverityWarn {
		t.Fatalf("unknown type => %+v, want meta/warn", ev)
	}
	if ev.Name != "adapter.unknown_event" || ev.Transport != "plugin" || ev.Raw != "" {
		t.Errorf("unsafe drift warning: %+v", ev)
	}
}

func TestManifestIsValid(t *testing.T) {
	if err := Manifest.Validate(); err != nil {
		t.Fatalf("manifest: %v", err)
	}
}

func TestEveryManifestMappedTypeHasAParserHandler(t *testing.T) {
	fixtures := map[string]string{
		"session.idle":         `{"type":"session.idle","properties":{"sessionID":"s1"}}`,
		"session.created":      `{"type":"session.created","properties":{"info":{"id":"s1"}}}`,
		"session.deleted":      `{"type":"session.deleted","properties":{"sessionID":"s1"}}`,
		"session.error":        `{"type":"session.error","properties":{"sessionID":"s1","error":{"name":"TestError"}}}`,
		"message.updated":      `{"type":"message.updated","properties":{"info":{"sessionID":"s1","role":"assistant"}}}`,
		"message.part.updated": `{"type":"message.part.updated","properties":{"part":{"sessionID":"s1","type":"tool","tool":"bash","state":{"status":"completed"}}}}`,
		"permission.updated":   `{"type":"permission.updated","properties":{"sessionID":"s1"}}`,
		"permission.replied":   `{"type":"permission.replied","properties":{"sessionID":"s1"}}`,
		"file.edited":          `{"type":"file.edited","properties":{"file":"/tmp/file"}}`,
	}
	if len(fixtures) != len(Manifest.Mapped) {
		t.Fatalf("fixture count = %d, manifest mapped count = %d", len(fixtures), len(Manifest.Mapped))
	}
	for _, eventType := range Manifest.Mapped {
		t.Run(eventType, func(t *testing.T) {
			raw, ok := fixtures[eventType]
			if !ok {
				t.Fatalf("manifest type %q has no drift-guard fixture", eventType)
			}
			ev := parse(t, raw)
			if ev == nil || ev.Name == "adapter.unknown_event" {
				t.Fatalf("manifest type %q has no parser handler: %+v", eventType, ev)
			}
		})
	}
}
