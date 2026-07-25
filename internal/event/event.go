// Package event defines the normalized envelope every capture source is
// mapped into before display, persistence, or export.
package event

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// CurrentSchemaVersion is stamped into every event at spool-append time.
// Version 0 means a pre-versioning spool line; readers treat it as v1.
const CurrentSchemaVersion = 1

// Category classifies an event for display grouping and filtering.
type Category string

const (
	CategorySession    Category = "session"
	CategoryPrompt     Category = "prompt"
	CategoryMessage    Category = "message"
	CategoryTool       Category = "tool"
	CategoryFile       Category = "file"
	CategoryPermission Category = "permission"
	CategoryShell      Category = "shell"
	CategoryError      Category = "error"
	CategoryMeta       Category = "meta"
)

// Severity ranks how prominently an event should surface.
type Severity string

const (
	SeverityInfo   Severity = "info"
	SeverityNotice Severity = "notice"
	SeverityWarn   Severity = "warn"
	SeverityError  Severity = "error"
)

var validCategories = map[Category]bool{
	CategorySession: true, CategoryPrompt: true, CategoryMessage: true,
	CategoryTool: true, CategoryFile: true, CategoryPermission: true,
	CategoryShell: true, CategoryError: true, CategoryMeta: true,
}

var validSeverities = map[Severity]bool{
	SeverityInfo: true, SeverityNotice: true, SeverityWarn: true, SeverityError: true,
}

// Event is the common envelope for all agent activity.
type Event struct {
	SchemaVersion int            `json:"schema_version,omitempty"`
	ID            string         `json:"id"`
	Time          time.Time      `json:"time"`
	SourceTime    *time.Time     `json:"source_time,omitempty"`  // source-supplied timestamp, when observable
	CaptureTime   *time.Time     `json:"capture_time,omitempty"` // when Firehose observed the event
	Source        string         `json:"source"`                 // agent family: claude-code, codex, opencode, generic, procwatch
	Agent         string         `json:"agent,omitempty"`        // specific agent/binary name
	SessionID     string         `json:"session_id,omitempty"`
	TraceID       string         `json:"trace_id,omitempty"` // groups causally related events across sessions, when the source supplies one
	TurnID        string         `json:"turn_id,omitempty"`  // source-native turn identifier, when the source supplies one
	CallID        string         `json:"call_id,omitempty"`  // source-native tool/command correlation id, when the source supplies one (added additively within schema v1)
	Category      Category       `json:"category"`
	Name          string         `json:"name,omitempty"` // source-specific event name
	Severity      Severity       `json:"severity,omitempty"`
	Summary       string         `json:"summary,omitempty"`
	Repo          string         `json:"repo,omitempty"`
	CWD           string         `json:"cwd,omitempty"`
	RepoID        string         `json:"repo_id,omitempty"`     // canonical local Git common-directory path, when observable
	WorktreeID    string         `json:"worktree_id,omitempty"` // canonical local Git worktree-root path, when observable
	Payload       map[string]any `json:"payload,omitempty"`
	Raw           string         `json:"raw,omitempty"` // original source payload, privacy mode permitting
}

// Validate reports whether the event has the minimum required shape.
func (e *Event) Validate() error {
	if e.Source == "" {
		return fmt.Errorf("event: source is required")
	}
	if e.Time.IsZero() {
		return fmt.Errorf("event: time is required")
	}
	if !validCategories[e.Category] {
		return fmt.Errorf("event: invalid category %q", e.Category)
	}
	if e.Severity != "" && !validSeverities[e.Severity] {
		return fmt.Errorf("event: invalid severity %q", e.Severity)
	}
	return nil
}

// NewID returns a random 16-byte hex identifier.
func NewID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
