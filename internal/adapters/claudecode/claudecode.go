// Package claudecode maps Claude Code (and Cursor-compatible) hook payloads
// delivered to `firehose hook-forward --source claude-code` into normalized
// events. Cursor uses camelCase hook names and tool_output; both are accepted.
package claudecode

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"agentfirehose/internal/capturemeta"
	"agentfirehose/internal/event"
	"agentfirehose/internal/workspace"
)

// Source is the agent family identifier for Claude Code events.
const Source = "claude-code"

// Manifest declares the locally observed and safely installed Claude Code
// hook surface. WorktreeCreate and FileChanged remain explicit coverage gaps.
var Manifest = capturemeta.Manifest{
	Source:    Source,
	Transport: "hook",
	Fidelity:  capturemeta.SupportedInBandHook,
	Mapped: []string{
		"SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion",
		"PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse",
		"PostToolUseFailure", "PostToolBatch", "Notification", "SubagentStart",
		"SubagentStop", "TaskCreated", "TaskCompleted", "Stop", "StopFailure",
		"TeammateIdle", "InstructionsLoaded", "ConfigChange", "CwdChanged",
		"WorktreeRemove", "PreCompact", "PostCompact", "Elicitation",
		"ElicitationResult", "SessionEnd", "MessageDisplay",
	},
	Filtered:     []string{"WorktreeCreate", "FileChanged"},
	SourceSchema: "claude-code@2.1.218",
}

type hookPayload struct {
	HookEventName    string         `json:"hook_event_name"`
	SessionID        string         `json:"session_id"`
	CWD              string         `json:"cwd"`
	PromptID         string         `json:"prompt_id"`
	TurnID           string         `json:"turn_id"`
	MessageID        string         `json:"message_id"`
	ToolName         string         `json:"tool_name"`
	ToolUseID        string         `json:"tool_use_id"`
	ToolInput        map[string]any `json:"tool_input"`
	DurationMS       float64        `json:"duration_ms"`
	IsInterrupt      *bool          `json:"is_interrupt"`
	Source           string         `json:"source"` // SessionStart source
	Reason           string         `json:"reason"` // SessionEnd reason
	PermissionMode   string         `json:"permission_mode"`
	NotificationType string         `json:"notification_type"`
	AgentID          string         `json:"agent_id"`
	AgentType        string         `json:"agent_type"`
	Effort           map[string]any `json:"effort"`
	Timestamp        string         `json:"timestamp"`
}

var fileTools = map[string]bool{
	"Edit": true, "Write": true, "MultiEdit": true, "NotebookEdit": true,
	"StrReplace": true, // Cursor
}

// cursorHookAliases maps Cursor camelCase hook names onto Claude Code's
// PascalCase names so one switch handles both emitters.
var cursorHookAliases = map[string]string{
	"preToolUse":         "PreToolUse",
	"postToolUse":        "PostToolUse",
	"postToolUseFailure": "PostToolUse",
	"userPromptSubmit":   "UserPromptSubmit",
	"beforeSubmitPrompt": "UserPromptSubmit",
	"sessionStart":       "SessionStart",
	"sessionEnd":         "SessionEnd",
	"subagentStop":       "SubagentStop",
	"stop":               "Stop",
	"preCompact":         "PreCompact",
	"notification":       "Notification",
}

func canonicalHookEvent(name string) string {
	if canon, ok := cursorHookAliases[name]; ok {
		return canon
	}
	return name
}

// Parse converts one hook payload into a normalized event.
func Parse(raw []byte) (event.Event, error) {
	var p hookPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return event.Event{}, fmt.Errorf("claudecode: %w", err)
	}
	hook := canonicalHookEvent(p.HookEventName)
	captured := time.Now().UTC()
	occurred := captured
	var sourceTime *time.Time
	if parsed, err := time.Parse(time.RFC3339Nano, p.Timestamp); err == nil {
		parsed = parsed.UTC()
		occurred = parsed
		sourceTime = &parsed
	}
	ev := event.Event{
		ID:          event.NewID(),
		Time:        occurred,
		SourceTime:  sourceTime,
		CaptureTime: &captured,
		Source:      Source,
		Agent:       "claude",
		SessionID:   p.SessionID,
		PromptID:    p.PromptID,
		TurnID:      p.TurnID,
		MessageID:   p.MessageID,
		CallID:      p.ToolUseID,
		Transport:   "hook",
		CWD:         p.CWD,
		Name:        hook,
		Severity:    event.SeverityInfo,
		Raw:         string(raw),
		Payload:     map[string]any{},
	}
	addCommonPayload(ev.Payload, p)

	switch hook {
	case "UserPromptSubmit", "UserPromptExpansion":
		ev.Category = event.CategoryPrompt
		ev.Summary = "user prompt submitted"
		if hook == "UserPromptExpansion" {
			ev.Summary = "user prompt expanded"
		}

	case "PreToolUse", "PostToolUse", "PostToolUseFailure":
		ev.Name = hook + ":" + p.ToolName
		ev.Category = event.CategoryTool
		verb := "will run"
		if hook == "PostToolUse" {
			verb = "ran"
			ev.Payload["status"] = "success"
		} else if hook == "PostToolUseFailure" {
			verb = "failed"
			ev.Payload["status"] = "error"
			ev.Severity = event.SeverityWarn
		} else {
			ev.Payload["status"] = "started"
		}
		switch {
		case p.ToolName == "Bash" || p.ToolName == "Shell":
			ev.Category = event.CategoryShell
			ev.Summary = verb + " shell tool"
		case fileTools[p.ToolName]:
			ev.Category = event.CategoryFile
			path, _ := p.ToolInput["file_path"].(string)
			ev.Summary = fmt.Sprintf("%s %s on %s", verb, p.ToolName, filepath.Base(path))
			ev.Payload["file_path"] = path
		default:
			ev.Summary = fmt.Sprintf("%s tool %s", verb, p.ToolName)
		}
		ev.Payload["tool_name"] = p.ToolName
		if p.DurationMS > 0 {
			ev.Payload["duration_ms"] = p.DurationMS
		}
		if p.IsInterrupt != nil {
			ev.Payload["interrupted"] = *p.IsInterrupt
		}

	case "SessionStart":
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		ev.Summary = "session started (" + orUnknown(p.Source) + ")"

	case "SessionEnd":
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		ev.Summary = "session ended (" + orUnknown(p.Reason) + ")"

	case "Stop", "SubagentStart", "SubagentStop", "TeammateIdle", "TaskCreated", "TaskCompleted":
		ev.Category = event.CategorySession
		ev.Summary = lifecycleSummary(hook)

	case "Notification":
		ev.Category = event.CategoryMeta
		if p.NotificationType == "permission_prompt" ||
			p.NotificationType == "elicitation_dialog" ||
			p.NotificationType == "elicitation_response" {
			ev.Category = event.CategoryPermission
		}
		ev.Severity = event.SeverityNotice
		ev.Summary = "notification"
		if p.NotificationType != "" {
			ev.Summary += ": " + p.NotificationType
		}

	case "PreCompact", "PostCompact":
		ev.Category = event.CategoryMeta
		ev.Summary = map[string]string{
			"PreCompact":  "context compaction starting",
			"PostCompact": "context compaction completed",
		}[hook]

	case "PermissionRequest", "PermissionDenied", "Elicitation", "ElicitationResult":
		ev.Category = event.CategoryPermission
		ev.Severity = event.SeverityNotice
		ev.Summary = lifecycleSummary(hook)
		if p.ToolName != "" {
			ev.Payload["tool_name"] = p.ToolName
		}

	case "PostToolBatch":
		ev.Category = event.CategoryTool
		ev.Summary = "tool batch completed"

	case "StopFailure":
		ev.Category = event.CategoryError
		ev.Severity = event.SeverityError
		ev.Summary = "agent turn failed"

	case "Setup", "InstructionsLoaded", "ConfigChange", "CwdChanged",
		"FileChanged", "WorktreeCreate", "WorktreeRemove", "MessageDisplay":
		ev.Category = event.CategoryMeta
		ev.Summary = lifecycleSummary(hook)

	default:
		warning := capturemeta.UnknownEvent(
			Source,
			"hook",
			p.HookEventName,
			"",
			"native hook event is not present in the Claude Code manifest",
			captured,
		)
		warning.Agent = ev.Agent
		warning.SessionID = ev.SessionID
		warning.PromptID = ev.PromptID
		warning.CWD = ev.CWD
		return workspace.Enrich(warning), nil
	}
	return workspace.Enrich(ev), nil
}

func addCommonPayload(payload map[string]any, p hookPayload) {
	if p.PermissionMode != "" {
		payload["permission_mode"] = p.PermissionMode
	}
	if level, ok := p.Effort["level"].(string); ok && level != "" {
		payload["effort_level"] = level
	}
	if p.AgentID != "" {
		payload["agent_id"] = p.AgentID
	}
	if p.AgentType != "" {
		payload["agent_type"] = p.AgentType
	}
	if p.NotificationType != "" {
		payload["notification_type"] = p.NotificationType
	}
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

func lifecycleSummary(hook string) string {
	summaries := map[string]string{
		"Setup":              "setup lifecycle",
		"Stop":               "agent finished responding",
		"StopFailure":        "agent turn failed",
		"SubagentStart":      "subagent started",
		"SubagentStop":       "subagent stopped",
		"TeammateIdle":       "teammate idle",
		"TaskCreated":        "task created",
		"TaskCompleted":      "task completed",
		"PermissionRequest":  "permission requested",
		"PermissionDenied":   "permission denied",
		"Elicitation":        "elicitation requested",
		"ElicitationResult":  "elicitation completed",
		"InstructionsLoaded": "instructions loaded",
		"ConfigChange":       "configuration changed",
		"CwdChanged":         "working directory changed",
		"FileChanged":        "watched file changed",
		"WorktreeCreate":     "worktree creation requested",
		"WorktreeRemove":     "worktree removed",
		"MessageDisplay":     "message display metadata",
	}
	if summary := summaries[hook]; summary != "" {
		return summary
	}
	return hook
}
