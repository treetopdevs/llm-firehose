package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

const sessionMetaLine = `{"timestamp":"2026-05-07T15:12:00.000Z","type":"session_meta","payload":{"id":"sess-codex-1","timestamp":"2026-05-07T15:11:59.000Z","cwd":"/Users/x/proj","originator":"Codex CLI","cli_version":"0.100.0","source":"vscode"}}`

func newParser(t *testing.T) *FileParser {
	t.Helper()
	p := NewFileParser()
	ev, err := p.ParseLine([]byte(sessionMetaLine))
	if err != nil {
		t.Fatalf("session_meta parse: %v", err)
	}
	if ev == nil {
		t.Fatal("session_meta should produce an event")
	}
	if ev.Category != event.CategorySession || ev.SessionID != "sess-codex-1" || ev.CWD != "/Users/x/proj" {
		t.Fatalf("session_meta mapped wrong: %+v", ev)
	}
	return p
}

func TestUserAndAgentMessages(t *testing.T) {
	p := newParser(t)
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:05.227Z","type":"event_msg","payload":{"type":"user_message","message":"deploy this app"}}`))
	if ev == nil || ev.Category != event.CategoryPrompt {
		t.Fatalf("user_message => %+v, want prompt", ev)
	}
	if ev.SessionID != "sess-codex-1" || ev.CWD != "/Users/x/proj" {
		t.Errorf("session context not carried: %+v", ev)
	}
	if !strings.Contains(ev.Summary, "deploy this app") {
		t.Errorf("summary %q", ev.Summary)
	}
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:17.547Z","type":"event_msg","payload":{"type":"agent_message","message":"I will check the repo."}}`))
	if ev == nil || ev.Category != event.CategoryMessage {
		t.Fatalf("agent_message => %+v, want message", ev)
	}
}

func TestExecCommandEndIsShell(t *testing.T) {
	p := newParser(t)
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:17.618Z","type":"event_msg","payload":{"type":"exec_command_end","command":["/bin/zsh","-lc","pwd"],"cwd":"/Users/x/proj","exit_code":0}}`))
	if ev == nil || ev.Category != event.CategoryShell {
		t.Fatalf("exec_command_end => %+v, want shell", ev)
	}
	if !strings.Contains(ev.Summary, "pwd") {
		t.Errorf("summary %q should contain command", ev.Summary)
	}
}

func TestPatchApplyEndIsFile(t *testing.T) {
	p := newParser(t)
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:18:14.429Z","type":"event_msg","payload":{"type":"patch_apply_end","success":true,"changes":{"/Users/x/proj/lib/router.ex":{"type":"update"}}}}`))
	if ev == nil || ev.Category != event.CategoryFile {
		t.Fatalf("patch_apply_end => %+v, want file", ev)
	}
	if !strings.Contains(ev.Summary, "router.ex") {
		t.Errorf("summary %q should name changed file", ev.Summary)
	}
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:18:15.000Z","type":"event_msg","payload":{"type":"patch_apply_end","success":false,"changes":{}}}`))
	if ev == nil || ev.Severity != event.SeverityError {
		t.Fatalf("failed patch should be error severity: %+v", ev)
	}
}

func TestTaskLifecycle(t *testing.T) {
	p := newParser(t)
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:05.218Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}`))
	if ev == nil || ev.Category != event.CategorySession {
		t.Fatalf("task_started => %+v", ev)
	}
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:26:31.688Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"Done, deployed."}}`))
	if ev == nil || ev.Category != event.CategorySession {
		t.Fatalf("task_complete => %+v", ev)
	}
}

func TestFunctionCallMapping(t *testing.T) {
	p := newParser(t)
	// MCP-style tool call has no *_end event: must surface as tool
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:25.187Z","type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\"path\":\"main.go\"}","call_id":"c1"}}`))
	if ev == nil || ev.Category != event.CategoryTool {
		t.Fatalf("function_call => %+v, want tool", ev)
	}
	// exec_command function_call is skipped (exec_command_end covers it)
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:17.547Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"c2"}}`))
	if ev != nil {
		t.Fatalf("exec_command function_call should be skipped, got %+v", ev)
	}
}

func TestNoiseLinesSkipped(t *testing.T) {
	p := newParser(t)
	for _, line := range []string{
		`{"timestamp":"2026-05-07T15:12:06.002Z","type":"event_msg","payload":{"type":"token_count"}}`,
		`{"timestamp":"2026-05-07T15:12:11.559Z","type":"response_item","payload":{"type":"reasoning","encrypted_content":"xxx"}}`,
		`{"timestamp":"2026-05-07T15:12:05.221Z","type":"turn_context","payload":{"cwd":"/Users/x/proj"}}`,
	} {
		ev, err := p.ParseLine([]byte(line))
		if err != nil {
			t.Errorf("noise line errored: %v", err)
		}
		if ev != nil {
			t.Errorf("noise line produced event: %+v", ev)
		}
	}
}

func TestErrorEvent(t *testing.T) {
	p := newParser(t)
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:06.002Z","type":"event_msg","payload":{"type":"error","message":"stream disconnected"}}`))
	if ev == nil || ev.Category != event.CategoryError || ev.Severity != event.SeverityError {
		t.Fatalf("error => %+v, want error/error", ev)
	}
}

func TestMalformedLineErrors(t *testing.T) {
	p := NewFileParser()
	if _, err := p.ParseLine([]byte("garbage")); err == nil {
		t.Error("expected error for malformed line")
	}
}

func TestWatcherStreamsNewSessionFile(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := make(chan event.Event, 32)
	w := NewWatcher(root, 10*time.Millisecond)
	go w.Run(ctx, ch)
	time.Sleep(30 * time.Millisecond)

	dir := filepath.Join(root, "2026", "07", "02")
	os.MkdirAll(dir, 0o755)
	path := filepath.Join(dir, "rollout-2026-07-02T10-00-00-abc.jsonl")
	line := sessionMetaLine + "\n" + `{"timestamp":"2026-07-02T10:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"hello codex"}}` + "\n"
	os.WriteFile(path, []byte(line), 0o644)

	var got []event.Event
	deadline := time.After(2 * time.Second)
	for len(got) < 2 {
		select {
		case ev := <-ch:
			got = append(got, ev)
		case <-deadline:
			t.Fatalf("watcher delivered %d events, want 2", len(got))
		}
	}
	if got[0].Category != event.CategorySession || got[1].Category != event.CategoryPrompt {
		t.Errorf("events: %+v", got)
	}
	if got[1].SessionID != "sess-codex-1" {
		t.Errorf("session not carried per-file: %+v", got[1])
	}
}
