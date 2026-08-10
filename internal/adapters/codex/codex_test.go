package codex

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
)

const sessionMetaLine = `{"timestamp":"2026-05-07T15:12:00.000Z","type":"session_meta","payload":{"id":"sess-codex-1","timestamp":"2026-05-07T15:11:59.000Z","cwd":"/Users/x/proj","originator":"Codex CLI","cli_version":"0.100.0","source":"vscode"}}`

func capturedRolloutLine(t *testing.T, marker string) string {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "rollout_current_sanitized.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.Contains(sc.Text(), marker) {
			return sc.Text()
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	t.Fatalf("captured rollout fixture has no line containing %q", marker)
	return ""
}

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

func TestRolloutDistinguishesSourceAndCaptureTime(t *testing.T) {
	before := time.Now().UTC()
	ev, err := NewFileParser().ParseLine([]byte(sessionMetaLine))
	after := time.Now().UTC()
	if err != nil || ev == nil {
		t.Fatalf("ParseLine = %+v, %v", ev, err)
	}

	wantSource := time.Date(2026, 5, 7, 15, 12, 0, 0, time.UTC)
	if ev.SourceTime == nil || !ev.SourceTime.Equal(wantSource) {
		t.Errorf("source_time = %v, want %v", ev.SourceTime, wantSource)
	}
	if !ev.Time.Equal(wantSource) {
		t.Errorf("legacy time = %v, want source time %v", ev.Time, wantSource)
	}
	if ev.CaptureTime == nil || ev.CaptureTime.Before(before) || ev.CaptureTime.After(after) {
		t.Errorf("capture_time = %v, want parser observation between %v and %v", ev.CaptureTime, before, after)
	}
}

func TestRolloutObservesGitIdentityForDaemonlessCapture(t *testing.T) {
	repo := filepath.Join(t.TempDir(), "project")
	cwd := filepath.Join(repo, "subdir")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"timestamp":"2026-05-07T15:12:00Z","type":"session_meta","payload":{"id":"sess","cwd":"` + cwd + `"}}`
	ev, err := NewFileParser().ParseLine([]byte(line))
	if err != nil || ev == nil {
		t.Fatalf("ParseLine = %+v, %v", ev, err)
	}
	wantRepo, _ := filepath.EvalSymlinks(filepath.Join(repo, ".git"))
	wantWorktree, _ := filepath.EvalSymlinks(repo)
	if ev.RepoID != wantRepo || ev.WorktreeID != wantWorktree {
		t.Errorf("identity = repo %q worktree %q, want repo %q worktree %q",
			ev.RepoID, ev.WorktreeID, wantRepo, wantWorktree)
	}
}

func TestCurrentSanitizedRolloutFixture(t *testing.T) {
	f, err := os.Open(filepath.Join("testdata", "rollout_current_sanitized.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	p := NewFileParser()
	seen := map[string]event.Event{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		ev, err := p.ParseLine(scanner.Bytes())
		if err != nil {
			t.Fatalf("parse real fixture line: %v", err)
		}
		if ev != nil {
			seen[ev.Name] = *ev
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{
		"session_meta", "task_started", "world_state", "turn_context",
		"user_message", "agent_message", "custom_tool_call:exec",
		"custom_tool_call_output:exec", "tool_search_call:tool_search",
		"tool_search_output:tool_search", "token_count", "task_complete",
	} {
		if _, ok := seen[name]; !ok {
			t.Errorf("real fixture did not produce %q; seen=%v", name, seen)
		}
	}
	if got := seen["agent_message"]; got.Category != event.CategoryMessage ||
		got.Payload["phase"] != "final_answer" {
		t.Errorf("latest assistant message = %+v", got)
	}
	if got := seen["custom_tool_call_output:exec"]; got.CallID != "call_mzb3w08qwqXmd2wsdauIzQ3p" ||
		!strings.Contains(got.Payload["output"].(string), "agent-firehose-codex-fixture") {
		t.Errorf("real tool output = %+v", got)
	}
	if got := seen["tool_search_call:tool_search"]; got.Payload["arguments"] !=
		`{"query":"node_repl js execute JavaScript persistent Node kernel computer use"}` {
		t.Errorf("real object arguments = %+v", got)
	}
	if got := seen["tool_search_output:tool_search"]; got.Payload["output"] !=
		"mcp__node_repl\nmcp__codex_apps__figma" {
		t.Errorf("safe tool-search output = %+v", got)
	}
	if serialized := fmt.Sprint(seen); strings.Contains(serialized, "developer_instructions") ||
		strings.Contains(serialized, "base_instructions") {
		t.Errorf("sanitized fixture leaked instruction bodies: %s", serialized)
	}
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
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:00.066Z","type":"response_item","payload":{"type":"function_call","id":"fc_1","name":"read_file","arguments":"{\"path\":\"main.go\"}","call_id":"c1","internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"}}}`))
	if ev == nil || ev.Category != event.CategoryTool {
		t.Fatalf("function_call => %+v, want tool", ev)
	}
	if ev.CallID != "c1" || ev.TurnID != "turn-1" || ev.Payload["phase"] != "start" {
		t.Fatalf("function_call correlation => %+v", ev)
	}
	// Current Codex emits exec_command starts and function_call_output ends.
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:00.066Z","type":"response_item","payload":{"type":"function_call","id":"fc_2","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}","call_id":"c2","internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"}}}`))
	if ev == nil || ev.Category != event.CategoryShell || ev.Payload["phase"] != "start" {
		t.Fatalf("exec_command start => %+v, want shell/start", ev)
	}
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:04.904Z","type":"response_item","payload":{"type":"function_call_output","id":"out_2","call_id":"c2","output":"Chunk ID: abc\nProcess exited with code 0\nFinal output:\n/repo\n","internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"}}}`))
	if ev == nil || ev.Category != event.CategoryShell || ev.CallID != "c2" || ev.TurnID != "turn-1" {
		t.Fatalf("exec_command output correlation => %+v", ev)
	}
	if ev.Payload["phase"] != "end" || !strings.Contains(ev.Payload["output"].(string), "Process exited") {
		t.Fatalf("exec_command output payload => %+v", ev.Payload)
	}
}

func TestCurrentRolloutMetadataAndUsage(t *testing.T) {
	p := newParser(t)
	ev, err := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:00:52.180Z","type":"turn_context","payload":{"turn_id":"turn-2","cwd":"/tmp/agent-firehose-codex-fixture/work","workspace_roots":["/tmp/agent-firehose-codex-fixture/work"],"current_date":"2026-07-24","timezone":"America/New_York","approval_policy":"never","approvals_reviewer":"user","sandbox_policy":{"type":"danger-full-access"},"permission_profile":{"type":"disabled"},"model":"gpt-5.6-sol","personality":"friendly","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-sol","reasoning_effort":"high","developer_instructions":"secret instructions must not be copied"}},"effort":"high","summary":"fixture"}}`))
	if err != nil || ev == nil {
		t.Fatalf("turn_context parse: ev=%+v err=%v", ev, err)
	}
	if ev.Category != event.CategoryMeta || ev.Name != "turn_context" || ev.TurnID != "turn-2" {
		t.Fatalf("turn_context envelope => %+v", ev)
	}
	if ev.Payload["model"] != "gpt-5.6-sol" || ev.Payload["effort"] != "high" ||
		ev.Payload["approval_policy"] != "never" || ev.Payload["sandbox_mode"] != "danger-full-access" {
		t.Fatalf("turn_context payload => %+v", ev.Payload)
	}
	if strings.Contains(fmt.Sprint(ev.Payload), "secret instructions") {
		t.Fatalf("turn_context leaked developer instructions: %+v", ev.Payload)
	}

	ev, err = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:04.905Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":70031,"cached_input_tokens":27392,"cache_write_input_tokens":0,"output_tokens":618,"reasoning_output_tokens":238,"total_tokens":70649},"last_token_usage":{"input_tokens":41692,"cached_input_tokens":27392,"cache_write_input_tokens":0,"output_tokens":290,"reasoning_output_tokens":84,"total_tokens":41982},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":76.0,"window_minutes":10080,"resets_at":1785423585},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"pro"}}}`))
	if err != nil || ev == nil || ev.Name != "token_count" {
		t.Fatalf("token_count parse: ev=%+v err=%v", ev, err)
	}
	if ev.Payload["transport"] != "rollout" || !strings.Contains(ev.Summary, "70,649") {
		t.Fatalf("token_count summary/payload => %+v", ev)
	}
	if ev.Payload["usage"] == nil || ev.Payload["rate_limits"] == nil {
		t.Fatalf("token_count details missing: %+v", ev.Payload)
	}
}

func TestCurrentToolOutputsMCPAndSettings(t *testing.T) {
	p := newParser(t)
	_, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:07.712Z","type":"response_item","payload":{"type":"custom_tool_call","id":"ct_1","status":"completed","call_id":"call-exec","name":"exec","input":"{\"code\":\"text(1)\"}","internal_chat_message_metadata_passthrough":{"turn_id":"turn-3"}}}`))
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:15.349Z","type":"response_item","payload":{"type":"custom_tool_call_output","id":"cto_1","call_id":"call-exec","output":[{"type":"input_text","text":"one"},{"type":"input_text","text":"two"}],"internal_chat_message_metadata_passthrough":{"turn_id":"turn-3"}}}`))
	if ev == nil || ev.Name != "custom_tool_call_output:exec" || ev.CallID != "call-exec" {
		t.Fatalf("custom output => %+v", ev)
	}
	if got := ev.Payload["output"]; got != "one\ntwo" {
		t.Fatalf("flattened output = %#v", got)
	}

	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:02:00Z","type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"mcp-1","invocation":{"server":"figma","tool":"get_design","arguments":{"fileKey":"abc"}},"duration":{"secs":1,"nanos":500000000},"result":{"Ok":{"content":[{"type":"text","text":"done"}],"isError":false}}}}`))
	if ev == nil || ev.CallID != "mcp-1" || ev.Payload["duration_ms"] != int64(1500) {
		t.Fatalf("mcp completion => %+v", ev)
	}

	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:02:01Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.6-sol","service_tier":"priority","approval_policy":"never","permission_profile":{"type":"disabled","file_system":{"entries":[{"path":{"value":{"kind":"root"}},"access":"read"}]}},"cwd":"/repo","reasoning_effort":"high","personality":"friendly","collaboration_mode":{"mode":"default","settings":{"developer_instructions":"do not persist this"}}}}}`))
	if ev == nil || ev.Name != "thread_settings_applied" || ev.Payload["model"] != "gpt-5.6-sol" {
		t.Fatalf("thread settings => %+v", ev)
	}
	if strings.Contains(fmt.Sprint(ev.Payload), "do not persist this") {
		t.Fatalf("settings leaked instructions: %+v", ev.Payload)
	}
}

func TestRealMCPStartEndUsesOneCorrelationKey(t *testing.T) {
	p := newParser(t)
	start, _ := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:40.474Z","type":"response_item","payload":{"type":"function_call","name":"js","namespace":"mcp__node_repl","arguments":"{}","call_id":"call-mcp","internal_chat_message_metadata_passthrough":{"turn_id":"turn-mcp"}}}`))
	end, _ := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:41.458Z","type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"call-mcp","invocation":{"server":"node_repl","tool":"js","arguments":{}},"duration":{"secs":0,"nanos":970000000},"result":{"Ok":{"content":[{"type":"text","text":"done"}],"isError":false}}}}`))
	if start == nil || end == nil ||
		start.TurnID != end.TurnID || start.CallID != end.CallID ||
		start.Payload["tool_name"] != end.Payload["tool_name"] {
		t.Fatalf("MCP correlation mismatch: start=%+v end=%+v", start, end)
	}
	if _, ok := p.Snapshot().Calls["call-mcp"]; ok {
		t.Fatalf("mcp_tool_call_end left call context behind: %+v", p.Snapshot().Calls)
	}
}

func TestAbsentRolloutTimestampUsesCaptureTimeOnly(t *testing.T) {
	before := time.Now().UTC()
	ev, err := NewFileParser().ParseLine([]byte(`{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}`))
	after := time.Now().UTC()
	if err != nil || ev == nil {
		t.Fatalf("ParseLine = %+v, %v", ev, err)
	}
	if ev.SourceTime != nil {
		t.Errorf("source_time = %v, want absent when rollout timestamp is missing", ev.SourceTime)
	}
	if ev.CaptureTime == nil || ev.CaptureTime.Before(before) || ev.CaptureTime.After(after) {
		t.Errorf("capture_time = %v, want between %v and %v", ev.CaptureTime, before, after)
	}
	if !ev.Time.Equal(*ev.CaptureTime) {
		t.Errorf("legacy time = %v, want capture time %v", ev.Time, *ev.CaptureTime)
	}
}

func TestApprovalPolicyAppearsInSummaryOnlyWhenPresent(t *testing.T) {
	p := newParser(t)
	withPolicy, err := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:00:52Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.6-sol","effort":"high","approval_policy":"never","sandbox_policy":{"type":"danger-full-access"}}}`))
	if err != nil || withPolicy == nil {
		t.Fatalf("with policy: %+v, %v", withPolicy, err)
	}
	if !strings.Contains(withPolicy.Summary, "never approvals") {
		t.Fatalf("summary with policy = %q", withPolicy.Summary)
	}

	emptyPolicy, err := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:00:53Z","type":"turn_context","payload":{"turn_id":"t2","model":"gpt-5.6-sol","effort":"high","sandbox_policy":{"type":"danger-full-access"}}}`))
	if err != nil || emptyPolicy == nil {
		t.Fatalf("empty policy: %+v, %v", emptyPolicy, err)
	}
	if strings.Contains(emptyPolicy.Summary, "approvals") {
		t.Fatalf("summary without policy leaked approvals: %q", emptyPolicy.Summary)
	}
}

func TestWorldStateIsSafeAndUnknownTypesWarnOnce(t *testing.T) {
	p := newParser(t)
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:00:52Z","type":"world_state","payload":{"full":true,"state":{"agents_md":{"directory":"/repo","text":"private instructions"},"apps_instructions":true,"permissions":"danger-full-access","skills":{"includeInstructions":true}}}}`))
	if ev == nil || ev.Name != "world_state" {
		t.Fatalf("world_state => %+v", ev)
	}
	if strings.Contains(fmt.Sprint(ev.Payload), "private instructions") {
		t.Fatalf("world_state leaked content: %+v", ev.Payload)
	}

	line := []byte(`{"timestamp":"2026-07-24T12:03:00Z","type":"event_msg","payload":{"type":"new_codex_signal","secret":"not copied"}}`)
	first, _ := p.ParseLine(line)
	second, _ := p.ParseLine(line)
	if first == nil || first.Severity != event.SeverityWarn || first.Name != "unmapped:new_codex_signal" {
		t.Fatalf("unknown event warning => %+v", first)
	}
	if second != nil {
		t.Fatalf("unknown event type should warn once, got %+v", second)
	}
	if strings.Contains(fmt.Sprint(first.Payload), "not copied") {
		t.Fatalf("unknown event leaked payload: %+v", first.Payload)
	}
}

func TestCompactionSubagentAndSafeItemMetadata(t *testing.T) {
	p := newParser(t)
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:00:00Z","type":"event_msg","payload":{"type":"context_compacted"}}`))
	if ev == nil || ev.Name != "context_compacted" || ev.Payload["phase"] != "end" {
		t.Fatalf("context compacted = %+v", ev)
	}
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:00:01Z","type":"event_msg","payload":{"type":"sub_agent_activity","event_id":"call-agent","occurred_at_ms":123,"agent_thread_id":"agent-thread","agent_path":"/root/review","kind":"started"}}`))
	if ev == nil || ev.CallID != "call-agent" || ev.Payload["phase"] != "start" {
		t.Fatalf("subagent activity = %+v", ev)
	}
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:00:02Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-plan","item":{"type":"Plan","id":"plan-1","text":"private plan body"}}}`))
	if ev == nil || ev.TurnID != "turn-plan" || strings.Contains(fmt.Sprint(ev.Payload), "private plan body") {
		t.Fatalf("safe item completion = %+v", ev)
	}
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:00:03Z","type":"compacted","payload":{"replacement_history":[{"role":"developer","content":"private instructions"}]}}`))
	if ev == nil || strings.Contains(fmt.Sprint(ev.Payload), "private instructions") {
		t.Fatalf("safe compacted = %+v", ev)
	}
}

func TestParserProducesUniqueRandomEnvelopeIDs(t *testing.T) {
	lines := []string{
		sessionMetaLine,
		`{"timestamp":"2026-05-07T15:12:05.227Z","type":"event_msg","payload":{"type":"user_message","message":"deploy this app"}}`,
		`{"timestamp":"2026-05-07T15:12:17.618Z","type":"event_msg","payload":{"type":"exec_command_end","call_id":"call_abc1","command":["/bin/zsh","-lc","pwd"],"cwd":"/Users/x/proj","exit_code":0}}`,
	}
	parse := func() []string {
		p := NewFileParser()
		var ids []string
		for _, line := range lines {
			ev, err := p.ParseLine([]byte(line))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if ev != nil {
				ids = append(ids, ev.ID)
			}
		}
		return ids
	}
	first, second := parse(), parse()
	if len(first) != 3 {
		t.Fatalf("expected 3 events, got %d", len(first))
	}
	for i := range first {
		if first[i] == "" {
			t.Errorf("event %d has empty id", i)
		}
		if first[i] == second[i] {
			t.Errorf("event %d reused random id %q", i, first[i])
		}
		for j := i + 1; j < len(first); j++ {
			if first[i] == first[j] {
				t.Errorf("events %d and %d share id %q", i, j, first[i])
			}
		}
	}
}

func TestParserStateResumesCorrelation(t *testing.T) {
	p := newParser(t)
	_, _ = p.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:00Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"c-state","internal_chat_message_metadata_passthrough":{"turn_id":"t-state"}}}`))
	resumed := NewFileParserFrom(p.Snapshot())
	ev, err := resumed.ParseLine([]byte(`{"timestamp":"2026-07-24T12:01:02Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c-state","output":"done"}}`))
	if err != nil || ev == nil || ev.Category != event.CategoryShell || ev.TurnID != "t-state" {
		t.Fatalf("resumed correlation = %+v, %v", ev, err)
	}
}

func TestCallIDPreserved(t *testing.T) {
	p := newParser(t)
	// exec_command completion carries the native correlation id.
	ev, _ := p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:17.618Z","type":"event_msg","payload":{"type":"exec_command_end","call_id":"call_abc1","command":["/bin/zsh","-lc","pwd"],"cwd":"/Users/x/proj","exit_code":0}}`))
	if ev == nil || ev.CallID != "call_abc1" {
		t.Fatalf("exec_command_end call_id => %+v, want call_abc1", ev)
	}
	// patch application carries one too.
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:18:14.429Z","type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_pt1","success":true,"changes":{"/Users/x/proj/lib/router.ex":{"type":"update"}}}}`))
	if ev == nil || ev.CallID != "call_pt1" {
		t.Fatalf("patch_apply_end call_id => %+v, want call_pt1", ev)
	}
	// MCP-style function_call: the fixture's call_id must survive.
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:25.187Z","type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\"path\":\"main.go\"}","call_id":"c1"}}`))
	if ev == nil || ev.CallID != "c1" {
		t.Fatalf("function_call call_id => %+v, want c1", ev)
	}
	// Events with no native correlation id leave the field empty.
	ev, _ = p.ParseLine([]byte(`{"timestamp":"2026-05-07T15:12:05.227Z","type":"event_msg","payload":{"type":"user_message","message":"deploy this app"}}`))
	if ev == nil || ev.CallID != "" {
		t.Fatalf("user_message should have no call_id: %+v", ev)
	}
}

func TestNoiseLinesSkipped(t *testing.T) {
	p := newParser(t)
	for _, line := range []string{
		`{"timestamp":"2026-05-07T15:12:11.559Z","type":"response_item","payload":{"type":"reasoning","encrypted_content":"xxx"}}`,
		`{"timestamp":"2026-05-07T15:12:11.560Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"private"}]}}`,
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

func TestDurableManifestIsValid(t *testing.T) {
	if err := DurableManifest.Validate(); err != nil {
		t.Fatalf("manifest: %v", err)
	}
}

// The manifest must match the parser: every native type the checked-in
// capture produces is declared as mapped, and no mapped name lacks a parser
// handler (the parser reports handler-less types as unmapped drift, which
// would contradict the doctor's mapped/filtered/unknown contract).
func TestDurableManifestMatchesParserHandlers(t *testing.T) {
	mapped := map[string]bool{}
	for _, name := range DurableManifest.Mapped {
		mapped[name] = true
	}

	// Native record scopes for probe construction. Everything else in Mapped
	// is an event_msg subtype.
	topLevel := map[string]bool{
		"session_meta": true, "turn_context": true, "world_state": true,
	}
	responseItem := map[string]bool{
		"function_call": true, "function_call_output": true,
		"custom_tool_call": true, "custom_tool_call_output": true,
		"tool_search_call": true, "tool_search_output": true,
	}

	// Types proven only by inline sanitized payloads in this file (see
	// testdata/README.md) must be declared as mapped too — the checked-in
	// rollout capture does not carry them.
	for _, name := range []string{
		"exec_command_end", "patch_apply_end", "mcp_tool_call_end",
		"context_compacted", "thread_settings_applied", "error",
	} {
		if !mapped[name] {
			t.Errorf("inline-proven native type %q missing from DurableManifest.Mapped", name)
		}
	}

	// Fixture-proven native types must be declared as mapped.
	f, err := os.Open(filepath.Join("testdata", "rollout_current_sanitized.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	p := NewFileParser()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		ev, err := p.ParseLine(scanner.Bytes())
		if err != nil {
			t.Fatalf("parse fixture line: %v", err)
		}
		if ev == nil {
			continue
		}
		native := strings.SplitN(ev.Name, ":", 2)[0]
		if native == "unmapped" {
			t.Errorf("checked-in capture produced drift warning %q", ev.Name)
			continue
		}
		if !mapped[native] {
			t.Errorf("fixture-proven native type %q missing from DurableManifest.Mapped", native)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}

	// Every mapped name must dispatch to a handler instead of the unmapped
	// drift path when probed at its native scope. Probes carry only the type
	// discriminator; a parse error still proves a handler exists.
	for _, name := range DurableManifest.Mapped {
		var line string
		switch {
		case topLevel[name]:
			line = `{"timestamp":"2026-07-24T12:00:00Z","type":"` + name + `","payload":{}}`
		case responseItem[name]:
			line = `{"timestamp":"2026-07-24T12:00:00Z","type":"response_item","payload":{"type":"` + name + `"}}`
		default:
			line = `{"timestamp":"2026-07-24T12:00:00Z","type":"event_msg","payload":{"type":"` + name + `"}}`
		}
		ev, _ := NewFileParser().ParseLine([]byte(line))
		if ev != nil && strings.HasPrefix(ev.Name, "unmapped:") {
			t.Errorf("DurableManifest.Mapped claims %q but the parser has no handler for it", name)
		}
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

func TestDurableWatcherBaselinesHistoryAndCapturesFreshFile(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "2026", "07", "23", "rollout-old.jsonl")
	if err := os.MkdirAll(filepath.Dir(old), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old, []byte(sessionMetaLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(t.TempDir(), "codex-cursors.json")
	var got []event.Event
	w := NewDurableWatcher(root, statePath, 10*time.Millisecond, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	})
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("legacy history imported: %+v", got)
	}

	fresh := filepath.Join(root, "2026", "07", "24", "rollout-fresh.jsonl")
	if err := os.MkdirAll(filepath.Dir(fresh), 0o755); err != nil {
		t.Fatal(err)
	}
	lines := sessionMetaLine + "\n" +
		`{"timestamp":"2026-07-24T10:00:01Z","type":"event_msg","payload":{"type":"agent_message","turn_id":"t1","message":"fresh commentary"}}` + "\n"
	if err := os.WriteFile(fresh, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].Category != event.CategoryMessage || got[1].SessionID != "sess-codex-1" {
		t.Fatalf("fresh capture = %+v", got)
	}
}

func TestDurableWatcherBaselineKeepsContextForLaterAppends(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "2026", "07", "24", "rollout-existing.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	sessionLine := capturedRolloutLine(t, `"type":"session_meta"`)
	agentLine := capturedRolloutLine(t, `"type":"agent_message"`)
	if err := os.WriteFile(path, []byte(sessionLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var got []event.Event
	w := NewDurableWatcher(root, filepath.Join(t.TempDir(), "codex-cursors.json"), time.Second, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	})
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("baseline imported historical events: %+v", got)
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(agentLine + "\n")
	_ = f.Close()
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SessionID != "019f944c-e8a2-7092-b9e2-1bdfe7ec4ded" || got[0].CWD != "/tmp/agent-firehose-codex-fixture/work" {
		t.Fatalf("baseline context was not retained: %+v", got)
	}
}

func TestDurableWatcherQuarantinesCorruptCursorAndResumes(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "rollout-existing.jsonl")
	sessionLine := capturedRolloutLine(t, `"type":"session_meta"`)
	agentLine := capturedRolloutLine(t, `"type":"agent_message"`)
	if err := os.WriteFile(path, []byte(sessionLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(t.TempDir(), "codex-cursors.json")
	if err := os.WriteFile(statePath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	var got []event.Event
	w := NewDurableWatcher(root, statePath, time.Second, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	})
	if err := w.Initialize(); err != nil {
		t.Fatalf("corrupt cursor disabled capture: %v", err)
	}
	if len(got) != 1 || got[0].Name != "rollout_capture_error" || got[0].Severity != event.SeverityWarn {
		t.Fatalf("cursor recovery warning = %+v", got)
	}
	backups, err := filepath.Glob(statePath + ".corrupt-*")
	if err != nil || len(backups) != 1 {
		t.Fatalf("corrupt cursor was not quarantined: backups=%v err=%v", backups, err)
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(agentLine + "\n")
	_ = f.Close()
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].SessionID != "019f944c-e8a2-7092-b9e2-1bdfe7ec4ded" {
		t.Fatalf("capture did not resume with context: %+v", got)
	}
}

func TestDurableWatcherRecoversMissedLinesAfterRestart(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(t.TempDir(), "codex-cursors.json")
	path := filepath.Join(root, "2026", "07", "24", "rollout-fresh.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	var first []event.Event
	w1 := NewDurableWatcher(root, statePath, time.Second, func(ev event.Event) error {
		first = append(first, ev)
		return nil
	})
	if err := w1.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(sessionMetaLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := w1.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"timestamp":"2026-07-24T10:00:02Z","type":"event_msg","payload":{"type":"agent_message","turn_id":"t1","message":"missed while down"}}` + "\n")
	_ = f.Close()

	var recovered []event.Event
	w2 := NewDurableWatcher(root, statePath, time.Second, func(ev event.Event) error {
		recovered = append(recovered, ev)
		return nil
	})
	if err := w2.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := w2.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || !strings.Contains(recovered[0].Summary, "missed while down") {
		t.Fatalf("recovered = %+v", recovered)
	}
}

func TestDurableWatcherDoesNotAdvanceOnSinkFailure(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(t.TempDir(), "codex-cursors.json")
	var attemptedID string
	w := NewDurableWatcher(root, statePath, time.Second, func(ev event.Event) error {
		attemptedID = ev.ID
		return fmt.Errorf("spool unavailable")
	})
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "rollout-fresh.jsonl")
	if err := os.WriteFile(path, []byte(sessionMetaLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err == nil {
		t.Fatal("expected sink failure")
	}

	var replayed []event.Event
	w2 := NewDurableWatcher(root, statePath, time.Second, func(ev event.Event) error {
		replayed = append(replayed, ev)
		return nil
	})
	if err := w2.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := w2.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 1 || replayed[0].Name != "session_meta" || replayed[0].ID != attemptedID {
		t.Fatalf("failed append was not replayed: %+v", replayed)
	}
}

func TestDurableWatcherPersistsParseWarningsBeforeAdvancing(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(t.TempDir(), "codex-cursors.json")
	var got []event.Event
	w := NewDurableWatcher(root, statePath, time.Second, func(ev event.Event) error {
		got = append(got, ev)
		return nil
	})
	if err := w.Initialize(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "rollout-fresh.jsonl")
	if err := os.WriteFile(path, []byte("not json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := w.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "rollout_parse_error" || got[0].Severity != event.SeverityWarn {
		t.Fatalf("parse warning = %+v", got)
	}
}

func TestDurableWatcherRetriesInitializationAndWarningPersistence(t *testing.T) {
	root := t.TempDir()
	blockedParent := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blockedParent, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	w := NewDurableWatcher(root, filepath.Join(blockedParent, "cursor.json"), time.Second, nil)
	if err := w.Initialize(); err == nil || w.loaded {
		t.Fatalf("failed initialization must remain retryable: err=%v loaded=%v", err, w.loaded)
	}

	attempts := 0
	w.Sink = func(event.Event) error {
		attempts++
		if attempts == 1 {
			return fmt.Errorf("spool still unavailable")
		}
		return nil
	}
	w.report(fmt.Errorf("cursor unavailable"))
	w.report(fmt.Errorf("cursor unavailable"))
	w.report(fmt.Errorf("cursor unavailable"))
	if attempts != 2 {
		t.Fatalf("warning persistence attempts = %d, want 2", attempts)
	}
}
