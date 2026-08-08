// Package codexhook maps Codex lifecycle hook payloads into observational
// firehose events. Hooks never return decisions that can alter Codex.
package codexhook

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// Source is the source identifier accepted by the hook-forward command.
const Source = "codex-hook"

type payload struct {
	SessionID            string  `json:"session_id"`
	TranscriptPath       *string `json:"transcript_path"`
	CWD                  string  `json:"cwd"`
	HookEventName        string  `json:"hook_event_name"`
	TurnID               string  `json:"turn_id"`
	ToolName             string  `json:"tool_name"`
	ToolInput            any     `json:"tool_input"`
	ToolResponse         any     `json:"tool_response"`
	ToolUseID            string  `json:"tool_use_id"`
	Prompt               string  `json:"prompt"`
	Source               string  `json:"source"`
	Reason               string  `json:"reason"`
	Model                string  `json:"model"`
	PermissionMode       string  `json:"permission_mode"`
	LastAssistantMessage string  `json:"last_assistant_message"`
	StopHookActive       bool    `json:"stop_hook_active"`
	Trigger              string  `json:"trigger"`
	AgentID              string  `json:"agent_id"`
	AgentType            string  `json:"agent_type"`
	AgentTranscriptPath  *string `json:"agent_transcript_path"`
}

// Parse converts one native Codex hook payload to the shared event envelope.
func Parse(raw []byte) (event.Event, error) {
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return event.Event{}, fmt.Errorf("codex-hook: %w", err)
	}
	if p.HookEventName == "" {
		return event.Event{}, fmt.Errorf("codex-hook: hook_event_name is required")
	}
	captured := time.Now().UTC()
	ev := event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: &captured,
		Source:      "codex",
		Agent:       "codex",
		SessionID:   p.SessionID,
		TurnID:      p.TurnID,
		CallID:      p.ToolUseID,
		CWD:         p.CWD,
		Name:        p.HookEventName,
		Severity:    event.SeverityInfo,
		Raw:         string(raw),
		Payload: map[string]any{
			"transport": "hook",
		},
	}
	if p.Model != "" {
		ev.Payload["model"] = p.Model
	}
	if p.PermissionMode != "" {
		ev.Payload["permission_mode"] = p.PermissionMode
	}
	if p.ToolUseID != "" {
		ev.Payload["tool_use_id"] = p.ToolUseID
	}
	if p.TranscriptPath != nil && *p.TranscriptPath != "" {
		ev.Payload["transcript_path"] = *p.TranscriptPath
	}

	switch p.HookEventName {
	case "SessionStart":
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		ev.Summary = "Codex session started"
		ev.Payload["phase"] = "start"
		ev.Payload["status"] = "started"
		ev.Payload["session_source"] = p.Source
	case "SessionEnd":
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		ev.Summary = "Codex session ended"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"
		ev.Payload["reason"] = p.Reason
	case "UserPromptSubmit":
		ev.Category = event.CategoryPrompt
		ev.Summary = `prompt: "` + excerpt(p.Prompt, 80) + `"`
		ev.Payload["message"] = p.Prompt
	case "PreToolUse", "PostToolUse":
		toolEvent(&ev, p)
	case "PermissionRequest":
		ev.Category = event.CategoryPermission
		ev.Severity = event.SeverityNotice
		ev.Summary = "permission requested"
		ev.Payload["phase"] = "start"
		ev.Payload["tool_name"] = p.ToolName
		ev.Payload["status"] = "requested"
		ev.Payload["tool_input"] = p.ToolInput
	case "PreCompact":
		ev.Category = event.CategoryMeta
		ev.Summary = "context compaction started"
		ev.Payload["phase"] = "start"
		ev.Payload["status"] = "started"
		ev.Payload["trigger"] = p.Trigger
	case "PostCompact":
		ev.Category = event.CategoryMeta
		ev.Summary = "context compaction completed"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"
		ev.Payload["trigger"] = p.Trigger
	case "SubagentStart":
		ev.Category = event.CategorySession
		ev.Summary = "subagent started"
		ev.Payload["phase"] = "start"
		ev.Payload["status"] = "started"
		ev.Payload["agent_id"] = p.AgentID
		ev.Payload["agent_type"] = p.AgentType
	case "SubagentStop":
		ev.Category = event.CategorySession
		ev.Summary = "subagent stopped"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"
		ev.Payload["agent_id"] = p.AgentID
		ev.Payload["agent_type"] = p.AgentType
		if p.AgentTranscriptPath != nil {
			ev.Payload["agent_transcript_path"] = *p.AgentTranscriptPath
		}
		ev.Payload["output"] = p.LastAssistantMessage
	case "Stop":
		ev.Category = event.CategorySession
		ev.Summary = "Codex turn completed"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"
		ev.Payload["output"] = p.LastAssistantMessage
		ev.Payload["stop_hook_active"] = p.StopHookActive
	default:
		ev.Category = event.CategoryMeta
		ev.Severity = event.SeverityWarn
		ev.Summary = "unrecognized Codex hook event: " + p.HookEventName
	}
	return ev, nil
}

func toolEvent(ev *event.Event, p payload) {
	ev.Category = categoryForTool(p.ToolName)
	ev.Payload["tool_name"] = p.ToolName
	ev.Payload["tool_input"] = p.ToolInput
	phase, verb := "start", "started"
	if p.HookEventName == "PostToolUse" {
		phase, verb = "end", "completed"
		ev.Payload["output"] = flatten(p.ToolResponse)
		if failed(p.ToolResponse) {
			ev.Severity = event.SeverityError
			ev.Payload["status"] = "error"
			verb = "failed"
		} else {
			ev.Payload["status"] = "success"
		}
	}
	ev.Payload["phase"] = phase
	if phase == "start" {
		ev.Payload["status"] = "started"
	}
	ev.Summary = p.ToolName + " " + verb
	input, _ := p.ToolInput.(map[string]any)
	if ev.Category == event.CategoryShell {
		if command, _ := input["cmd"].(string); command != "" {
			ev.Summary = verb + ": " + excerpt(command, 100)
		} else if command, _ := input["command"].(string); command != "" {
			ev.Summary = verb + ": " + excerpt(command, 100)
		}
	}
	if ev.Category == event.CategoryFile {
		if path, _ := input["file_path"].(string); path != "" {
			ev.Summary = p.ToolName + " " + verb + " on " + filepath.Base(path)
			ev.Payload["file_path"] = path
		}
	}
}

func categoryForTool(name string) event.Category {
	switch strings.ToLower(name) {
	case "exec_command", "shell", "bash":
		return event.CategoryShell
	case "apply_patch", "edit", "write", "multiedit":
		return event.CategoryFile
	default:
		return event.CategoryTool
	}
}

func flatten(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprint(v)
		}
		return string(data)
	}
}

func failed(value any) bool {
	if text, ok := value.(string); ok {
		lower := strings.ToLower(text)
		return strings.Contains(lower, "process exited with code 1") ||
			strings.Contains(lower, "process exited with code 2") ||
			strings.Contains(lower, "error:")
	}
	m, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if success, ok := m["success"].(bool); ok && !success {
		return true
	}
	if isError, ok := m["isError"].(bool); ok && isError {
		return true
	}
	return m["error"] != nil
}

func excerpt(s string, max int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	runes := []rune(s)
	if len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return s
}
