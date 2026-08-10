// Package opencode maps OpenCode bus events into normalized events. Capture
// works through an OpenCode plugin (see plugin.go) that forwards each bus
// event to `firehose hook-forward --source opencode` as JSON on stdin.
//
// The mapped shapes are proven against the sanitized real OpenCode 1.18.10
// captures in testdata/ except where testdata/README.md lists a known gap.
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
	"session.created":      {},
	"session.updated":      {},
	"session.status":       {},
	"session.idle":         {},
	"session.diff":         {},
	"session.deleted":      {},
	"session.error":        {},
	"message.updated":      {},
	"message.part.updated": {},
	"permission.updated":   {},
	"permission.replied":   {},
	"file.edited":          {},
	"file.watcher.updated": {},
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
	},
	SourceSchema: "opencode@1.18.x",
}

type busEvent struct {
	ID         string          `json:"id"` // stable identifier assigned by the bus
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
		ID:              event.NewID(),
		Time:            captured,
		CaptureTime:     &captured,
		Source:          Source,
		Agent:           "opencode",
		SessionID:       sessionID(props),
		CWD:             be.Directory,
		Transport:       Manifest.Transport,
		UpstreamEventID: be.ID,
		Name:            be.Type,
		Severity:        event.SeverityInfo,
		Payload:         map[string]any{},
		Raw:             string(raw),
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
	case "session.created":
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		ev.Summary = "session started"
		applySessionInfo(ev, props, "created")
	case "session.updated":
		ev.Category = event.CategorySession
		ev.Summary = "session updated"
		applySessionInfo(ev, props, "updated")
		info := mapValue(props, "info")
		if cost, ok := info["cost"].(float64); ok {
			ev.Payload["cost"] = cost
		}
		if tokens := tokenPayload(mapValue(info, "tokens")); tokens != nil {
			ev.Payload["tokens"] = tokens
		}
	case "session.status":
		ev.Category = event.CategorySession
		kind, _ := mapValue(props, "status")["type"].(string)
		if kind == "" {
			ev.Summary = "session status"
		} else {
			ev.Summary = "session " + kind
		}
		ev.Payload["status"] = kind
	case "session.idle":
		ev.Category = event.CategorySession
		ev.Summary = "session idle"
	case "session.diff":
		ev.Category = event.CategorySession
		ev.Summary = "session diff"
		if diff, ok := props["diff"].([]any); ok {
			ev.Payload["changed_files"] = len(diff)
		}
	case "session.deleted":
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		ev.Summary = "session deleted"
	case "session.error":
		ev.Category = event.CategoryError
		ev.Severity = event.SeverityError
		ev.Summary = "session error: " + errorName(props)
	case "message.updated":
		parseMessage(ev, props)
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
	case "file.watcher.updated":
		ev.Category = event.CategoryFile
		file, _ := props["file"].(string)
		kind, _ := props["event"].(string)
		if kind == "" {
			kind = "change"
		}
		ev.Summary = "file " + kind + ": " + filepath.Base(file)
		ev.Payload["file_path"] = file
		ev.Payload["change_type"] = kind
	default:
		return nil, fmt.Errorf("opencode: manifest type %q has no parser handler", be.Type)
	}
	return ev, nil
}

// parseMessage maps message.updated using the real 1.18.10 info shape:
// correlation IDs, created/completed timestamps, and — once the assistant
// message carries a finish reason — usage tokens and cost.
func parseMessage(ev *event.Event, props map[string]any) {
	info := mapValue(props, "info")
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
	times := mapValue(info, "time")
	if t := epochMS(times["completed"]); t != nil {
		ev.SourceTime = t
	} else if t := epochMS(times["created"]); t != nil {
		ev.SourceTime = t
	}
	if role != "" {
		ev.Payload["role"] = role
	}
	if agent, ok := info["agent"].(string); ok && agent != "" {
		ev.Payload["agent"] = agent
	}
	if mode, ok := info["mode"].(string); ok && mode != "" {
		ev.Payload["mode"] = mode
	}
	addModelInfo(ev, info)
	if role == "user" {
		ev.Category = event.CategoryPrompt
		ev.Summary = "user prompt"
		return
	}
	ev.Category = event.CategoryMessage
	ev.Summary = "assistant message"
	if finish, ok := info["finish"].(string); ok && finish != "" {
		ev.Payload["finish"] = finish
		if cost, ok := info["cost"].(float64); ok {
			ev.Payload["cost"] = cost
		}
		if tokens := tokenPayload(mapValue(info, "tokens")); tokens != nil {
			ev.Payload["tokens"] = tokens
		}
	}
}

// parsePart maps message.part.updated. Terminal tool states, step-finish, and
// patch parts carry durable signal; text/reasoning/step-start parts stream
// too often to show and are deliberate skips mirrored by the plugin filter.
func parsePart(ev *event.Event, props map[string]any) (*event.Event, error) {
	part := mapValue(props, "part")
	if id, ok := part["sessionID"].(string); ok {
		ev.SessionID = id
	}
	if id, ok := part["messageID"].(string); ok {
		ev.MessageID = id
	}
	if t := epochMS(props["time"]); t != nil {
		ev.SourceTime = t
	}
	switch part["type"] {
	case "tool":
		return parseToolPart(ev, part)
	case "step-finish":
		ev.Category = event.CategoryMessage
		ev.Name = "step-finish"
		ev.Summary = "assistant step finished"
		if reason, ok := part["reason"].(string); ok && reason != "" {
			ev.Payload["reason"] = reason
		}
		if snapshot, ok := part["snapshot"].(string); ok && snapshot != "" {
			ev.Payload["snapshot"] = snapshot
		}
		if cost, ok := part["cost"].(float64); ok {
			ev.Payload["cost"] = cost
		}
		if tokens := tokenPayload(mapValue(part, "tokens")); tokens != nil {
			ev.Payload["tokens"] = tokens
		}
		return ev, nil
	case "patch":
		ev.Category = event.CategoryFile
		ev.Name = "patch"
		ev.Summary = "patch applied"
		if files, ok := part["files"].([]any); ok {
			ev.Payload["file_count"] = len(files)
		}
		if hash, ok := part["hash"].(string); ok && hash != "" {
			ev.Payload["snapshot"] = hash
		}
		return ev, nil
	default:
		return nil, nil // text, reasoning, step-start: streaming noise
	}
}

// parseToolPart maps terminal tool states. The safe payload is metadata only:
// tool name, status, duration, exit code, and the target path for file tools.
// Arguments, output, titles, and provider metadata stay in full-mode raw.
func parseToolPart(ev *event.Event, part map[string]any) (*event.Event, error) {
	state := mapValue(part, "state")
	status, _ := state["status"].(string)
	if status != "completed" && status != "error" {
		return nil, nil // wait for the terminal update
	}
	// The real bus supplies the model's call correlation id in part.callID;
	// part.id is the part record id and is only a fallback.
	if id, ok := part["callID"].(string); ok && id != "" {
		ev.CallID = id
	} else if id, ok := part["id"].(string); ok {
		ev.CallID = id
	}
	tool, _ := part["tool"].(string)
	input, _ := state["input"].(map[string]any)
	ev.Name = "tool:" + tool
	ev.Payload["tool_name"] = tool
	ev.Payload["status"] = status
	times := mapValue(state, "time")
	if start, end := epochMS(times["start"]), epochMS(times["end"]); start != nil && end != nil {
		ev.Payload["duration_ms"] = end.Sub(*start).Milliseconds()
	}
	if exit, ok := mapValue(state, "metadata")["exit"].(float64); ok {
		ev.Payload["exit_code"] = int(exit)
	}
	switch {
	case tool == "bash":
		ev.Category = event.CategoryShell
		ev.Summary = "ran shell tool"
	case fileToolNames[tool]:
		ev.Category = event.CategoryFile
		path, _ := input["filePath"].(string)
		ev.Summary = fmt.Sprintf("%s %s", tool, filepath.Base(path))
		if path != "" {
			ev.Payload["file_path"] = path
		}
	default:
		ev.Category = event.CategoryTool
		ev.Summary = "tool: " + tool
	}
	if status == "error" {
		ev.Severity = event.SeverityWarn
	}
	return ev, nil
}

// applySessionInfo maps the shared session info envelope: source version,
// the preferred nested timestamp, and agent/model identity.
func applySessionInfo(ev *event.Event, props map[string]any, timeKey string) {
	info := mapValue(props, "info")
	if ev.SessionID == "" {
		if id, ok := info["id"].(string); ok {
			ev.SessionID = id
		}
	}
	if version, ok := info["version"].(string); ok {
		ev.SourceVersion = version
	}
	times := mapValue(info, "time")
	if t := epochMS(times[timeKey]); t != nil {
		ev.SourceTime = t
	} else if t := epochMS(times["created"]); t != nil {
		ev.SourceTime = t
	}
	if agent, ok := info["agent"].(string); ok && agent != "" {
		ev.Payload["agent"] = agent
	}
	addModelInfo(ev, info)
}

// addModelInfo extracts model/provider identity from the three observed
// shapes: top-level modelID/providerID (assistant messages), a nested model
// object with modelID (user messages), or with id (session info).
func addModelInfo(ev *event.Event, info map[string]any) {
	model, _ := info["modelID"].(string)
	provider, _ := info["providerID"].(string)
	nested := mapValue(info, "model")
	if model == "" {
		if v, ok := nested["modelID"].(string); ok {
			model = v
		} else if v, ok := nested["id"].(string); ok {
			model = v
		}
	}
	if provider == "" {
		if v, ok := nested["providerID"].(string); ok {
			provider = v
		}
	}
	if model != "" {
		ev.Payload["model"] = model
	}
	if provider != "" {
		ev.Payload["provider"] = provider
	}
}

func tokenPayload(tokens map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"input", "output", "reasoning"} {
		if v, ok := tokens[key].(float64); ok {
			out[key] = v
		}
	}
	cache := mapValue(tokens, "cache")
	if v, ok := cache["read"].(float64); ok {
		out["cache_read"] = v
	}
	if v, ok := cache["write"].(float64); ok {
		out["cache_write"] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func mapValue(m map[string]any, key string) map[string]any {
	v, _ := m[key].(map[string]any)
	return v
}

// epochMS converts a bus epoch-milliseconds value into a UTC timestamp.
func epochMS(v any) *time.Time {
	ms, ok := v.(float64)
	if !ok || ms <= 0 {
		return nil
	}
	t := time.UnixMilli(int64(ms)).UTC()
	return &t
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
