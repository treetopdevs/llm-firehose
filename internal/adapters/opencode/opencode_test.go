package opencode

import (
	"os"
	"path/filepath"
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
	ev := parse(t, `{"type":"message.part.updated","properties":{"part":{"id":"p1","sessionID":"oc-1","type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls -la"}}}}}`)
	if ev == nil || ev.Category != event.CategoryShell {
		t.Fatalf("bash tool part => %+v, want shell", ev)
	}
	if !strings.Contains(ev.Summary, "ls -la") {
		t.Errorf("summary %q", ev.Summary)
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

func TestPermissionEvents(t *testing.T) {
	ask := parse(t, `{"type":"permission.updated","properties":{"sessionID":"oc-1","title":"Run: rm -rf build","type":"bash"}}`)
	if ask == nil || ask.Category != event.CategoryPermission || ask.Severity != event.SeverityNotice {
		t.Fatalf("permission.updated => %+v", ask)
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

func TestUnknownSkipped(t *testing.T) {
	ev := parse(t, `{"type":"lsp.client.diagnostics","properties":{}}`)
	if ev != nil {
		t.Fatalf("unknown type should be skipped, got %+v", ev)
	}
}

func TestWritePlugin(t *testing.T) {
	dir := t.TempDir()
	path, err := WritePlugin(dir, "/Applications/Agent Firehose/firehosed")
	if err != nil {
		t.Fatalf("WritePlugin: %v", err)
	}
	if filepath.Dir(path) != dir {
		t.Errorf("plugin written outside dir: %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read plugin: %v", err)
	}
	js := string(data)
	if !strings.Contains(js, `["/Applications/Agent Firehose/firehosed","hook-forward","--source","opencode"]`) {
		t.Errorf("plugin should use the configured fail-silent executable:\n%s", js)
	}
}
