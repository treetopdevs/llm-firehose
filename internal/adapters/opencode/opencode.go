// Package opencode maps OpenCode bus events into normalized events. Capture
// works through an OpenCode plugin (see plugin.go) that forwards each bus
// event to `firehose hook-forward --source opencode` as JSON on stdin.
package opencode

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"agentfirehose/internal/event"
)

// Source is the agent family identifier for OpenCode events.
const Source = "opencode"

type busEvent struct {
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"properties"`
	Directory  string          `json:"directory"` // added by the plugin
}

var fileToolNames = map[string]bool{"edit": true, "write": true, "patch": true, "multiedit": true}

// Parse maps one forwarded bus event to a normalized event. A nil event with
// nil error means the bus event is deliberately skipped (streaming noise).
func Parse(raw []byte) (*event.Event, error) {
	var be busEvent
	if err := json.Unmarshal(raw, &be); err != nil {
		return nil, fmt.Errorf("opencode: %w", err)
	}
	var props map[string]any
	if len(be.Properties) > 0 {
		if err := json.Unmarshal(be.Properties, &props); err != nil {
			return nil, fmt.Errorf("opencode: properties: %w", err)
		}
	}
	ev := &event.Event{
		ID:        event.NewID(),
		Time:      time.Now().UTC(),
		Source:    Source,
		Agent:     "opencode",
		SessionID: sessionID(props),
		CWD:       be.Directory,
		Name:      be.Type,
		Severity:  event.SeverityInfo,
		Payload:   props,
		Raw:       string(raw),
	}

	switch be.Type {
	case "session.idle":
		ev.Category = event.CategorySession
		ev.Summary = "session idle"
	case "session.created":
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		ev.Summary = "session started"
	case "session.deleted":
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		ev.Summary = "session deleted"
	case "session.error":
		ev.Category = event.CategoryError
		ev.Severity = event.SeverityError
		ev.Summary = "session error: " + errorSummary(props)
	case "message.updated":
		info, _ := props["info"].(map[string]any)
		role, _ := info["role"].(string)
		if id, ok := info["sessionID"].(string); ok {
			ev.SessionID = id
		}
		if role == "user" {
			ev.Category = event.CategoryPrompt
			ev.Summary = "user prompt"
		} else {
			ev.Category = event.CategoryMessage
			ev.Summary = "assistant message"
		}
	case "message.part.updated":
		return parsePart(ev, props)
	case "permission.updated":
		ev.Category = event.CategoryPermission
		ev.Severity = event.SeverityNotice
		title, _ := props["title"].(string)
		ev.Summary = "permission requested: " + title
	case "permission.replied":
		ev.Category = event.CategoryPermission
		ev.Severity = event.SeverityNotice
		resp, _ := props["response"].(string)
		ev.Summary = "permission answered: " + resp
	case "file.edited":
		ev.Category = event.CategoryFile
		file, _ := props["file"].(string)
		ev.Summary = "edited " + filepath.Base(file)
	default:
		return nil, nil
	}
	return ev, nil
}

// parsePart maps tool-call parts; text/reasoning parts stream too often to show.
func parsePart(ev *event.Event, props map[string]any) (*event.Event, error) {
	part, _ := props["part"].(map[string]any)
	if part["type"] != "tool" {
		return nil, nil
	}
	state, _ := part["state"].(map[string]any)
	status, _ := state["status"].(string)
	if status != "completed" && status != "error" {
		return nil, nil // wait for the terminal update
	}
	if id, ok := part["sessionID"].(string); ok {
		ev.SessionID = id
	}
	tool, _ := part["tool"].(string)
	input, _ := state["input"].(map[string]any)
	ev.Name = "tool:" + tool
	switch {
	case tool == "bash":
		ev.Category = event.CategoryShell
		cmd, _ := input["command"].(string)
		ev.Summary = "ran: " + cmd
	case fileToolNames[tool]:
		ev.Category = event.CategoryFile
		path, _ := input["filePath"].(string)
		ev.Summary = fmt.Sprintf("%s %s", tool, filepath.Base(path))
	default:
		ev.Category = event.CategoryTool
		ev.Summary = "tool: " + tool
	}
	if status == "error" {
		ev.Severity = event.SeverityWarn
	}
	return ev, nil
}

func sessionID(props map[string]any) string {
	if id, ok := props["sessionID"].(string); ok {
		return id
	}
	if info, ok := props["info"].(map[string]any); ok {
		if id, ok := info["id"].(string); ok {
			return id
		}
	}
	return ""
}

func errorSummary(props map[string]any) string {
	err, _ := props["error"].(map[string]any)
	name, _ := err["name"].(string)
	if data, ok := err["data"].(map[string]any); ok {
		if msg, ok := data["message"].(string); ok {
			return name + ": " + msg
		}
	}
	if name == "" {
		return "unknown"
	}
	return name
}
