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
		"PostToolUseFailure", "StopFailure", "PreCompact",
		"Notification", "SubagentStop", "Stop", "SessionEnd",
	},
	Filtered:     []string{"WorktreeCreate", "FileChanged"},
	SourceSchema: "claude-code@2.1.218",
}

type hookPayload struct {
	HookEventName    string          `json:"hook_event_name"`
	SessionID        string          `json:"session_id"`
	CWD              string          `json:"cwd"`
	PromptID         string          `json:"prompt_id"`
	TurnID           string          `json:"turn_id"`
	MessageID        string          `json:"message_id"`
	ToolName         string          `json:"tool_name"`
	ToolUseID        string          `json:"tool_use_id"`
	ToolInput        map[string]any  `json:"tool_input"`
	ToolResponse     json.RawMessage `json:"tool_response"`
	DurationMS       *float64        `json:"duration_ms"`
	IsInterrupt      *bool           `json:"is_interrupt"`
	Error            string          `json:"error"`
	Source           string          `json:"source"` // SessionStart source
	Reason           string          `json:"reason"` // SessionEnd reason
	PermissionMode   string          `json:"permission_mode"`
	NotificationType string          `json:"notification_type"`
	AgentID          string          `json:"agent_id"`
	AgentType        string          `json:"agent_type"`
	Effort           map[string]any  `json:"effort"`
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
		mapToolEvent(ev, p, hook)

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
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"

	case "StopFailure":
		// A failed agent response is a session-level failure: unlike a single
		// failing tool it sets the session error overlay deliberately.
		ev.Category = event.CategoryError
		ev.Severity = event.SeverityError
		ev.Summary = "agent response failed"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "error"
		ev.Payload["error_class"] = stopFailureClass(p.Error)

	case "PreCompact":
		ev.Category = event.CategoryMeta
		ev.Summary = "context compaction"

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

func mapToolEvent(ev *event.Event, p hookPayload, hook string) {
	ev.Name = hook + ":" + p.ToolName
	ev.Category = categoryForTool(p.ToolName)
	ev.Payload["tool_name"] = p.ToolName

	verb := "will run"
	switch hook {
	case "PreToolUse":
		ev.Payload["phase"] = "start"
		ev.Payload["status"] = "started"
	case "PostToolUse":
		verb = "ran"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "success"
		if interrupted := toolResponseInterrupted(p.ToolResponse); interrupted != nil {
			ev.Payload["interrupted"] = *interrupted
			if *interrupted {
				ev.Payload["status"] = "interrupted"
				verb = "interrupted"
			}
		}
	case "PostToolUseFailure":
		// A single failing tool is warn-level, matching the opencode and codex
		// adapters; it must not flip the whole session's error overlay.
		verb = "failed"
		ev.Severity = event.SeverityWarn
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "error"
		if p.IsInterrupt != nil {
			ev.Payload["interrupted"] = *p.IsInterrupt
			if *p.IsInterrupt {
				ev.Payload["status"] = "interrupted"
				verb = "interrupted"
			}
		}
	}

	switch {
	case p.ToolName == "Bash" || p.ToolName == "Shell":
		ev.Summary = verb + " shell tool"
	case fileTools[p.ToolName]:
		// The full path feeds the artifacts/files view (index.EventFilePaths);
		// only the base name surfaces in the summary.
		path, _ := p.ToolInput["file_path"].(string)
		ev.Summary = fmt.Sprintf("%s %s on %s", verb, p.ToolName, filepath.Base(path))
		ev.Payload["file_path"] = path
	default:
		ev.Summary = fmt.Sprintf("%s tool %s", verb, p.ToolName)
	}

	if p.DurationMS != nil && *p.DurationMS >= 0 {
		ev.Payload["duration_ms"] = *p.DurationMS
	}
}

func categoryForTool(name string) event.Category {
	switch {
	case name == "Bash" || name == "Shell":
		return event.CategoryShell
	case fileTools[name]:
		return event.CategoryFile
	default:
		return event.CategoryTool
	}
}

func toolResponseInterrupted(raw json.RawMessage) *bool {
	if len(raw) == 0 {
		return nil
	}
	var safe struct {
		Interrupted *bool `json:"interrupted"`
	}
	if err := json.Unmarshal(raw, &safe); err != nil {
		return nil
	}
	return safe.Interrupted
}

func stopFailureClass(class string) string {
	switch class {
	case "rate_limit", "overloaded", "authentication_failed",
		"oauth_org_not_allowed", "billing_error", "invalid_request",
		"model_not_found", "server_error", "max_output_tokens":
		return class
	default:
		return "unknown"
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
