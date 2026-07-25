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
// hook surface. WorktreeCreate and FileChanged are deliberately skipped:
// observing the former would replace Claude's worktree behavior, while the
// latter requires a user-defined watch list.
var Manifest = capturemeta.Manifest{
	Source:    Source,
	Transport: "hook",
	Fidelity:  capturemeta.SupportedInBandHook,
	Mapped: []string{
		"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
		"Notification", "SubagentStop", "Stop", "SessionEnd",
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
	"postToolUseFailure": "PostToolUseFailure",
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

// Parse converts one hook payload into a normalized event. A nil event means
// the hook family is deliberately filtered.
func Parse(raw []byte) (*event.Event, error) {
	var p hookPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("claudecode: %w", err)
	}
	hook := canonicalHookEvent(p.HookEventName)
	if hook == "WorktreeCreate" || hook == "FileChanged" {
		return nil, nil
	}
	captured := time.Now().UTC()
	ev := &event.Event{
		ID:          event.NewID(),
		Time:        captured,
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
	case "UserPromptSubmit":
		ev.Category = event.CategoryPrompt
		ev.Summary = "user prompt submitted"

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

	case "Stop", "SubagentStop":
		ev.Category = event.CategorySession
		ev.Summary = lifecycleSummary(hook)

	case "Notification":
		// Older Claude and Cursor payloads omit notification_type. Preserve the
		// conservative needs-input behavior unless a real fixture proves a
		// notification family is non-blocking.
		ev.Category = event.CategoryPermission
		ev.Severity = event.SeverityNotice
		ev.Summary = "notification"
		if p.NotificationType != "" {
			ev.Summary += ": " + p.NotificationType
		}

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
		enriched := workspace.Enrich(warning)
		return &enriched, nil
	}
	enriched := workspace.Enrich(*ev)
	return &enriched, nil
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
		"Stop":         "agent finished responding",
		"SubagentStop": "subagent stopped",
	}
	if summary := summaries[hook]; summary != "" {
		return summary
	}
	return hook
}
