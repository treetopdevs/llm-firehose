// Package claudecode maps Claude Code hook payloads (delivered on stdin to
// `firehose emit --source claude-code`) into normalized events.
package claudecode

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// Source is the agent family identifier for Claude Code events.
const Source = "claude-code"

type hookPayload struct {
	HookEventName string         `json:"hook_event_name"`
	SessionID     string         `json:"session_id"`
	CWD           string         `json:"cwd"`
	ToolName      string         `json:"tool_name"`
	ToolInput     map[string]any `json:"tool_input"`
	ToolResponse  any            `json:"tool_response"`
	Prompt        string         `json:"prompt"`
	Message       string         `json:"message"`
	Source        string         `json:"source"` // SessionStart source
	Reason        string         `json:"reason"` // SessionEnd reason
}

var fileTools = map[string]bool{
	"Edit": true, "Write": true, "MultiEdit": true, "NotebookEdit": true,
}

// Parse converts one hook payload into a normalized event.
func Parse(raw []byte) (event.Event, error) {
	var p hookPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return event.Event{}, fmt.Errorf("claudecode: %w", err)
	}
	ev := event.Event{
		ID:        event.NewID(),
		Time:      time.Now().UTC(),
		Source:    Source,
		Agent:     "claude",
		SessionID: p.SessionID,
		CWD:       p.CWD,
		Name:      p.HookEventName,
		Severity:  event.SeverityInfo,
		Raw:       string(raw),
		Payload:   map[string]any{},
	}

	switch p.HookEventName {
	case "UserPromptSubmit":
		ev.Category = event.CategoryPrompt
		ev.Summary = fmt.Sprintf("prompt: %q", excerpt(p.Prompt, 80))
		ev.Payload["prompt"] = p.Prompt

	case "PreToolUse", "PostToolUse":
		ev.Name = p.HookEventName + ":" + p.ToolName
		ev.Category = event.CategoryTool
		verb := "will run"
		if p.HookEventName == "PostToolUse" {
			verb = "ran"
		}
		switch {
		case p.ToolName == "Bash":
			ev.Category = event.CategoryShell
			cmd, _ := p.ToolInput["command"].(string)
			ev.Summary = fmt.Sprintf("%s: %s", verb, excerpt(cmd, 100))
		case fileTools[p.ToolName]:
			ev.Category = event.CategoryFile
			path, _ := p.ToolInput["file_path"].(string)
			ev.Summary = fmt.Sprintf("%s %s on %s", verb, p.ToolName, filepath.Base(path))
			ev.Payload["file_path"] = path
		default:
			ev.Summary = fmt.Sprintf("%s tool %s", verb, p.ToolName)
		}
		ev.Payload["tool_name"] = p.ToolName
		ev.Payload["tool_input"] = p.ToolInput
		if p.ToolResponse != nil {
			ev.Payload["tool_response"] = p.ToolResponse
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
		ev.Summary = "agent finished responding"

	case "Notification":
		ev.Category = event.CategoryPermission
		ev.Severity = event.SeverityNotice
		ev.Summary = excerpt(p.Message, 120)
		ev.Payload["message"] = p.Message

	case "PreCompact":
		ev.Category = event.CategoryMeta
		ev.Summary = "context compaction"

	default:
		ev.Category = event.CategoryMeta
		ev.Severity = event.SeverityWarn
		ev.Summary = "unrecognized hook event: " + p.HookEventName
	}
	return ev, nil
}

func excerpt(s string, max int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}
