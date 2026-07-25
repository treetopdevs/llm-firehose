// Package claudecode maps Claude Code (and Cursor-compatible) hook payloads
// delivered to `firehose hook-forward --source claude-code` into normalized
// events. Cursor uses camelCase hook names and tool_output; both are accepted.
package claudecode

import (
	"encoding/json"
	"fmt"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/workspace"
)

// Source is the agent family identifier for Claude Code events.
const Source = "claude-code"

type hookPayload struct {
	HookEventName string          `json:"hook_event_name"`
	SessionID     string          `json:"session_id"`
	PromptID      string          `json:"prompt_id"`
	CWD           string          `json:"cwd"`
	ToolName      string          `json:"tool_name"`
	ToolUseID     string          `json:"tool_use_id"`
	ToolResponse  json.RawMessage `json:"tool_response"`
	DurationMS    *int64          `json:"duration_ms"`
	IsInterrupt   *bool           `json:"is_interrupt"`
	Error         string          `json:"error"`
	Source        string          `json:"source"` // SessionStart source
	Reason        string          `json:"reason"` // SessionEnd reason
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

// Parse converts one hook payload into a normalized event.
func Parse(raw []byte) (event.Event, error) {
	var p hookPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return event.Event{}, fmt.Errorf("claudecode: %w", err)
	}
	hook := canonicalHookEvent(p.HookEventName)
	captured := time.Now().UTC()
	ev := event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: &captured,
		Source:      Source,
		Agent:       "claude",
		SessionID:   p.SessionID,
		PromptID:    p.PromptID,
		CallID:      p.ToolUseID,
		CWD:         p.CWD,
		Name:        hook,
		Severity:    event.SeverityInfo,
		Raw:         string(raw),
		Payload:     map[string]any{},
	}

	switch hook {
	case "UserPromptSubmit":
		ev.Category = event.CategoryPrompt
		ev.Summary = "prompt submitted"

	case "PreToolUse", "PostToolUse", "PostToolUseFailure":
		mapToolEvent(&ev, p, hook)

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
		ev.Summary = "agent finished responding"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "completed"

	case "StopFailure":
		ev.Category = event.CategoryError
		ev.Severity = event.SeverityError
		ev.Summary = "agent response failed"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "error"
		ev.Payload["error_class"] = stopFailureClass(p.Error)

	case "Notification":
		ev.Category = event.CategoryPermission
		ev.Severity = event.SeverityNotice
		ev.Summary = "notification received"

	case "PreCompact":
		ev.Category = event.CategoryMeta
		ev.Summary = "context compaction"

	default:
		ev.Category = event.CategoryMeta
		ev.Severity = event.SeverityWarn
		ev.Summary = "unrecognized hook event: " + p.HookEventName
	}
	return workspace.Enrich(ev), nil
}

func mapToolEvent(ev *event.Event, p hookPayload, hook string) {
	ev.Name = hook + ":" + p.ToolName
	ev.Category = categoryForTool(p.ToolName)
	ev.Payload["tool_name"] = p.ToolName

	switch hook {
	case "PreToolUse":
		ev.Summary = p.ToolName + " started"
		ev.Payload["phase"] = "start"
		ev.Payload["status"] = "started"
	case "PostToolUse":
		ev.Summary = p.ToolName + " completed"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "success"
		if interrupted := toolResponseInterrupted(p.ToolResponse); interrupted != nil {
			ev.Payload["interrupted"] = *interrupted
			if *interrupted {
				ev.Summary = p.ToolName + " interrupted"
				ev.Payload["status"] = "interrupted"
			}
		}
	case "PostToolUseFailure":
		ev.Severity = event.SeverityError
		ev.Summary = p.ToolName + " failed"
		ev.Payload["phase"] = "end"
		ev.Payload["status"] = "error"
		if p.IsInterrupt != nil {
			ev.Payload["interrupted"] = *p.IsInterrupt
			if *p.IsInterrupt {
				ev.Summary = p.ToolName + " interrupted"
				ev.Payload["status"] = "interrupted"
			}
		}
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
