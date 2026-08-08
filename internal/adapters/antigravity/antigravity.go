// Package antigravity maps Antigravity CLI (agy) hook payloads delivered to
// `firehose hook-forward --source antigravity --event <name>` into normalized
// events.
//
// Antigravity hook payloads carry no event-name field (see
// testdata/README.md), and Pre/PostInvocation shapes are identical, so the
// forwarder must tag every payload with the event name its hook was
// registered under. Parse therefore takes the event name explicitly.
//
// The mapped shapes are proven against the sanitized real agy 1.1.10
// captures in testdata/ except where testdata/README.md lists a known gap.
package antigravity

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"agentfirehose/internal/capturemeta"
	"agentfirehose/internal/event"
	"agentfirehose/internal/workspace"
)

// Source is the agent family identifier for Antigravity CLI events.
const Source = "antigravity"

// Manifest declares the observed Antigravity hook surface: the five-event
// contract documented at antigravity.google/docs/hooks. All five families
// have parsers; the installer wires only the three post-only events (see
// internal/cli/install.go for the decision-path rationale).
var Manifest = capturemeta.Manifest{
	Source:    Source,
	Transport: "hook",
	Fidelity:  capturemeta.SupportedInBandHook,
	Mapped: []string{
		"PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop",
	},
	SourceSchema: "antigravity-cli@1.1.10",
}

type hookPayload struct {
	ConversationID    string    `json:"conversationId"`
	WorkspacePaths    []string  `json:"workspacePaths"`
	ModelName         string    `json:"modelName"`
	StepIdx           *int64    `json:"stepIdx"`
	ToolCall          *toolCall `json:"toolCall"`
	Error             string    `json:"error"`
	InvocationNum     *int64    `json:"invocationNum"`
	InitialNumSteps   *int64    `json:"initialNumSteps"`
	TerminationReason string    `json:"terminationReason"`
	FullyIdle         *bool     `json:"fullyIdle"`
	// artifactDirectoryPath and transcriptPath are deliberately not decoded:
	// they are paths into Antigravity's internal brain/ store and must never
	// enter the safe payload or summary. Raw retains them for full mode.
}

type toolCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

// fileToolArgKeys maps file-category tool names to the args key that holds
// the target path. Both entries are proven by the 1.1.10 fixture corpus;
// further write-like tool names join this allowlist when a real capture
// records their args key (testdata/README.md). list_dir stays a plain tool:
// its DirectoryPath routinely points into the internal brain/ store.
var fileToolArgKeys = map[string]string{
	"view_file":            "AbsolutePath",
	"replace_file_content": "TargetFile",
}

// Parse converts one hook payload into a normalized event. eventName is the
// hook event the forwarder was registered under — required, because the
// payload itself carries no event-name field.
func Parse(eventName string, raw []byte) (*event.Event, error) {
	if eventName == "" {
		return nil, fmt.Errorf("antigravity: hook event name is required (payloads carry no event-name field)")
	}
	var p hookPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("antigravity: %w", err)
	}
	captured := time.Now().UTC()
	ev := &event.Event{
		ID:          event.NewID(),
		Time:        captured,
		CaptureTime: &captured,
		Source:      Source,
		Agent:       "agy",
		SessionID:   p.ConversationID,
		Transport:   "hook",
		Severity:    event.SeverityInfo,
		Raw:         string(raw),
		Payload:     map[string]any{},
	}
	// A single workspace path is the working directory; with zero or several
	// paths no single CWD is observable, and paths are never joined.
	if len(p.WorkspacePaths) == 1 {
		ev.CWD = p.WorkspacePaths[0]
	}
	if p.ModelName != "" {
		ev.Payload["model"] = p.ModelName
	}

	switch eventName {
	case "PreToolUse", "PostToolUse":
		mapToolEvent(ev, p, eventName)

	case "PreInvocation", "PostInvocation":
		ev.Category = event.CategoryMeta
		ev.Name = eventName
		if p.InvocationNum != nil {
			ev.Payload["invocation_num"] = *p.InvocationNum
		}
		if p.InitialNumSteps != nil {
			ev.Payload["initial_num_steps"] = *p.InitialNumSteps
		}
		state := "started"
		if eventName == "PostInvocation" {
			state = "completed"
		}
		if p.InvocationNum != nil {
			ev.Summary = fmt.Sprintf("model invocation %d %s", *p.InvocationNum, state)
		} else {
			ev.Summary = "model invocation " + state
		}

	case "Stop":
		ev.Name = "Stop"
		ev.Category = event.CategorySession
		ev.Severity = event.SeverityNotice
		if p.TerminationReason != "" {
			ev.Payload["termination_reason"] = p.TerminationReason
		}
		if p.FullyIdle != nil {
			ev.Payload["fully_idle"] = *p.FullyIdle
		}
		ev.Summary = "agent loop stopped (" + orUnknown(p.TerminationReason) + ")"
		if p.Error != "" {
			// Not yet observed in the wild: agy 1.1.10 left `error` empty even
			// for its captured NO_TOOL_CALL stop (testdata/README.md); the
			// branch is proven by a real fixture with only its existing error
			// value substituted. A stop-with-error ends the whole execution
			// loop, so unlike a single failing tool it maps to the error
			// category deliberately. The error text stays in Raw only.
			ev.Category = event.CategoryError
			ev.Severity = event.SeverityError
			ev.Summary = "agent loop stopped with error (" + orUnknown(p.TerminationReason) + ")"
		}

	default:
		warning := capturemeta.UnknownEvent(
			Source,
			"hook",
			eventName,
			"",
			"native hook event is not present in the Antigravity manifest",
			captured,
		)
		warning.Agent = ev.Agent
		warning.SessionID = ev.SessionID
		warning.CWD = ev.CWD
		enriched := workspace.Enrich(warning)
		return &enriched, nil
	}
	enriched := workspace.Enrich(*ev)
	return &enriched, nil
}

func mapToolEvent(ev *event.Event, p hookPayload, eventName string) {
	toolName := ""
	var args map[string]any
	if p.ToolCall != nil {
		toolName = p.ToolCall.Name
		args = p.ToolCall.Args
	}
	ev.Name = eventName + ":" + toolName
	ev.Payload["tool_name"] = toolName
	if p.StepIdx != nil {
		ev.Payload["step_idx"] = *p.StepIdx
	}
	// No native tool-call correlation id exists in the payload; CallID stays
	// empty rather than being fabricated from stepIdx.

	verb := "will run"
	switch eventName {
	case "PreToolUse":
		ev.Payload["phase"] = "start"
		ev.Payload["status"] = "started"
	case "PostToolUse":
		ev.Payload["phase"] = "end"
		if p.Error == "" {
			verb = "ran"
			ev.Payload["status"] = "success"
		} else {
			// An error-populated PostToolUse has not been observed in the wild
			// (a run_command exiting 1 still carried error: "" on agy 1.1.10 —
			// see testdata/README.md); this branch is proven by a real fixture
			// with only its existing error value substituted. A single failing
			// tool is warn-level, matching the other adapters; the error text
			// itself stays in Raw only.
			verb = "failed"
			ev.Payload["status"] = "error"
			ev.Severity = event.SeverityWarn
		}
	}

	// toolSummary, toolAction, CommandLine, Cwd, and every other tool arg
	// stay out of the safe payload and summary; the allowlisted file-path
	// arg is the deliberate exception so the timeline can say which file was
	// touched (the claudecode precedent).
	switch {
	case toolName == "run_command":
		ev.Category = event.CategoryShell
		ev.Summary = verb + " shell tool"
	case fileToolArgKeys[toolName] != "":
		ev.Category = event.CategoryFile
		path, _ := args[fileToolArgKeys[toolName]].(string)
		ev.Summary = fmt.Sprintf("%s %s on %s", verb, toolName, filepath.Base(path))
		ev.Payload["file_path"] = path
	default:
		ev.Category = event.CategoryTool
		ev.Summary = fmt.Sprintf("%s tool %s", verb, toolName)
	}
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}
