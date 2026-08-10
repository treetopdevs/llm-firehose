// Package codex tails Codex rollout session files
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) and maps their lines into
// normalized events. The daemon persists mapped observations to the spool;
// the daemonless TUI displays them without re-persisting.
package codex

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/workspace"
)

// Source is the agent family identifier for Codex events.
const Source = "codex"

type rolloutLine struct {
	Timestamp time.Time       `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type eventMsgPayload struct {
	Type             string          `json:"type"`
	TurnID           string          `json:"turn_id"`
	CallID           string          `json:"call_id"`
	Message          string          `json:"message"`
	Phase            string          `json:"phase"`
	Command          []string        `json:"command"`
	ExitCode         *int            `json:"exit_code"`
	Success          *bool           `json:"success"`
	Changes          map[string]any  `json:"changes"`
	LastAgentMessage string          `json:"last_agent_message"`
	Action           json.RawMessage `json:"action"`
	Info             json.RawMessage `json:"info"`
	RateLimits       json.RawMessage `json:"rate_limits"`
	ThreadSettings   json.RawMessage `json:"thread_settings"`
	StartedAt        int64           `json:"started_at"`
	CompletedAt      int64           `json:"completed_at"`
	DurationMS       int64           `json:"duration_ms"`
	TimeToFirstToken int64           `json:"time_to_first_token_ms"`
	ModelContext     int64           `json:"model_context_window"`
	Collaboration    string          `json:"collaboration_mode_kind"`
	Invocation       struct {
		Server    string          `json:"server"`
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"invocation"`
	Duration struct {
		Secs  int64 `json:"secs"`
		Nanos int64 `json:"nanos"`
	} `json:"duration"`
	Result        json.RawMessage `json:"result"`
	EventID       string          `json:"event_id"`
	OccurredAtMS  int64           `json:"occurred_at_ms"`
	AgentThreadID string          `json:"agent_thread_id"`
	AgentPath     string          `json:"agent_path"`
	Kind          string          `json:"kind"`
	ThreadID      string          `json:"thread_id"`
	Item          json.RawMessage `json:"item"`
}

type callContext struct {
	name     string
	category event.Category
	turnID   string
	started  time.Time
}

// ParserState is the durable context needed to resume parsing in the middle of
// a rollout without losing session or tool-call correlation.
type ParserState struct {
	SessionID string                     `json:"session_id,omitempty"`
	CWD       string                     `json:"cwd,omitempty"`
	Calls     map[string]ParserCallState `json:"calls,omitempty"`
	Warned    map[string]bool            `json:"warned,omitempty"`
}

// ParserCallState is the serializable form of an in-flight call.
type ParserCallState struct {
	Name     string         `json:"name"`
	Category event.Category `json:"category"`
	TurnID   string         `json:"turn_id,omitempty"`
	Started  time.Time      `json:"started,omitempty"`
}

// FileParser converts one rollout file's lines into events, carrying session,
// call, and adapter-drift context across lines.
type FileParser struct {
	sessionID string
	cwd       string
	calls     map[string]callContext
	warned    map[string]bool
}

func NewFileParser() *FileParser {
	return &FileParser{
		calls:  map[string]callContext{},
		warned: map[string]bool{},
	}
}

// NewFileParserFrom resumes from a previously checkpointed parser state.
func NewFileParserFrom(state ParserState) *FileParser {
	p := NewFileParser()
	p.Restore(state)
	return p
}

// Snapshot returns an independent, serializable parser state.
func (p *FileParser) Snapshot() ParserState {
	state := ParserState{
		SessionID: p.sessionID,
		CWD:       p.cwd,
		Calls:     make(map[string]ParserCallState, len(p.calls)),
		Warned:    make(map[string]bool, len(p.warned)),
	}
	for id, call := range p.calls {
		state.Calls[id] = ParserCallState{
			Name: call.name, Category: call.category, TurnID: call.turnID, Started: call.started,
		}
	}
	for kind, warned := range p.warned {
		state.Warned[kind] = warned
	}
	return state
}

// Restore replaces the parser's context with a prior snapshot.
func (p *FileParser) Restore(state ParserState) {
	p.sessionID, p.cwd = state.SessionID, state.CWD
	p.calls = make(map[string]callContext, len(state.Calls))
	for id, call := range state.Calls {
		p.calls[id] = callContext{
			name: call.Name, category: call.Category, turnID: call.TurnID, started: call.Started,
		}
	}
	p.warned = make(map[string]bool, len(state.Warned))
	for kind, warned := range state.Warned {
		p.warned[kind] = warned
	}
}

// ParseLine maps one JSONL line to an event. A nil event with nil error means
// the line is deliberately skipped (duplicate messages, reasoning, etc.).
func (p *FileParser) ParseLine(line []byte) (*event.Event, error) {
	var rl rolloutLine
	if err := json.Unmarshal(line, &rl); err != nil {
		return nil, fmt.Errorf("codex: %w", err)
	}
	switch rl.Type {
	case "session_meta":
		return p.parseSessionMeta(rl)
	case "event_msg":
		return p.parseEventMsg(rl)
	case "response_item":
		return p.parseResponseItem(rl)
	case "turn_context":
		return p.parseTurnContext(rl)
	case "world_state":
		return p.parseWorldState(rl)
	case "compacted":
		ev := p.base(rl, event.CategoryMeta, "compacted")
		ev.Summary = "context compaction completed"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"
		return ev, nil
	case "inter_agent_communication_metadata":
		var metadata struct {
			TriggerTurn bool `json:"trigger_turn"`
		}
		_ = json.Unmarshal(rl.Payload, &metadata)
		ev := p.base(rl, event.CategoryMeta, rl.Type)
		ev.Summary = "inter-agent communication"
		ev.Payload["trigger_turn"] = metadata.TriggerTurn
		return ev, nil
	default:
		return p.unmapped(rl, "outer:"+rl.Type)
	}
}

func (p *FileParser) base(rl rolloutLine, cat event.Category, name string) *event.Event {
	captureTime := time.Now().UTC()
	ev := event.Event{
		ID:          event.NewID(),
		Time:        captureTime,
		CaptureTime: &captureTime,
		Source:      Source,
		Agent:       "codex",
		SessionID:   p.sessionID,
		CWD:         p.cwd,
		Category:    cat,
		Name:        name,
		Severity:    event.SeverityInfo,
		Payload:     map[string]any{"transport": "rollout"},
	}
	if !rl.Timestamp.IsZero() {
		sourceTime := rl.Timestamp
		ev.Time = sourceTime
		ev.SourceTime = &sourceTime
	}
	enriched := workspace.Enrich(ev)
	return &enriched
}

func (p *FileParser) parseSessionMeta(rl rolloutLine) (*event.Event, error) {
	var m struct {
		ID         string `json:"id"`
		CWD        string `json:"cwd"`
		Originator string `json:"originator"`
		CLIVersion string `json:"cli_version"`
		Source     string `json:"source"`
	}
	if err := json.Unmarshal(rl.Payload, &m); err != nil {
		return nil, err
	}
	p.sessionID, p.cwd = m.ID, m.CWD
	ev := p.base(rl, event.CategorySession, "session_meta")
	ev.Severity = event.SeverityNotice
	ev.Summary = fmt.Sprintf("codex session started (%s %s)", m.Originator, m.CLIVersion)
	ev.Payload["originator"] = m.Originator
	ev.Payload["cli_version"] = m.CLIVersion
	ev.Payload["session_source"] = m.Source
	return ev, nil
}

func (p *FileParser) parseTurnContext(rl rolloutLine) (*event.Event, error) {
	var m struct {
		TurnID            string `json:"turn_id"`
		CWD               string `json:"cwd"`
		Model             string `json:"model"`
		Effort            string `json:"effort"`
		ApprovalPolicy    string `json:"approval_policy"`
		ApprovalsReviewer string `json:"approvals_reviewer"`
		Personality       string `json:"personality"`
		SandboxPolicy     struct {
			Type string `json:"type"`
		} `json:"sandbox_policy"`
		PermissionProfile struct {
			Type string `json:"type"`
		} `json:"permission_profile"`
		CollaborationMode struct {
			Mode string `json:"mode"`
		} `json:"collaboration_mode"`
	}
	if err := json.Unmarshal(rl.Payload, &m); err != nil {
		return nil, err
	}
	if m.CWD != "" {
		p.cwd = m.CWD
	}
	ev := p.base(rl, event.CategoryMeta, "turn_context")
	ev.TurnID = m.TurnID
	ev.Summary = compactJoin(m.Model, m.Effort, m.SandboxPolicy.Type, approvals(m.ApprovalPolicy))
	ev.Payload["model"] = m.Model
	ev.Payload["effort"] = m.Effort
	ev.Payload["approval_policy"] = m.ApprovalPolicy
	ev.Payload["approvals_reviewer"] = m.ApprovalsReviewer
	ev.Payload["sandbox_mode"] = m.SandboxPolicy.Type
	ev.Payload["permission_mode"] = m.PermissionProfile.Type
	ev.Payload["collaboration_mode"] = m.CollaborationMode.Mode
	ev.Payload["personality"] = m.Personality
	return ev, nil
}

func (p *FileParser) parseWorldState(rl rolloutLine) (*event.Event, error) {
	var m struct {
		Full  bool                       `json:"full"`
		State map[string]json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal(rl.Payload, &m); err != nil {
		return nil, err
	}
	sections := make([]string, 0, len(m.State))
	for name := range m.State {
		sections = append(sections, name)
	}
	sort.Strings(sections)
	ev := p.base(rl, event.CategoryMeta, "world_state")
	ev.Summary = fmt.Sprintf("world state %s (%d sections)", map[bool]string{true: "snapshot", false: "update"}[m.Full], len(sections))
	ev.Payload["full"] = m.Full
	ev.Payload["changed_sections"] = sections
	return ev, nil
}

func (p *FileParser) parseEventMsg(rl rolloutLine) (*event.Event, error) {
	var m eventMsgPayload
	if err := json.Unmarshal(rl.Payload, &m); err != nil {
		return nil, err
	}
	switch m.Type {
	case "user_message":
		ev := p.base(rl, event.CategoryPrompt, m.Type)
		ev.TurnID = m.TurnID
		ev.Summary = fmt.Sprintf("prompt: %q", excerpt(m.Message, 80))
		ev.Payload["message"] = m.Message
		return ev, nil
	case "agent_message":
		ev := p.base(rl, event.CategoryMessage, m.Type)
		ev.TurnID = m.TurnID
		ev.Summary = excerpt(m.Message, 120)
		ev.Payload["message"] = m.Message
		if m.Phase != "" {
			ev.Payload["phase"] = m.Phase
		}
		return ev, nil
	case "agent_reasoning":
		return nil, nil
	case "context_compacted":
		ev := p.base(rl, event.CategoryMeta, m.Type)
		ev.Summary = "context compaction completed"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"
		return ev, nil
	case "sub_agent_activity":
		ev := p.base(rl, event.CategorySession, m.Type)
		ev.CallID = m.EventID
		ev.Summary = "subagent " + firstNonEmpty(m.Kind, "activity")
		ev.Payload["phase"] = phaseForKind(m.Kind)
		ev.Payload["status"] = m.Kind
		ev.Payload["agent_thread_id"] = m.AgentThreadID
		ev.Payload["agent_path"] = m.AgentPath
		ev.Payload["occurred_at_ms"] = m.OccurredAtMS
		return ev, nil
	case "item_completed":
		var item struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		_ = json.Unmarshal(m.Item, &item)
		ev := p.base(rl, event.CategoryMeta, m.Type)
		ev.TurnID = m.TurnID
		ev.Summary = firstNonEmpty(item.Type, "item") + " completed"
		ev.Payload["status"] = "completed"
		ev.Payload["item_type"] = item.Type
		ev.Payload["item_id"] = item.ID
		return ev, nil
	case "token_count":
		return p.tokenCount(rl, m.Info, m.RateLimits)
	case "exec_command_end":
		ev := p.base(rl, event.CategoryShell, m.Type)
		ev.TurnID, ev.CallID = m.TurnID, m.CallID
		ev.Summary = "ran: " + excerpt(shellCommand(m.Command), 100)
		ev.Payload["phase"] = "end"
		ev.Payload["tool_name"] = "exec_command"
		ev.Payload["command"] = shellCommand(m.Command)
		ev.Payload["status"] = "success"
		if m.ExitCode != nil {
			ev.Payload["exit_code"] = *m.ExitCode
			if *m.ExitCode != 0 {
				ev.Severity = event.SeverityWarn
				ev.Payload["status"] = "error"
			}
		}
		return ev, nil
	case "patch_apply_end":
		ev := p.base(rl, event.CategoryFile, m.Type)
		ev.TurnID, ev.CallID = m.TurnID, m.CallID
		ev.Payload["phase"] = "end"
		ev.Payload["tool_name"] = "apply_patch"
		ev.Payload["status"] = "success"
		files := make([]string, 0, len(m.Changes))
		for path := range m.Changes {
			files = append(files, filepath.Base(path))
		}
		sort.Strings(files)
		if m.Success != nil && !*m.Success {
			ev.Severity, ev.Summary = event.SeverityError, "patch failed"
			ev.Payload["status"] = "error"
		} else {
			ev.Summary = "patched " + excerpt(strings.Join(files, ", "), 100)
		}
		ev.Payload["changes"] = m.Changes
		return ev, nil
	case "task_started":
		ev := p.base(rl, event.CategorySession, m.Type)
		ev.TurnID = m.TurnID
		ev.Summary = "turn started"
		ev.Payload["phase"] = "start"
		ev.Payload["status"] = "started"
		ev.Payload["started_at"] = m.StartedAt
		ev.Payload["model_context_window"] = m.ModelContext
		ev.Payload["collaboration_mode"] = m.Collaboration
		return ev, nil
	case "task_complete":
		ev := p.base(rl, event.CategorySession, m.Type)
		ev.TurnID = m.TurnID
		ev.Summary = "turn complete: " + excerpt(m.LastAgentMessage, 100)
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"
		ev.Payload["duration_ms"] = m.DurationMS
		ev.Payload["time_to_first_token_ms"] = m.TimeToFirstToken
		ev.Payload["output"] = m.LastAgentMessage
		return ev, nil
	case "web_search_end":
		ev := p.base(rl, event.CategoryTool, m.Type)
		ev.TurnID = m.TurnID
		var action struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(m.Action, &action)
		ev.Summary = "web search: " + excerpt(action.Query, 90)
		ev.Payload["phase"] = "end"
		ev.Payload["tool_name"] = "web_search"
		ev.Payload["status"] = "completed"
		ev.Payload["query"] = action.Query
		return ev, nil
	case "mcp_tool_call_end":
		return p.mcpToolEnd(rl, m)
	case "thread_settings_applied":
		return p.threadSettings(rl, m.ThreadSettings)
	case "error", "stream_error", "turn_aborted":
		ev := p.base(rl, event.CategoryError, m.Type)
		ev.TurnID = m.TurnID
		ev.Severity = event.SeverityError
		ev.Payload["status"] = "error"
		ev.Summary = excerpt(m.Message, 120)
		if ev.Summary == "" {
			ev.Summary = m.Type
		}
		return ev, nil
	default:
		return p.unmapped(rl, m.Type)
	}
}

func (p *FileParser) tokenCount(rl rolloutLine, infoRaw, limitsRaw json.RawMessage) (*event.Event, error) {
	var info struct {
		TotalTokenUsage map[string]any `json:"total_token_usage"`
		LastTokenUsage  map[string]any `json:"last_token_usage"`
		ContextWindow   int64          `json:"model_context_window"`
	}
	if err := json.Unmarshal(infoRaw, &info); err != nil {
		return nil, err
	}
	var limits map[string]any
	if len(limitsRaw) > 0 && string(limitsRaw) != "null" {
		_ = json.Unmarshal(limitsRaw, &limits)
	}
	total := int64FromAny(info.TotalTokenUsage["total_tokens"])
	last := int64FromAny(info.LastTokenUsage["total_tokens"])
	ev := p.base(rl, event.CategoryMeta, "token_count")
	ev.Summary = fmt.Sprintf("tokens: %s total (%s latest)", comma(total), comma(last))
	ev.Payload["usage"] = map[string]any{
		"total":                info.TotalTokenUsage,
		"latest":               info.LastTokenUsage,
		"model_context_window": info.ContextWindow,
	}
	ev.Payload["rate_limits"] = limits
	return ev, nil
}

func (p *FileParser) threadSettings(rl rolloutLine, raw json.RawMessage) (*event.Event, error) {
	var s struct {
		Model          string `json:"model"`
		ServiceTier    string `json:"service_tier"`
		ApprovalPolicy string `json:"approval_policy"`
		CWD            string `json:"cwd"`
		Effort         string `json:"reasoning_effort"`
		Personality    string `json:"personality"`
		Permission     struct {
			Type string `json:"type"`
		} `json:"permission_profile"`
		Collaboration struct {
			Mode string `json:"mode"`
		} `json:"collaboration_mode"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	ev := p.base(rl, event.CategoryMeta, "thread_settings_applied")
	ev.Summary = "settings: " + compactJoin(s.Model, s.Effort, s.Permission.Type, approvals(s.ApprovalPolicy))
	ev.Payload["model"] = s.Model
	ev.Payload["service_tier"] = s.ServiceTier
	ev.Payload["effort"] = s.Effort
	ev.Payload["approval_policy"] = s.ApprovalPolicy
	ev.Payload["permission_mode"] = s.Permission.Type
	ev.Payload["collaboration_mode"] = s.Collaboration.Mode
	ev.Payload["personality"] = s.Personality
	return ev, nil
}

func (p *FileParser) mcpToolEnd(rl rolloutLine, m eventMsgPayload) (*event.Event, error) {
	name := m.Invocation.Server + "/" + m.Invocation.Tool
	ctx := p.calls[m.CallID]
	if ctx.name != "" {
		name = ctx.name
	}
	category := ctx.category
	if category == "" {
		category = event.CategoryTool
	}
	ev := p.base(rl, category, "mcp_tool_call_end:"+name)
	ev.TurnID, ev.CallID = firstNonEmpty(m.TurnID, ctx.turnID), m.CallID
	ev.Summary = "MCP completed: " + name
	ev.Payload["phase"] = "end"
	ev.Payload["tool_name"] = name
	ev.Payload["status"] = "completed"
	ev.Payload["duration_ms"] = m.Duration.Secs*1000 + m.Duration.Nanos/1_000_000
	ev.Payload["output"] = flattenMCPResult(m.Result)
	if mcpResultIsError(m.Result) {
		ev.Severity = event.SeverityWarn
		ev.Payload["status"] = "error"
	}
	delete(p.calls, m.CallID)
	return ev, nil
}

func (p *FileParser) parseResponseItem(rl rolloutLine) (*event.Event, error) {
	var m struct {
		Type      string          `json:"type"`
		Name      string          `json:"name"`
		Namespace string          `json:"namespace"`
		Arguments json.RawMessage `json:"arguments"`
		Input     string          `json:"input"`
		Output    json.RawMessage `json:"output"`
		CallID    string          `json:"call_id"`
		Status    string          `json:"status"`
		Execution string          `json:"execution"`
		Metadata  struct {
			TurnID string `json:"turn_id"`
		} `json:"internal_chat_message_metadata_passthrough"`
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(rl.Payload, &m); err != nil {
		return nil, err
	}
	switch m.Type {
	case "message", "agent_message", "reasoning":
		return nil, nil
	case "function_call", "custom_tool_call", "tool_search_call":
		name := rolloutToolName(m.Namespace, m.Name)
		if m.Type == "tool_search_call" {
			name = "tool_search"
		}
		cat := toolCategory(name)
		ev := p.base(rl, cat, m.Type+":"+name)
		ev.TurnID, ev.CallID = m.Metadata.TurnID, m.CallID
		ev.Summary = "tool started: " + name
		ev.Payload["phase"] = "start"
		ev.Payload["tool_name"] = name
		ev.Payload["status"] = firstNonEmpty(m.Status, "started")
		if arguments := flattenJSONText(m.Arguments); arguments != "" {
			ev.Payload["arguments"] = arguments
		}
		if m.Input != "" {
			ev.Payload["input"] = m.Input
		}
		p.calls[m.CallID] = callContext{name: name, category: cat, turnID: m.Metadata.TurnID, started: rl.Timestamp}
		return ev, nil
	case "function_call_output", "custom_tool_call_output", "tool_search_output":
		ctx := p.calls[m.CallID]
		name := ctx.name
		if name == "" && m.Type == "tool_search_output" {
			name = "tool_search"
		}
		cat := ctx.category
		if cat == "" {
			cat = event.CategoryTool
		}
		ev := p.base(rl, cat, m.Type+":"+name)
		ev.TurnID, ev.CallID = firstNonEmpty(m.Metadata.TurnID, ctx.turnID), m.CallID
		ev.Summary = "tool completed: " + name
		ev.Payload["phase"] = "end"
		ev.Payload["tool_name"] = name
		ev.Payload["status"] = firstNonEmpty(m.Status, "completed")
		output := flattenOutput(m.Output)
		if m.Type == "tool_search_output" && output == "" {
			names := make([]string, 0, len(m.Tools))
			for _, tool := range m.Tools {
				if tool.Name != "" {
					names = append(names, tool.Name)
				}
			}
			output = strings.Join(names, "\n")
		}
		ev.Payload["output"] = output
		if !ctx.started.IsZero() {
			ev.Payload["duration_ms"] = rl.Timestamp.Sub(ctx.started).Milliseconds()
		}
		delete(p.calls, m.CallID)
		return ev, nil
	case "local_shell_call":
		ev := p.base(rl, event.CategoryShell, m.Type)
		ev.TurnID, ev.CallID = m.Metadata.TurnID, m.CallID
		ev.Summary = "shell call"
		ev.Payload["phase"] = "start"
		ev.Payload["tool_name"] = "shell"
		ev.Payload["status"] = firstNonEmpty(m.Status, "started")
		return ev, nil
	default:
		return p.unmapped(rl, "response_item:"+m.Type)
	}
}

func (p *FileParser) unmapped(rl rolloutLine, kind string) (*event.Event, error) {
	if kind == "" || p.warned[kind] {
		return nil, nil
	}
	p.warned[kind] = true
	ev := p.base(rl, event.CategoryMeta, "unmapped:"+strings.TrimPrefix(kind, "response_item:"))
	ev.Severity = event.SeverityWarn
	ev.Summary = "unmapped Codex rollout record: " + kind
	ev.Payload["record_type"] = kind
	return ev, nil
}

func toolCategory(name string) event.Category {
	switch strings.ToLower(name) {
	case "bash", "exec_command", "shell":
		return event.CategoryShell
	case "apply_patch", "edit", "write":
		return event.CategoryFile
	default:
		return event.CategoryTool
	}
}

func rolloutToolName(namespace, name string) string {
	if strings.HasPrefix(namespace, "mcp__") {
		return strings.TrimPrefix(namespace, "mcp__") + "/" + name
	}
	return name
}

func flattenOutput(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var blocks []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var out []string
		for _, block := range blocks {
			if block.Text != "" {
				out = append(out, block.Text)
			}
		}
		return strings.Join(out, "\n")
	}
	return string(raw)
}

func flattenJSONText(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return ""
	}
	if raw[0] == '"' {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return text
		}
	}
	var compact bytes.Buffer
	if json.Compact(&compact, raw) == nil {
		return compact.String()
	}
	return string(raw)
}

func flattenMCPResult(raw json.RawMessage) string {
	var result struct {
		OK struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"Ok"`
		Err any `json:"Err"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return ""
	}
	var out []string
	for _, block := range result.OK.Content {
		if block.Text != "" {
			out = append(out, block.Text)
		}
	}
	return strings.Join(out, "\n")
}

func mcpResultIsError(raw json.RawMessage) bool {
	var result struct {
		OK struct {
			IsError bool `json:"isError"`
		} `json:"Ok"`
		Err any `json:"Err"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return true
	}
	return result.Err != nil || result.OK.IsError
}

func shellCommand(argv []string) string {
	if len(argv) >= 3 && strings.HasSuffix(argv[0], "sh") && strings.HasPrefix(argv[1], "-") {
		return argv[len(argv)-1]
	}
	return strings.Join(argv, " ")
}

func excerpt(s string, max int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}

func compactJoin(parts ...string) string {
	var out []string
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			out = append(out, part)
		}
	}
	return strings.Join(out, " · ")
}

func approvals(policy string) string {
	policy = strings.TrimSpace(policy)
	if policy == "" {
		return ""
	}
	return policy + " approvals"
}

func int64FromAny(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case json.Number:
		value, _ := n.Int64()
		return value
	}
	return 0
}

func comma(n int64) string {
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func phaseForKind(kind string) string {
	switch strings.ToLower(kind) {
	case "started", "start":
		return "start"
	case "completed", "stopped", "finished", "end":
		return "end"
	default:
		return "update"
	}
}
