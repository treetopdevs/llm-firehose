// Package codex tails Codex rollout session files
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) and maps their lines into
// normalized events. Codex has no hook surface, so the viewer reads these
// files directly; nothing is re-persisted to the spool.
package codex

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"agentfirehose/internal/event"
)

// Source is the agent family identifier for Codex events.
const Source = "codex"

type rolloutLine struct {
	Timestamp time.Time       `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// FileParser converts one rollout file's lines into events, carrying the
// session id and cwd learned from the file's session_meta line.
type FileParser struct {
	sessionID string
	cwd       string
}

func NewFileParser() *FileParser { return &FileParser{} }

// ParseLine maps one JSONL line to an event. A nil event with nil error means
// the line is deliberately skipped (noise: token counts, reasoning, etc.).
func (p *FileParser) ParseLine(line []byte) (*event.Event, error) {
	var rl rolloutLine
	if err := json.Unmarshal(line, &rl); err != nil {
		return nil, fmt.Errorf("codex: %w", err)
	}
	switch rl.Type {
	case "session_meta":
		return p.parseSessionMeta(rl)
	case "event_msg":
		return p.parseEventMsg(rl)
	case "response_item":
		return p.parseResponseItem(rl)
	}
	return nil, nil
}

func (p *FileParser) base(rl rolloutLine, cat event.Category, name string) *event.Event {
	return &event.Event{
		ID:        event.NewID(),
		Time:      rl.Timestamp,
		Source:    Source,
		Agent:     "codex",
		SessionID: p.sessionID,
		CWD:       p.cwd,
		Category:  cat,
		Name:      name,
		Severity:  event.SeverityInfo,
		Payload:   map[string]any{},
		Raw:       "", // set by callers that want it
	}
}

func (p *FileParser) parseSessionMeta(rl rolloutLine) (*event.Event, error) {
	var m struct {
		ID         string `json:"id"`
		CWD        string `json:"cwd"`
		Originator string `json:"originator"`
		CLIVersion string `json:"cli_version"`
	}
	if err := json.Unmarshal(rl.Payload, &m); err != nil {
		return nil, err
	}
	p.sessionID = m.ID
	p.cwd = m.CWD
	ev := p.base(rl, event.CategorySession, "session_meta")
	ev.Severity = event.SeverityNotice
	ev.Summary = fmt.Sprintf("codex session started (%s %s)", m.Originator, m.CLIVersion)
	ev.Payload["originator"] = m.Originator
	ev.Payload["cli_version"] = m.CLIVersion
	return ev, nil
}

func (p *FileParser) parseEventMsg(rl rolloutLine) (*event.Event, error) {
	var m struct {
		Type             string          `json:"type"`
		Message          string          `json:"message"`
		Command          []string        `json:"command"`
		ExitCode         *int            `json:"exit_code"`
		Success          *bool           `json:"success"`
		Changes          map[string]any  `json:"changes"`
		LastAgentMessage string          `json:"last_agent_message"`
		Action           json.RawMessage `json:"action"`
	}
	if err := json.Unmarshal(rl.Payload, &m); err != nil {
		return nil, err
	}
	switch m.Type {
	case "user_message":
		ev := p.base(rl, event.CategoryPrompt, m.Type)
		ev.Summary = fmt.Sprintf("prompt: %q", excerpt(m.Message, 80))
		ev.Payload["message"] = m.Message
		return ev, nil
	case "agent_message":
		ev := p.base(rl, event.CategoryMessage, m.Type)
		ev.Summary = excerpt(m.Message, 120)
		ev.Payload["message"] = m.Message
		return ev, nil
	case "exec_command_end":
		ev := p.base(rl, event.CategoryShell, m.Type)
		cmd := shellCommand(m.Command)
		ev.Summary = "ran: " + excerpt(cmd, 100)
		ev.Payload["command"] = cmd
		if m.ExitCode != nil {
			ev.Payload["exit_code"] = *m.ExitCode
			if *m.ExitCode != 0 {
				ev.Severity = event.SeverityWarn
			}
		}
		return ev, nil
	case "patch_apply_end":
		ev := p.base(rl, event.CategoryFile, m.Type)
		files := make([]string, 0, len(m.Changes))
		for path := range m.Changes {
			files = append(files, filepath.Base(path))
		}
		sort.Strings(files)
		if m.Success != nil && !*m.Success {
			ev.Severity = event.SeverityError
			ev.Summary = "patch failed"
		} else {
			ev.Summary = "patched " + excerpt(strings.Join(files, ", "), 100)
		}
		ev.Payload["changes"] = m.Changes
		return ev, nil
	case "task_started":
		ev := p.base(rl, event.CategorySession, m.Type)
		ev.Summary = "turn started"
		return ev, nil
	case "task_complete":
		ev := p.base(rl, event.CategorySession, m.Type)
		ev.Summary = "turn complete: " + excerpt(m.LastAgentMessage, 100)
		return ev, nil
	case "web_search_end":
		ev := p.base(rl, event.CategoryTool, m.Type)
		var a struct {
			Query string `json:"query"`
		}
		json.Unmarshal(m.Action, &a)
		ev.Summary = "web search: " + excerpt(a.Query, 90)
		return ev, nil
	case "error", "stream_error", "turn_aborted":
		ev := p.base(rl, event.CategoryError, m.Type)
		ev.Severity = event.SeverityError
		ev.Summary = excerpt(m.Message, 120)
		if ev.Summary == "" {
			ev.Summary = m.Type
		}
		return ev, nil
	}
	return nil, nil
}

func (p *FileParser) parseResponseItem(rl rolloutLine) (*event.Event, error) {
	var m struct {
		Type      string `json:"type"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
		Input     string `json:"input"`
	}
	if err := json.Unmarshal(rl.Payload, &m); err != nil {
		return nil, err
	}
	switch m.Type {
	case "function_call":
		// exec_command / apply_patch surface via their richer *_end event_msg lines
		if m.Name == "exec_command" || m.Name == "apply_patch" {
			return nil, nil
		}
		ev := p.base(rl, event.CategoryTool, "function_call:"+m.Name)
		ev.Summary = "tool call: " + m.Name
		ev.Payload["name"] = m.Name
		ev.Payload["arguments"] = m.Arguments
		return ev, nil
	case "local_shell_call":
		ev := p.base(rl, event.CategoryShell, m.Type)
		ev.Summary = "shell call"
		return ev, nil
	case "custom_tool_call":
		if m.Name == "apply_patch" { // patch_apply_end covers it
			return nil, nil
		}
		ev := p.base(rl, event.CategoryTool, "custom_tool_call:"+m.Name)
		ev.Summary = "tool call: " + m.Name
		ev.Payload["name"] = m.Name
		ev.Payload["input"] = m.Input
		return ev, nil
	}
	return nil, nil
}

func shellCommand(argv []string) string {
	// Codex wraps commands as ["/bin/zsh","-lc","actual command"]; show the tail.
	if len(argv) >= 3 && strings.HasSuffix(argv[0], "sh") && strings.HasPrefix(argv[1], "-") {
		return argv[len(argv)-1]
	}
	return strings.Join(argv, " ")
}

func excerpt(s string, max int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}
