// Package opencode maps OpenCode bus events into normalized events. Capture
// works through an OpenCode plugin (see plugin.go) that forwards each bus
// event to `firehose hook-forward --source opencode` as JSON on stdin.
package opencode

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"time"

	"agentfirehose/internal/capturemeta"
	"agentfirehose/internal/event"
)

// Source is the agent family identifier for OpenCode events.
const Source = "opencode"

var handledBusTypes = map[string]struct{}{
	"session.idle":         {},
	"session.created":      {},
	"session.deleted":      {},
	"session.error":        {},
	"message.updated":      {},
	"message.part.updated": {},
	"permission.updated":   {},
	"permission.replied":   {},
	"file.edited":          {},
}

// Manifest is the parser/plugin coverage contract. The generated plugin uses
// the same lists so high-volume filters cannot drift independently.
var Manifest = capturemeta.Manifest{
	Source:    Source,
	Transport: "plugin",
	Fidelity:  capturemeta.SupportedPassiveStream,
	Mapped:    handledBusTypeNames(),
	Filtered: []string{
		"message.part.delta",
		"message.reasoning.delta",
	},
	SourceSchema: "opencode@1.18.x",
}

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
	captured := time.Now().UTC()
	ev := &event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: &captured,
		Source:      Source,
		Agent:       "opencode",
		SessionID:   sessionID(props),
		CWD:         be.Directory,
		Transport:   Manifest.Transport,
		Name:        be.Type,
		Severity:    event.SeverityInfo,
		Payload:     map[string]any{},
		Raw:         string(raw),
	}
	if containsType(Manifest.Filtered, be.Type) {
		return nil, nil
	}
	if _, ok := handledBusTypes[be.Type]; !ok {
		sourceVersion, _ := props["version"].(string)
		warning := capturemeta.UnknownEvent(
			Source,
			Manifest.Transport,
			be.Type,
			sourceVersion,
			"native bus event is not present in the OpenCode manifest",
			captured,
		)
		warning.Agent = "opencode"
		warning.SessionID = ev.SessionID
		warning.CWD = ev.CWD
		return &warning, nil
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
		ev.Summary = "session error: " + errorName(props)
	case "message.updated":
		info, _ := props["info"].(map[string]any)
		role, _ := info["role"].(string)
		if id, ok := info["sessionID"].(string); ok {
			ev.SessionID = id
		}
		if id, ok := info["id"].(string); ok {
			ev.MessageID = id
		}
		if id, ok := info["parentID"].(string); ok {
			ev.ParentID = id
		}
		if role != "" {
			ev.Payload["role"] = role
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
		ev.Summary = "permission requested"
		if permissionType, ok := props["type"].(string); ok {
			ev.Payload["permission_type"] = permissionType
		}
	case "permission.replied":
		ev.Category = event.CategoryPermission
		ev.Severity = event.SeverityNotice
		resp, _ := props["response"].(string)
		ev.Summary = "permission answered: " + resp
		ev.Payload["decision"] = resp
	case "file.edited":
		ev.Category = event.CategoryFile
		file, _ := props["file"].(string)
		ev.Summary = "edited " + filepath.Base(file)
		ev.Payload["file_path"] = file
	default:
		return nil, fmt.Errorf("opencode: manifest type %q has no parser handler", be.Type)
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
	if id, ok := part["id"].(string); ok {
		ev.CallID = id
	}
	tool, _ := part["tool"].(string)
	input, _ := state["input"].(map[string]any)
	ev.Name = "tool:" + tool
	ev.Payload["tool_name"] = tool
	ev.Payload["status"] = status
	switch {
	case tool == "bash":
		ev.Category = event.CategoryShell
		ev.Summary = "ran shell tool"
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

func handledBusTypeNames() []string {
	names := make([]string, 0, len(handledBusTypes))
	for name := range handledBusTypes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func containsType(names []string, target string) bool {
	for _, name := range names {
		if name == target {
			return true
		}
	}
	return false
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

func errorName(props map[string]any) string {
	err, _ := props["error"].(map[string]any)
	name, _ := err["name"].(string)
	if name == "" {
		return "unknown"
	}
	return name
}
